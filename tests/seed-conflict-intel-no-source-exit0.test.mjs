// Regression tests for #5256: seed-conflict-intel crash-looped forever when it had
// NO usable conflict source.
//
// The chain (verified in prod 2026-07-13, deployment 31cefd91): ACLED has no
// credentials configured -> the seeder takes its long-standing auxiliary-only path
// (#1651/#2288, whose own comment says it exists to "exit 0 rather than crashing every
// cron tick") -> GDELT, the only fallback, is 429ing GLOBALLY (reproduced off-Railway)
// so it yields nothing -> declareRecords returns 0 -> contract RETRY -> the last-good
// keys expired long ago so extendExistingTtl no-ops -> #5258's guard exits 1.
//
// That guard is right in general (a zero-yield run whose last-good is gone IS a dead
// feed), but it assumes a later tick can restore data. With no source configured, no
// tick ever can: it crash-looped every ~15min forever, firing "Deploy Crashed!" each
// time while /api/health ALREADY reported acledIntel EMPTY/crit. The crash added no
// information over the health check — only alert fatigue.
//
// Fix: a seeder may declare `sourceUnavailable` on its payload. runSeed then publishes
// NOTHING (an empty envelope would overwrite last-good the moment the source blips) and
// exits 0. The data alarm stays where it belongs — /api/health.
//
// These tests lock BOTH directions: the new exit-0 escape AND that a plain zero-yield
// run (no sourceUnavailable) still exits 1, so #5258 is not weakened.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { runSeed, redactProxyCredentials, curlFetch } from '../scripts/_seed-utils.mjs';
import { fetchAll, fetchGdeltConflictEvents, CONFLICT_COUNTRIES } from '../scripts/seed-conflict-intel.mjs';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_EXIT = process.exit;
const ORIGINAL_ENV = {
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  ACLED_EMAIL: process.env.ACLED_EMAIL,
  ACLED_PASSWORD: process.env.ACLED_PASSWORD,
  ACLED_ACCESS_TOKEN: process.env.ACLED_ACCESS_TOKEN,
};

let recordedCalls;
let expireResult;

beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.example.com';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
  recordedCalls = [];
  expireResult = 0; // every key already expired — the prod state that triggered exit 1

  globalThis.fetch = async (url, opts = {}) => {
    const body = opts?.body ? (() => { try { return JSON.parse(opts.body); } catch { return opts.body; } })() : null;
    recordedCalls.push({ url: String(url), method: opts?.method || 'GET', body });
    if (Array.isArray(body) && Array.isArray(body[0])) {
      return new Response(JSON.stringify(body.map(() => ({ result: expireResult }))), { status: 200 });
    }
    return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
  };

  process.exit = (code) => {
    const e = new Error(`__test_exit__:${code}`);
    e.exitCode = code;
    throw e;
  };
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  process.exit = ORIGINAL_EXIT;
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    if (v == null) delete process.env[k];
    else process.env[k] = v;
  }
});

async function runWithExitTrap(fn) {
  try {
    await fn();
    return null;
  } catch (err) {
    if (!String(err.message).startsWith('__test_exit__:')) throw err;
    return err.exitCode;
  }
}

// Did runSeed write the canonical payload key? (An empty publish would clobber last-good.)
function publishedCanonicalKey(key) {
  return recordedCalls.some(c =>
    Array.isArray(c.body) && c.body[0] === 'SET' && c.body[1] === key);
}

function runSeedReturning(payload, resource) {
  return runWithExitTrap(() =>
    runSeed('test', resource, `test:${resource}:v1`, async () => payload, {
      validateFn: (d) => Array.isArray(d?.events),
      ttlSeconds: 3600,
      sourceVersion: 'test-v1',
      schemaVersion: 1,
      maxStaleMin: 120,
      declareRecords: (d) => d.events.length,
    }),
  );
}

// ─── the fix ───

test('sourceUnavailable + expired last-good: exits 0 instead of crash-looping', async () => {
  const exitCode = await runSeedReturning({ events: [], sourceUnavailable: true }, 'no-source');
  assert.equal(exitCode, 0, 'a seeder with no usable source must not crash — /api/health carries the EMPTY alarm');
});

test('sourceUnavailable never publishes an empty envelope over last-good', async () => {
  await runSeedReturning({ events: [], sourceUnavailable: true }, 'no-source-nopublish');
  assert.equal(
    publishedCanonicalKey('test:no-source-nopublish:v1'), false,
    'publishing events:[] would wipe real data the next time the source merely blips',
  );
});

test('sourceUnavailable while last-good is STILL ALIVE: exits 0 and still says NO SOURCE', async () => {
  // PR#5290 review (Greptile P2): the outcome is exit 0 whether or not last-good survived,
  // but the REASON must be visible on every tick. Falling through to the generic
  // "TTL extended, bundle will retry next cycle" message would hide the no-source condition
  // for however many cycles the keys survive — an operator would only learn the feed had no
  // source once it had already gone EMPTY.
  expireResult = 1; // every key still present — TTL extension succeeds

  const lines = [];
  const [origLog, origWarn] = [console.log, console.warn];
  console.log = (...a) => lines.push(a.join(' '));
  console.warn = (...a) => lines.push(a.join(' '));
  let exitCode;
  try {
    exitCode = await runSeedReturning({ events: [], sourceUnavailable: true }, 'no-source-alive');
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }
  const out = lines.join('\n');

  assert.equal(exitCode, 0);
  assert.match(out, /NO SOURCE/, 'the no-source reason must be logged even while last-good is alive');
  assert.match(out, /=== Done \(\d+ms, NO SOURCE\) ===/, 'terminal marker must name the real outcome');
  assert.doesNotMatch(
    out, /bundle will retry next cycle/,
    'the generic RETRY message implies a source may come back — misleading when there is none',
  );
});

// ─── #5258 must NOT be weakened ───

test('plain zero-yield with expired last-good STILL exits 1 (#5258 intact)', async () => {
  const exitCode = await runSeedReturning({ events: [] }, 'dead-feed');
  assert.equal(exitCode, 1, 'a zero-yield run that did NOT declare sourceUnavailable is still a dead feed');
});

// ─── seeder wiring: the no-creds + GDELT-down path must declare sourceUnavailable ───

test('fetchAll: no ACLED creds + GDELT fallback down -> declares sourceUnavailable', async () => {
  delete process.env.ACLED_EMAIL;
  delete process.env.ACLED_PASSWORD;
  delete process.env.ACLED_ACCESS_TOKEN;

  // Aux feeds (HAPI/PizzINT) 429 like prod; the GDELT fallback is injected because its
  // proxy path shells out to curl and would otherwise escape the stub and hit the network.
  globalThis.fetch = async () => new Response('rate limited', { status: 429 });

  const data = await fetchAll({
    fetchGdeltFallback: async () => { throw new Error('GDELT coverage below floor: 0/20; bulk fallback failed: HTTP 429'); },
  });
  assert.equal(Array.isArray(data.events), true);
  assert.equal(data.events.length, 0);
  assert.equal(
    data.sourceUnavailable, true,
    'an errored fallback is NOT a legitimate zero — it must be flagged so runSeed skips publish and exits 0',
  );
});

test('fetchAll: no ACLED creds but GDELT fallback WORKS -> not sourceUnavailable', async () => {
  delete process.env.ACLED_EMAIL;
  delete process.env.ACLED_PASSWORD;
  delete process.env.ACLED_ACCESS_TOKEN;
  globalThis.fetch = async () => new Response('rate limited', { status: 429 });

  const data = await fetchAll({
    fetchGdeltFallback: async () => ({ events: [{ country: 'UA', event_date: '2026-07-13' }], source: 'gdelt' }),
  });
  assert.equal(data.events.length, 1);
  assert.notEqual(
    data.sourceUnavailable, true,
    'a working fallback must publish normally — the exit-0 escape must not swallow real data',
  );
});

// ─── SECURITY: proxy credentials must never reach the logs ───

test('redactProxyCredentials scrubs inline proxy user:pass from surfaced errors', () => {
  // The exact shape Node's execFileSync produced on a curl-level failure: the whole argv,
  // proxy credentials included. This was written to Railway logs on every GDELT proxy
  // failure during the 2026-07-13 429 storm.
  const leaked = 'Command failed: curl -sS --compressed --max-time 15 -L '
    + '-x http://spp5user:s3cr3tPassw0rd@us.decodo.com:10001 '
    + '-H Accept: application/json https://api.gdeltproject.org/api/v2/doc/doc?query=x';

  const safe = redactProxyCredentials(leaked);

  assert.equal(safe.includes('s3cr3tPassw0rd'), false, 'password must not survive redaction');
  assert.equal(safe.includes('spp5user'), false, 'username must not survive redaction');
  assert.match(safe, /http:\/\/\*\*\*:\*\*\*@us\.decodo\.com:10001/, 'host:port kept — it is the useful diagnostic');
  assert.match(safe, /api\.gdeltproject\.org/, 'target URL must survive — it is not a secret');
});

test('redactProxyCredentials leaves credential-free text untouched', () => {
  const clean = 'curl: (35) OpenSSL SSL_connect: SSL_ERROR_SYSCALL in connection to api.gdeltproject.org:443';
  assert.equal(redactProxyCredentials(clean), clean);
});

// The helper tests above are NOT enough: the scrubbing that actually protects us lives in a
// catch inside curlFetch. PR#5290 review caught that reverting that catch to a bare
// `throw err` left the whole suite green — the security fix was guarded by nothing. These
// drive the real branch through curlFetch's `exec` seam.

const PROXY_AUTH = 'spp5user:s3cr3tPassw0rd@us.decodo.com:10001';

// Exactly what Node builds when the curl BINARY exits non-zero: the entire argv in .message,
// curl's diagnostic in .stderr, and .status set to curl's EXIT CODE (not an HTTP status).
function execFileSyncFailure({ stderr }) {
  return () => {
    throw Object.assign(
      new Error(
        'Command failed: curl -sS --compressed --max-time 15 -L '
        + `-x http://${PROXY_AUTH} -H Accept: application/json `
        + 'https://api.gdeltproject.org/api/v2/doc/doc?query=x',
      ),
      { status: 35, stderr, stdout: '' },
    );
  };
}

function curlFetchExpectingThrow(exec) {
  try {
    curlFetch('https://api.gdeltproject.org/api/v2/doc/doc?query=x', PROXY_AUTH, {}, { exec });
  } catch (err) {
    return err;
  }
  throw new Error('curlFetch should have thrown');
}

test('curlFetch: a curl-level failure never leaks proxy credentials into the error', () => {
  const err = curlFetchExpectingThrow(execFileSyncFailure({
    stderr: 'curl: (35) OpenSSL SSL_connect: SSL_ERROR_SYSCALL in connection to api.gdeltproject.org:443\n',
  }));

  assert.equal(err.message.includes('s3cr3tPassw0rd'), false, 'password must never reach the logs');
  assert.equal(err.message.includes('spp5user'), false, 'username must never reach the logs');
  assert.match(err.message, /^curl failed: /);
  assert.equal(err.curlFailed, true);
  assert.match(err.message, /SSL_ERROR_SYSCALL/, "curl's own diagnostic is kept — it is the useful part");
});

test('curlFetch: credentials are scrubbed even when curl produced no stderr (message fallback)', () => {
  // The fallback path interpolates err.message — the argv-bearing string itself. If it is
  // not redacted on the way through, this is where the credentials escape.
  const err = curlFetchExpectingThrow(execFileSyncFailure({ stderr: '' }));

  assert.equal(err.message.includes('s3cr3tPassw0rd'), false);
  assert.equal(err.message.includes('spp5user'), false);
  assert.match(err.message, /\*\*\*:\*\*\*@us\.decodo\.com/, 'redacted, but the proxy host is still named');
});

test('curlFetch: a curl-level failure must NOT carry .status (it is an exit code, not HTTP)', () => {
  // _gdelt-fetch.mjs discriminates "upstream returned non-2xx" from "network/curl failure"
  // purely on `typeof status === 'number'`. execFileSync sets .status to curl's EXIT code
  // (35 here), so leaking it through made the retry logic read exit-35 as an HTTP status,
  // miss RETRYABLE_STATUSES, and refuse to retry the proxy — killing the Decodo IP rotation
  // on exactly the TLS tears it exists to survive.
  const err = curlFetchExpectingThrow(execFileSyncFailure({ stderr: 'curl: (35) SSL_ERROR_SYSCALL\n' }));
  assert.equal(err.status, undefined, 'curl exit code must not masquerade as an HTTP status');
});

test('curlFetch: a genuine non-2xx HTTP response still carries .status (contract intact)', () => {
  // The other half of the discriminator: when curl SUCCEEDS but the upstream returns 429,
  // .status must still be set, or the retry logic loses the HTTP case entirely.
  const err = curlFetchExpectingThrow(() => 'rate limited\n429');
  assert.equal(err.status, 429);
  assert.equal(err.curlFailed, undefined, 'an HTTP error is not a curl-level failure');
});

// ─── GDELT 429-storm: back off instead of hammering ───

test('GDELT 429 storm: sweep aborts after the first all-throttled batch', async () => {
  const attempted = [];
  const result = await fetchGdeltConflictEvents({
    fetchCountryEvents: async (cc) => {
      attempted.push(cc);
      return { country: cc, ok: false, events: [], error: 'GDELT retries exhausted (last direct: HTTP 429) (last proxy: HTTP 429)' };
    },
    fetchBulkEvents: async () => { throw new Error('bulk export also throttled'); },
    pace: async () => {},
    now: () => 0,
    deadlineAt: 10_000_000,
    loadPreviousSnapshot: async () => null,
  }).catch((e) => e);

  assert.ok(result instanceof Error, 'a fully throttled sweep still fails (no data)');
  assert.ok(
    attempted.length <= 4,
    `must stop after the first all-429 batch, not grind the limiter: attempted ${attempted.length}/${CONFLICT_COUNTRIES.length}`,
  );
});

test('GDELT storm: aborts on a MIXED throttled batch (429 + SSL tear), not just a uniform one', async () => {
  // PR#5290 review (Greptile P2): a real storm is rarely uniformly 429 — under load GDELT
  // also times out and tears TLS. Requiring EVERY result to be a 429 missed that and ground
  // on for a second batch. The signal is: whole batch failed, nothing succeeded anywhere,
  // and at least one failure is an explicit rate-limit.
  const attempted = [];
  const errors = [
    'GDELT retries exhausted (last direct: HTTP 429) (last proxy: HTTP 429)',
    'GDELT retries exhausted (last direct: HTTP 429) (last proxy: HTTP 429)',
    'GDELT retries exhausted (last direct: HTTP 429) (last proxy: HTTP 429)',
    'curl failed: curl: (35) OpenSSL SSL_connect: SSL_ERROR_SYSCALL', // no 429 in this one
  ];
  const result = await fetchGdeltConflictEvents({
    fetchCountryEvents: async (cc) => {
      const error = errors[attempted.length % errors.length];
      attempted.push(cc);
      return { country: cc, ok: false, events: [], error };
    },
    fetchBulkEvents: async () => { throw new Error('bulk export also throttled'); },
    pace: async () => {},
    now: () => 0,
    deadlineAt: 10_000_000,
    loadPreviousSnapshot: async () => null,
  }).catch((e) => e);

  assert.ok(result instanceof Error);
  assert.ok(
    attempted.length <= 4,
    `a mixed 429/SSL storm must abort on the first batch too: attempted ${attempted.length}/${CONFLICT_COUNTRIES.length}`,
  );
});

test('GDELT storm abort does NOT fire on an all-failed batch with NO rate-limit (SSL/timeout only)', async () => {
  // PR#5290 review: without this, deleting `anyRateLimited` from the abort condition still
  // passed every test. It is the clause that distinguishes "we are being throttled — backing
  // off helps" from "transient per-country network failures — backing off just gives up
  // early". A pure SSL/timeout wipeout must keep sweeping and let floorUnreachable decide.
  const attempted = [];
  await fetchGdeltConflictEvents({
    fetchCountryEvents: async (cc) => {
      attempted.push(cc);
      return {
        country: cc, ok: false, events: [],
        error: 'curl failed: curl: (35) OpenSSL SSL_connect: SSL_ERROR_SYSCALL', // no 429 anywhere
      };
    },
    fetchBulkEvents: async () => { throw new Error('bulk unused'); },
    pace: async () => {},
    now: () => 0,
    deadlineAt: 10_000_000,
    loadPreviousSnapshot: async () => null,
  }).catch(() => {});

  assert.ok(
    attempted.length > 4,
    `a non-throttled wipeout must not be mislabelled a rate-limit storm and cut short: attempted ${attempted.length}`,
  );
});

test('GDELT storm abort does NOT fire when a country in the batch succeeds', async () => {
  // The abort must never cut short a sweep that is actually working. One success in the
  // batch means we are not being uniformly throttled — keep going.
  const attempted = [];
  await fetchGdeltConflictEvents({
    fetchCountryEvents: async (cc) => {
      attempted.push(cc);
      // First country of every batch succeeds; the rest are throttled.
      if (attempted.length % 4 === 1) return { country: cc, ok: true, events: [{ country: cc, event_date: '2026-07-13' }] };
      return { country: cc, ok: false, events: [], error: 'HTTP 429' };
    },
    fetchBulkEvents: async () => { throw new Error('bulk unused'); },
    pace: async () => {},
    now: () => 0,
    deadlineAt: 10_000_000,
    loadPreviousSnapshot: async () => null,
  }).catch(() => {});

  assert.ok(
    attempted.length > 4,
    'a batch containing a success must not trip the storm abort',
  );
});
