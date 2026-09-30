/**
 * Structured logger.
 *
 * Keeps the dependency surface small (no pino/winston) while still emitting
 * single-line JSON in production - which is what Loki/Datadog/CloudWatch
 * ingest - and a readable coloured line in development.
 */

const env = require('../config/env');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const COLORS = { error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m', debug: '\x1b[90m' };
const RESET = '\x1b[0m';

const activeLevel = LEVELS[env.LOG_LEVEL] ?? LEVELS.info;

/** Process-wide default fields; per-request context uses `logger.child`. */
const bindings = [];

function emit(level, message, meta) {
  if (LEVELS[level] > activeLevel) return;
  const timestamp = new Date().toISOString();
  const payload = meta && Object.keys(meta).length ? { level, timestamp, message, ...mergeBindings(), ...meta } : null;

  if (env.isProduction) {
    const line = JSON.stringify(payload ?? { level, timestamp, message, ...mergeBindings() });
    if (level === 'error') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
    return;
  }

  const scope = mergeBindings();
  const suffix = Object.keys(scope).length || meta ? ` ${JSON.stringify({ ...scope, ...meta })}` : '';
  const line = `${COLORS[level] ?? ''}${timestamp} ${level.toUpperCase().padEnd(5)}${RESET} ${message}${suffix}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

function mergeBindings() {
  return bindings.reduce((acc, entry) => ({ ...acc, ...entry }), {});
}

const logger = {
  error: (message, meta) => emit('error', message, meta),
  warn: (message, meta) => emit('warn', message, meta),
  info: (message, meta) => emit('info', message, meta),
  debug: (message, meta) => emit('debug', message, meta),

  /** Attach fields (e.g. requestId, userId) to every following line. */
  child(fields) {
    const scoped = { ...fields };
    return {
      error: (message, meta) => emit('error', message, { ...scoped, ...meta }),
      warn: (message, meta) => emit('warn', message, { ...scoped, ...meta }),
      info: (message, meta) => emit('info', message, { ...scoped, ...meta }),
      debug: (message, meta) => emit('debug', message, { ...scoped, ...meta }),
      child: logger.child,
    };
  },

  /** Alias kept for readability in middleware (`logger.bind({ requestId })`). */
  bind(fields) {
    return logger.child(fields);
  },

  /** Morgan-compatible stream writer. */
  stream: {
    write: (message) => emit('info', message.trim().replace(/^::1\s+/, '')),
  },

  level: env.LOG_LEVEL,
};

module.exports = logger;
