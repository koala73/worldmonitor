// Contract for the Canada ingest bundle.
//
// The bundle exists so six Canadian seeders consume ONE Railway slot instead of
// six. These tests pin the two things that silently rot: the per-member cadence
// (the reason the bundle is cheaper than six crons) and the seed-meta keys (the
// gate the runner uses to decide whether a member is due).
//
// The bundle script cannot be imported — it calls runBundle at module scope — so
// this reads it through the same static parser the repo-wide bundle gates use.

import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractBundleSections, resolveExpr } from './helpers/bundle-section-parser.mjs';
import { bundleDisableEnvVar, disabledMembersFromEnv } from '../scripts/_bundle-runner.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'scripts/seed-bundle-canada.mjs'), 'utf8');
const RUNNER_SRC = readFileSync(join(root, 'scripts/_bundle-runner.mjs'), 'utf8');
const TORONTO_TFS_SEEDER_SRC = readFileSync(join(root, 'scripts/seed-toronto-tfs.mjs'), 'utf8');
const TORONTO_TPS_SEEDER_SRC = readFileSync(join(root, 'scripts/seed-toronto-tps.mjs'), 'utf8');
const ACCEPTANCE_BASELINE = JSON.parse(
  readFileSync(join(root, 'scripts/seed-freshness-baseline.json'), 'utf8'),
);
const sections = extractBundleSections(src);

const MIN = 60_000;
const HOUR = 3_600_000;

function section(label) {
  const found = sections.find((s) => s.label === label);
  assert.ok(found, `bundle must declare a ${label} section`);
  return found;
}

test('declares exactly the ten active Canada members', () => {
  assert.deepEqual(
    sections.map((s) => s.label).sort(),
    [
      'Alberta-Emergency-Alert',
      'BC-Emergency-Info',
      'BC-Open511',
      'Provincial-511',
      'SaskAlert',
      'TTC-Alerts',
      'Toronto-Roads',
      'Toronto-TFS',
      'Toronto-TPS',
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
    ['BC-Emergency-Info', 15 * MIN],
    ['SaskAlert', 15 * MIN],
    ['VIA-Rail-Live', 15 * MIN],
    ['TTC-Alerts', 5 * MIN],
    ['Toronto-TFS', 5 * MIN],
    ['Toronto-TPS', 15 * MIN],
  ];
  for (const [label, intervalMs] of expected) {
    assert.equal(
      resolveExpr(src, section(label).intervalMsExpr),
      intervalMs,
      `${label} cadence changed — confirm the bandwidth math before accepting it`,
    );
  }
});

test('Manitoba cutover acknowledgement reaches the first eligible Provincial-511 admission', () => {
  const provincial = section('Provincial-511');
  const intervalMs = resolveExpr(src, provincial.intervalMsExpr);
  const freshnessGuard = /elapsed\s*<\s*section\.intervalMs\s*\*\s*(\d+(?:\.\d+)?)/.exec(RUNNER_SRC);
  assert.ok(freshnessGuard, 'bundle runner must expose its interval freshness admission ratio');
  const freshnessRatio = Number(freshnessGuard[1]);
  assert.ok(freshnessRatio > 0 && freshnessRatio <= 1, 'freshness admission ratio must be in (0, 1]');

  const service = JSON.parse(readFileSync(join(root, 'scripts/railway-services.json'), 'utf8'))
    .find((row) => row.service === 'seed-bundle-canada');
  assert.equal(service?.cronSchedule, '*/5 * * * *');
  const cronIntervalMs = 5 * MIN;

  // The ack itself is gone — manitobaRoads publishes and #6622 was pruned on
  // 2026-08-20. The ARITHMETIC it encoded is not gone, and it is the part worth
  // keeping: a cutover window for this member must clear the runner's
  // 0.8-interval freshness gate, so it spans the */5 ticks the gate skips.
  // Pinned unconditionally against the live interval, ratio and cron so it
  // still fails when any of the three moves — a bare `if (ack)` guard here
  // would be an assertion that can no longer run.
  const firstEligibleDelayMs = Math.ceil((intervalMs * freshnessRatio) / cronIntervalMs) * cronIntervalMs;
  assert.equal(
    firstEligibleDelayMs,
    15 * MIN,
    'the first eligible Provincial-511 admission must still be three */5 ticks out',
  );

  // Directional: no ack is required now, but one added later must span exactly
  // that window rather than expiring on the activation tick.
  const manitoba = ACCEPTANCE_BASELINE.acknowledged.find((entry) => entry.name === 'manitobaRoads');
  if (manitoba) {
    const activatedAt = Date.parse(manitoba.cutover?.activatedAt);
    const firstScheduledRunAt = Date.parse(manitoba.cutover?.firstScheduledRunAt);
    assert.equal(
      firstScheduledRunAt,
      activatedAt + firstEligibleDelayMs,
      'the cutover must include */5 ticks skipped by the runner\'s 0.8-interval freshness gate',
    );
    assert.equal(Date.parse(manitoba.expiresAt), firstScheduledRunAt);
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
    'Alberta-Emergency-Alert': ['seed-meta:alerts:alberta-aea', 'alerts:canada:alberta-aea:v1'],
    'BC-Emergency-Info': ['seed-meta:alerts:bc-emergency-info', 'alerts:canada:bc-evacuation:v1'],
    'SaskAlert': ['seed-meta:alerts:saskalert', 'alerts:canada:saskalert:v1'],
    'VIA-Rail-Live': ['seed-meta:transit:viarail-live', 'transit:viarail:live'],
    // The canonical key is transit:ttc:alerts:v1 but the resource is
    // 'ttc-alerts', so the meta key takes a HYPHEN. api/health.js watched
    // seed-meta:transit:ttc:alerts and would never have seen a publish.
    'TTC-Alerts': ['seed-meta:transit:ttc-alerts', 'transit:ttc:alerts:v1'],
    'Toronto-TFS': ['seed-meta:safety:toronto-tfs', 'safety:toronto-tfs:v1'],
    'Toronto-TPS': ['seed-meta:safety:toronto-tps', 'safety:toronto-tps:v1'],
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

test('Toronto sources use provider freshness, bounded execution, and durable activation', () => {
  const expected = [
    {
      label: 'Toronto-TFS',
      seederSrc: TORONTO_TFS_SEEDER_SRC,
      contentMeta: 'torontoTfsContentMeta',
      maxContentAgeMin: 'TFS_MAX_STALE_MIN',
      fetchPhaseTimeoutMs: 45_000,
      parentTimeoutMs: 60_000,
      activationKey: 'seed-activated:safety:toronto-tfs',
      completionMetaKey: 'seed-completion:safety:toronto-tfs',
    },
    {
      label: 'Toronto-TPS',
      seederSrc: TORONTO_TPS_SEEDER_SRC,
      contentMeta: 'torontoTpsContentMeta',
      maxContentAgeMin: 'TPS_MAX_STALE_MIN',
      fetchPhaseTimeoutMs: 90_000,
      parentTimeoutMs: 105_000,
      activationKey: 'seed-activated:safety:toronto-tps',
      completionMetaKey: 'seed-completion:safety:toronto-tps',
    },
  ];

  for (const contract of expected) {
    assert.match(
      contract.seederSrc,
      new RegExp(`contentMeta:\\s*${contract.contentMeta}`),
      `${contract.label} must derive freshness from the provider payload`,
    );
    assert.match(
      contract.seederSrc,
      new RegExp(`maxContentAgeMin:\\s*${contract.maxContentAgeMin}`),
      `${contract.label} content age must use its declared source freshness budget`,
    );

    const fetchTimeout = /fetchPhaseTimeoutMs:\s*([\d_]+)/.exec(contract.seederSrc);
    assert.ok(fetchTimeout, `${contract.label} must declare fetchPhaseTimeoutMs`);
    const fetchPhaseTimeoutMs = Number(fetchTimeout[1].replaceAll('_', ''));
    assert.equal(fetchPhaseTimeoutMs, contract.fetchPhaseTimeoutMs, `${contract.label} fetch deadline changed`);

    const parentTimeoutMs = resolveExpr(src, section(contract.label).timeoutMsExpr);
    assert.equal(parentTimeoutMs, contract.parentTimeoutMs, `${contract.label} parent deadline changed`);
    assert.ok(
      fetchPhaseTimeoutMs < parentTimeoutMs,
      `${contract.label} fetch deadline must leave the bundle runner time to terminate cleanly`,
    );
    const sectionLine = src.split('\n').find((line) => line.includes(`label: '${contract.label}'`));
    assert.match(
      sectionLine,
      new RegExp(`completionMetaKey: '${contract.completionMetaKey}'`),
      `${contract.label} must attest that activation work completed after the canonical write`,
    );
    assert.match(contract.seederSrc, new RegExp(`afterPublish:\\s*mark${contract.label === 'Toronto-TFS' ? 'Tfs' : 'Tps'}Activated`));
    assert.match(contract.seederSrc, new RegExp(contract.activationKey));
  }

  const acknowledged = new Set(ACCEPTANCE_BASELINE.acknowledged.map((entry) => entry.name));
  assert.equal(acknowledged.has('torontoTfs'), false);
  assert.equal(acknowledged.has('torontoTps'), false);
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
    ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'MANITOBA_511_KEY', 'ALBERTA_511_KEY'],
    'members publish through runSeed (Upstash REST pair); Manitoba and Alberta 511 each '
    + 'need their Railway key. Alberta was keyless until 2026-08-19, when the vendor began '
    + 'answering an unkeyed GET with HTTP 400 "Invalid Key" and the jurisdiction went stale '
    + 'for 88 hours while the bundle still reported OK.',
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

  assert.equal(checked, 10, 'all ten active members must be checked, or this guard is partly vacuous');
});

describe('per-member kill switch (#6711)', () => {
  // A bundle collapses N services into one, which also collapses N deploy
  // controls into one: before this, taking a single misbehaving member out of
  // rotation meant editing the section list and redeploying the bundle, which
  // stops its siblings too.

  it('scopes the env var per bundle so one bundle cannot disable another', () => {
    assert.equal(bundleDisableEnvVar('Canada'), 'WM_BUNDLE_CANADA_DISABLED_MEMBERS');
    assert.equal(bundleDisableEnvVar('ecb-eu'), 'WM_BUNDLE_ECB_EU_DISABLED_MEMBERS');
    // Two bundles with a same-named member must not share a switch.
    assert.notEqual(bundleDisableEnvVar('Canada'), bundleDisableEnvVar('ecb-eu'));
  });

  it('parses a comma list, tolerating spacing and empties', () => {
    const env = { WM_BUNDLE_CANADA_DISABLED_MEMBERS: ' Toronto-Roads , ,BC-Open511 ' };
    const disabled = disabledMembersFromEnv('Canada', env);
    assert.deepEqual([...disabled].sort(), ['BC-Open511', 'Toronto-Roads']);
  });

  it('treats an unset or blank switch as nothing disabled', () => {
    // Must be empty, not "everything" — a blank env var disabling the whole
    // bundle would be a catastrophic default.
    assert.equal(disabledMembersFromEnv('Canada', {}).size, 0);
    assert.equal(disabledMembersFromEnv('Canada', { WM_BUNDLE_CANADA_DISABLED_MEMBERS: '' }).size, 0);
    assert.equal(disabledMembersFromEnv('Canada', { WM_BUNDLE_CANADA_DISABLED_MEMBERS: '   ' }).size, 0);
  });

  it('refuses to start when the switch names a section that does not exist', () => {
    // THE FAIL-CLOSED PROPERTY. A typo'd kill switch that silently disables
    // nothing is the worst outcome: an operator believes a source is off while
    // it keeps running. Verified on the runner source because runBundle spawns
    // child processes.
    assert.match(RUNNER_SRC, /names unknown section\(s\)/);
    assert.match(RUNNER_SRC, /Refusing to start/);
    // It must throw, not warn-and-continue.
    const guard = /const unknownDisabled[\s\S]*?\n  \}/.exec(RUNNER_SRC);
    assert.ok(guard, 'the unknown-label guard must exist');
    assert.match(guard[0], /throw new Error/);
  });

  it('logs a disabled member instead of skipping it silently', () => {
    // A member that vanishes with no log is indistinguishable from one that was
    // never configured.
    assert.match(RUNNER_SRC, /status=DISABLED reason=kill-switch/);
    assert.match(RUNNER_SRC, /disabled:\$\{disabled\}/);
  });

  it('does not count a disabled member as ran, failed, or graceful', () => {
    // Counting it as ran would let a fully-disabled bundle report a healthy
    // tick; counting it as failed would crash the service on a deliberate
    // operator action.
    const block = /if \(disabledMembers\.has\(section\.label\)\) \{[\s\S]*?continue;\n    \}/.exec(RUNNER_SRC);
    assert.ok(block, 'the disable branch must exist');
    assert.match(block[0], /disabled\+\+/);
    assert.equal(/ran\+\+|failed\+\+|gracefulFailed\+\+/.test(block[0]), false);
  });
});
