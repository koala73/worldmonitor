// Orbital Watch ships dark (#10710): scripts/seed-orbital-sites.mjs writes nothing
// until ORBITAL_WATCH_ENABLED=true, so health must not count the absent index as a
// rollout in progress. Dark, the probe reads NOT_CONFIGURED (ok bucket) and claims no
// rollout deadline; lit, it gets the normal one-day first-publication window on a
// deadline key that the dark period never wrote.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const name = 'orbitalSites';
const now = Date.parse('2026-11-14T13:00:00Z');

async function loadHealth(enabled) {
  const previous = process.env.ORBITAL_WATCH_ENABLED;
  if (enabled === undefined) delete process.env.ORBITAL_WATCH_ENABLED;
  else process.env.ORBITAL_WATCH_ENABLED = enabled;
  try {
    const mod = await import(`../api/health.js?orbital-watch=${encodeURIComponent(String(enabled))}`);
    return mod.__testing__;
  } finally {
    if (previous === undefined) delete process.env.ORBITAL_WATCH_ENABLED;
    else process.env.ORBITAL_WATCH_ENABLED = previous;
  }
}

function classifyAbsent(health, until) {
  return health.classifyKey(name, health.STANDALONE_KEYS[name], { allowOnDemand: true }, {
    keyStrens: new Map(), keyErrors: new Map(), keyMetaErrors: new Map(),
    keyMetaValues: new Map(),
    activationStates: new Map([[name, false]]),
    rolloutPendingUntilMs: new Map(until ? [[name, until]] : []), now,
  });
}

const deadlineSets = (health) => health.regionalEnergyRolloutCommands(now, 'production')
  .filter((c) => c[0] === 'SET' && String(c[1]).includes('orbital:sites'));

for (const flag of [undefined, 'false', '1']) {
  test(`dark (ORBITAL_WATCH_ENABLED=${flag}): the absent index is NOT_CONFIGURED and claims no deadline`, async () => {
    const health = await loadHealth(flag);
    const entry = classifyAbsent(health);
    assert.equal(entry.status, 'NOT_CONFIGURED');
    assert.equal(health.healthStatusBucket(entry, now), 'ok');
    // Even a deadline left in Redis from before this fix must not turn it into a warning.
    assert.equal(classifyAbsent(health, now + 60_000).status, 'NOT_CONFIGURED');
    assert.deepEqual(deadlineSets(health), []);
  });
}

test('lit: the absent index is ROLLOUT_PENDING inside the window and EMPTY after it', async () => {
  const health = await loadHealth(' TRUE ');
  assert.equal(classifyAbsent(health, now + 60_000).status, 'ROLLOUT_PENDING');
  assert.equal(classifyAbsent(health, now).status, 'EMPTY');
});

test('lit: the one-day deadline uses a key the dark period never claimed', async () => {
  const health = await loadHealth('true');
  const darkEraKey = `health:rollout-deadline:${health.STANDALONE_KEYS[name]}`;
  const sets = deadlineSets(health);
  assert.equal(sets.length, 1);
  assert.notEqual(sets[0][1], darkEraKey);
  assert.deepEqual(sets[0], ['SET', health.SEED_META[name].rolloutDeadlineKey, String(now + 1440 * 60_000), 'NX']);
});

test('health reads the same switch as the seeder and the orbital RPCs', async () => {
  const { orbitalSitesEnabled } = await import('../scripts/seed-orbital-sites.mjs');
  for (const value of [undefined, '', 'false', '1', 'true', ' TRUE ']) {
    const health = await loadHealth(value);
    const lit = classifyAbsent(health, now + 60_000).status !== 'NOT_CONFIGURED';
    assert.equal(lit, orbitalSitesEnabled({ ORBITAL_WATCH_ENABLED: value }), `value ${JSON.stringify(value)}`);
  }
});
