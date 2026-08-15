// Contract for the Canada ingest bundle.
//
// The bundle exists so six Canadian seeders consume ONE Railway slot instead of
// six. These tests pin the two things that silently rot: the per-member cadence
// (the reason the bundle is cheaper than six crons) and the seed-meta keys (the
// gate the runner uses to decide whether a member is due).
//
// The bundle script cannot be imported — it calls runBundle at module scope — so
// this reads it through the same static parser the repo-wide bundle gates use.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractBundleSections, resolveExpr } from './helpers/bundle-section-parser.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'scripts/seed-bundle-canada.mjs'), 'utf8');
const sections = extractBundleSections(src);

const MIN = 60_000;
const HOUR = 3_600_000;

function section(label) {
  const found = sections.find((s) => s.label === label);
  assert.ok(found, `bundle must declare a ${label} section`);
  return found;
}

test('declares exactly the six Canada members', () => {
  assert.deepEqual(
    sections.map((s) => s.label).sort(),
    [
      'Alberta-Emergency-Alert',
      'BC-Open511',
      'Provincial-511',
      'TTC-Alerts',
      'Toronto-Roads',
      'VIA-Rail-Live',
    ],
    'a member added to the bundle without a decision here is a slot nobody agreed to',
  );
});

test('per-member cadence is the declared one, not TTC\'s cron inherited', () => {
  // The service cron is */5 because TTC needs it. Every other member is gated by
  // its own intervalMs — that is the whole reason one service can replace six.
  // Toronto at */15 cost 348 MB/day for a construction-permit feed; 2h is ~44.
  const expected = [
    ['Provincial-511', 15 * MIN],
    ['Toronto-Roads', 2 * HOUR],
    ['BC-Open511', 30 * MIN],
    ['Alberta-Emergency-Alert', 15 * MIN],
    ['VIA-Rail-Live', 15 * MIN],
    ['TTC-Alerts', 5 * MIN],
  ];
  for (const [label, intervalMs] of expected) {
    assert.equal(
      resolveExpr(src, section(label).intervalMsExpr),
      intervalMs,
      `${label} cadence changed — confirm the bandwidth math before accepting it`,
    );
  }
});

test('seed-meta keys follow runSeed(domain, resource), not the canonical key', () => {
  // runSeed derives `seed-meta:${domain}:${resource}`. It is NOT the canonical
  // key with :v1 stripped, and the two diverge wherever a resource contains a
  // hyphen where the canonical key has a colon. Getting this wrong points the
  // runner's due-check at a key the seeder never writes, so the member either
  // runs every tick or never runs — silently, either way.
  const expected = {
    'Provincial-511': ['seed-meta:infra:ontario-511', 'infra:ontario-511:v1'],
    'Toronto-Roads': ['seed-meta:infra:toronto-roads', 'infra:toronto-roads:v1'],
    'BC-Open511': ['seed-meta:infra:bc-open511', 'infra:bc-open511:v1'],
    'Alberta-Emergency-Alert': ['seed-meta:alerts:alberta-aea', 'alerts:alberta-aea:v1'],
    'VIA-Rail-Live': ['seed-meta:transit:viarail-live', 'transit:viarail:live'],
    // The canonical key is transit:ttc:alerts:v1 but the resource is
    // 'ttc-alerts', so the meta key takes a HYPHEN. api/health.js watched
    // seed-meta:transit:ttc:alerts and would never have seen a publish.
    'TTC-Alerts': ['seed-meta:transit:ttc-alerts', 'transit:ttc:alerts:v1'],
  };
  // The shared parser does not expose these fields, so read them off the section
  // literal — anchored on the label so a key can never be matched against the
  // wrong member.
  for (const [label, [seedMetaKey, canonicalKey]] of Object.entries(expected)) {
    const line = src.split('\n').find((l) => l.includes(`label: '${label}'`));
    assert.ok(line, `${label} section literal must be on one line`);
    assert.match(line, new RegExp(`seedMetaKey: '${seedMetaKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`), `${label} seedMetaKey`);
    assert.match(line, new RegExp(`canonicalKey: '${canonicalKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`), `${label} canonicalKey`);
  }
});

test('every member declares a timeout, and none can exceed the wall budget', () => {
  // A section whose timeout cannot fit is deferred on EVERY tick and never runs.
  // runBundle throws on an unadmittable section, so this catches it in CI first.
  const maxBundleMs = 570_000;
  for (const s of sections) {
    const timeoutMs = resolveExpr(src, s.timeoutMsExpr);
    assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0, `${s.label} must declare a timeoutMs`);
    assert.ok(timeoutMs < maxBundleMs, `${s.label} timeout ${timeoutMs} cannot fit the ${maxBundleMs}ms budget`);
  }
});

test('skips a member whose script is absent instead of failing the whole bundle', () => {
  // The bundle is registered before its members merge, so on an intermediate
  // tree some scripts do not exist. Reaching spawn() with a missing file settles
  // as a HARD failure and reds the service for a member that simply was not
  // deployed yet. The filter must be on existsSync, and it must log.
  assert.match(src, /existsSync\(join\(here, section\.script\)\)/);
  assert.match(src, /SKIPPING \$\{section\.label\}/);
});

test('is registered as an active service now that it is provisioned', () => {
  // Was: asserted lifecycle 'planned' with no watchPatterns and no cron, which
  // is what keeps an unprovisioned row out of the live audit. The service now
  // exists on Railway (0a4b8757, cron */5), so the row has to say so — a
  // 'planned' row for a service that IS running hides it from the very drift
  // and watch-path audits that would catch it deploying stale code.
  const registry = JSON.parse(readFileSync(join(root, 'scripts/railway-services.json'), 'utf8'));
  const entry = registry.find((row) => row.service === 'seed-bundle-canada');
  assert.ok(entry, 'seed-bundle-canada must be in the Railway registry');
  assert.equal(Object.hasOwn(entry, 'lifecycle'), false, 'an active service carries no lifecycle marker');
  assert.equal(entry.cronSchedule, '*/5 * * * *', 'must match the cron configured on Railway');
  assert.ok(Array.isArray(entry.watchPatterns) && entry.watchPatterns.length > 0);
  assert.deepEqual(
    entry.requiredEnv,
    ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'],
    'members publish through runSeed, which needs the Upstash REST pair',
  );
});

test('every member script and its bundle entry is a watch path', () => {
  // A member whose script is missing from watchPatterns does not redeploy when
  // it changes: the service keeps running the previously-built copy, silently,
  // with a green cron. The bundle spawns members as child processes, so their
  // paths are NOT reachable from the entry's own import graph — nothing else
  // forces them into this list.
  const registry = JSON.parse(readFileSync(join(root, 'scripts/railway-services.json'), 'utf8'));
  const entry = registry.find((row) => row.service === 'seed-bundle-canada');
  const patterns = new Set(entry.watchPatterns);
  assert.ok(patterns.has('scripts/seed-bundle-canada.mjs'), 'the bundle entry must be a watch path');
  assert.ok(patterns.has('scripts/_bundle-runner.mjs'), 'the shared runner must be a watch path');
  for (const s of sections) {
    assert.ok(
      patterns.has(`scripts/${s.script}`),
      `${s.label}: scripts/${s.script} must be a watch path, or a change to it never redeploys`,
    );
  }
});

// A member's cadence is not just a cost knob: the Redis TTL and the health
// staleness budget are both sized AGAINST it. Moving the interval without moving
// them breaks the layer two ways, and neither is visible in this file alone —
// #6711 set Toronto to 2h while its seeder still carried a 90min TTL and its
// probe a 45min budget, so the key expired 30min before every write and a
// perfectly healthy publisher read STALE_SEED forever.
//
// tests/seed-ttl-outlives-health-staleness.test.mjs compares TTL to staleness
// and passed throughout, because it never sees the interval. This is the check
// that does.
function resolveTtlSeconds(script) {
  const seederPath = join(root, 'scripts', script);
  const seederSrc = readFileSync(seederPath, 'utf8');
  const m = /ttlSeconds:\s*([A-Za-z_]\w*|\d+)/.exec(seederSrc);
  assert.ok(m, `${script} must declare ttlSeconds, or this guard silently skips it`);
  const expr = m[1];
  const local = resolveExpr(seederSrc, expr);
  if (local != null) return local;
  // Imported constant: follow the import to its defining module rather than
  // skipping, or the members that share a TTL constant go unchecked.
  const imp = new RegExp(
    `import\\s*\\{[^}]*\\b${expr}\\b[^}]*\\}\\s*from\\s*'(\\.[^']+)'`,
  ).exec(seederSrc);
  assert.ok(imp, `${script}: cannot resolve ttlSeconds identifier ${expr}`);
  const fromSrc = readFileSync(join(dirname(seederPath), imp[1]), 'utf8');
  const resolved = resolveExpr(fromSrc, expr);
  assert.ok(Number.isFinite(resolved), `${script}: ${expr} did not resolve to a number`);
  return resolved;
}

test('every member’s TTL and health staleness budget cover its bundle interval', () => {
  const health = readFileSync(join(root, 'api/health.js'), 'utf8');
  let checked = 0;

  for (const s of sections) {
    const intervalMs = resolveExpr(src, s.intervalMsExpr);
    assert.ok(Number.isFinite(intervalMs) && intervalMs > 0, `${s.label} must declare an intervalMs`);

    // A TTL at or below the interval means the canonical key expires before the
    // next write lands, so the layer is blank for the gap on every cycle.
    const ttlSeconds = resolveTtlSeconds(s.script);
    assert.ok(
      ttlSeconds * 1000 > intervalMs,
      `${s.label}: TTL ${ttlSeconds}s does not outlive its ${intervalMs / 60000}min interval — `
        + 'the canonical key expires before the next write and the layer goes blank',
    );

    // A staleness budget below the interval means a healthy publisher is
    // reported STALE_SEED permanently, because normal data age reaches the
    // interval just before each write.
    // The section parser exposes only label/script/intervals, so read the
    // member's seed-meta key straight out of the bundle source.
    const keyMatch = new RegExp(
      `label:\\s*'${s.label}'[^}]*?seedMetaKey:\\s*'([^']+)'`,
    ).exec(src);
    assert.ok(keyMatch, `${s.label}: bundle section must declare a seedMetaKey`);
    const seedMetaKey = keyMatch[1];
    const probe = new RegExp(
      `key:\\s*'${seedMetaKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}',\\s*\\n?\\s*maxStaleMin:\\s*(\\d+)`,
    ).exec(health);
    assert.ok(probe, `${s.label}: no api/health.js probe found for ${seedMetaKey}`);
    const maxStaleMin = Number(probe[1]);
    assert.ok(
      maxStaleMin * 60_000 >= intervalMs,
      `${s.label}: maxStaleMin ${maxStaleMin}min is below its ${intervalMs / 60000}min interval — `
        + 'a healthy publisher would read STALE_SEED permanently',
    );
    checked += 1;
  }

  assert.equal(checked, 6, 'all six members must be checked, or this guard is partly vacuous');
});
