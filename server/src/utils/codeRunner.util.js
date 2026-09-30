/**
 * Sandboxed code execution for coding questions.
 *
 * JavaScript runs inside an `isolated-vm` isolate: no `require`, no network,
 * no filesystem, a hard wall-clock timeout and a memory ceiling per attempt.
 * Other languages are delegated to per-language adapters which shell out to a
 * local runtime inside a locked-down working directory; when the runtime is
 * unavailable the adapter reports `unsupported` so the grader can fall back to
 * manual review instead of failing the candidate.
 *
 * Set CODE_RUNNER=disabled to turn the whole thing off (AI/manual grading
 * still works, coding answers simply go to the manual queue).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const env = require('../config/env');
const logger = require('./logger.util');

const RESULT_SHAPE = { passed: false, output: null, error: null, durationMs: 0, expected: null, actual: null, timedOut: false };

let isolatedVmLoadError = null;
let isolatedVmModule = null;

function loadIsolatedVm() {
  if (isolatedVmModule) return isolatedVmModule;
  if (isolatedVmLoadError) return null;
  try {
    // Required lazily so the API still boots when the native build is absent.
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    isolatedVmModule = require('isolated-vm');
    return isolatedVmModule;
  } catch (error) {
    isolatedVmLoadError = error;
    logger.warn('isolated-vm unavailable - coding answers will fall back to manual grading', {
      error: error.message,
    });
    return null;
  }
}

function runnerDisabled() {
  return env.CODE_RUNNER === 'disabled';
}

/** Coerce stored test-case values (strings from the author UI) for comparison. */
function looseEquals(expected, actual) {
  if (expected === actual) return true;
  if (expected === null || actual === null || expected === undefined || actual === undefined) return false;
  if (typeof expected === 'object' || typeof actual === 'object') {
    try {
      return JSON.stringify(sortKeys(expected)) === JSON.stringify(sortKeys(actual));
    } catch {
      return false;
    }
  }
  return String(expected) === String(actual);
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => ({ ...acc, [key]: sortKeys(value[key]) }), {});
  }
  return value;
}

function toArguments(input) {
  if (Array.isArray(input)) return input;
  if (input === undefined || input === null) return [];
  if (typeof input === 'string') {
    const lines = input.split('\n').map((line) => line.trim()).filter(Boolean);
    if (lines.length > 1) {
      return lines.map((line) => {
        const numeric = Number(line);
        return Number.isNaN(numeric) ? line : numeric;
      });
    }
    try {
      return [JSON.parse(input)];
    } catch {
      return [input];
    }
  }
  return [input];
}

/**
 * Execute a JavaScript answer against every test case.
 *
 * @param {string} code
 * @param {Array<{id, input, expectedOutput, isSample}>} testCases
 * @param {object} options { entryFunction, timeLimitMs, memoryLimitMb, includeHidden }
 */
async function runJavaScript(code, testCases = [], options = {}) {
  if (runnerDisabled()) return unsupported('code runner disabled by configuration');

  const ivm = loadIsolatedVm();
  if (!ivm) return unsupported('isolated-vm is not installed on this host');

  const timeLimitMs = Math.min(Number(options.timeLimitMs ?? env.CODE_EXECUTION_TIMEOUT_MS), env.CODE_EXECUTION_TIMEOUT_MS);
  const memoryLimitMb = Math.min(Number(options.memoryLimitMb ?? env.CODE_EXECUTION_MEMORY_MB), env.CODE_EXECUTION_MEMORY_MB);
  const entryFunction = options.entryFunction ?? 'solution';
  const tests = testCases.slice(0, env.CODE_EXECUTION_MAX_TESTS);

  const isolate = new ivm.Isolate({ memoryLimit: memoryLimitMb });
  try {
    const context = await isolate.createContext();
    const harness = `
      const console = { log: (...args) => globalThis.__logs.push(args.map(String).join(' ')) };
      globalThis.__logs = [];
    `;
    await context.evalClosure(harness, {}, { timeout: 1000 });

    // Reject anything that smells like an escape attempt before compiling.
    const banned = /\b(require|import|process|globalThis\s*\[\s*['"]|Function\s*\(|eval\s*\(|fetch\s*\(|XMLHttpRequest|WebAssembly)\b/;
    if (banned.test(code)) {
      return {
        status: 'REJECTED',
        compileOutput: 'forbidden construct detected in submission',
        logs: [],
        results: tests.map((test) => ({ ...RESULT_SHAPE, testId: test.id, error: 'FORBIDDEN_CONSTRUCT' })),
        passedCount: 0,
        totalCount: tests.length,
      };
    }

    await context.evalClosure(`${code}\nglobalThis.__entry = typeof ${entryFunction} === 'function' ? ${entryFunction} : null;\n`, {}, {
      timeout: timeLimitMs,
      filename: 'submission.js',
    });

    const entry = await context.global.get('__entry', { reference: true, function: 'reference' });
    if (!entry) {
      return {
        status: 'ERROR',
        compileOutput: `function ${entryFunction}() is not defined`,
        logs: [],
        results: tests.map((test) => ({ ...RESULT_SHAPE, testId: test.id, error: 'MISSING_ENTRY_FUNCTION' })),
        passedCount: 0,
        totalCount: tests.length,
      };
    }

    const results = [];
    for (const test of tests) {
      const args = toArguments(test.input);
      const startedAt = Date.now();
      try {
        const cloneArgs = args.map((arg) => new ivm.ExternalCopy(arg).copyInto({ transferIn: true }));
        const actual = await entry.apply(undefined, cloneArgs, { timeout: timeLimitMs, arguments: { reference: false } });
        const plain = actual === undefined ? null : actual;
        results.push({
          ...RESULT_SHAPE,
          testId: test.id,
          isSample: Boolean(test.isSample),
          input: test.input,
          expected: test.expectedOutput,
          actual: plain,
          output: plain === null ? 'null' : JSON.stringify(plain),
          passed: looseEquals(test.expectedOutput, plain),
          durationMs: Date.now() - startedAt,
        });
      } catch (error) {
        results.push({
          ...RESULT_SHAPE,
          testId: test.id,
          isSample: Boolean(test.isSample),
          input: test.input,
          expected: test.expectedOutput,
          error: error.message ?? 'runtime error',
          timedOut: /timed out/i.test(String(error.message)),
          durationMs: Date.now() - startedAt,
        });
      }
    }

    const logs = await context.global.get('__logs').catch(() => []);
    return {
      status: results.every((result) => result.error && !result.passed) ? 'ERROR' : 'OK',
      compileOutput: null,
      logs: Array.isArray(logs) ? logs : [],
      results,
      passedCount: results.filter((result) => result.passed).length,
      totalCount: results.length,
      memoryIsolatedMb: memoryLimitMb,
    };
  } catch (error) {
    logger.error('javascript sandbox failure', { error: error.message });
    return {
      status: 'ERROR',
      compileOutput: error.message,
      logs: [],
      results: tests.map((test) => ({ ...RESULT_SHAPE, testId: test.id, error: error.message })),
      passedCount: 0,
      totalCount: tests.length,
    };
  } finally {
    isolate.dispose();
  }
}

const LANGUAGE_ADAPTERS = {
  python: { command: 'python3', args: (file) => [file], write: (code) => ({ name: 'solution.py', code }) },
  ruby: { command: 'ruby', args: (file) => [file], write: (code) => ({ name: 'solution.rb', code }) },
  php: { command: 'php', args: (file) => [file], write: (code) => ({ name: 'solution.php', code }) },
  go: { command: 'go', args: (dir) => ['run', dir], write: (code) => ({ name: 'main.go', code }) },
  c: { command: 'gcc', compile: (dir) => ({ binary: 'solution', args: ['-x', 'c', `${dir}/solution.c`, '-o', 'solution'] }), write: (code) => ({ name: 'solution.c', code }) },
  cpp: { command: 'g++', compile: (dir) => ({ binary: 'solution', args: ['-x', 'c++', `${dir}/solution.cpp`, '-o', 'solution'] }), write: (code) => ({ name: 'solution.cpp', code }) },
  java: { command: 'javac', compile: (dir) => ({ binary: 'Main', args: [`${dir}/Main.java`], run: { command: 'java', args: ['-cp', dir, 'Main'] } }), write: (code) => ({ name: 'Main.java', code }) },
  typescript: { command: 'npx', args: (dir) => ['ts-node', '--transpile-only', `${dir}/solution.ts`], write: (code) => ({ name: 'solution.ts', code }) },
};

/**
 * Run a non-JavaScript submission. stdout of each execution is compared
 * line-by-line with `expectedOutput`. Returns `unsupported` when the toolchain
 * is missing so callers can route the answer to manual grading.
 */
async function runWithRuntime(language, code, testCases = [], options = {}) {
  const adapter = LANGUAGE_ADAPTERS[language];
  if (!adapter) return unsupported(`no adapter for language "${language}"`);
  if (runnerDisabled()) return unsupported('code runner disabled by configuration');

  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `exam-run-${language}-`));
  const timeLimitMs = Math.min(Number(options.timeLimitMs ?? env.CODE_EXECUTION_TIMEOUT_MS), env.CODE_EXECUTION_TIMEOUT_MS);
  const entryFunction = options.entryFunction ?? 'solution';
  const tests = testCases.slice(0, env.CODE_EXECUTION_MAX_TESTS);

  try {
    const file = adapter.write(code);
    const sourcePath = path.join(workDir, file.name);
    await fs.promises.writeFile(sourcePath, prependHarness(language, file.code, entryFunction), 'utf8');

    let runSpec = { command: adapter.command, args: (adapter.args ?? ((dir) => [dir]))(sourcePath) };

    if (adapter.compile) {
      const compiled = adapter.compile(workDir);
      const compile = await spawnProcess(compiled.command ?? adapter.command, compiled.args, { cwd: workDir, timeoutMs: timeLimitMs });
      if (compile.code !== 0) {
        return {
          status: 'COMPILE_ERROR',
          compileOutput: compile.stderr || compile.stdout,
          logs: [],
          results: tests.map((test) => ({ ...RESULT_SHAPE, testId: test.id, error: 'COMPILE_ERROR' })),
          passedCount: 0,
          totalCount: tests.length,
        };
      }
      runSpec = compiled.run ?? { command: `./${compiled.binary}`, args: [] };
    }

    const results = [];
    for (const test of tests) {
      const input = typeof test.input === 'string' ? test.input : JSON.stringify(test.input ?? '');
      const startedAt = Date.now();
      const run = await spawnProcess(runSpec.command, runSpec.args, {
        cwd: workDir,
        timeoutMs: timeLimitMs,
        stdin: `${input}\n`,
        env: { PATH: process.env.PATH },
      });
      const actual = run.stdout.trim();
      const expected = String(test.expectedOutput ?? '').trim();
      results.push({
        ...RESULT_SHAPE,
        testId: test.id,
        isSample: Boolean(test.isSample),
        input: test.input,
        expected,
        actual,
        output: actual,
        error: run.timedOut ? 'TIME_LIMIT_EXCEEDED' : run.code !== 0 ? (run.stderr || 'process exited non-zero') : null,
        timedOut: Boolean(run.timedOut),
        passed: !run.timedOut && run.code === 0 && compareStdout(expected, actual),
        durationMs: Date.now() - startedAt,
      });
    }

    return {
      status: results.some((result) => result.error && result.error !== 'TIME_LIMIT_EXCEEDED') && results.every((result) => result.error) ? 'ERROR' : 'OK',
      compileOutput: null,
      logs: results.map((result) => result.output).filter(Boolean),
      results,
      passedCount: results.filter((result) => result.passed).length,
      totalCount: results.length,
    };
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Language-neutral harness: coding answers are graded by test case, so for the
 * stdin/stdout languages we simply run the submitted program. The harness only
 * adds a tiny shim where the language needs an explicit entry point.
 */
function prependHarness(language, code, entryFunction) {
  if (language === 'java' && !code.includes('class Main')) {
    return `public class Main {\n  public static void main(String[] args) {\n    System.out.println(new ${entryFunction.charAt(0).toUpperCase()}${entryFunction.slice(1)}().run());\n  }\n}\n`;
  }
  if (language === 'go' && !code.includes('func main')) {
    return `package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println(${entryFunction}())\n}\n`;
  }
  if (language === 'python' && !code.includes('__main__')) {
    return `${code}\n\nif __name__ == "__main__":\n    import json, sys\n    _args = [json.loads(line) if line.strip().startswith(("[", "{")) else (int(line) if line.strip().lstrip("-").isdigit() else line.strip()) for line in sys.stdin]\n    print(${entryFunction}(*_args) if _args else ${entryFunction}())\n`;
  }
  return code;
}

function compareStdout(expected, actual) {
  if (expected === actual) return true;
  const expectedLines = expected.split('\n').map((line) => line.trim()).filter(Boolean);
  const actualLines = actual.split('\n').map((line) => line.trim()).filter(Boolean);
  if (expectedLines.length !== actualLines.length) return false;
  return expectedLines.every((line, index) => line === actualLines[index]);
}

function spawnProcess(command, args = [], { cwd, timeoutMs = 10_000, stdin, env: childEnv } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
    child = spawn(command, args, {
      cwd,
      // A deliberately minimal environment: the submission must not inherit
      // cloud credentials, database URLs or signing secrets from the API host.
      env: { PATH: process.env.PATH ?? process.env.Path ?? '', ...(childEnv ?? {}) },
      shell: false,
      windowsHide: true,
    });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: error.message, timedOut: false });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 1_000_000) child.kill('SIGKILL');
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: error.code === 'ENOENT' ? `RUNTIME_NOT_AVAILABLE: ${command}` : error.message, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });

    if (stdin !== undefined) child.stdin?.write(stdin);
    child.stdin?.end();
  });
}

function unsupported(reason) {
  logger.warn('code execution unavailable', { reason });
  return { status: 'UNSUPPORTED', reason, compileOutput: null, logs: [], results: [], passedCount: 0, totalCount: 0 };
}

/** Dispatch on language; used directly by the "run sample tests" endpoint. */
async function runCode({ language = 'javascript', code = '', testCases = [], entryFunction = 'solution', timeLimitMs, memoryLimitMb, includeHidden = true }) {
  if (!code.trim()) {
    return { status: 'ERROR', compileOutput: null, logs: [], results: [], passedCount: 0, totalCount: testCases.length, reason: 'empty submission' };
  }
  const tests = includeHidden ? testCases : testCases.filter((test) => test.isSample);
  if (language === 'javascript') {
    return runJavaScript(code, tests, { entryFunction, timeLimitMs, memoryLimitMb });
  }
  return runWithRuntime(language, code, tests, { entryFunction, timeLimitMs, memoryLimitMb });
}

/** Turn an execution report into a 0..1 grading ratio. */
function scoreFromRun(run, scoringRule = 'PASSED_TEST_PERCENT', hiddenTestCount = 0) {
  if (!run || run.status === 'UNSUPPORTED') return null;
  const total = (run.totalCount || run.results?.length || 0) + Number(hiddenTestCount || 0);
  if (!total) return 0;
  const passed = run.passedCount ?? 0;
  if (scoringRule === 'ALL_TESTS') return passed === total ? 1 : 0;
  return Math.min(1, passed / total);
}

module.exports = {
  LANGUAGE_ADAPTERS,
  looseEquals,
  runCode,
  runJavaScript,
  runWithRuntime,
  scoreFromRun,
  toArguments,
};
