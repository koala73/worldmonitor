// @ts-check
import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildPayload,
  validateRegistry,
  recordCount,
  FUEL_SHORTAGES_CANONICAL_KEY,
  MAX_STALE_MIN,
} from '../scripts/_fuel-shortage-registry.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(resolve(__dirname, '../scripts/data/fuel-shortages.json'), 'utf-8');
const registry = JSON.parse(raw) as { shortages: Record<string, any> };

describe('fuel-shortages registry — schema', () => {
  test('registry passes validateRegistry', () => {
    assert.equal(validateRegistry(registry), true);
  });

  test('canonical key is stable string', () => {
    assert.equal(FUEL_SHORTAGES_CANONICAL_KEY, 'energy:fuel-shortages:v1');
  });

  test('recordCount reports at least 10 shortages (MIN floor)', () => {
    assert.ok(recordCount(registry) >= 10);
  });

  test('MAX_STALE_MIN is 2× daily cron (2880 min)', () => {
    assert.equal(MAX_STALE_MIN, 2880);
  });
});

describe('fuel-shortages registry — identity + enums', () => {
  test('every shortage.id matches its object key', () => {
    for (const [key, s] of Object.entries(registry.shortages)) {
      assert.equal(s.id, key, `${key} -> id=${s.id}`);
    }
  });

  test('every country code is ISO 3166-1 alpha-2', () => {
    const iso2 = /^[A-Z]{2}$/;
    for (const s of Object.values(registry.shortages)) {
      assert.ok(iso2.test(s.country), `${s.id}: bad country ${s.country}`);
    }
  });

  test('every product is in the valid set', () => {
    const valid = new Set(['petrol', 'diesel', 'jet', 'heating_oil']);
    for (const s of Object.values(registry.shortages)) {
      assert.ok(valid.has(s.product), `${s.id}: bad product ${s.product}`);
    }
  });

  test('every severity is "confirmed" or "watch"', () => {
    const valid = new Set(['confirmed', 'watch']);
    for (const s of Object.values(registry.shortages)) {
      assert.ok(valid.has(s.severity), `${s.id}: bad severity ${s.severity}`);
    }
  });

  test('every impactType is in the valid set', () => {
    const valid = new Set(['stations_closed', 'rationing', 'flights_cancelled', 'import_cut', 'price_spike']);
    for (const s of Object.values(registry.shortages)) {
      for (const t of s.impactTypes) {
        assert.ok(valid.has(t), `${s.id}: bad impactType ${t}`);
      }
    }
  });

  test('every causeChain entry is in the valid set', () => {
    const valid = new Set(['upstream_refinery', 'logistics', 'policy', 'chokepoint', 'sanction', 'war', 'import_cut']);
    for (const s of Object.values(registry.shortages)) {
      assert.ok(s.causeChain.length > 0, `${s.id}: empty causeChain`);
      for (const c of s.causeChain) {
        assert.ok(valid.has(c), `${s.id}: bad cause ${c}`);
      }
    }
  });
});

describe('fuel-shortages registry — evidence contract', () => {
  test('confirmed severity requires at least one regulator/operator source OR firstRegulatorConfirmation', () => {
    for (const s of Object.values(registry.shortages)) {
      if (s.severity !== 'confirmed') continue;
      const hasAuthoritative =
        s.evidence.firstRegulatorConfirmation != null ||
        s.evidence.evidenceSources.some((src: any) =>
          src.sourceType === 'regulator' || src.sourceType === 'operator',
        );
      assert.ok(hasAuthoritative, `${s.id}: confirmed but no authoritative source`);
    }
  });

  test('every evidence source has {authority, title, url, date, sourceType}', () => {
    const validSourceTypes = new Set(['regulator', 'operator', 'press', 'ais-relay', 'satellite']);
    for (const s of Object.values(registry.shortages)) {
      for (const src of s.evidence.evidenceSources) {
        assert.equal(typeof src.authority, 'string', `${s.id}: src missing authority`);
        assert.equal(typeof src.title, 'string', `${s.id}: src missing title`);
        assert.equal(typeof src.url, 'string', `${s.id}: src missing url`);
        assert.ok(src.url.startsWith('http'), `${s.id}: src url not http(s)`);
        assert.equal(typeof src.date, 'string', `${s.id}: src missing date`);
        assert.ok(validSourceTypes.has(src.sourceType), `${s.id}: bad sourceType ${src.sourceType}`);
      }
    }
  });

  test('classifierConfidence is within 0..1 for every entry', () => {
    for (const s of Object.values(registry.shortages)) {
      const c = s.evidence.classifierConfidence;
      assert.ok(c >= 0 && c <= 1, `${s.id}: bad classifierConfidence ${c}`);
    }
  });

  test('lastConfirmed is not earlier than firstSeen', () => {
    for (const s of Object.values(registry.shortages)) {
      const first = Date.parse(s.firstSeen);
      const last = Date.parse(s.lastConfirmed);
      assert.ok(last >= first, `${s.id}: lastConfirmed < firstSeen`);
    }
  });
});

describe('fuel-shortages registry — validateRegistry rejects bad input', () => {
  test('rejects empty object', () => {
    assert.equal(validateRegistry({}), false);
  });

  test('rejects null', () => {
    assert.equal(validateRegistry(null), false);
  });

  test('rejects below MIN_SHORTAGES', () => {
    const firstKey = Object.keys(registry.shortages)[0]!;
    const bad = { shortages: { only: registry.shortages[firstKey] } };
    assert.equal(validateRegistry(bad), false);
  });

  test('rejects confirmed severity with press-only sources', () => {
    const bad = JSON.parse(JSON.stringify(registry));
    const victim = Object.values(bad.shortages).find((s: any) => s.severity === 'confirmed') as any;
    assert.ok(victim, 'precondition: at least one confirmed shortage');
    victim.evidence.firstRegulatorConfirmation = null;
    victim.evidence.evidenceSources = [
      { authority: 'Press', title: 't', url: 'https://a', date: '2026-01-01', sourceType: 'press' },
    ];
    assert.equal(validateRegistry(bad), false);
  });

  test('rejects unknown product', () => {
    const bad = JSON.parse(JSON.stringify(registry));
    const firstKey = Object.keys(bad.shortages)[0]!;
    bad.shortages[firstKey].product = 'kerosene';
    assert.equal(validateRegistry(bad), false);
  });
});

describe('fuel-shortages published lifecycle', () => {
  test('demotes confirmed rows at 7 days and drops rows at 14 days since confirmation', () => {
    const before = buildPayload(new Date('2026-04-21T23:59:59.999Z'));
    assert.equal(before.shortages['pk-petrol-2026-q1'].severity, 'confirmed');
    const demoted = buildPayload(new Date('2026-04-22T00:00:00Z'));
    assert.equal(demoted.shortages['pk-petrol-2026-q1'].severity, 'watch');
    assert.equal(demoted.shortages['pk-petrol-2026-q1'].lastConfirmed, '2026-04-15T00:00:00Z');
    assert.equal(demoted.shortages['cu-diesel-2026-q1'].severity, 'confirmed');
    assert.equal(demoted.shortages['ir-petrol-2026-q1'].severity, 'watch');

    const expired = buildPayload(new Date('2026-04-29T00:00:00Z'));
    assert.equal(expired.shortages['pk-petrol-2026-q1'], undefined);
    assert.equal(expired.shortages['ir-petrol-2026-q1'], undefined);
    assert.equal(expired.shortages['ng-diesel-2026-q1'].severity, 'watch');
  });

  test('publishes an empty registry when every curated row has expired', () => {
    const payload = buildPayload(new Date('2026-05-04T00:00:00Z'));
    assert.deepEqual(payload.shortages, {});
    assert.equal(recordCount(payload), 0);
    assert.equal(payload.updatedAt, '2026-05-04T00:00:00.000Z');
  });
});
