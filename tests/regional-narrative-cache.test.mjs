// Regional narrative prompt-hash cache (#4896 item 1).
//
// generateRegionalNarrative fired its ~900-token LLM call before any
// content-identity check: byte-identical world state (7 regions × 4 runs/day
// via seed-bundle-regional) regenerated the same narrative every 6h, and
// same-bucket re-runs burned it just to have persistSnapshot discard the
// result. The generator now caches the parsed narrative under a hash of the
// exact prompt (whose only volatile input is a day-granular date) so an
// unchanged world reuses the narrative instead of re-billing it.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateRegionalNarrative,
  emptyNarrative,
} from '../scripts/regional-snapshot/narrative.mjs';

const REGION = { id: 'mena', name: 'Middle East & North Africa' };

function snapshotFixture() {
  return {
    region_id: 'mena',
    actors: [{ name: 'Actor A', role: 'state', leverage_score: 0.8 }],
    scenario_sets: [],
    transmission_paths: [],
    triggers: { active: [] },
    regime: { label: 'contested' },
    balance: {
      coercive_pressure: 0.5, domestic_fragility: 0.3, capital_stress: 0.2,
      energy_vulnerability: 0.4, alliance_cohesion: 0.6, maritime_access: 0.7,
      energy_leverage: 0.5, net_balance: 0.1,
    },
    narrative: emptyNarrative(),
  };
}

const VALID_LLM_TEXT = JSON.stringify({
  situation: { text: 'Something is happening in the region.', evidence_ids: [] },
});

function makeCache() {
  const store = new Map();
  return {
    store,
    gets: 0,
    sets: 0,
    async get(key) { this.gets += 1; return store.get(key)?.value ?? null; },
    async set(key, value, ttlSeconds) { this.sets += 1; store.set(key, { value, ttlSeconds }); },
  };
}

afterEach(() => { /* no globals mutated — everything is injected */ });

test('identical inputs hit the cache: one LLM call, second result served as provider=cache', async () => {
  const cache = makeCache();
  let llmCalls = 0;
  const callLlm = async () => { llmCalls += 1; return { text: VALID_LLM_TEXT, provider: 'groq', model: 'llama-70b' }; };

  const first = await generateRegionalNarrative(REGION, snapshotFixture(), [], { callLlm, cache });
  const second = await generateRegionalNarrative(REGION, snapshotFixture(), [], { callLlm, cache });

  assert.equal(llmCalls, 1, 'byte-identical prompt must not re-bill the LLM');
  assert.equal(first.narrative.situation.text, 'Something is happening in the region.');
  assert.deepEqual(second.narrative, first.narrative, 'cached narrative must round-trip');
  assert.equal(second.provider, 'cache');
  assert.equal(second.model, 'llama-70b', 'cached entry must preserve the producing model');
  assert.equal(cache.sets, 1);
  const [, entry] = [...cache.store.entries()][0];
  assert.ok(entry.ttlSeconds > 0, 'cache writes must carry a TTL');
});

test('changed snapshot content misses the cache and generates fresh', async () => {
  const cache = makeCache();
  let llmCalls = 0;
  const callLlm = async () => { llmCalls += 1; return { text: VALID_LLM_TEXT, provider: 'groq', model: 'llama-70b' }; };

  await generateRegionalNarrative(REGION, snapshotFixture(), [], { callLlm, cache });
  const changed = snapshotFixture();
  changed.actors = [{ name: 'Actor B', role: 'state', leverage_score: 0.4 }];
  await generateRegionalNarrative(REGION, changed, [], { callLlm, cache });

  assert.equal(llmCalls, 2, 'different world state must regenerate');
});

test('failed/invalid generations are never cached', async () => {
  const cache = makeCache();
  const callLlm = async () => ({ text: 'not json at all', provider: 'groq', model: 'llama-70b' });

  const result = await generateRegionalNarrative(REGION, snapshotFixture(), [], { callLlm, cache });

  assert.deepEqual(result.narrative, emptyNarrative());
  assert.equal(cache.sets, 0, 'an empty/invalid narrative must not be pinned for the TTL');
});

test('a throwing cache never blocks generation', async () => {
  const cache = {
    async get() { throw new Error('redis down'); },
    async set() { throw new Error('redis down'); },
  };
  let llmCalls = 0;
  const callLlm = async () => { llmCalls += 1; return { text: VALID_LLM_TEXT, provider: 'groq', model: 'llama-70b' }; };

  const result = await generateRegionalNarrative(REGION, snapshotFixture(), [], { callLlm, cache });

  assert.equal(llmCalls, 1);
  assert.equal(result.narrative.situation.text, 'Something is happening in the region.');
});

test('global region still short-circuits without touching cache or LLM', async () => {
  const cache = makeCache();
  let llmCalls = 0;
  const callLlm = async () => { llmCalls += 1; return { text: VALID_LLM_TEXT, provider: 'groq', model: 'x' }; };

  const result = await generateRegionalNarrative({ id: 'global', name: 'Global' }, snapshotFixture(), [], { callLlm, cache });

  assert.deepEqual(result.narrative, emptyNarrative());
  assert.equal(llmCalls, 0);
  assert.equal(cache.gets, 0);
});
