/**
 * /api/health probes the deployed Convex tenant-relay gate for the gateway role
 * (#8208 / #8217).
 *
 * #8208 took checkout, the customer portal and notification channels down for
 * nine hours while every credential existed in the right store: the Vercel
 * build predated the secret (`create-checkout` returned its env-missing 503
 * before reaching Convex), and the Convex deploy predated it too (every
 * `/relay/*` route answered 401). Sentry saw 18 warning-level events spread
 * over the window; nothing paged. Presence in a store proves nothing — only
 * the deployed gate admitting the deployed secret does.
 *
 * So the health sweep now sends one credentialed, body-less POST to
 * `/relay/create-checkout`. The relay's own contract makes that safe and
 * decisive: a wrong or missing bearer is `401 UNAUTHORIZED`, an admitted
 * bearer with an empty body is `400 MISSING_FIELDS` before any mutation runs.
 * The verdict rides the existing snapshot (one probe per 60 s TTL at most, no
 * matter how many pollers) and lands in compact `problems`, which is what the
 * 15-minute seed-freshness monitor fails on.
 */
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.UPSTASH_REDIS_REST_URL = 'https://mock-upstash.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token';
process.env.WORLDMONITOR_VALID_KEYS = 'test-health-admin-key';

const { default: handler, __testing__ } = await import('../api/health.js');
const {
  HEALTH_VERDICT_SNAPSHOT_KEY: HEALTH_SNAPSHOT_KEY,
  HEALTH_VERDICT_COMPACT_SNAPSHOT_KEY: HEALTH_COMPACT_SNAPSHOT_KEY,
  RELAY_GATEWAY_GATE_CHECK_NAME,
  RELAY_GATEWAY_GATE_ROUTE,
  RELAY_GATEWAY_GATE_TIMEOUT_MS,
  STATUS_COUNTS,
} = __testing__;

const realFetch = globalThis.fetch;
const savedEnv = {};
const ENV_KEYS = ['CONVEX_SITE_URL', 'CONVEX_TENANT_RELAY_SECRET', 'VERCEL_ENV', 'VERCEL'];

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

const SECRET = 'wm-gateway-secret-fixture';
const SITE = 'https://convex-site.test';

/**
 * Redis mock (same shape as health-verdict-snapshot.test.mjs) plus a Convex
 * relay stub. `relay` decides what the gate answers; `relayCalls` records what
 * the sweep sent so the probe's own contract is pinned, not just its verdict.
 */
function mockTransports({ relay }) {
  const snapshotStore = { [HEALTH_SNAPSHOT_KEY]: null, [HEALTH_COMPACT_SNAPSHOT_KEY]: null };
  const relayCalls = [];
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.startsWith(SITE)) {
      relayCalls.push({ url: target, init });
      return relay(target, init);
    }
    const commands = JSON.parse(init.body);
    const results = commands.map(([op, key, value]) => {
      if (op === 'GET' && key in snapshotStore) return { result: snapshotStore[key] };
      if (op === 'STRLEN') return { result: 100 };
      if (op === 'LLEN') return { result: 1 };
      if (op === 'GET') return { result: JSON.stringify({ fetchedAt: Date.now(), recordCount: 1 }) };
      if (op === 'EXISTS') return { result: 0 };
      if (op === 'HEXISTS') return { result: 1 };
      if (op === 'SET' && key in snapshotStore) { snapshotStore[key] = value; return { result: 'OK' }; }
      return { result: 'OK' };
    });
    return new Response(JSON.stringify(results), { status: 200 });
  };
  return { relayCalls, snapshotStore };
}

async function sweep() {
  const detailed = await handler(new Request('https://api.worldmonitor.app/api/health', {
    headers: { 'x-worldmonitor-key': 'test-health-admin-key' },
  }));
  const compact = await handler(new Request('https://api.worldmonitor.app/api/health?compact=1'));
  return { detailed: await detailed.json(), compact: await compact.json() };
}

function productionEnv() {
  process.env.VERCEL = '1';
  process.env.VERCEL_ENV = 'production';
  process.env.CONVEX_SITE_URL = SITE;
  process.env.CONVEX_TENANT_RELAY_SECRET = SECRET;
}

const admitted = () => Response.json({ error: 'MISSING_FIELDS', required: ['userId', 'productId'] }, { status: 400 });
const rejected = () => Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });

// The Redis mock is deliberately naive, so the registry already reports a
// handful of coverage warnings and crits of its own. Every verdict below is
// asserted as a DELTA against this control sweep (gate omitted), never as an
// absolute overall status — that is what proves the gate moved the census.
async function controlSummary() {
  process.env.VERCEL_ENV = 'preview';
  delete process.env.CONVEX_SITE_URL;
  delete process.env.CONVEX_TENANT_RELAY_SECRET;
  mockTransports({ relay: admitted });
  const { detailed } = await sweep();
  assert.equal(detailed.checks[RELAY_GATEWAY_GATE_CHECK_NAME], undefined, 'control sweep carries no gate');
  return detailed.summary;
}

test('an admitted bearer is OK and stays out of compact problems', async () => {
  const control = await controlSummary();
  productionEnv();
  const { relayCalls } = mockTransports({ relay: admitted });

  const { detailed, compact } = await sweep();

  const entry = detailed.checks[RELAY_GATEWAY_GATE_CHECK_NAME];
  assert.equal(entry.status, 'OK');
  assert.equal(entry.role, 'gateway');
  assert.equal(entry.route, RELAY_GATEWAY_GATE_ROUTE);
  assert.equal(entry.httpStatus, 400);
  assert.equal(compact.problems?.[RELAY_GATEWAY_GATE_CHECK_NAME], undefined);
  assert.equal(detailed.summary.crit, control.crit, 'an admitted gate adds no crit');
  assert.equal(detailed.summary.warn, control.warn, 'an admitted gate adds no warn');
  assert.equal(detailed.summary.ok, control.ok + 1, 'it is counted, as ok');

  // The probe's own contract: one body-less POST, the deployed secret as bearer,
  // a UA the relay logs can attribute, and a bounded timeout.
  assert.equal(relayCalls.length, 1, 'one probe per sweep');
  const [{ url, init }] = relayCalls;
  assert.equal(url, `${SITE}${RELAY_GATEWAY_GATE_ROUTE}`);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, `Bearer ${SECRET}`);
  assert.equal(init.body, '{}');
  assert.match(init.headers['User-Agent'], /^worldmonitor-health-relay-gate\//);
  assert.ok(init.signal instanceof AbortSignal, 'probe carries an abort signal');
  assert.ok(RELAY_GATEWAY_GATE_TIMEOUT_MS <= 5_000, 'the sweep cannot wait on Convex indefinitely');
});

test('a 401 from the deployed gate is RELAY_GATE_REJECTED, critical, and reaches compact problems', async () => {
  const control = await controlSummary();
  productionEnv();
  mockTransports({ relay: rejected });

  const { detailed, compact } = await sweep();

  const entry = detailed.checks[RELAY_GATEWAY_GATE_CHECK_NAME];
  assert.equal(entry.status, 'RELAY_GATE_REJECTED');
  assert.equal(entry.httpStatus, 401);
  assert.equal(STATUS_COUNTS.RELAY_GATE_REJECTED, 'crit');
  assert.equal(detailed.summary.crit, control.crit + 1, 'the rejected gate is one more crit');
  assert.notEqual(detailed.status, 'HEALTHY');
  assert.equal(compact.problems[RELAY_GATEWAY_GATE_CHECK_NAME].status, 'RELAY_GATE_REJECTED');
  assert.match(compact.problems[RELAY_GATEWAY_GATE_CHECK_NAME].hint, /deploy/i, 'the hint names the fix, not just the symptom');
});

test('missing gateway env on a production build is RELAY_GATE_MISCONFIGURED without touching the network', async () => {
  // This is the Vercel half of #8208: the build that serves create-checkout
  // cannot see the secret, so it 503s before ever reaching Convex.
  process.env.VERCEL = '1';
  process.env.VERCEL_ENV = 'production';
  process.env.CONVEX_SITE_URL = SITE;
  delete process.env.CONVEX_TENANT_RELAY_SECRET;
  const { relayCalls } = mockTransports({ relay: admitted });

  const { detailed, compact } = await sweep();

  const entry = detailed.checks[RELAY_GATEWAY_GATE_CHECK_NAME];
  assert.equal(entry.status, 'RELAY_GATE_MISCONFIGURED');
  assert.deepEqual(entry.missing, ['CONVEX_TENANT_RELAY_SECRET']);
  assert.equal(STATUS_COUNTS.RELAY_GATE_MISCONFIGURED, 'crit');
  assert.equal(relayCalls.length, 0);
  assert.equal(compact.problems[RELAY_GATEWAY_GATE_CHECK_NAME].status, 'RELAY_GATE_MISCONFIGURED');
  assert.match(compact.problems[RELAY_GATEWAY_GATE_CHECK_NAME].hint, /new commit/i, 'the hint carries the #8216 redeploy trap');
});

test('VERCEL_ENV=production on a build Vercel is not running (no VERCEL=1) omits the check', async () => {
  // The rollout-semantics suites (tests/fred-rates-rollout-health.test.mjs)
  // model production on a laptop with VERCEL_ENV alone and no tenant secret.
  // A missing var is only the fault on the build that serves customers.
  delete process.env.VERCEL;
  process.env.VERCEL_ENV = 'production';
  delete process.env.CONVEX_SITE_URL;
  delete process.env.CONVEX_TENANT_RELAY_SECRET;
  const { relayCalls } = mockTransports({ relay: admitted });

  const { detailed } = await sweep();

  assert.equal(detailed.checks[RELAY_GATEWAY_GATE_CHECK_NAME], undefined);
  assert.equal(relayCalls.length, 0);
});

test('outside production a missing gateway env omits the check instead of failing it', async () => {
  // Previews and local runs legitimately lack the tenant secret; the existing
  // health suites never set it and must keep reading HEALTHY.
  process.env.VERCEL_ENV = 'preview';
  delete process.env.CONVEX_SITE_URL;
  delete process.env.CONVEX_TENANT_RELAY_SECRET;
  const { relayCalls } = mockTransports({ relay: admitted });

  const { detailed } = await sweep();

  assert.equal(detailed.checks[RELAY_GATEWAY_GATE_CHECK_NAME], undefined);
  assert.equal(relayCalls.length, 0);
});

test('an unreachable or erroring relay is RELAY_GATE_UNREACHABLE, a warning, never a credential verdict', async () => {
  const control = await controlSummary();
  productionEnv();
  mockTransports({ relay: async () => { throw new TypeError('fetch failed'); } });

  const { detailed, compact } = await sweep();

  const entry = detailed.checks[RELAY_GATEWAY_GATE_CHECK_NAME];
  assert.equal(entry.status, 'RELAY_GATE_UNREACHABLE');
  assert.equal(STATUS_COUNTS.RELAY_GATE_UNREACHABLE, 'warn');
  assert.match(entry.error, /fetch failed/);
  assert.equal(detailed.summary.warn, control.warn + 1, 'one more warn, no new crit');
  assert.equal(detailed.summary.crit, control.crit);
  assert.equal(compact.problems[RELAY_GATEWAY_GATE_CHECK_NAME].status, 'RELAY_GATE_UNREACHABLE');
});

test('an unexpected admit-side answer is also RELAY_GATE_UNREACHABLE, so a relay 5xx cannot read as "credential fine"', async () => {
  productionEnv();
  mockTransports({ relay: () => new Response('upstream', { status: 502 }) });

  const { detailed } = await sweep();

  const entry = detailed.checks[RELAY_GATEWAY_GATE_CHECK_NAME];
  assert.equal(entry.status, 'RELAY_GATE_UNREACHABLE');
  assert.equal(entry.httpStatus, 502);
});

test('the gate check does not change summary.total, which the docs pin to the key registries', async () => {
  productionEnv();
  mockTransports({ relay: rejected });
  const withGate = (await sweep()).detailed;

  process.env.VERCEL_ENV = 'preview';
  delete process.env.CONVEX_TENANT_RELAY_SECRET;
  mockTransports({ relay: admitted });
  const withoutGate = (await sweep()).detailed;

  assert.equal(withGate.summary.total, withoutGate.summary.total);
  assert.ok(withGate.checks[RELAY_GATEWAY_GATE_CHECK_NAME]);
  assert.equal(withoutGate.checks[RELAY_GATEWAY_GATE_CHECK_NAME], undefined);
});
