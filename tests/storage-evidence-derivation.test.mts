import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deriveStoragePublicBadge,
  STORAGE_BADGE_DERIVER_VERSION,
  type StorageEvidenceInput,
} from '../src/shared/storage-evidence';

const __dirname = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(resolve(__dirname, '../scripts/data/storage-facilities.json'), 'utf-8');
const registry = JSON.parse(raw) as { facilities: Record<string, { id: string; evidence: StorageEvidenceInput & { lastEvidenceUpdate: string } }> };

const NOW = Date.parse('2026-04-22T00:00:00Z');
const VALID = new Set(['operational', 'reduced', 'offline', 'disputed']);

describe('deriveStoragePublicBadge — full registry coverage', () => {
  test('every curated facility yields a valid badge', () => {
    for (const [id, f] of Object.entries(registry.facilities)) {
      const badge = deriveStoragePublicBadge(f.evidence, NOW);
      assert.ok(VALID.has(badge), `${id}: bad badge ${badge}`);
    }
  });

  test('raw entries NEVER ship with pre-computed publicBadge (contract)', () => {
    for (const f of Object.values(registry.facilities)) {
      assert.equal((f as any).publicBadge, undefined,
        `${f.id}: registry MUST NOT pre-compute publicBadge`);
    }
  });

  test('deriver version is stable for registry v1', () => {
    assert.equal(STORAGE_BADGE_DERIVER_VERSION, 'storage-badge-deriver-v1');
  });
});

describe('deriveStoragePublicBadge — null / malformed input', () => {
  test('undefined input returns "disputed"', () => {
    assert.equal(deriveStoragePublicBadge(undefined, NOW), 'disputed');
  });

  test('null input returns "disputed"', () => {
    assert.equal(deriveStoragePublicBadge(null, NOW), 'disputed');
  });

  test('empty object returns "disputed"', () => {
    assert.equal(deriveStoragePublicBadge({} as StorageEvidenceInput, NOW), 'disputed');
  });

  test('never throws on malformed input', () => {
    // Deliberately hostile inputs.
    assert.doesNotThrow(() => deriveStoragePublicBadge({ physicalState: 'garbage' } as any, NOW));
    assert.doesNotThrow(() => deriveStoragePublicBadge({ sanctionRefs: [null as any] }, NOW));
    assert.doesNotThrow(() => deriveStoragePublicBadge({ operatorStatement: null }, NOW));
  });
});

describe('deriveStoragePublicBadge — operational / reduced', () => {
  test('operational regardless of staleness returns "operational"', () => {
    const fresh: StorageEvidenceInput = {
      physicalState: 'operational',
      physicalStateSource: 'operator',
      lastEvidenceUpdate: '2026-04-15T00:00:00Z',
    };
    assert.equal(deriveStoragePublicBadge(fresh, NOW), 'operational');
    const stale: StorageEvidenceInput = {
      physicalState: 'operational',
      physicalStateSource: 'operator',
      lastEvidenceUpdate: '2020-01-01T00:00:00Z',
    };
    // Positive "operational" claims are safe even on old data.
    assert.equal(deriveStoragePublicBadge(stale, NOW), 'operational');
  });

  test('reduced fresh returns "reduced", stale falls to "disputed"', () => {
    const fresh: StorageEvidenceInput = {
      physicalState: 'reduced',
      physicalStateSource: 'operator',
      lastEvidenceUpdate: '2026-04-15T00:00:00Z',
    };
    assert.equal(deriveStoragePublicBadge(fresh, NOW), 'reduced');
    const stale: StorageEvidenceInput = {
      physicalState: 'reduced',
      physicalStateSource: 'operator',
      lastEvidenceUpdate: '2026-04-01T00:00:00Z',
    };
    assert.equal(deriveStoragePublicBadge(stale, NOW), 'disputed');
  });
});

describe('deriveStoragePublicBadge — offline rules', () => {
  test('offline + sanction refs → "offline"', () => {
    const ev: StorageEvidenceInput = {
      physicalState: 'offline',
      physicalStateSource: 'operator',
      sanctionRefs: [{ authority: 'US', listId: 'X', date: '2024-01-01', url: 'https://t.co/a' }],
      lastEvidenceUpdate: '2026-04-15T00:00:00Z',
    };
    assert.equal(deriveStoragePublicBadge(ev, NOW), 'offline');
  });

  test('offline + commercialState=suspended → "offline"', () => {
    const ev: StorageEvidenceInput = {
      physicalState: 'offline',
      physicalStateSource: 'operator',
      commercialState: 'suspended',
      lastEvidenceUpdate: '2026-04-15T00:00:00Z',
    };
    assert.equal(deriveStoragePublicBadge(ev, NOW), 'offline');
  });

  test('offline + operator statement → "offline"', () => {
    const ev: StorageEvidenceInput = {
      physicalState: 'offline',
      physicalStateSource: 'operator',
      operatorStatement: { text: 'Maintenance window', url: '', date: '2026-04-10' },
      lastEvidenceUpdate: '2026-04-15T00:00:00Z',
    };
    assert.equal(deriveStoragePublicBadge(ev, NOW), 'offline');
  });

  test('offline from press-only signal → "disputed" (no paperwork)', () => {
    const ev: StorageEvidenceInput = {
      physicalState: 'offline',
      physicalStateSource: 'press',
      lastEvidenceUpdate: '2026-04-15T00:00:00Z',
    };
    assert.equal(deriveStoragePublicBadge(ev, NOW), 'disputed');
  });

  test('offline + sanction refs, stale evidence → "disputed"', () => {
    const ev: StorageEvidenceInput = {
      physicalState: 'offline',
      physicalStateSource: 'operator',
      sanctionRefs: [{ authority: 'US', listId: 'X', date: '2024-01-01', url: 'https://t.co/a' }],
      lastEvidenceUpdate: '2020-01-01T00:00:00Z',
    };
    assert.equal(deriveStoragePublicBadge(ev, NOW), 'disputed');
  });

  test('offline with zero supporting evidence → "disputed"', () => {
    const ev: StorageEvidenceInput = {
      physicalState: 'offline',
      physicalStateSource: 'operator',
      lastEvidenceUpdate: '2026-04-15T00:00:00Z',
    };
    assert.equal(deriveStoragePublicBadge(ev, NOW), 'disputed');
  });
});

describe('deriveStoragePublicBadge — under_construction / unknown', () => {
  test('under_construction returns "disputed"', () => {
    const ev: StorageEvidenceInput = {
      physicalState: 'under_construction',
      physicalStateSource: 'operator',
      lastEvidenceUpdate: '2026-04-15T00:00:00Z',
    };
    assert.equal(deriveStoragePublicBadge(ev, NOW), 'disputed');
  });

  test('unknown returns "disputed"', () => {
    const ev: StorageEvidenceInput = {
      physicalState: 'unknown',
      physicalStateSource: 'operator',
      lastEvidenceUpdate: '2026-04-15T00:00:00Z',
    };
    assert.equal(deriveStoragePublicBadge(ev, NOW), 'disputed');
  });
});
