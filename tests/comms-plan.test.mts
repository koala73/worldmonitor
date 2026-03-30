import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCommsMessage,
  createCommsPlanStore,
  getResolvedCommsPlan,
} from '../src/services/comms-plan.ts';

function createMemoryStorage() {
  const store = new Map();
  return {
    getItem(key) {
      return store.get(key) ?? null;
    },
    setItem(key, value) {
      store.set(key, value);
    },
    removeItem(key) {
      store.delete(key);
    },
  };
}

function makePlace(overrides = {}) {
  return {
    id: 'place-home',
    name: 'Home Base',
    lat: 35.994,
    lon: -78.8986,
    radiusKm: 40,
    tags: ['home'],
    priority: 10,
    notes: '',
    offlinePinned: true,
    primary: true,
    source: 'manual',
    sortIndex: 1,
    createdAt: 1_711_734_400_000,
    updatedAt: 1_711_734_400_000,
    ...overrides,
  };
}

test('getResolvedCommsPlan seeds a place-aware default ladder when no custom plan exists', () => {
  const plan = getResolvedCommsPlan(makePlace());

  assert.equal(plan.placeId, 'place-home');
  assert.equal(plan.fallbackSteps.length > 0, true);
  assert.equal(plan.templates.safe.status, 'safe');
  assert.match(plan.fallbackSteps[0]?.label ?? '', /Signal|SMS|Call|Voice/i);
});

test('createCommsPlanStore persists per-place plans and rehydrates them', () => {
  const storage = createMemoryStorage();
  const store = createCommsPlanStore(storage);

  store.upsertPlan({
    placeId: 'place-home',
    notes: 'Use satcom after 15 minutes of silence.',
    fallbackSteps: [
      {
        id: 'satcom',
        label: 'Satcom ping',
        kind: 'satcom',
        instruction: 'Use Garmin inReach preset if both cellular and radio fail.',
        priority: 1,
      },
    ],
  });

  const reloaded = createCommsPlanStore(storage);
  const plan = reloaded.getPlan('place-home');

  assert.equal(plan?.notes, 'Use satcom after 15 minutes of silence.');
  assert.equal(plan?.fallbackSteps[0]?.kind, 'satcom');
});

test('buildCommsMessage produces a place-aware outbound check-in with fallback guidance', () => {
  const place = makePlace({ name: 'Parents House', tags: ['family'] });
  const plan = getResolvedCommsPlan(place, {
    placeId: 'place-home',
    notes: 'Use channel 3 if voice service fails.',
    fallbackSteps: [
      {
        id: 'sms-thread',
        label: 'Signal thread',
        kind: 'signal',
        instruction: 'Post to the family Signal thread first.',
        priority: 1,
      },
      {
        id: 'gmrs',
        label: 'GMRS channel 3',
        kind: 'radio',
        instruction: 'Switch to GMRS channel 3 after 10 minutes.',
        priority: 2,
      },
    ],
  });

  const message = buildCommsMessage({
    status: 'moving',
    place,
    plan,
    now: new Date('2026-03-29T19:00:00.000Z'),
  });

  assert.match(message, /Parents House/);
  assert.match(message, /Moving/i);
  assert.match(message, /Signal thread/);
  assert.match(message, /GMRS channel 3/);
  assert.match(message, /2026-03-29/);
});

test('exportPlans and importPlans round-trip valid plan data', () => {
  const source = createCommsPlanStore(createMemoryStorage());
  source.upsertPlan({
    placeId: 'place-home',
    notes: 'Primary rally point is the north parking lot.',
    fallbackSteps: [
      {
        id: 'voice',
        label: 'Voice call',
        kind: 'call',
        instruction: 'Call the primary contact and leave a voicemail.',
        priority: 1,
      },
    ],
  });

  const exported = source.exportPlans();
  const target = createCommsPlanStore(createMemoryStorage());
  const imported = target.importPlans(exported);

  assert.equal(imported.length, 1);
  assert.equal(target.getPlan('place-home')?.notes, 'Primary rally point is the north parking lot.');
});
