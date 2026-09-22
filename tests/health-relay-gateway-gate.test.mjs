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
const { findOperationalProblems, findPendingDiagnostics } = await import('../scripts/check-seed-freshness.mjs');
const {
  HEALTH_VERDICT_SNAPSHOT_KEY: HEALTH_SNAPSHOT_KEY,
  HEALTH_VERDICT_COMPACT_SNAPSHOT_KEY: HEALTH_COMPACT_SNAPSHOT_KEY,
  RELAY_GATEWAY_GATE_CHECK_NAME,
  RELAY_GATEWAY_GATE_ROUTE,
  RELAY_GATEWAY_GATE_TIMEOUT_MS,
  RELAY_GATEWAY_GATE_PROBE_KEY,
  RELAY_GATEWAY_GATE_PROBE_TTL_SECONDS,
  RELAY_GATEWAY_GATE_LEASE_KEY,
  RELAY_GATEWAY_GATE_LEASE_TTL_SECONDS,
  HEALTH_VERDICT_SNAPSHOT_TTL_SECONDS,
  RELAY_GATEWAY_GATE_TRANSPORT_GRACE_MS,
  RELAY_GATEWAY_GATE_PROBE_RETENTION_SECONDS,
  withTransportGrace,
  parseCachedRelayGatewayGate,
  readOrProbeRelayGatewayGate,
  STATUS_COUNTS,
} = __testing__;

const realFetch = globalThis.fetch;
const savedEnv = {};
const ENV_KEYS = ['CONVEX_SITE_URL', 'CONVEX_URL', 'CONVEX_TENANT_RELAY_SECRET', 'VERCEL_ENV', 'VERCEL'];

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
function mockTransports({ relay, relayOrigin = SITE }) {
  // Verdict snapshots and the shared probe verdict live in the same store so a
  // second sweep can be forced (clear the snapshots) while the probe cache is
  // left to do its job.
  const snapshotStore = {
    [HEALTH_SNAPSHOT_KEY]: null,
    [HEALTH_COMPACT_SNAPSHOT_KEY]: null,
    [RELAY_GATEWAY_GATE_PROBE_KEY]: null,
    [RELAY_GATEWAY_GATE_LEASE_KEY]: null,
  };
  const relayCalls = [];
  const redisCommands = [];
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (new URL(target).origin === new URL(relayOrigin).origin) {
      relayCalls.push({ url: target, init });
      return relay(target, init);
    }
    const commands = JSON.parse(init.body);
    redisCommands.push(...commands);
    const results = commands.map(([op, key, value, ...rest]) => {
      if (op === 'GET' && key in snapshotStore) return { result: snapshotStore[key] };
      if (op === 'STRLEN') return { result: 100 };
      if (op === 'LLEN') return { result: 1 };
      if (op === 'GET') return { result: JSON.stringify({ fetchedAt: Date.now(), recordCount: 1 }) };
      if (op === 'EXISTS') return { result: 0 };
      if (op === 'HEXISTS') return { result: 1 };
      if (op === 'SET' && key in snapshotStore) {
        // Honour NX like Redis does: a held key is not overwritten and the
        // reply is null, which is how a sweep learns it lost the lease.
        if (rest.includes('NX') && snapshotStore[key] != null) return { result: null };
        snapshotStore[key] = value;
        return { result: 'OK' };
      }
      if (op === 'DEL' && key in snapshotStore) { snapshotStore[key] = null; return { result: 1 }; }
      if (op === 'EVAL') {
        // EVAL <script> 1 <key> <expected> [<next> <ttl>]: the compare-and-set
        // fallback publish when the script sets, the compare-and-delete
        // release otherwise. `expected` is '' for an absent key, as in Lua.
        // Keys and args follow Redis' `EVAL script numkeys key... arg...`
        // shape. The guard key is always KEYS[1]; a set script writes KEYS[n].
        const numkeys = Number(value);
        const keys = rest.slice(0, numkeys);
        const [expected, next, ttl] = rest.slice(numkeys);
        const guard = keys[0];
        const target = keys[keys.length - 1];
        if (!(guard in snapshotStore)) return { result: 0 };
        const current = snapshotStore[guard] ?? '';
        if (key.includes("'set'")) {
          if (current !== expected) return { result: 0 };
          snapshotStore[target] = next;
          return { result: ttl ? 'OK' : 0 };
        }
        if (current === expected) { snapshotStore[guard] = null; return { result: 1 }; }
        return { result: 0 };
      }
      return { result: 'OK' };
    });
    return new Response(JSON.stringify(results), { status: 200 });
  };
  return { relayCalls, snapshotStore, redisCommands };
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

test('a first unreachable or erroring relay is RELAY_GATE_UNREACHABLE under grace: pending, not yet a problem, never a credential verdict', async () => {
  const control = await controlSummary();
  productionEnv();
  mockTransports({ relay: async () => { throw new TypeError('fetch failed'); } });

  const { detailed, compact } = await sweep();

  const entry = detailed.checks[RELAY_GATEWAY_GATE_CHECK_NAME];
  assert.equal(entry.status, 'RELAY_GATE_UNREACHABLE');
  assert.equal(STATUS_COUNTS.RELAY_GATE_UNREACHABLE, 'warn');
  assert.match(entry.error, /fetch failed/);
  // One blip is not evidence: the first sighting carries a bounded grace,
  // buckets as ok, lands in compact `pending`, and the 15-minute monitor's
  // own predicates agree it is not operational (#8282 review).
  const graceUntil = Date.parse(entry.transportGraceUntil);
  assert.ok(graceUntil > Date.now() && graceUntil <= Date.now() + RELAY_GATEWAY_GATE_TRANSPORT_GRACE_MS + 1_000);
  assert.equal(detailed.summary.warn, control.warn, 'no new warn while under grace');
  assert.equal(detailed.summary.crit, control.crit);
  assert.equal(detailed.summary.pending, (control.pending ?? 0) + 1, 'summary.pending is published once something is pending');
  assert.equal(compact.problems?.[RELAY_GATEWAY_GATE_CHECK_NAME], undefined);
  assert.equal(compact.pending[RELAY_GATEWAY_GATE_CHECK_NAME].status, 'RELAY_GATE_UNREACHABLE');
  assert.equal(findOperationalProblems(compact).some((p) => p.name === RELAY_GATEWAY_GATE_CHECK_NAME), false);
  assert.ok(findPendingDiagnostics(compact).some((p) => p.name === RELAY_GATEWAY_GATE_CHECK_NAME));
});

test('a stall that outlives its grace becomes an operational RELAY_GATE_UNREACHABLE problem and the grace is carried, not restarted', async () => {
  productionEnv();
  const { snapshotStore, redisCommands } = mockTransports({ relay: () => new Response('upstream', { status: 502 }) });
  // Previous window: unreachable, grace already expired, verdict itself stale
  // (older than the freshness window) but still retained for the streak.
  const expiredGrace = new Date(Date.now() - 1_000).toISOString();
  snapshotStore[RELAY_GATEWAY_GATE_PROBE_KEY] = JSON.stringify({
    role: 'gateway', route: RELAY_GATEWAY_GATE_ROUTE, status: 'RELAY_GATE_UNREACHABLE',
    evaluatedAt: new Date(Date.now() - 2 * RELAY_GATEWAY_GATE_PROBE_TTL_SECONDS * 1_000).toISOString(),
    transportGraceUntil: expiredGrace,
  });

  const { detailed, compact } = await sweep();

  const entry = detailed.checks[RELAY_GATEWAY_GATE_CHECK_NAME];
  assert.equal(entry.status, 'RELAY_GATE_UNREACHABLE');
  // The streak is carried, but NOT as a live softening deadline: an expired
  // `transportGraceUntil` is registered in ENTRY_SOFTENING_DEADLINES, so
  // republishing it would make every snapshot instantly unservable and turn a
  // persistent outage into a full Redis sweep per poll instead of one warm
  // read (#8282 review).
  assert.equal(entry.transportGraceExpiredAt, expiredGrace, 'the original deadline is carried across windows');
  assert.equal(entry.transportGraceUntil, undefined, 'an expired deadline is never republished as a softening');
  const snapshotWrite = redisCommands.find(([op, key]) => op === 'SET' && key === HEALTH_SNAPSHOT_KEY);
  assert.equal(snapshotWrite[4], String(__testing__.HEALTH_VERDICT_SNAPSHOT_TTL_SECONDS), 'the warning snapshot keeps its full TTL');
  assert.equal(compact.problems[RELAY_GATEWAY_GATE_CHECK_NAME].status, 'RELAY_GATE_UNREACHABLE');
  assert.ok(findOperationalProblems(compact).some((p) => p.name === RELAY_GATEWAY_GATE_CHECK_NAME), 'now operational');
  // Owner publish: EVAL <script> 2 <lease> <verdict> <token> <json> <ttl>.
  const publish = redisCommands.find(([op, , numkeys, , target]) => op === 'EVAL' && numkeys === '2' && target === RELAY_GATEWAY_GATE_PROBE_KEY);
  assert.equal(publish[3], RELAY_GATEWAY_GATE_LEASE_KEY, 'the publish is guarded by the lease');
  assert.equal(String(publish[7]), String(RELAY_GATEWAY_GATE_PROBE_RETENTION_SECONDS), 'retained past the freshness window for the streak');
  // With no other traffic the operational monitor is the only sweep, every
  // 15 minutes; the streak must survive that gap or every run would be a
  // "first sighting" and a dead relay would sit in pending forever.
  const { SEED_FRESHNESS_MONITOR_INTERVAL_MS } = __testing__;
  assert.equal(SEED_FRESHNESS_MONITOR_INTERVAL_MS, 15 * 60 * 1_000, 'mirrors seed-freshness-monitor.yml cron */15');
  assert.ok(RELAY_GATEWAY_GATE_PROBE_RETENTION_SECONDS * 1_000
    > RELAY_GATEWAY_GATE_TRANSPORT_GRACE_MS + SEED_FRESHNESS_MONITOR_INTERVAL_MS,
  'retention outlives grace plus one monitor interval');
});

test('withTransportGrace only decorates unreachable verdicts and restarts after a healthy window', () => {
  const now = Date.parse('2026-09-17T12:00:00Z');
  const ok = { status: 'OK' };
  assert.deepEqual(withTransportGrace(ok, { status: 'RELAY_GATE_UNREACHABLE', transportGraceUntil: 'x' }, now), ok);
  const first = withTransportGrace({ status: 'RELAY_GATE_UNREACHABLE' }, { status: 'OK' }, now);
  assert.equal(first.transportGraceUntil, new Date(now + RELAY_GATEWAY_GATE_TRANSPORT_GRACE_MS).toISOString());
  const carried = withTransportGrace({ status: 'RELAY_GATE_UNREACHABLE' }, first, now + 60_000);
  assert.equal(carried.transportGraceUntil, first.transportGraceUntil);
  const malformed = withTransportGrace({ status: 'RELAY_GATE_UNREACHABLE' }, { status: 'RELAY_GATE_UNREACHABLE', transportGraceUntil: 'not-a-date' }, now);
  assert.equal(malformed.transportGraceUntil, new Date(now + RELAY_GATEWAY_GATE_TRANSPORT_GRACE_MS).toISOString());
  // Past the deadline the streak moves to a field that is NOT a softening
  // deadline, so the snapshot stays servable for its full TTL (#8282 review).
  const elapsed = withTransportGrace({ status: 'RELAY_GATE_UNREACHABLE' }, first, now + RELAY_GATEWAY_GATE_TRANSPORT_GRACE_MS + 1);
  assert.equal(elapsed.transportGraceUntil, undefined);
  assert.equal(elapsed.transportGraceExpiredAt, first.transportGraceUntil);
  // And the expired anchor is itself carried, so the streak never restarts.
  const stillElapsed = withTransportGrace({ status: 'RELAY_GATE_UNREACHABLE' }, elapsed, now + 60 * 60_000);
  assert.equal(stillElapsed.transportGraceExpiredAt, first.transportGraceUntil);
  // A healthy window clears it: the next unreachable sighting is a first one.
  const restarted = withTransportGrace({ status: 'RELAY_GATE_UNREACHABLE' }, { status: 'OK' }, now + 60 * 60_000);
  assert.equal(restarted.transportGraceUntil, new Date(now + 60 * 60_000 + RELAY_GATEWAY_GATE_TRANSPORT_GRACE_MS).toISOString());
  assert.equal(restarted.transportGraceExpiredAt, undefined);
});

test('a follower whose fallback publish is defeated adopts the verdict that beat it', async () => {
  // The owner publishes between the follower's last poll and its fallback
  // CAS. The CAS correctly refuses, but returning the fabricated fallback
  // anyway would let handleHealth write it over the owner's real verdict —
  // hiding a fresh rejection as pending for a whole monitor run (#8282 review).
  productionEnv();
  const ownerVerdict = JSON.stringify({ role: 'gateway', route: RELAY_GATEWAY_GATE_ROUTE, status: 'RELAY_GATE_REJECTED', httpStatus: 401, evaluatedAt: new Date().toISOString() });
  const { snapshotStore, relayCalls } = mockTransports({ relay: admitted });
  snapshotStore[RELAY_GATEWAY_GATE_LEASE_KEY] = 'owner-token';
  const redisFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    // Land the owner's verdict just before the follower's fallback CAS runs.
    if (typeof init?.body === 'string' && init.body.includes('probed') && init.body.includes('false')) {
      snapshotStore[RELAY_GATEWAY_GATE_PROBE_KEY] = ownerVerdict;
    }
    return redisFetch(url, init);
  };
  const entry = await readOrProbeRelayGatewayGate({
    now: Date.now(),
    key: RELAY_GATEWAY_GATE_PROBE_KEY,
    leaseKey: RELAY_GATEWAY_GATE_LEASE_KEY,
    followerWaitMs: 5,
    followerPollMs: 1,
    sleep: async () => {},
  });
  assert.equal(relayCalls.length, 0, 'the follower never probed');
  assert.deepEqual(entry, JSON.parse(ownerVerdict), 'the owner verdict that defeated the CAS wins');
  assert.equal(snapshotStore[RELAY_GATEWAY_GATE_PROBE_KEY], ownerVerdict, 'and stayed published');
});

test('an unexpected admit-side answer is also RELAY_GATE_UNREACHABLE, so a relay 5xx cannot read as "credential fine"', async () => {
  productionEnv();
  mockTransports({ relay: () => new Response('upstream', { status: 502 }) });

  const { detailed } = await sweep();

  const entry = detailed.checks[RELAY_GATEWAY_GATE_CHECK_NAME];
  assert.equal(entry.status, 'RELAY_GATE_UNREACHABLE');
  assert.equal(entry.httpStatus, 502);
});

test('concurrent or back-to-back sweeps inside the TTL reuse one probe verdict instead of each asking Convex', async () => {
  // A caller that loses the snapshot lock waits 3 s and then sweeps on its
  // own; the probe budget is longer than that wait, so without a shared
  // verdict a cold burst during an outage would fan out one relay call per
  // caller (#8282 review). The verdict is kept in Redis for the snapshot TTL.
  productionEnv();
  const { relayCalls, snapshotStore } = mockTransports({ relay: rejected });

  const first = await sweep();
  assert.equal(relayCalls.length, 1);
  assert.ok(snapshotStore[RELAY_GATEWAY_GATE_PROBE_KEY], 'the verdict is persisted for the next sweep');
  const persisted = snapshotStore[RELAY_GATEWAY_GATE_PROBE_KEY];

  // Force a second full sweep (drop the verdict snapshots) while the probe
  // verdict is still inside its window.
  snapshotStore[HEALTH_SNAPSHOT_KEY] = null;
  snapshotStore[HEALTH_COMPACT_SNAPSHOT_KEY] = null;
  const second = await sweep();

  assert.equal(relayCalls.length, 1, 'the second sweep reused the cached verdict');
  assert.equal(second.detailed.checks[RELAY_GATEWAY_GATE_CHECK_NAME].status, 'RELAY_GATE_REJECTED');
  assert.equal(second.detailed.checks[RELAY_GATEWAY_GATE_CHECK_NAME].evaluatedAt,
    first.detailed.checks[RELAY_GATEWAY_GATE_CHECK_NAME].evaluatedAt);
  assert.equal(snapshotStore[RELAY_GATEWAY_GATE_PROBE_KEY], persisted, 'a reused verdict is not rewritten');
  assert.equal(RELAY_GATEWAY_GATE_PROBE_TTL_SECONDS, HEALTH_VERDICT_SNAPSHOT_TTL_SECONDS,
    'the gate is re-asked exactly as often as the verdict itself');

  // Once the window has passed the next sweep probes again.
  const stale = JSON.stringify({
    ...JSON.parse(persisted),
    evaluatedAt: new Date(Date.now() - (RELAY_GATEWAY_GATE_PROBE_TTL_SECONDS + 1) * 1_000).toISOString(),
  });
  snapshotStore[RELAY_GATEWAY_GATE_PROBE_KEY] = stale;
  snapshotStore[HEALTH_SNAPSHOT_KEY] = null;
  snapshotStore[HEALTH_COMPACT_SNAPSHOT_KEY] = null;
  await sweep();
  assert.equal(relayCalls.length, 2, 'an expired verdict is re-probed');
});

test('the gateway credential is never sent over plaintext: a non-https or malformed site URL is MISCONFIGURED without a request', async () => {
  productionEnv();
  process.env.CONVEX_SITE_URL = 'http://convex-site.test';
  const { relayCalls } = mockTransports({ relay: admitted });

  const { detailed } = await sweep();

  const entry = detailed.checks[RELAY_GATEWAY_GATE_CHECK_NAME];
  assert.equal(entry.status, 'RELAY_GATE_MISCONFIGURED');
  assert.deepEqual(entry.invalid, ['CONVEX_SITE_URL']);
  assert.equal(relayCalls.length, 0, 'no request carried the bearer');

  process.env.CONVEX_SITE_URL = 'not a url';
  mockTransports({ relay: admitted });
  const malformed = (await sweep()).detailed.checks[RELAY_GATEWAY_GATE_CHECK_NAME];
  assert.equal(malformed.status, 'RELAY_GATE_MISCONFIGURED');

  // Outside a production build the same misconfiguration is omitted, like a
  // missing var, so a local http: Convex never fails a laptop sweep.
  delete process.env.VERCEL;
  process.env.CONVEX_SITE_URL = 'http://127.0.0.1:3210';
  const { relayCalls: localCalls } = mockTransports({ relay: admitted });
  const local = (await sweep()).detailed;
  assert.equal(local.checks[RELAY_GATEWAY_GATE_CHECK_NAME], undefined);
  assert.equal(localCalls.length, 0);
});

test('population is single-flight: a sweep that loses the probe lease waits for the published verdict and never probes itself', async () => {
  productionEnv();
  const { relayCalls, snapshotStore } = mockTransports({ relay: rejected });
  // Another sweep holds the lease; it publishes its verdict on the follower's
  // second poll.
  snapshotStore[RELAY_GATEWAY_GATE_LEASE_KEY] = String(Date.now());
  const ownerVerdict = { role: 'gateway', route: RELAY_GATEWAY_GATE_ROUTE, status: 'OK', httpStatus: 400, evaluatedAt: new Date().toISOString() };
  let polls = 0;
  const sleep = async () => { polls += 1; if (polls === 2) snapshotStore[RELAY_GATEWAY_GATE_PROBE_KEY] = JSON.stringify(ownerVerdict); };

  const entry = await readOrProbeRelayGatewayGate({
    now: Date.now(),
    key: RELAY_GATEWAY_GATE_PROBE_KEY,
    leaseKey: RELAY_GATEWAY_GATE_LEASE_KEY,
    followerWaitMs: 10_000,
    followerPollMs: 1,
    sleep,
  });

  assert.deepEqual(entry, ownerVerdict, 'the follower reports the owner\'s verdict');
  assert.equal(relayCalls.length, 0, 'the follower never touched Convex');
  assert.equal(polls, 2);
  assert.ok(snapshotStore[RELAY_GATEWAY_GATE_LEASE_KEY], 'the follower does not release a lease it does not own');
});

test('a follower whose owner publishes nothing within the probe budget reports the gate unclassified, not admitted', async () => {
  productionEnv();
  const { relayCalls, snapshotStore } = mockTransports({ relay: admitted });
  snapshotStore[RELAY_GATEWAY_GATE_LEASE_KEY] = String(Date.now());

  const entry = await readOrProbeRelayGatewayGate({
    now: Date.now(),
    key: RELAY_GATEWAY_GATE_PROBE_KEY,
    leaseKey: RELAY_GATEWAY_GATE_LEASE_KEY,
    followerWaitMs: 5,
    followerPollMs: 1,
    sleep: async () => {},
  });

  assert.equal(entry.status, 'RELAY_GATE_UNREACHABLE');
  assert.match(entry.error, /lease/);
  assert.equal(relayCalls.length, 0);
  // One slow or crashed owner is a single observation, so the follower's
  // fallback carries the same grace as a probed unreachable verdict and
  // buckets as pending rather than paging (#8282 review).
  assert.ok(Date.parse(entry.transportGraceUntil) > Date.now(), 'follower fallback carries transport grace');
  assert.ok(RELAY_GATEWAY_GATE_LEASE_TTL_SECONDS * 1_000 > RELAY_GATEWAY_GATE_TIMEOUT_MS, 'a crashed owner cannot wedge the gate past its own probe budget');
  // The follower must outwait the owner's whole critical path: the relay
  // probe, then the verdict publish with its own Redis timeout, plus slack —
  // or a follower that is the monitor request gives up a moment before the
  // verdict lands and pages a false warning (#8282 review).
  const { RELAY_GATEWAY_GATE_FOLLOWER_WAIT_MS, RELAY_GATEWAY_GATE_REDIS_TIMEOUT_MS } = __testing__;
  assert.ok(RELAY_GATEWAY_GATE_FOLLOWER_WAIT_MS > RELAY_GATEWAY_GATE_TIMEOUT_MS + RELAY_GATEWAY_GATE_REDIS_TIMEOUT_MS,
    'follower wait covers probe + publish');
  assert.ok(RELAY_GATEWAY_GATE_LEASE_TTL_SECONDS * 1_000 > RELAY_GATEWAY_GATE_FOLLOWER_WAIT_MS,
    'the lease outlives the follower wait, so a follower never sees a free lease while the owner is still publishing');
});

test('a follower fallback persists its grace deadline, so the next owner carries the streak instead of minting a new one', async () => {
  // Owner dies without publishing, relay stays down, no other traffic. The
  // follower's fallback lived only in the 60 s health snapshot, so the next
  // 15-minute monitor found no predecessor and granted a NEW three-minute
  // grace — one more interval before a dead relay paged (#8282 review).
  productionEnv();
  const { relayCalls, snapshotStore, redisCommands } = mockTransports({ relay: () => new Response('upstream', { status: 502 }) });
  snapshotStore[RELAY_GATEWAY_GATE_LEASE_KEY] = 'crashed-owner';
  const followerNow = Date.now();
  const fallback = await readOrProbeRelayGatewayGate({
    now: followerNow,
    key: RELAY_GATEWAY_GATE_PROBE_KEY,
    leaseKey: RELAY_GATEWAY_GATE_LEASE_KEY,
    followerWaitMs: 5,
    followerPollMs: 1,
    sleep: async () => {},
  });
  assert.equal(fallback.status, 'RELAY_GATE_UNREACHABLE');
  assert.equal(relayCalls.length, 0);

  const persisted = JSON.parse(snapshotStore[RELAY_GATEWAY_GATE_PROBE_KEY]);
  assert.equal(persisted.transportGraceUntil, fallback.transportGraceUntil, 'the fallback deadline is in Redis');
  assert.equal(persisted.probed, false, 'the persisted fallback says it never probed');
  const publish = redisCommands.find(([op, , numkeys, target]) => op === 'EVAL' && numkeys === '1' && target === RELAY_GATEWAY_GATE_PROBE_KEY);
  assert.ok(publish, 'the fallback is published with a compare-and-set, never a blind SET');
  assert.equal(String(publish[6]), String(__testing__.RELAY_GATEWAY_GATE_PROBE_RETENTION_SECONDS), 'retained across a monitor interval');

  // The persisted fallback is a predecessor, not a verdict: the next sweep
  // (the monitor, one interval later, lease free) still probes — and its
  // unreachable verdict carries the follower's deadline.
  snapshotStore[RELAY_GATEWAY_GATE_LEASE_KEY] = null;
  const monitorNow = followerNow + 15 * 60_000;
  const next = await readOrProbeRelayGatewayGate({
    now: monitorNow,
    clock: () => monitorNow,
    key: RELAY_GATEWAY_GATE_PROBE_KEY,
    leaseKey: RELAY_GATEWAY_GATE_LEASE_KEY,
  });
  assert.equal(relayCalls.length, 1, 'the fallback is never served as a fresh verdict');
  assert.equal(next.status, 'RELAY_GATE_UNREACHABLE');
  assert.equal(next.transportGraceExpiredAt, fallback.transportGraceUntil, 'the streak carried past its deadline');
  assert.equal(next.transportGraceUntil, undefined, 'and not as a live softening');
  assert.equal(next.probed, undefined);
  assert.equal(__testing__.healthStatusBucket(next, monitorNow), 'warn', 'and the expired deadline pages');
});

test('a follower fallback never overwrites a verdict the owner published after the follower\'s last read', async () => {
  productionEnv();
  const { snapshotStore } = mockTransports({ relay: admitted });
  snapshotStore[RELAY_GATEWAY_GATE_LEASE_KEY] = 'slow-owner';
  const ownerVerdict = JSON.stringify({ role: 'gateway', route: RELAY_GATEWAY_GATE_ROUTE, status: 'OK', httpStatus: 400, evaluatedAt: new Date().toISOString() });
  // The owner lands its verdict after the follower's last read (here: the
  // lease attempt is the first Redis call after the initial GET, and the
  // wait budget of 0 means no poll follows it).
  const redisFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (typeof init?.body === 'string' && init.body.includes(RELAY_GATEWAY_GATE_LEASE_KEY) && init.body.includes('"NX"')) {
      snapshotStore[RELAY_GATEWAY_GATE_PROBE_KEY] = ownerVerdict;
    }
    return redisFetch(url, init);
  };
  const entry = await readOrProbeRelayGatewayGate({
    now: Date.now(),
    key: RELAY_GATEWAY_GATE_PROBE_KEY,
    leaseKey: RELAY_GATEWAY_GATE_LEASE_KEY,
    followerWaitMs: 0,
    followerPollMs: 1,
    sleep: async () => {},
  });
  assert.equal(snapshotStore[RELAY_GATEWAY_GATE_PROBE_KEY], ownerVerdict, 'compare-and-set left the owner\'s verdict in place');
  assert.deepEqual(entry, JSON.parse(ownerVerdict), 'and the follower reports it rather than its own fallback');
});

test('a follower accepts a verdict the owner published after the follower\'s own sweep began', async () => {
  // The owner's `evaluatedAt` is later than the follower's fixed `now`;
  // validating against `now` would call it future-dated and persist a false
  // RELAY_GATE_UNREACHABLE in both snapshots (#8282 review).
  productionEnv();
  const { relayCalls, snapshotStore } = mockTransports({ relay: rejected });
  snapshotStore[RELAY_GATEWAY_GATE_LEASE_KEY] = 'owner-token';
  const followerNow = Date.now() - 2_000;
  const ownerVerdict = { role: 'gateway', route: RELAY_GATEWAY_GATE_ROUTE, status: 'OK', httpStatus: 400, evaluatedAt: new Date(followerNow + 1_500).toISOString() };
  snapshotStore[RELAY_GATEWAY_GATE_PROBE_KEY] = JSON.stringify(ownerVerdict);

  const entry = await readOrProbeRelayGatewayGate({
    now: followerNow,
    key: RELAY_GATEWAY_GATE_PROBE_KEY,
    leaseKey: RELAY_GATEWAY_GATE_LEASE_KEY,
    followerWaitMs: 10_000,
    followerPollMs: 1,
    sleep: async () => {},
  });

  assert.deepEqual(entry, ownerVerdict);
  assert.equal(relayCalls.length, 0);
});

test('an owner whose lease lapsed mid-probe does not release a successor\'s lease', async () => {
  productionEnv();
  const { snapshotStore } = mockTransports({
    relay: () => {
      // The TTL expired during the probe and another sweep took the lease.
      snapshotStore[RELAY_GATEWAY_GATE_LEASE_KEY] = 'successor-token';
      return rejected();
    },
  });

  await readOrProbeRelayGatewayGate({
    now: Date.now(),
    key: RELAY_GATEWAY_GATE_PROBE_KEY,
    leaseKey: RELAY_GATEWAY_GATE_LEASE_KEY,
    followerWaitMs: 5,
    followerPollMs: 1,
    sleep: async () => {},
  });

  assert.equal(snapshotStore[RELAY_GATEWAY_GATE_LEASE_KEY], 'successor-token', 'compare-and-delete left the successor lease in place');
  // The publish is guarded by the same token: a lapsed owner resuming after
  // its successor published must not overwrite the newer verdict with an
  // older one (an old OK masking a new rejection, or an old failure
  // replacing a recovery) (#8282 review). What it may leave behind is only
  // the follower fallback it becomes — a predecessor, never a verdict.
  const left = JSON.parse(snapshotStore[RELAY_GATEWAY_GATE_PROBE_KEY]);
  assert.notEqual(left.status, 'RELAY_GATE_REJECTED', 'the lapsed owner did not publish its own verdict');
  assert.equal(left.probed, false);
});

test('a lapsed owner never overwrites the verdict its successor already published', async () => {
  productionEnv();
  const successorVerdict = JSON.stringify({ role: 'gateway', route: RELAY_GATEWAY_GATE_ROUTE, status: 'RELAY_GATE_REJECTED', httpStatus: 401, evaluatedAt: new Date().toISOString() });
  const { snapshotStore } = mockTransports({
    relay: () => {
      // While this owner was paused the successor took the lease, probed,
      // published a rejection, and released; the stale owner then resumes
      // with an admitted answer.
      snapshotStore[RELAY_GATEWAY_GATE_LEASE_KEY] = null;
      snapshotStore[RELAY_GATEWAY_GATE_PROBE_KEY] = successorVerdict;
      return admitted();
    },
  });
  const entry = await readOrProbeRelayGatewayGate({
    now: Date.now(),
    key: RELAY_GATEWAY_GATE_PROBE_KEY,
    leaseKey: RELAY_GATEWAY_GATE_LEASE_KEY,
  });
  assert.equal(snapshotStore[RELAY_GATEWAY_GATE_PROBE_KEY], successorVerdict, 'the newer rejection stayed published');
  // Losing the lease makes this sweep a follower: it adopts the successor's
  // verdict instead of carrying its own stale OK into the health snapshot,
  // which handleHealth writes unconditionally for the snapshot TTL (#8282 review).
  assert.deepEqual(entry, JSON.parse(successorVerdict), 'the stale owner adopts the successor verdict');
});

test('an owner whose publish result is indeterminate adopts a successor verdict that lands, rather than trusting its own', async () => {
  // The publish EVAL times out / errors: nothing proves the verdict landed
  // before the lease lapsed, and a successor may already own the gate. Only an
  // explicit publish success makes returning `fresh` safe (#8282 review).
  productionEnv();
  const successorVerdict = JSON.stringify({ role: 'gateway', route: RELAY_GATEWAY_GATE_ROUTE, status: 'RELAY_GATE_REJECTED', httpStatus: 401, evaluatedAt: new Date().toISOString() });
  const { snapshotStore } = mockTransports({ relay: admitted });
  const redisFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (typeof init?.body === 'string' && init.body.includes(`"2","${RELAY_GATEWAY_GATE_LEASE_KEY}"`)) {
      throw new Error('redis publish timed out');
    }
    return redisFetch(url, init);
  };
  let polls = 0;
  const entry = await readOrProbeRelayGatewayGate({
    now: Date.now(),
    key: RELAY_GATEWAY_GATE_PROBE_KEY,
    leaseKey: RELAY_GATEWAY_GATE_LEASE_KEY,
    followerWaitMs: 10_000,
    followerPollMs: 1,
    sleep: async () => { if (++polls === 2) snapshotStore[RELAY_GATEWAY_GATE_PROBE_KEY] = successorVerdict; },
  });
  assert.deepEqual(entry, JSON.parse(successorVerdict), 'the newer verdict wins over the unproven own one');
});

test('an owner whose publish result is indeterminate and sees no successor verdict still reports its own probe, not an unreachable fallback', async () => {
  productionEnv();
  const { snapshotStore, relayCalls } = mockTransports({ relay: admitted });
  const redisFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (typeof init?.body === 'string' && init.body.includes(`"2","${RELAY_GATEWAY_GATE_LEASE_KEY}"`)) {
      throw new Error('redis publish timed out');
    }
    return redisFetch(url, init);
  };
  const entry = await readOrProbeRelayGatewayGate({
    now: Date.now(),
    key: RELAY_GATEWAY_GATE_PROBE_KEY,
    leaseKey: RELAY_GATEWAY_GATE_LEASE_KEY,
    followerWaitMs: 5,
    followerPollMs: 1,
    sleep: async () => {},
  });
  assert.equal(relayCalls.length, 1);
  assert.equal(entry.status, 'OK', 'this sweep did probe; with no newer verdict its own observation stands');
  assert.equal(snapshotStore[RELAY_GATEWAY_GATE_PROBE_KEY], null, 'and no unclassified fallback was persisted over nothing');
});

test('a lapsed owner whose successor is still probing waits for that verdict like any follower', async () => {
  productionEnv();
  const successorVerdict = JSON.stringify({ role: 'gateway', route: RELAY_GATEWAY_GATE_ROUTE, status: 'RELAY_GATE_REJECTED', httpStatus: 401, evaluatedAt: new Date().toISOString() });
  const { snapshotStore } = mockTransports({
    relay: () => {
      // The successor holds the lease but has not published yet.
      snapshotStore[RELAY_GATEWAY_GATE_LEASE_KEY] = 'successor-token';
      return admitted();
    },
  });
  let polls = 0;
  const entry = await readOrProbeRelayGatewayGate({
    now: Date.now(),
    key: RELAY_GATEWAY_GATE_PROBE_KEY,
    leaseKey: RELAY_GATEWAY_GATE_LEASE_KEY,
    followerWaitMs: 10_000,
    followerPollMs: 1,
    sleep: async () => { if (++polls === 2) snapshotStore[RELAY_GATEWAY_GATE_PROBE_KEY] = successorVerdict; },
  });
  assert.deepEqual(entry, JSON.parse(successorVerdict), 'adopted once the successor published');
  assert.equal(snapshotStore[RELAY_GATEWAY_GATE_LEASE_KEY], 'successor-token', 'the successor lease was left alone');
});

test('a lapsed owner whose successor never publishes falls back to the graced unclassified verdict, not its own stale one', async () => {
  productionEnv();
  const { snapshotStore } = mockTransports({
    relay: () => {
      snapshotStore[RELAY_GATEWAY_GATE_LEASE_KEY] = 'successor-token';
      return admitted();
    },
  });
  const entry = await readOrProbeRelayGatewayGate({
    now: Date.now(),
    key: RELAY_GATEWAY_GATE_PROBE_KEY,
    leaseKey: RELAY_GATEWAY_GATE_LEASE_KEY,
    followerWaitMs: 5,
    followerPollMs: 1,
    sleep: async () => {},
  });
  assert.equal(entry.status, 'RELAY_GATE_UNREACHABLE');
  assert.match(entry.error, /lease/);
  assert.ok(Date.parse(entry.transportGraceUntil) > Date.now(), 'graced like any follower fallback');
  assert.equal(JSON.parse(snapshotStore[RELAY_GATEWAY_GATE_PROBE_KEY]).probed, false, 'the fallback deadline is persisted');
});

test('the lease owner publishes before releasing, and the lease is free after the sweep', async () => {
  productionEnv();
  const { relayCalls, snapshotStore } = mockTransports({ relay: rejected });

  await sweep();

  assert.equal(relayCalls.length, 1);
  assert.ok(snapshotStore[RELAY_GATEWAY_GATE_PROBE_KEY], 'verdict published');
  assert.equal(snapshotStore[RELAY_GATEWAY_GATE_LEASE_KEY], null, 'lease released');
});

test('the verdict and lease keys are scoped per deployment like the snapshot keys', () => {
  // Preview and production share one Upstash; a preview's verdict or lease
  // must never be reused by production (#8282 review, P1).
  const { healthVerdictRedisKey } = __testing__;
  assert.equal(RELAY_GATEWAY_GATE_PROBE_KEY,
    healthVerdictRedisKey('health:relay-gate:v1', process.env.VERCEL_ENV, process.env.VERCEL_GIT_COMMIT_SHA));
  assert.equal(RELAY_GATEWAY_GATE_LEASE_KEY, `${RELAY_GATEWAY_GATE_PROBE_KEY}:lease`);
  // Production is one live deployment and keeps the bare key; every preview
  // deploy gets its own env+sha namespace, so no preview can publish into or
  // read from production's verdict.
  const prod = healthVerdictRedisKey('health:relay-gate:v1', 'production', 'abcdef0123456789');
  const preview = healthVerdictRedisKey('health:relay-gate:v1', 'preview', 'abcdef0123456789');
  assert.equal(prod, 'health:relay-gate:v1');
  assert.notEqual(prod, preview, 'the same commit on preview and production gets different keys');
  assert.notEqual(preview, healthVerdictRedisKey('health:relay-gate:v1', 'preview', 'fedcba9876543210'),
    'two preview deploys get different keys');
});

test('a deployment that would not report the gate never reads the shared verdict or lease', async () => {
  process.env.VERCEL_ENV = 'preview';
  delete process.env.VERCEL;
  delete process.env.CONVEX_SITE_URL;
  delete process.env.CONVEX_TENANT_RELAY_SECRET;
  const { relayCalls, redisCommands } = mockTransports({ relay: admitted });

  await sweep();

  const touched = redisCommands.filter(([, key]) => key === RELAY_GATEWAY_GATE_PROBE_KEY || key === RELAY_GATEWAY_GATE_LEASE_KEY);
  assert.deepEqual(touched, [], 'applicability is decided before any Redis access');
  assert.equal(relayCalls.length, 0);
});

test('the probe reaches fetch through a forwarding wrapper, not a detached reference', async () => {
  // Edge runtimes require the native fetch to be called with its global
  // receiver; a captured `globalThis.fetch` invoked bare throws, which would
  // have read as RELAY_GATE_UNREACHABLE on every sweep (#8282 review, P1).
  productionEnv();
  const { relayCalls } = mockTransports({ relay: admitted });
  const wrapped = globalThis.fetch;
  globalThis.fetch = function receiverSensitiveFetch(url, init) {
    // Only the relay call is under test; the Redis mock is reached by bare
    // `fetch(...)` calls whose receiver is undefined, which native fetch
    // tolerates. A detached `const f = globalThis.fetch; f(url)` also arrives
    // with an undefined receiver, so the relay-origin branch is where the
    // wrapper (receiver = globalThis) and a detached reference differ.
    if (new URL(String(url)).origin === new URL(SITE).origin && this !== globalThis) {
      throw new TypeError('Illegal invocation');
    }
    return wrapped(url, init);
  };

  const { detailed } = await sweep();

  assert.equal(relayCalls.length, 1);
  assert.equal(detailed.checks[RELAY_GATEWAY_GATE_CHECK_NAME].status, 'OK');
});

test('a deployment configured through CONVEX_URL alone is probed at its .convex.site twin, not flagged misconfigured', async () => {
  // The gateways resolve CONVEX_SITE_URL ?? CONVEX_URL with .convex.cloud →
  // .convex.site (api/create-checkout.ts, customer-portal.ts,
  // notification-channels.ts); the probe must accept the same shape (#8282 review, P1).
  process.env.VERCEL = '1';
  process.env.VERCEL_ENV = 'production';
  delete process.env.CONVEX_SITE_URL;
  process.env.CONVEX_URL = 'https://fixture-123.convex.cloud';
  process.env.CONVEX_TENANT_RELAY_SECRET = SECRET;
  const { relayCalls } = mockTransports({ relay: admitted, relayOrigin: 'https://fixture-123.convex.site' });

  const { detailed } = await sweep();

  assert.equal(detailed.checks[RELAY_GATEWAY_GATE_CHECK_NAME].status, 'OK');
  assert.equal(relayCalls.length, 1);
  assert.equal(relayCalls[0].url, `https://fixture-123.convex.site${RELAY_GATEWAY_GATE_ROUTE}`);
});

test('a cached verdict is only trusted when it is well-formed and inside its window', () => {
  const now = Date.parse('2026-09-17T12:00:00Z');
  const fresh = { status: 'OK', evaluatedAt: new Date(now - 10_000).toISOString() };
  assert.deepEqual(parseCachedRelayGatewayGate(JSON.stringify(fresh), now), fresh);
  assert.equal(parseCachedRelayGatewayGate(JSON.stringify({ ...fresh, evaluatedAt: new Date(now + 5_000).toISOString() }), now), null, 'future-dated is not trusted');
  assert.equal(parseCachedRelayGatewayGate(JSON.stringify({ ...fresh, evaluatedAt: new Date(now - 61_000).toISOString() }), now), null, 'expired');
  assert.equal(parseCachedRelayGatewayGate(JSON.stringify({ evaluatedAt: fresh.evaluatedAt }), now), null, 'no status');
  assert.equal(parseCachedRelayGatewayGate('{not-json', now), null);
  assert.equal(parseCachedRelayGatewayGate(null, now), null);
});

test('the gate check counts in summary.total exactly once, so the partition invariant holds with and without it', async () => {
  // `ok + warn + onDemandWarn + crit == total` is the endpoint's documented
  // partition (scripts/docs-stats.mjs pins it on the published examples). A
  // check that lands in a bucket but not in `total` breaks it by one for
  // every consumer computing ratios (#8282 review).
  const partition = (s) => s.ok + s.warn + s.onDemandWarn + s.crit;

  productionEnv();
  mockTransports({ relay: rejected });
  const withGate = (await sweep()).detailed;

  process.env.VERCEL_ENV = 'preview';
  delete process.env.VERCEL;
  delete process.env.CONVEX_TENANT_RELAY_SECRET;
  mockTransports({ relay: admitted });
  const withoutGate = (await sweep()).detailed;

  assert.ok(withGate.checks[RELAY_GATEWAY_GATE_CHECK_NAME]);
  assert.equal(withoutGate.checks[RELAY_GATEWAY_GATE_CHECK_NAME], undefined);
  assert.equal(withGate.summary.total, withoutGate.summary.total + 1, 'one liveness entry, counted once');
  assert.equal(partition(withGate.summary), withGate.summary.total);
  assert.equal(partition(withoutGate.summary), withoutGate.summary.total);
});

test('the probe hits exactly the URL the gateways build, path and trailing slash included', async () => {
  // The gateways append the route to the configured string as-is
  // (api/create-checkout.ts). Probing a normalised origin instead could pass
  // while checkout hits a different, dead endpoint (#8282 review, P1).
  productionEnv();
  process.env.CONVEX_SITE_URL = 'https://convex-site.test/base/';
  const { relayCalls } = mockTransports({ relay: admitted });

  const { detailed } = await sweep();

  assert.equal(detailed.checks[RELAY_GATEWAY_GATE_CHECK_NAME].status, 'OK');
  assert.equal(relayCalls[0].url, `https://convex-site.test/base/${RELAY_GATEWAY_GATE_ROUTE}`);
});
