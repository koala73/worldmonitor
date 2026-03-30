import test from 'node:test';
import assert from 'node:assert/strict';

import { getCommsDirectoryLinks } from '../src/services/comms-directory.ts';
import {
  buildCommsFieldCard,
  buildCommsFieldCardCsv,
  buildCommsFieldCardJson,
} from '../src/services/comms-export.ts';
import { getResolvedCommsPlan } from '../src/services/comms-plan.ts';

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

test('getCommsDirectoryLinks returns curated scanner and repeater references for a saved place', () => {
  const links = getCommsDirectoryLinks(makePlace({ name: 'Durham Home', tags: ['home', 'family'] }));

  assert.equal(links.length >= 4, true);
  assert.equal(links.some((link) => link.kind === 'scanner'), true);
  assert.equal(links.some((link) => link.kind === 'repeater'), true);
  assert.equal(links.some((link) => link.provider === 'Zello'), true);
  assert.match(links[0]?.note ?? '', /Durham Home/);
});

test('buildCommsFieldCard includes place, fallback ladder, templates, and references', () => {
  const place = makePlace({ name: 'Parents House', tags: ['family'] });
  const plan = getResolvedCommsPlan(place, {
    placeId: place.id,
    notes: 'Use channel 3 after 10 minutes.',
    fallbackSteps: [
      {
        id: 'signal-thread',
        label: 'Signal thread',
        kind: 'signal',
        instruction: 'Post to the family thread first.',
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
  const references = getCommsDirectoryLinks(place, plan);

  const card = buildCommsFieldCard({
    place,
    plan,
    references,
    generatedAt: new Date('2026-03-29T20:00:00.000Z'),
  });

  assert.equal(card.placeName, 'Parents House');
  assert.equal(card.fallbackSteps.length, 2);
  assert.equal(card.references.length, references.length);
  assert.equal(card.templates.safe.label, 'Safe');
  assert.match(card.notes ?? '', /channel 3/i);
});

test('buildCommsFieldCardCsv emits fallback and reference sections', () => {
  const place = makePlace({ name: 'Bugout Cabin', tags: ['bugout'] });
  const plan = getResolvedCommsPlan(place);
  const csv = buildCommsFieldCardCsv(buildCommsFieldCard({
    place,
    plan,
    references: getCommsDirectoryLinks(place, plan),
    generatedAt: new Date('2026-03-29T20:00:00.000Z'),
  }));

  assert.match(csv, /Fallback Steps/);
  assert.match(csv, /References/);
  assert.match(csv, /Bugout Cabin/);
});

test('buildCommsFieldCardJson preserves structured references and templates', () => {
  const place = makePlace();
  const plan = getResolvedCommsPlan(place);
  const json = buildCommsFieldCardJson(buildCommsFieldCard({
    place,
    plan,
    references: getCommsDirectoryLinks(place, plan),
    generatedAt: new Date('2026-03-29T20:00:00.000Z'),
  }));
  const parsed = JSON.parse(json);

  assert.equal(parsed.placeId, 'place-home');
  assert.equal(Array.isArray(parsed.references), true);
  assert.equal(parsed.templates.safe.status, 'safe');
});
