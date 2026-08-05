// Regression guard for #6241 — the military-flights seeder must stop re-firing
// `/states/all` while OpenSky's daily credit budget is exhausted.
//
// Production has seen `X-Rate-Limit-Retry-After-Seconds: 22688` (~6.3h). The
// seeder runs as a FRESH PROCESS on every Railway `*/5` tick, so a module-level
// cooldown cannot survive the window — the deadline has to live in Redis or the
// seeder issues ~76 doomed authenticated requests per outage.
//
// The credit cost of a 429 is zero (the budget is already gone), so none of this
// is observable from the published payload or from a credit-spend assertion —
// which is why #6222's budget suite passes with this bug fully present. These
// tests drive `fetchAllStates()` against a fake Upstash REST endpoint and count
// the OUTBOUND requests a second, freshly-imported module instance makes.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

process.env.OPENSKY_CLIENT_ID = 'test-client';
process.env.OPENSKY_CLIENT_SECRET = 'test-secret';
process.env.WINGBITS_API_KEY = 'test-wingbits';
process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-redis-token';
delete process.env.OPENSKY_PROXY_AUTH;
delete process.env.PROXY_URL;

const OPENSKY_HOST = 'opensky-network.org';
const TOKEN_HOST = 'auth.opensky-network.org';
const WINGBITS_HOST = 'customer-api.wingbits.com';
const REDIS_HOST = 'redis.test';
const COOLDOWN_KEY = 'opensky:cooldown-until:v1';

const originalFetch = globalThis.fetch;
const originalLog = console.log;
const originalWarn = console.warn;

let calls;
let redisStore;
let logLines;
let redisReadFails;

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// A state vector is a positional array; index 0 is icao24, 5 lon, 6 lat, 8 onGround.
function state(icao24, callsign, lat, lon) {
  const s = new Array(17).fill(null);
  s[0] = icao24;
  s[1] = callsign;
  s[5] = lon;
  s[6] = lat;
  s[7] = 10000;
  s[8] = false;
  s[9] = 400;
  s[10] = 90;
  return s;
}

// ADF7C8-AFFFFF is the USAF hex range the seeder already recognises, so these
// are admitted on hex alone and the assertions do not depend on callsign rules.
const WINGBITS_ONLY = 'ae1111';
const OPENSKY_ONLY = 'ae2222';

function handleRedis(u, opts) {
  if ((opts.method || 'GET').toUpperCase() === 'POST') {
    const cmd = JSON.parse(opts.body);
    const [verb, key] = cmd;
    if (verb === 'SET') {
      redisStore.set(key, { value: cmd[2], ttl: cmd[3] === 'EX' ? Number(cmd[4]) : null });
      return json({ result: 'OK' });
    }
    if (verb === 'DEL') {
      return json({ result: redisStore.delete(key) ? 1 : 0 });
    }
    return json({ result: null });
  }
  if (redisReadFails === 'http') return new Response('upstream unavailable', { status: 503 });
  // A DNS/socket failure rejects the fetch outright rather than answering 503 —
  // a different code path in the reader, and the one a Redis outage produces.
  if (redisReadFails === 'throw') throw new TypeError('fetch failed');
  const key = decodeURIComponent(u.pathname.replace(/^\/get\//, ''));
  const entry = redisStore.get(key);
  return json({ result: entry ? entry.value : null });
}

function install({
  openSkyStatus = 200,
  retryAfterSeconds = null,
  retryAfterHeader = 'X-Rate-Limit-Retry-After-Seconds',
  tokenStatus = 200,
  tokenRetryAfterSeconds = null,
} = {}) {
  calls = [];
  logLines = [];
  const capture = (sink) => (...args) => { logLines.push(args.join(' ')); sink(...args); };
  console.log = capture(originalLog);
  console.warn = capture(originalWarn);

  globalThis.fetch = async (url, opts = {}) => {
    const raw = typeof url === 'string' ? url : url.url;
    calls.push({ url: raw, method: opts.method || 'GET', headers: opts.headers || {} });
    const u = new URL(raw);

    if (u.host === REDIS_HOST) return handleRedis(u, opts);

    if (u.host === TOKEN_HOST) {
      if (tokenStatus !== 200) {
        const headers = {};
        if (tokenRetryAfterSeconds != null) {
          headers['X-Rate-Limit-Retry-After-Seconds'] = String(tokenRetryAfterSeconds);
        }
        return new Response('Too many requests', { status: tokenStatus, headers });
      }
      return json({ access_token: 'tok', expires_in: 1800 });
    }
    if (u.host === WINGBITS_HOST) {
      return json([
        { alias: 'PACIFIC', data: [
          { h: WINGBITS_ONLY, f: 'RCH999', la: 30, lo: 130, ab: 30000, gs: 450, th: 180, og: false },
        ] },
      ]);
    }
    if (u.host === OPENSKY_HOST) {
      if (openSkyStatus !== 200) {
        const headers = {};
        if (retryAfterSeconds != null) headers[retryAfterHeader] = String(retryAfterSeconds);
        return new Response('Too many requests', { status: openSkyStatus, headers });
      }
      return json({ time: 0, states: [state(OPENSKY_ONLY, 'RCH123', 40, -100)] });
    }
    return json({});
  };
}

const openSkyDataCalls = () => calls.filter((c) => new URL(c.url).host === OPENSKY_HOST);
const openSkyTokenCalls = () => calls.filter((c) => new URL(c.url).host === TOKEN_HOST);
const readCooldownRecord = () => {
  const entry = redisStore.get(COOLDOWN_KEY);
  return entry ? JSON.parse(entry.value) : null;
};

// The cooldown record is scoped to the OpenSky account that earned it, so any
// hand-seeded fixture that must reach the LATER guards has to carry this
// seeder's own fingerprint — otherwise it is rejected as another account's.
const ACCOUNT = createHash('sha256').update('test-client').digest('hex').slice(0, 12);
const seedCooldown = (record, ttl = 60) => {
  redisStore.set(COOLDOWN_KEY, { value: JSON.stringify({ account: ACCOUNT, ...record }), ttl });
};

// A fresh module instance is how this suite models the next cron tick. The
// seeder is a one-shot process, so anything the fix keeps in a module-level
// variable is gone by the time the next tick runs — only Redis survives.
let moduleSeq = 0;
async function freshSeeder() {
  moduleSeq += 1;
  return import(`../scripts/seed-military-flights.mjs?tick=${moduleSeq}`);
}

beforeEach(() => {
  redisStore = new Map();
  redisReadFails = false;
  install();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  console.warn = originalWarn;
});

test('a 429 with a retry-after header persists a cooldown deadline to Redis', async () => {
  const retryAfterSeconds = 22_688; // the value production actually returned
  install({ openSkyStatus: 429, retryAfterSeconds });
  const before = Date.now();
  const seeder = await freshSeeder();
  await seeder.fetchAllStates();

  const record = readCooldownRecord();
  assert.ok(
    record,
    `No \`${COOLDOWN_KEY}\` record after a 429. The seeder is a one-shot process on a */5 cron, ` +
    'so a module-level cooldown cannot survive the outage — the deadline must be persisted (#6241).',
  );
  const expected = before + retryAfterSeconds * 1000;
  assert.ok(
    Math.abs(Number(record.until) - expected) < 60_000,
    `Cooldown deadline ${record.until} does not honour X-Rate-Limit-Retry-After-Seconds=${retryAfterSeconds} ` +
    `(expected ~${expected}). Ignoring the header re-fires ~76 doomed requests across the window (#6241).`,
  );

  const ttl = redisStore.get(COOLDOWN_KEY)?.ttl;
  assert.ok(
    ttl != null && ttl >= retryAfterSeconds,
    `Cooldown key TTL is ${ttl}s but the deadline is ${retryAfterSeconds}s away — the key would ` +
    'expire mid-outage and the seeder would resume hammering (#6241).',
  );
});

test('the next run issues ZERO OpenSky requests while the deadline is in the future', async () => {
  install({ openSkyStatus: 429, retryAfterSeconds: 22_688 });
  await (await freshSeeder()).fetchAllStates();
  assert.ok(readCooldownRecord(), 'precondition: the 429 run must have armed a cooldown');

  // Second tick: a brand-new module instance, so nothing but Redis carries state.
  install();
  const { allStates, fetchSources } = await (await freshSeeder()).fetchAllStates();

  assert.equal(
    openSkyDataCalls().length, 0,
    `The cooled-down run still issued ${openSkyDataCalls().length} OpenSky /states/all request(s). ` +
    'Every one is guaranteed to 429 for the rest of the window — ~76 per outage (#6241).',
  );
  assert.equal(
    openSkyTokenCalls().length, 0,
    'The cooled-down run still fetched an OpenSky bearer token. A token is only ever used for the ' +
    'call being skipped, so acquiring one is pure round-trip cost (#6241).',
  );
  assert.ok(
    allStates.map((s) => s[0]).includes(WINGBITS_ONLY),
    'Wingbits coverage disappeared during the OpenSky cooldown. Skipping OpenSky must degrade to ' +
    'Wingbits-only, never to an empty publish (#6241).',
  );
  // Anchored on the `quota-cooldown:<n>s` shape, not a bare /cooldown/. The
  // in-process token backoff reports the plain string 'cooldown' from
  // getOpenSkyAuthStatus(), so a loose match would accept a run that skipped for
  // an entirely different reason and never consulted the persisted deadline.
  assert.match(
    fetchSources.regions[0]?.authStatus || '',
    /^quota-cooldown:\d+s$/,
    `Expected the GLOBAL region to record a persisted quota cooldown with its remaining seconds, ` +
    `got: ${fetchSources.regions[0]?.authStatus}. A bare 'cooldown' is the in-process auth backoff, ` +
    'which is a different mechanism with a different lifetime (#6241).',
  );
});

test('the skip is logged with the remaining wait', async () => {
  install({ openSkyStatus: 429, retryAfterSeconds: 22_688 });
  await (await freshSeeder()).fetchAllStates();

  install();
  await (await freshSeeder()).fetchAllStates();

  const skipLine = logLines.find((line) => /OpenSky/i.test(line) && /cooldown/i.test(line));
  assert.ok(
    skipLine,
    'The cooled-down run logged nothing about the skip. Quota exhaustion and a provider outage ' +
    `both surface as "no OpenSky states" otherwise. Lines seen:\n${logLines.join('\n')}`,
  );
  assert.match(
    skipLine,
    /\d+\s*h/i,
    `The skip line does not report the remaining wait: "${skipLine}". Without it a 90s blip and a ` +
    '6-hour quota outage read identically in the logs (#6241).',
  );
});

test('the retry-after survives the proxy-enabled branch', async () => {
  // Production runs with OPENSKY_PROXY_AUTH set, which takes a DIFFERENT error
  // path out of fetchOpenSkyAuthenticated than the direct-only tests above. If
  // the header were dropped there, prod would silently arm the 90s fallback
  // instead of the advertised 6.3h — a 250x weaker fix, invisible everywhere else.
  process.env.OPENSKY_PROXY_AUTH = 'http://user:pass@proxy.test:8080';
  try {
    const retryAfterSeconds = 22_688;
    install({ openSkyStatus: 429, retryAfterSeconds });
    const before = Date.now();
    await (await freshSeeder()).fetchAllStates();

    const record = readCooldownRecord();
    assert.ok(record, 'No cooldown record was written on the proxy-enabled path (#6241).');
    assert.ok(
      Math.abs(Number(record.until) - (before + retryAfterSeconds * 1000)) < 60_000,
      `Proxy-enabled path armed a ${Math.round((record.until - before) / 1000)}s cooldown instead of ` +
      `${retryAfterSeconds}s — the retry-after was lost while re-wrapping the direct error (#6241).`,
    );
  } finally {
    delete process.env.OPENSKY_PROXY_AUTH;
  }
});

test('the proxy transport surfaces the rate-limit headers it used to drop', async () => {
  // The link the combiner test below depends on. `proxyFetch` opens raw sockets
  // and never touches globalThis.fetch, but it accepts injectable connectTunnel /
  // requestFn seams — so the REAL transport can be driven with a real 429. Before
  // this, the resolved object carried no headers at all, which made every
  // downstream retry-after assertion true only of a hand-built fixture.
  const require = createRequire(import.meta.url);
  const { proxyFetch } = require('../scripts/_proxy-utils.cjs');
  const { parseRetryAfterSeconds } = await freshSeeder();

  const fakeResponse = new EventEmitter();
  fakeResponse.statusCode = 429;
  fakeResponse.headers = { 'x-rate-limit-retry-after-seconds': '22688' };

  const result = await proxyFetch('https://opensky-network.org/api/states/all', { host: 'p', port: 1 }, {
    connectTunnel: async () => ({ socket: null, destroy: () => {} }),
    requestFn: (_opts, cb) => {
      const req = new EventEmitter();
      req.end = () => {
        cb(fakeResponse);
        fakeResponse.emit('end');
      };
      req.write = () => {};
      return req;
    },
  });

  assert.equal(result.status, 429, 'expected the injected 429 to reach the caller');
  assert.equal(
    parseRetryAfterSeconds(result.headers), 22_688,
    'The proxy transport still drops the rate-limit headers, so a 429 arriving through the tunnel ' +
    'can only ever produce the fallback cooldown instead of the advertised window (#6241).',
  );

  // Second half of the chain: the SAME result object must become an error the
  // cooldown can read. Asserting only on result.headers above would leave
  // proxyFetchJson's own wiring unproven.
  const { proxyResponseError } = await freshSeeder();
  const err = proxyResponseError(result);
  assert.equal(err.status, 429, 'the proxy error must carry the status');
  assert.equal(
    err.retryAfterSeconds, 22_688,
    'proxyFetchJson built the error without reading the tunnel headers, so the advertised window ' +
    'is discarded between the transport and the cooldown (#6241).',
  );
});

test('the combined direct+proxy error keeps the proxy leg 429 metadata', async () => {
  // The other proxy assertion covers the DIRECT-429 short-circuit. This covers
  // the remaining shape: direct fails with something else, the proxy then 429s.
  // The proxyError fixture below is now a shape production can actually emit —
  // the test above proves the transport surfaces the headers and proxyFetchJson
  // parses them onto the error.
  const { combineOpenSkyFetchErrors } = await freshSeeder();
  const combined = combineOpenSkyFetchErrors(
    new Error('HTTP 500: upstream boom'),
    Object.assign(new Error('HTTP 429: quota'), { status: 429, retryAfterSeconds: 22_688 }),
  );

  assert.equal(
    combined.status, 429,
    'The combined error dropped the proxy leg status, so the 429 is only detectable by string-matching (#6241).',
  );
  assert.equal(
    combined.retryAfterSeconds, 22_688,
    'The combined error dropped the proxy leg retry-after, collapsing a 6.3h cooldown to the 90s fallback (#6241).',
  );
  assert.match(combined.message, /HTTP 429\b/, 'the combined message must still carry the 429 for the string matcher');
});

test('parseRetryAfterSeconds handles both header containers and the HTTP-date form', async () => {
  // Two transports hand this parser two different container types: a fetch
  // `Headers` (direct) and a plain object (the proxy tunnel). Driving
  // fetchAllStates only ever exercises the first.
  const { parseRetryAfterSeconds } = await freshSeeder();

  assert.equal(
    parseRetryAfterSeconds({ 'X-Rate-Limit-Retry-After-Seconds': '600' }), 600,
    'Plain-object headers from the proxy tunnel must parse; `Headers.get` would have thrown on them (#6241).',
  );
  assert.equal(
    parseRetryAfterSeconds(new Headers({ 'retry-after': '600' })), 600,
    'A fetch Headers instance must still parse.',
  );

  // RFC 7231 permits Retry-After as an HTTP-date. Number() on it is NaN, so
  // without the date arm a dated 429 silently degrades to the fallback.
  const inTenMinutes = new Date(Date.now() + 600_000).toUTCString();
  const parsed = parseRetryAfterSeconds({ 'retry-after': inTenMinutes });
  assert.ok(
    parsed > 540 && parsed <= 600,
    `An HTTP-date Retry-After (${inTenMinutes}) parsed to ${parsed}; expected ~600s (#6241).`,
  );

  assert.equal(parseRetryAfterSeconds({}), null, 'absent header must yield null, not 0');
  assert.equal(parseRetryAfterSeconds({ 'retry-after': '-5' }), null, 'a negative delay is not a deadline');
  assert.equal(
    parseRetryAfterSeconds({ 'retry-after': '604800' }), 86_400,
    'A one-week retry-after must clamp to the 24h maximum, not park the tier for a week (#6241).',
  );
});

test('a proxy-gateway 429 is not mistaken for an OpenSky lockout', async () => {
  // The residential proxy's own gateway rejects with status 429 for ITS quota
  // (Decodo traffic limits have done exactly this), carrying the `proxyConnect`
  // marker _proxy-utils.cjs sets for this discrimination. Treating it as an
  // OpenSky lockout would park a perfectly healthy upstream on someone else's
  // billing problem. Unreachable from a fetch mock — the tunnel is raw sockets.
  const { isOpenSkyRateLimitedError, combineOpenSkyFetchErrors } = await freshSeeder();

  const gatewayError = Object.assign(new Error('Proxy CONNECT: HTTP/1.1 429 Too Many Requests'), {
    status: 429,
    proxyConnect: true,
  });

  assert.equal(
    isOpenSkyRateLimitedError(gatewayError), false,
    'A proxy-gateway 429 was classified as an OpenSky rate limit. Both collapse to status 429, so ' +
    'without the proxyConnect marker the proxy vendor\'s quota parks the OpenSky tier (#6241).',
  );

  // The same must hold after the direct+proxy re-wrap, which is how this error
  // actually reaches the classifier in production.
  const combined = combineOpenSkyFetchErrors(new Error('HTTP 500: boom'), gatewayError);
  assert.equal(
    isOpenSkyRateLimitedError(combined), false,
    'The gateway marker was dropped by the combine, so the re-wrapped error reads as a bare 429 and ' +
    'arms an OpenSky cooldown anyway (#6241).',
  );

  // Control: an identical error WITHOUT the marker is a genuine OpenSky 429.
  // Without this the assertions above would pass if the predicate always said false.
  assert.equal(
    isOpenSkyRateLimitedError(Object.assign(new Error('HTTP 429: quota'), { status: 429 })), true,
    'A real OpenSky 429 must still be classified as rate-limited.',
  );
});

test('a run with NO Redis credentials degrades instead of exiting', async () => {
  // This is the entire reason getOptionalRedisCredentials exists rather than the
  // shared getRedisCredentials, which process.exit(1)s on missing creds. Every
  // other test sets UPSTASH_* at module scope, so without this case swapping in
  // the shared reader would hard-kill credential-less runs with the suite green.
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  try {
    install({ openSkyStatus: 429, retryAfterSeconds: 22_688 });
    const { allStates } = await (await freshSeeder()).fetchAllStates();

    assert.ok(
      allStates.map((s) => s[0]).includes(WINGBITS_ONLY),
      'A credential-less run did not publish. The cooldown is an optimisation; with nowhere to ' +
      'persist it the run must still degrade to Wingbits, not die (#6241).',
    );
    assert.equal(
      calls.filter((c) => new URL(c.url).host === REDIS_HOST).length, 0,
      'A credential-less run still issued Redis calls — the credential guard is not short-circuiting.',
    );
  } finally {
    process.env.UPSTASH_REDIS_REST_URL = url;
    process.env.UPSTASH_REDIS_REST_TOKEN = token;
  }
});

test('the key TTL still outlives the deadline at the 24h clamp boundary', async () => {
  // The TTL is `ceil(cooldownMs/1000) + 60`. Every other test exercises it at
  // 22,688s; the interesting point is the clamp, where cooldownMs is pinned to
  // the maximum and an off-by-one in either expression expires the key while the
  // deadline it guards is still in the future.
  install({ openSkyStatus: 429, retryAfterSeconds: 7 * 24 * 3_600 }); // a week -> clamps to 24h
  await (await freshSeeder()).fetchAllStates();

  const record = readCooldownRecord();
  const entry = redisStore.get(COOLDOWN_KEY);

  // Assert against the persisted values, not wall-clock deltas: the elapsed
  // milliseconds between the fixture and the write would otherwise decide
  // whether a boundary assertion rounds past the clamp.
  assert.equal(
    record.cooldownMs, 86_400_000,
    `A one-week retry-after produced a ${record.cooldownMs}ms cooldown; it must clamp to 24h (#6241).`,
  );
  assert.equal(
    record.retryAfterSeconds, 86_400,
    'The persisted retry-after must be the clamped value the deadline was actually derived from.',
  );
  assert.ok(
    entry.ttl > record.cooldownMs / 1000,
    `Key TTL ${entry.ttl}s does not outlive the ${record.cooldownMs / 1000}s cooldown at the clamp ` +
    'boundary. The key would expire mid-cooldown and the seeder would resume hammering (#6241).',
  );
});

test('a 429 with no retry-after header still arms a bounded cooldown', async () => {
  install({ openSkyStatus: 429 });
  await (await freshSeeder()).fetchAllStates();

  const record = readCooldownRecord();
  assert.ok(
    record && Number(record.until) > Date.now(),
    'A 429 without X-Rate-Limit-Retry-After-Seconds armed no cooldown at all. OpenSky omits the ' +
    'header on some rejections, and those are exactly as doomed to repeat (#6241).',
  );
  assert.ok(
    Number(record.until) - Date.now() <= 24 * 60 * 60 * 1000,
    `A header-less 429 armed a ${Math.round((record.until - Date.now()) / 1000)}s cooldown; it must ` +
    'stay bounded so an unexplained rejection cannot blackout OpenSky indefinitely (#6241).',
  );
});

test('an expired cooldown record is cleared after the next successful call', async () => {
  seedCooldown({ until: Date.now() - 1_000, retryAfterSeconds: 90 });

  await (await freshSeeder()).fetchAllStates();

  assert.equal(
    openSkyDataCalls().length, 1,
    'An EXPIRED cooldown blocked the OpenSky call. The deadline is a point in time, not a latch — ' +
    'comparing presence instead of `until` strands OpenSky until the key TTLs out (#6241).',
  );
  assert.equal(
    readCooldownRecord(), null,
    'A successful call left the stale cooldown record in place. It must be cleared so the next ' +
    "run's read is not a wasted round-trip against a dead deadline (#6241).",
  );
});

// Both fixtures must be REJECTED by the implausibility guard, so each asserts the
// guard's own log line too. Without that, `dataCalls === 1` is also what you get
// when the record was never read at all (wrong key, unparseable envelope,
// Number.isFinite rejecting it) — the assertion would pass for the wrong reason.
for (const [label, until] of [
  ['ten years out', Date.now() + 10 * 365 * 24 * 60 * 60 * 1000],
  // Past the ECMAScript Date range (+/-8.64e15 ms). `Number.isFinite` admits it,
  // so it reaches the guard — and a nanosecond-scale timestamp is exactly the
  // shape a buggy writer produces.
  ['beyond the JS Date range', 1.78e18],
]) {
  test(`an absurd future deadline (${label}) cannot blackout OpenSky forever`, async () => {
    seedCooldown({ until });

    const { allStates } = await (await freshSeeder()).fetchAllStates();

    assert.equal(
      openSkyDataCalls().length, 1,
      `A cooldown deadline ${label} silently disabled OpenSky. Any deadline beyond the documented ` +
      'maximum window is corrupt and must be ignored, not obeyed (#6241).',
    );
    assert.ok(
      logLines.some((l) => /implausible cooldown deadline/.test(l)),
      `The implausibility guard never ran for a deadline ${label} — the OpenSky call happening ` +
      `anyway proves nothing on its own. Lines seen:\n${logLines.join('\n')}`,
    );
    assert.ok(
      allStates.map((s) => s[0]).includes(WINGBITS_ONLY),
      `A deadline ${label} killed the whole run instead of being ignored. Formatting an untrusted ` +
      'deadline as a Date throws RangeError past 8.64e15, and this read runs outside any caller ' +
      "try — so the guard against a corrupt record becomes a total outage, Wingbits included (#6241).",
    );
  });
}

test("a cooldown recorded by ANOTHER OpenSky account is ignored", async () => {
  // The quota is per-account but the key is global, so after a credential
  // rotation a healthy new account would otherwise serve out the old account's
  // lockout — losing coverage for up to the remaining window on a key nobody
  // knows to delete.
  redisStore.set(COOLDOWN_KEY, {
    value: JSON.stringify({ until: Date.now() + 6 * 3_600_000, account: 'deadbeefcafe' }),
    ttl: 3_600,
  });

  const { allStates } = await (await freshSeeder()).fetchAllStates();

  assert.equal(
    openSkyDataCalls().length, 1,
    "A cooldown earned by different credentials suppressed this account's OpenSky call. The quota " +
    'is per-account, so a rotated credential must not inherit the old lockout (#6241).',
  );
  assert.ok(
    logLines.some((l) => /different OpenSky account/.test(l)),
    `The account mismatch was not reported, so the call happening could equally mean the record was ` +
    `never read. Lines seen:\n${logLines.join('\n')}`,
  );
  assert.ok(allStates.length > 0, 'the run must still publish');
});

test('a cooldown recorded by THIS account is still honoured', async () => {
  // Control for the test above: if the fingerprint check rejected everything,
  // that test would pass while the whole mechanism was dead.
  seedCooldown({ until: Date.now() + 6 * 3_600_000 }, 3_600);

  await (await freshSeeder()).fetchAllStates();

  assert.equal(
    openSkyDataCalls().length, 0,
    'A cooldown carrying this account\'s own fingerprint was ignored — the account check is ' +
    'rejecting valid records, which disables the entire mechanism (#6241).',
  );
});

test('a 429 on the TOKEN endpoint also arms the cooldown', async () => {
  // Token acquisition runs OUTSIDE fetchOpenSkyAuthenticated's try, so it exits
  // by THROWING rather than by returning `rateLimited`. That path costs three
  // attempts and ~7s of sleeps per tick, and is just as doomed to repeat.
  install({ tokenStatus: 429, tokenRetryAfterSeconds: 22_688 });
  const before = Date.now();
  await (await freshSeeder()).fetchAllStates();

  const record = readCooldownRecord();
  assert.ok(
    record,
    'A 429 on auth.opensky-network.org armed no cooldown. It is the same account-wide lockout, and ' +
    'the token path retries three times with ~7s of sleeps on every tick of the window (#6241).',
  );
  assert.ok(
    Math.abs(Number(record.until) - (before + 22_688 * 1000)) < 60_000,
    `Token-path cooldown honoured the wrong deadline: ${record.until}.`,
  );
});

test('a standard `Retry-After` header is honoured when the vendor header is absent', async () => {
  // parseRetryAfterSeconds checks two header names. Every other test sets only
  // the vendor one, so without this case the `retry-after` arm is dead code that
  // could be deleted with the whole suite still green.
  install({ openSkyStatus: 429, retryAfterSeconds: 22_688, retryAfterHeader: 'Retry-After' });
  const before = Date.now();
  await (await freshSeeder()).fetchAllStates();

  const record = readCooldownRecord();
  assert.ok(record, 'A 429 carrying only the standard Retry-After header armed no cooldown (#6241).');
  assert.ok(
    Math.abs(Number(record.until) - (before + 22_688 * 1000)) < 60_000,
    `Standard Retry-After was ignored; deadline was ${record.until}, expected ~${before + 22_688_000}. ` +
    'The fallback header arm exists precisely because OpenSky does not always send the vendor one (#6241).',
  );
});

test('the header-less fallback outlives one */5 cron tick', async () => {
  // The whole mechanism is a no-op if the fallback expires before the next
  // process starts: the seeder is one-shot on a 300s cron, so a deadline shorter
  // than that suppresses exactly zero requests while still logging "cooldown".
  install({ openSkyStatus: 429 });
  const before = Date.now();
  await (await freshSeeder()).fetchAllStates();

  const record = readCooldownRecord();
  assert.ok(record, 'precondition: a header-less 429 must arm a cooldown');
  const cooldownMs = Number(record.until) - before;
  assert.ok(
    cooldownMs > 300_000,
    `The header-less fallback armed only ${Math.round(cooldownMs / 1000)}s. The cron period is 300s, ` +
    'so anything shorter has already expired by the next tick and prevents no requests at all (#6241).',
  );
});

for (const mode of ['http', 'throw']) {
  test(`a Redis read failure (${mode}) fails OPEN — the OpenSky call still runs`, async () => {
    seedCooldown({ until: Date.now() + 3_600_000 }, 3_600);
    redisReadFails = mode;

    await (await freshSeeder()).fetchAllStates();

    assert.equal(
      openSkyDataCalls().length, 1,
      `An unreadable cooldown key (${mode}) suppressed the OpenSky call. A Redis blip must not ` +
      'delete a data tier — the worst case of failing open is one wasted request (#6241).',
    );
  });
}

// Both Redis WRITE verbs must be contained. SET is reached by the 429 path; DEL
// by the expired-record-then-success path. Each has its own catch, and a bare
// "the run survived" assertion would stay green with either catch deleted —
// the outer try in fetchOpenSkyGlobal swallows the throw too. So each case also
// pins the specific warn only the inner catch emits.
for (const [verb, setup, expectedWarn] of [
  [
    'SET',
    () => install({ openSkyStatus: 429, retryAfterSeconds: 3_600 }),
    /failed to persist cooldown/,
  ],
  [
    'DEL',
    () => {
      install();
      seedCooldown({ until: Date.now() - 1_000 });
    },
    /failed to clear cooldown/,
  ],
]) {
  test(`a Redis ${verb} failure does not abort the run`, async () => {
    setup();
    const mocked = globalThis.fetch;
    globalThis.fetch = async (url, opts = {}) => {
      const raw = typeof url === 'string' ? url : url.url;
      const isPost = (opts.method || 'GET').toUpperCase() === 'POST';
      if (new URL(raw).host === REDIS_HOST && isPost && JSON.parse(opts.body)[0] === verb) {
        calls.push({ url: raw, method: 'POST', headers: {} });
        throw new TypeError('fetch failed');
      }
      return mocked(url, opts);
    };

    const { allStates, fetchSources } = await (await freshSeeder()).fetchAllStates();

    assert.ok(
      allStates.map((s) => s[0]).includes(WINGBITS_ONLY),
      `A failed cooldown ${verb} took the whole run down with it. Persisting the deadline is best ` +
      'effort — the publish is not (#6241).',
    );
    assert.ok(
      logLines.some((l) => expectedWarn.test(l)),
      `The ${verb} failure was not reported by its own handler. Without this the outer catch in ` +
      `fetchOpenSkyGlobal would swallow it identically, so "the run survived" proves nothing. ` +
      `Lines seen:\n${logLines.join('\n')}`,
    );
    assert.ok(
      !String(fetchSources.regions[0]?.authStatus || '').includes('fetch failed'),
      `The ${verb} failure escaped into the OpenSky status (${fetchSources.regions[0]?.authStatus}), ` +
      'masking the real upstream outcome (#6241).',
    );
  });
}

test('a total Redis outage (read AND write) still publishes from Wingbits', async () => {
  // The shape a real Upstash incident takes. Every other Redis test fails one
  // verb; this one fails them all, which is the only case where the cooldown can
  // be neither read nor recorded.
  install({ openSkyStatus: 429, retryAfterSeconds: 22_688 });
  const mocked = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const raw = typeof url === 'string' ? url : url.url;
    if (new URL(raw).host === REDIS_HOST) throw new TypeError('fetch failed');
    return mocked(url, opts);
  };

  const { allStates } = await (await freshSeeder()).fetchAllStates();

  assert.ok(
    allStates.map((s) => s[0]).includes(WINGBITS_ONLY),
    'A total Redis outage turned a degraded run into an empty publish. The cooldown is an ' +
    'optimisation; losing it must never cost the data (#6241).',
  );
  assert.equal(
    openSkyDataCalls().length, 1,
    'A total Redis outage changed the OpenSky request count. With no readable deadline the run must ' +
    'fail OPEN — exactly one attempt, same as an un-cooled run (#6241).',
  );
});
