/**
 * OpenRouter transport.
 *
 * A single chat-completions client used by every AI feature. This module owns
 * the wire protocol only - retries, timeouts, usage extraction and JSON
 * coercion. Plan limits and `AiUsageLog` accounting live in
 * `services/ai.service.js`.
 *
 * Docs: POST {OPENROUTER_BASE_URL}/chat/completions
 */

const env = require('./env');
const logger = require('../utils/logger.util');

/** Rough USD per-million-token rates used for cost estimates only. */
const MODEL_RATES = {
  'openai/gpt-4o': { prompt: 2.5, completion: 10 },
  'openai/gpt-4o-mini': { prompt: 0.15, completion: 0.6 },
  'anthropic/claude-sonnet-4': { prompt: 3, completion: 15 },
  'meta-llama/llama-3.1-70b-instruct': { prompt: 0.52, completion: 0.75 },
  'deepseek/deepseek-coder': { prompt: 0.14, completion: 0.28 },
  'google/gemini-flash-1.5': { prompt: 0.075, completion: 0.3 },
};

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

class OpenRouterError extends Error {
  constructor(message, { status, code, requestId, retryable = false, providerError } = {}) {
    super(message);
    this.name = 'OpenRouterError';
    this.status = status ?? 502;
    this.code = code ?? 'AI_UPSTREAM_ERROR';
    this.requestId = requestId ?? null;
    this.retryable = retryable;
    this.providerError = providerError ?? null;
  }
}

function estimateCostUsd(model, usage = {}) {
  const rate = MODEL_RATES[model] ?? { prompt: 1, completion: 4 };
  const promptTokens = Number(usage.prompt_tokens ?? 0);
  const completionTokens = Number(usage.completion_tokens ?? 0);
  return (promptTokens * rate.prompt + completionTokens * rate.completion) / 1_000_000;
}

function buildHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
    // OpenRouter attribution headers - recommended, harmless if ignored.
    'HTTP-Referer': env.API_BASE_URL,
    'X-Title': 'Online Exam & Assessment Platform',
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} params
 * @param {Array<{role: string, content: string}>} params.messages
 * @param {string} [params.system]         shorthand system prompt
 * @param {string} [params.model]          defaults to OPENROUTER_MODEL
 * @param {number} [params.temperature]
 * @param {number} [params.maxTokens]
 * @param {object} [params.responseFormat] { type: 'json_object' } or a json_schema descriptor
 * @param {string[]} [params.models]       provider fallback chain
 * @param {number} [params.seed]
 * @param {boolean} [params.stream]
 * @returns {Promise<{content, model, usage, requestId, finishReason, latencyMs, retries, parsed?}>}
 */
async function chat(params = {}) {
  if (!env.OPENROUTER_API_KEY) {
    throw new OpenRouterError('OPENROUTER_API_KEY is not set - AI features are disabled', {
      status: 503,
      code: 'AI_NOT_CONFIGURED',
    });
  }

  const messages = params.messages ?? [];
  if (params.system) messages.unshift({ role: 'system', content: params.system });
  if (!messages.length) throw new OpenRouterError('chat() requires at least one message', { status: 400, code: 'AI_BAD_REQUEST' });

  const body = {
    model: params.model ?? env.OPENROUTER_MODEL,
    messages,
    temperature: params.temperature ?? 0.2,
    max_tokens: params.maxTokens ?? 2048,
    top_p: params.topP ?? 1,
    stream: Boolean(params.stream),
    ...(params.responseFormat ? { response_format: params.responseFormat } : {}),
    ...(params.models?.length ? { models: params.models } : {}),
    ...(params.seed !== undefined ? { seed: params.seed } : {}),
    ...(params.stop?.length ? { stop: params.stop } : {}),
    usage: { include: true },
  };

  const maxAttempts = env.OPENROUTER_MAX_RETRIES + 1;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.OPENROUTER_TIMEOUT_MS);

    try {
      const response = await fetch(`${env.OPENROUTER_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const requestId = response.headers.get('x-request-id') ?? response.headers.get('request-id') ?? null;
      const text = await response.text();

      if (!response.ok) {
        let payload = null;
        try {
          payload = JSON.parse(text);
        } catch {
          /* upstream returned an HTML error page */
        }
        const message = payload?.error?.message ?? `OpenRouter responded ${response.status}`;
        const error = new OpenRouterError(message, {
          status: response.status,
          code: payload?.error?.code ?? `AI_HTTP_${response.status}`,
          requestId,
          retryable: RETRYABLE_STATUS.has(response.status),
          providerError: payload?.error ?? null,
        });
        lastError = error;
        if (!error.retryable || attempt === maxAttempts) throw error;
        await sleep(backoffMs(attempt, response.headers.get('retry-after')));
        continue;
      }

      const data = JSON.parse(text);
      const choice = data.choices?.[0];
      const model = data.model ?? body.model;
      const usage = data.usage ?? {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      };

      return {
        content: choice?.message?.content ?? '',
        reasoning: choice?.message?.reasoning ?? null,
        refusal: choice?.message?.refusal ?? null,
        model,
        usage: {
          promptTokens: Number(usage.prompt_tokens ?? 0),
          completionTokens: Number(usage.completion_tokens ?? 0),
          totalTokens: Number(usage.total_tokens ?? usage.prompt_tokens + usage.completion_tokens ?? 0),
        },
        costUsd: Number(usage.cost ?? estimateCostUsd(model, usage)),
        requestId,
        finishReason: choice?.finish_reason ?? null,
        latencyMs: Date.now() - startedAt,
        retries: attempt - 1,
      };
    } catch (error) {
      if (error instanceof OpenRouterError) {
        if (!error.retryable || attempt === maxAttempts) throw error;
        await sleep(backoffMs(attempt, null));
        continue;
      }
      const aborted = error.name === 'AbortError';
      lastError = new OpenRouterError(aborted ? 'OpenRouter request timed out' : error.message, {
        status: aborted ? 504 : 502,
        code: aborted ? 'AI_TIMEOUT' : 'AI_NETWORK_ERROR',
        retryable: true,
      });
      if (attempt === maxAttempts) throw lastError;
      await sleep(backoffMs(attempt, null));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new OpenRouterError('OpenRouter request failed', { status: 502 });
}

function backoffMs(attempt, retryAfterHeader) {
  const retryAfter = Number(retryAfterHeader);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 15_000);
  const base = Math.min(2 ** (attempt - 1) * 700, 8000);
  return base + Math.round(Math.random() * 350);
}

/** Strip markdown fences and repair the common truncation case. */
function extractJson(raw) {
  const text = String(raw ?? '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.search(/[[{]/);
    if (start < 0) throw new OpenRouterError('model did not return JSON', { status: 502, code: 'AI_BAD_JSON' });
    const open = candidate[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < candidate.length; index += 1) {
      const char = candidate[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') escaped = true;
      else if (char === '"') inString = !inString;
      else if (!inString && char === open) depth += 1;
      else if (!inString && char === close) {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(candidate.slice(start, index + 1));
          } catch {
            break;
          }
        }
      }
    }
    logger.debug('AI returned unparsable JSON', { preview: candidate.slice(0, 400) });
    throw new OpenRouterError('model returned malformed JSON', { status: 502, code: 'AI_BAD_JSON' });
  }
}

/** `chat` + JSON coercion, with one automatic "reply with valid JSON only" retry. */
async function chatJson(params = {}) {
  const request = {
    ...params,
    responseFormat: params.responseFormat ?? { type: 'json_object' },
    temperature: params.temperature ?? 0,
  };

  const first = await chat(request);
  try {
    return { ...first, parsed: extractJson(first.content) };
  } catch (error) {
    logger.warn('AI JSON repair retry', { code: error.code, model: first.model });
    const retry = await chat({
      ...request,
      messages: [
        ...(request.messages ?? []),
        { role: 'assistant', content: first.content },
        { role: 'user', content: 'That response was not valid JSON. Reply again with ONLY the JSON document, no prose and no code fences.' },
      ],
    });
    return { ...retry, parsed: extractJson(retry.content), repaired: true };
  }
}

/** Batched helper used by the question generator and bulk graders. */
async function chatMany(requests, { concurrency = 3 } = {}) {
  const results = new Array(requests.length);
  let cursor = 0;

  async function worker() {
    while (cursor < requests.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = { ok: true, value: await chat(requests[index]) };
      } catch (error) {
        results[index] = { ok: false, error: { message: error.message, code: error.code, status: error.status } };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, requests.length || 1) }, worker));
  return results;
}

module.exports = {
  MODEL_RATES,
  OpenRouterError,
  chat,
  chatJson,
  chatMany,
  estimateCostUsd,
  extractJson,
  isConfigured: () => Boolean(env.OPENROUTER_API_KEY),
};
