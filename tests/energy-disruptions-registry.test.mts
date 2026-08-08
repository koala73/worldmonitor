// @ts-check
import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateRegistry,
  recordCount,
  buildPayload,
  ENERGY_DISRUPTIONS_CANONICAL_KEY,
  MAX_STALE_MIN,
} from '../scripts/_energy-disruption-registry.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(resolve(__dirname, '../scripts/data/energy-disruptions.json'), 'utf-8');
const rawRegistry = JSON.parse(raw) as { events: Record<string, any> };
// validateRegistry checks the buildPayload output (the denormalised shape
// the seeder actually writes to Redis), not the raw JSON on disk. Since
// plan §R/#5 decision B, buildPayload attaches countries[] per event; the
// raw file intentionally omits that field so a curator can edit events
// without manually computing affected countries.
const registry = buildPayload() as { events: Record<string, any> };

describe('energy-disruptions registry — schema', () => {
  test('registry passes validateRegistry', () => {
    assert.equal(validateRegistry(registry), true);
  });

  test('canonical key is stable', () => {
    assert.equal(ENERGY_DISRUPTIONS_CANONICAL_KEY, 'energy:disruptions:v1');
  });

  test('at least 8 events (MIN floor)', () => {
    assert.ok(recordCount(registry) >= 8);
  });

  test('MAX_STALE_MIN is 2× weekly cron', () => {
    assert.equal(MAX_STALE_MIN, 20_160);
  });
});

describe('energy-disruptions registry — identity + enums', () => {
  test('every event.id matches its object key', () => {
    for (const [key, e] of Object.entries(registry.events)) {
      assert.equal(e.id, key, `${key} -> id=${e.id}`);
    }
  });

  test('every assetType is pipeline or storage', () => {
    const valid = new Set(['pipeline', 'storage']);
    for (const e of Object.values(registry.events)) {
      assert.ok(valid.has(e.assetType), `${e.id}: bad assetType`);
    }
  });

  test('every eventType is in the valid set', () => {
    const valid = new Set(['sabotage', 'sanction', 'maintenance', 'mechanical', 'weather', 'commercial', 'war', 'other']);
    for (const e of Object.values(registry.events)) {
      assert.ok(valid.has(e.eventType), `${e.id}: bad eventType ${e.eventType}`);
    }
  });

  test('endAt is null or not earlier than startAt', () => {
    for (const e of Object.values(registry.events)) {
      if (e.endAt === null) continue;
      const start = Date.parse(e.startAt);
      const end = Date.parse(e.endAt);
      assert.ok(end >= start, `${e.id}: endAt < startAt`);
    }
  });

  test('every event references a non-empty assetId', () => {
    for (const e of Object.values(registry.events)) {
      assert.ok(typeof e.assetId === 'string' && e.assetId.length > 0, `${e.id}: empty assetId`);
    }
  });
});

describe('energy-disruptions registry — evidence', () => {
  test('every event has at least one source', () => {
    for (const e of Object.values(registry.events)) {
      assert.ok(e.sources.length > 0, `${e.id}: no sources`);
    }
  });

  test('every source has valid sourceType + http(s) url', () => {
    const valid = new Set(['regulator', 'operator', 'press', 'ais-relay', 'satellite']);
    for (const e of Object.values(registry.events)) {
      for (const s of e.sources) {
        assert.ok(valid.has(s.sourceType), `${e.id}: bad sourceType ${s.sourceType}`);
        assert.ok(s.url.startsWith('http'), `${e.id}: url not http(s)`);
      }
    }
  });

  test('classifierConfidence within 0..1', () => {
    for (const e of Object.values(registry.events)) {
      assert.ok(e.classifierConfidence >= 0 && e.classifierConfidence <= 1, `${e.id}: bad confidence`);
    }
  });
});

describe('energy-disruptions registry — countries[] denorm (§R #5 B)', () => {
  test('every event in buildPayload output has non-empty countries[]', () => {
    for (const e of Object.values(registry.events)) {
      assert.ok(
        Array.isArray(e.countries) && e.countries.length > 0,
        `${e.id}: empty countries[] — assetId may be orphaned`,
      );
    }
  });

  test('every country code is ISO-3166-1 alpha-2 uppercase', () => {
    for (const e of Object.values(registry.events)) {
      for (const c of e.countries) {
        assert.ok(/^[A-Z]{2}$/.test(c), `${e.id}: bad country code ${c}`);
      }
    }
  });

  test('raw JSON on disk does NOT carry countries[] (source of truth is the join)', () => {
    for (const e of Object.values(rawRegistry.events)) {
      assert.equal(e.countries, undefined, `${e.id}: raw JSON should not pre-compute countries[]`);
    }
  });

  test('nord-stream-1-sabotage-2022 resolves to [DE, RU]', () => {
    const nord = registry.events['nord-stream-1-sabotage-2022'];
    assert.ok(nord, 'nord-stream-1-sabotage-2022 missing from registry');
    assert.deepEqual(nord.countries, ['DE', 'RU']);
  });
});

describe('energy-disruptions registry — validateRegistry rejects bad input', () => {
  test('rejects empty object', () => {
    assert.equal(validateRegistry({}), false);
  });

  test('rejects null', () => {
    assert.equal(validateRegistry(null), false);
  });

  test('rejects endAt earlier than startAt', () => {
    const bad = JSON.parse(JSON.stringify(registry));
    const firstKey = Object.keys(bad.events)[0]!;
    bad.events[firstKey].startAt = '2024-06-01T00:00:00Z';
    bad.events[firstKey].endAt = '2020-01-01T00:00:00Z';
    assert.equal(validateRegistry(bad), false);
  });

  test('rejects unknown eventType', () => {
    const bad = JSON.parse(JSON.stringify(registry));
    const firstKey = Object.keys(bad.events)[0]!;
    bad.events[firstKey].eventType = 'telekinesis';
    assert.equal(validateRegistry(bad), false);
  });
});
