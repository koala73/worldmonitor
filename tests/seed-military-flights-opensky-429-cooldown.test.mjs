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

function install({ openSkyStatus = 200, retryAfterSeconds = null } = {}) {
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
        if (retryAfterSeconds != null) headers['X-Rate-Limit-Retry-After-Seconds'] = String(retryAfterSeconds);
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
  assert.match(
    fetchSources.regions[0]?.authStatus || '',
    /cooldown/i,
    `Expected the GLOBAL region to record a cooldown status, got: ${fetchSources.regions[0]?.authStatus}`,
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

test('the combined direct+proxy error keeps the proxy leg 429 metadata', async () => {
  // The other proxy assertion covers the DIRECT-429 short-circuit. This covers
  // the remaining shape: direct fails with something else, the proxy then 429s.
  // Only the pure combiner is reachable here — _proxy-utils.cjs opens raw
  // sockets, so no fetch mock can drive that leg.
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
  redisStore.set(COOLDOWN_KEY, {
    value: JSON.stringify({ until: Date.now() - 1_000, retryAfterSeconds: 90 }),
    ttl: 60,
  });

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

test('an absurd future deadline cannot blackout OpenSky forever', async () => {
  // A corrupt or hand-written record must not be able to switch the tier off
  // permanently — this guard IS the alarm, so it has to fail open on nonsense.
  redisStore.set(COOLDOWN_KEY, {
    value: JSON.stringify({ until: Date.now() + 10 * 365 * 24 * 60 * 60 * 1000 }),
    ttl: 60,
  });

  await (await freshSeeder()).fetchAllStates();

  assert.equal(
    openSkyDataCalls().length, 1,
    'A 10-year cooldown deadline silently disabled OpenSky. Any deadline beyond the documented ' +
    'maximum window is corrupt and must be ignored, not obeyed (#6241).',
  );
});

for (const mode of ['http', 'throw']) {
  test(`a Redis read failure (${mode}) fails OPEN — the OpenSky call still runs`, async () => {
    redisStore.set(COOLDOWN_KEY, {
      value: JSON.stringify({ until: Date.now() + 3_600_000 }),
      ttl: 3_600,
    });
    redisReadFails = mode;

    await (await freshSeeder()).fetchAllStates();

    assert.equal(
      openSkyDataCalls().length, 1,
      `An unreadable cooldown key (${mode}) suppressed the OpenSky call. A Redis blip must not ` +
      'delete a data tier — the worst case of failing open is one wasted request (#6241).',
    );
  });
}

test('a Redis WRITE failure does not abort the run', async () => {
  // The 429 already cost the run its OpenSky tier; losing Wingbits on top
  // because the cooldown could not be persisted turns a degraded run into an
  // empty publish.
  install({ openSkyStatus: 429, retryAfterSeconds: 3_600 });
  const mocked = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const raw = typeof url === 'string' ? url : url.url;
    if (new URL(raw).host === REDIS_HOST && (opts.method || 'GET').toUpperCase() === 'POST') {
      calls.push({ url: raw, method: 'POST', headers: {} });
      throw new TypeError('fetch failed');
    }
    return mocked(url, opts);
  };

  const { allStates } = await (await freshSeeder()).fetchAllStates();

  assert.ok(
    allStates.map((s) => s[0]).includes(WINGBITS_ONLY),
    'A failed cooldown write took the whole run down with it. Persisting the deadline is best ' +
    'effort — the publish is not (#6241).',
  );
});
