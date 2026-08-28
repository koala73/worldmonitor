import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv();
});

test('custom API Sentry transport is disabled under node:test even with a DSN', async (t) => {
  if (!process.env.NODE_TEST_CONTEXT) {
    t.skip('NODE_TEST_CONTEXT is not set by this test runner mode');
    return;
  }

  process.env.VITE_SENTRY_DSN = 'https://public@example.ingest.sentry.io/12345';

  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(null, { status: 200 });
  };

  const { makeCaptureSilentError } = await import(`./_sentry-common.js?test=${Date.now()}-${Math.random()}`);
  const captureSilentError = makeCaptureSilentError({
    runtime: 'edge',
    platform: 'javascript',
    logPrefix: '[sentry-test]',
  });

  await captureSilentError(new Error('test-only failure'));

  assert.equal(fetchCalls, 0);
});

test('custom API Sentry transport can be exercised by clearing NODE_TEST_CONTEXT', async () => {
  delete process.env.NODE_TEST_CONTEXT;
  process.env.VITE_SENTRY_DSN = 'https://public@example.ingest.sentry.io/12345';

  const fetchCalls = [];
  globalThis.fetch = async (input, init) => {
    fetchCalls.push({ input, init });
    return new Response(null, { status: 200 });
  };

  const { makeCaptureSilentError } = await import(`./_sentry-common.js?test=${Date.now()}-${Math.random()}`);
  const captureSilentError = makeCaptureSilentError({
    runtime: 'edge',
    platform: 'javascript',
    logPrefix: '[sentry-test]',
  });

  await captureSilentError(new Error('test-only failure'));

  assert.equal(fetchCalls.length, 1);
  const [{ input, init }] = fetchCalls;
  assert.equal(String(input), 'https://example.ingest.sentry.io/api/12345/envelope/');
  assert.equal(init?.headers?.['X-Sentry-Auth'], 'Sentry sentry_version=7, sentry_key=public');
});

// Regression: the edge/serverless bundles are minified, so a custom error
// class's `constructor.name` is a mangled identifier that changes on every
// build. Production proof (2026-08-21, WORLDMONITOR-Y2): `RpcValidationError`
// — which sets `this.name = 'RpcValidationError'` — reported to Sentry as
// exception type `At`, giving the issue the title `At: get-country-risk HTTP
// 400`. Any Sentry search, alert, or saved query keyed on `error.type` stops
// matching the moment the mangled name shifts.
//
// `err.name` is the value the class sets explicitly and is minification-proof;
// `api/mcp/error-fingerprint.ts` already prefers it. The envelope builder must
// agree.
test('envelope exception type prefers err.name over the minifiable constructor name', async () => {
  delete process.env.NODE_TEST_CONTEXT;
  process.env.VITE_SENTRY_DSN = 'https://public@example.ingest.sentry.io/12345';

  const fetchCalls = [];
  globalThis.fetch = async (input, init) => {
    fetchCalls.push({ input, init });
    return new Response(null, { status: 200 });
  };

  const { makeCaptureSilentError } = await import(`./_sentry-common.js?test=${Date.now()}-${Math.random()}`);
  const captureSilentError = makeCaptureSilentError({
    runtime: 'edge',
    platform: 'javascript',
    logPrefix: '[sentry-test]',
  });

  // `At` stands in for the mangled class identifier the minifier emits.
  class At extends Error {
    constructor(label) {
      super(`${label} HTTP 400`);
      this.name = 'RpcValidationError';
    }
  }

  await captureSilentError(new At('get-country-risk'));

  assert.equal(fetchCalls.length, 1);
  const body = fetchCalls[0].init.body;
  const event = JSON.parse(String(body).split('\n')[2]);
  const [value] = event.exception.values;
  assert.equal(
    value.type,
    'RpcValidationError',
    'exception type must come from err.name, which survives minification',
  );
  assert.equal(value.value, 'get-country-risk HTTP 400');
});

// A thrown value with no useful `name` must still report a type rather than an
// empty string: an anonymous subclass, or an Error whose name was blanked.
test('envelope exception type falls back when err.name is empty', async () => {
  delete process.env.NODE_TEST_CONTEXT;
  process.env.VITE_SENTRY_DSN = 'https://public@example.ingest.sentry.io/12345';

  const fetchCalls = [];
  globalThis.fetch = async (input, init) => {
    fetchCalls.push({ input, init });
    return new Response(null, { status: 200 });
  };

  const { makeCaptureSilentError } = await import(`./_sentry-common.js?test=${Date.now()}-${Math.random()}`);
  const captureSilentError = makeCaptureSilentError({
    runtime: 'edge',
    platform: 'javascript',
    logPrefix: '[sentry-test]',
  });

  class BlankNamed extends Error {}
  const blank = new BlankNamed('no name set');
  blank.name = '';

  await captureSilentError(blank);

  const event = JSON.parse(String(fetchCalls[0].init.body).split('\n')[2]);
  assert.equal(event.exception.values[0].type, 'BlankNamed');
});

// Native errors already agree between `name` and `constructor.name`; the
// change must not perturb them. DOMException is the one that actually shows up
// in production (WORLDMONITOR-Z9/-ZM/-R2, AbortSignal.timeout on edge fetches).
test('envelope exception type is unchanged for native error classes', async () => {
  delete process.env.NODE_TEST_CONTEXT;
  process.env.VITE_SENTRY_DSN = 'https://public@example.ingest.sentry.io/12345';

  const fetchCalls = [];
  globalThis.fetch = async (input, init) => {
    fetchCalls.push({ input, init });
    return new Response(null, { status: 200 });
  };

  const { makeCaptureSilentError } = await import(`./_sentry-common.js?test=${Date.now()}-${Math.random()}`);
  const captureSilentError = makeCaptureSilentError({
    runtime: 'edge',
    platform: 'javascript',
    logPrefix: '[sentry-test]',
  });

  await captureSilentError(new TypeError('bad input'));
  await captureSilentError(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));

  const types = fetchCalls.map(
    (call) => JSON.parse(String(call.init.body).split('\n')[2]).exception.values[0].type,
  );
  // DOMException carries its *reason* in `name` (TimeoutError), which is
  // strictly more informative than the constructor name it replaces.
  assert.deepEqual(types, ['TypeError', 'TimeoutError']);
});

// The `err.name` preference above is only an improvement while every custom
// error class actually sets `this.name`. A subclass that omits it inherits
// `Error.prototype.name === 'Error'` and silently reports the generic type —
// the mangled-but-specific identifier it used to send is gone. All 19 classes
// satisfy this today; this guard keeps the next one honest.
test('every custom Error subclass sets this.name explicitly', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { dirname, join, relative, resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

  // Walk in-process rather than shelling out to `rg`: ripgrep is not a declared
  // dependency of this repo and nothing else in the suite requires it, so an
  // ENOENT on a runner without it would be a false red rather than a finding.
  const sourceFiles = function* walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) yield* walk(full);
      else if (/\.(ts|js)$/.test(entry.name) && !/\.test\.|\.d\.ts$/.test(entry.name)) yield full;
    }
  };

  // Body of a class declaration: from its opening line to the matching close.
  // Brace-counting rather than a fixed line window, so a long constructor
  // (or a class whose `this.name` sits below one) can't slip past.
  const classBody = (source, startLine) => {
    const lines = source.split('\n');
    let depth = 0;
    let started = false;
    const body = [];
    for (let i = startLine - 1; i < lines.length; i += 1) {
      body.push(lines[i]);
      for (const ch of lines[i]) {
        if (ch === '{') { depth += 1; started = true; } else if (ch === '}') depth -= 1;
      }
      if (started && depth <= 0) break;
    }
    return body.join('\n');
  };

  const setsName = (body) => /\bthis\.name\s*=\s*['"`]/.test(body);

  // Positive control: the detector must actually reject a class that omits
  // `this.name`, otherwise a broken `setsName` would report a clean sweep.
  assert.equal(
    setsName('class Nameless extends Error {\n  constructor(m) { super(m); }\n}'),
    false,
    'detector is vacuous — it accepts a class that never assigns this.name',
  );
  assert.equal(
    setsName("class Named extends Error {\n  constructor(m) { super(m); this.name = 'Named'; }\n}"),
    true,
    'detector is inverted — it rejects a class that does assign this.name',
  );

  const offenders = [];
  let checked = 0;
  const declaration = /class\s+(\w+Error)\s+extends\s+Error\b/;
  for (const dir of ['api', 'server', 'shared']) {
    for (const file of sourceFiles(join(repoRoot, dir))) {
      const source = readFileSync(file, 'utf-8');
      if (!declaration.test(source)) continue;
      source.split('\n').forEach((text, index) => {
        const className = text.match(declaration)?.[1];
        if (!className) return;
        checked += 1;
        if (!setsName(classBody(source, index + 1))) {
          offenders.push(`${className} (${relative(repoRoot, file)}:${index + 1})`);
        }
      });
    }
  }

  assert.ok(checked >= 19, `expected to scan the known custom Error classes, scanned ${checked}`);
  assert.deepEqual(
    offenders,
    [],
    'these Error subclasses report type "Error" to Sentry — set this.name in the constructor',
  );
});
