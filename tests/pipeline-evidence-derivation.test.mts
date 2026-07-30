import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import { derivePublicBadge, DERIVER_VERSION } from '../server/worldmonitor/supply-chain/v1/_pipeline-evidence';
import { pickNewerClassifierVersion, pickNewerIsoTimestamp } from '../src/shared/pipeline-evidence';

const NOW = Date.parse('2026-04-22T12:00:00Z');
const FRESH = '2026-04-20T00:00:00Z';          // 2 days old — fresh
const STALE = '2026-03-01T00:00:00Z';          // ~52 days old — stale

function base(overrides: Partial<any> = {}): any {
  return {
    physicalState: 'flowing',
    physicalStateSource: 'operator',
    operatorStatement: undefined,
    commercialState: 'under_contract',
    sanctionRefs: [],
    lastEvidenceUpdate: FRESH,
    classifierVersion: 'v1',
    classifierConfidence: 0.9,
    ...overrides,
  };
}

describe('derivePublicBadge — happy paths', () => {
  test('flowing → flowing', () => {
    assert.equal(derivePublicBadge(base({ physicalState: 'flowing' }), NOW), 'flowing');
  });

  test('reduced → reduced', () => {
    assert.equal(derivePublicBadge(base({ physicalState: 'reduced' }), NOW), 'reduced');
  });

  test('offline + sanction ref → offline', () => {
    assert.equal(
      derivePublicBadge(base({
        physicalState: 'offline',
        physicalStateSource: 'press',
        sanctionRefs: [{ authority: 'EU', listId: '2022/879', date: '2022-06-03', url: 'https://x' }],
      }), NOW),
      'offline',
    );
  });

  test('offline + expired contract → offline', () => {
    assert.equal(
      derivePublicBadge(base({
        physicalState: 'offline',
        physicalStateSource: 'press',
        commercialState: 'expired',
      }), NOW),
      'offline',
    );
  });

  test('offline + operator statement → offline', () => {
    assert.equal(
      derivePublicBadge(base({
        physicalState: 'offline',
        physicalStateSource: 'operator',
        operatorStatement: { text: 'force majeure', url: 'https://x', date: '2024-01-01' },
      }), NOW),
      'offline',
    );
  });
});

describe('derivePublicBadge — disputed tier (single-source or stale)', () => {
  test('offline + press-only (no sanction / contract / operator) → disputed', () => {
    assert.equal(
      derivePublicBadge(base({
        physicalState: 'offline',
        physicalStateSource: 'press',
      }), NOW),
      'disputed',
    );
  });

  test('offline + ais-relay only → disputed', () => {
    assert.equal(
      derivePublicBadge(base({
        physicalState: 'offline',
        physicalStateSource: 'ais-relay',
      }), NOW),
      'disputed',
    );
  });

  test('unknown physical state → disputed', () => {
    assert.equal(derivePublicBadge(base({ physicalState: 'unknown' }), NOW), 'disputed');
  });

  test('undefined evidence → disputed', () => {
    assert.equal(derivePublicBadge(undefined, NOW), 'disputed');
  });
});

describe('derivePublicBadge — staleness guard', () => {
  test('offline + sanction ref + STALE evidence → disputed (not offline)', () => {
    assert.equal(
      derivePublicBadge(base({
        physicalState: 'offline',
        sanctionRefs: [{ authority: 'EU', listId: 'x', date: 'x', url: 'x' }],
        lastEvidenceUpdate: STALE,
      }), NOW),
      'disputed',
    );
  });

  test('reduced + STALE evidence → disputed', () => {
    assert.equal(
      derivePublicBadge(base({
        physicalState: 'reduced',
        lastEvidenceUpdate: STALE,
      }), NOW),
      'disputed',
    );
  });

  test('flowing + STALE evidence → flowing (optimistic default)', () => {
    assert.equal(
      derivePublicBadge(base({ lastEvidenceUpdate: STALE }), NOW),
      'flowing',
    );
  });

  test('undefined lastEvidenceUpdate treated as stale for non-flowing', () => {
    assert.equal(
      derivePublicBadge(base({
        physicalState: 'offline',
        sanctionRefs: [{ authority: 'EU', listId: 'x', date: 'x', url: 'x' }],
        lastEvidenceUpdate: '',
      }), NOW),
      'disputed',
    );
  });
});

describe('derivePublicBadge — versioning', () => {
  test('DERIVER_VERSION is exported and versioned', () => {
    assert.ok(DERIVER_VERSION.startsWith('badge-deriver-v'));
  });

  test('deterministic — same input produces same output', () => {
    const ev = base({ physicalState: 'reduced' });
    assert.equal(derivePublicBadge(ev, NOW), derivePublicBadge(ev, NOW));
  });
});

describe('pickNewerClassifierVersion — real comparison, not gas-preference', () => {
  test('returns the higher v-numbered version', () => {
    assert.equal(pickNewerClassifierVersion('v1', 'v2'), 'v2');
    assert.equal(pickNewerClassifierVersion('v2', 'v1'), 'v2');
    assert.equal(pickNewerClassifierVersion('v1', 'v10'), 'v10');
  });

  test('returns unique value when either is missing', () => {
    assert.equal(pickNewerClassifierVersion('', 'v2'), 'v2');
    assert.equal(pickNewerClassifierVersion('v2', ''), 'v2');
    assert.equal(pickNewerClassifierVersion(undefined, undefined), 'v1');
  });

  test('falls back to lexicographic on non-v-numbered values', () => {
    assert.equal(pickNewerClassifierVersion('alpha', 'beta'), 'beta');
  });

  test('gas=v1 + oil=v2 during rollout → v2 (not gas-preference)', () => {
    assert.equal(pickNewerClassifierVersion('v1', 'v2'), 'v2');
  });
});

describe('pickNewerIsoTimestamp — actual timestamp comparison', () => {
  test('returns the newer ISO', () => {
    const a = '2026-04-20T00:00:00Z';
    const b = '2026-04-22T00:00:00Z';
    assert.equal(pickNewerIsoTimestamp(a, b), b);
    assert.equal(pickNewerIsoTimestamp(b, a), b);
  });

  test('returns the valid one when the other is missing / invalid', () => {
    const valid = '2026-04-22T00:00:00Z';
    assert.equal(pickNewerIsoTimestamp(valid, undefined), valid);
    assert.equal(pickNewerIsoTimestamp(undefined, valid), valid);
    assert.equal(pickNewerIsoTimestamp(valid, 'not-an-iso'), valid);
  });

  test('both empty → empty string', () => {
    assert.equal(pickNewerIsoTimestamp(undefined, undefined), '');
    assert.equal(pickNewerIsoTimestamp('', ''), '');
  });

  test('oil fresher than gas during rollout → oil timestamp (not gas-preference)', () => {
    const gasStale = '2026-04-15T00:00:00Z';
    const oilFresh = '2026-04-22T12:00:00Z';
    assert.equal(pickNewerIsoTimestamp(gasStale, oilFresh), oilFresh);
  });
});
