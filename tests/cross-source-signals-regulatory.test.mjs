import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function normalize(value) {
  return JSON.parse(JSON.stringify(value));
}

const seedSrc = readFileSync('scripts/seed-cross-source-signals.mjs', 'utf8');

const pureSrc = seedSrc
  .replace(/^import\s.*$/gm, '')
  .replace(/loadEnvFile\([^)]+\);\n/, '')
  .replace(/async function readAllSourceKeys[\s\S]*?\n}\n\n\/\/ ── Signal extractors/m, '// readAllSourceKeys removed for unit test\n\n// ── Signal extractors')
  .replace(/runSeed\('intelligence'[\s\S]*$/m, '')
  // Contract migration added `export function declareRecords`; vm.runInContext
  // cannot execute ESM export syntax. Strip the keyword so the function
  // body still evaluates as a plain declaration.
  .replace(/^export\s+(function\s+declareRecords)/m, '$1');

const ctx = vm.createContext({ console, Date, Math, Number, Array, Map, Set, String, RegExp });
vm.runInContext(`${pureSrc}\n;globalThis.__exports = { SOURCE_KEYS, TYPE_CATEGORY, BASE_WEIGHT, scoreTier, extractRegulatoryAction, detectCompositeEscalation };`, ctx);

const {
  SOURCE_KEYS,
  TYPE_CATEGORY,
  BASE_WEIGHT,
  scoreTier,
  extractRegulatoryAction,
  detectCompositeEscalation,
} = ctx.__exports;

describe('source registration', () => {
  it('adds the regulatory seed key to SOURCE_KEYS', () => {
    assert.ok(SOURCE_KEYS.includes('regulatory:actions:v1'));
  });

  it('maps regulatory actions to the policy category and a 2.0 base weight', () => {
    assert.equal(TYPE_CATEGORY.CROSS_SOURCE_SIGNAL_TYPE_REGULATORY_ACTION, 'policy');
    assert.equal(BASE_WEIGHT.CROSS_SOURCE_SIGNAL_TYPE_REGULATORY_ACTION, 2.0);
  });

  it('registers the extractor in the extractor list', () => {
    assert.match(seedSrc, /extractRegulatoryAction,/);
  });
});

describe('extractRegulatoryAction', () => {
  it('returns an empty array when the source key is missing', () => {
    assert.deepEqual(normalize(extractRegulatoryAction({})), []);
  });

  it('returns an empty array when payload.actions is not an array', () => {
    assert.deepEqual(normalize(extractRegulatoryAction({ 'regulatory:actions:v1': { actions: 'corrupted' } })), []);
    assert.deepEqual(normalize(extractRegulatoryAction({ 'regulatory:actions:v1': { actions: null } })), []);
    assert.deepEqual(normalize(extractRegulatoryAction({ 'regulatory:actions:v1': {} })), []);
    assert.deepEqual(normalize(extractRegulatoryAction({ 'regulatory:actions:v1': { actions: 42 } })), []);
  });

  it('emits only high and medium signals, prioritizes high before fresher medium, and limits output to 3', () => {
    const now = Date.now();
    const payload = {
      'regulatory:actions:v1': {
        actions: [
          {
            id: 'fdic-a',
            agency: 'FDIC',
            title: 'FDIC Guidance Update',
            publishedAt: new Date(now - 1 * 3600 * 1000).toISOString(),
            tier: 'medium',
          },
          {
            id: 'sec-c',
            agency: 'SEC',
            title: 'SEC Settlement',
            publishedAt: new Date(now - 5 * 3600 * 1000).toISOString(),
            tier: 'high',
          },
          {
            id: 'sec-a',
            agency: 'SEC',
            title: 'SEC Charges Issuer',
            publishedAt: new Date(now - 2 * 3600 * 1000).toISOString(),
            tier: 'high',
          },
          {
            id: 'finra-low',
            agency: 'FINRA',
            title: 'FINRA Monthly Bulletin',
            publishedAt: new Date(now - 3 * 3600 * 1000).toISOString(),
            tier: 'low',
          },
          {
            id: 'cftc-b',
            agency: 'CFTC',
            title: 'CFTC Advisory Notice',
            publishedAt: new Date(now - 4 * 3600 * 1000).toISOString(),
            tier: 'medium',
          },
          {
            id: 'fed-unknown',
            agency: 'Federal Reserve',
            title: 'Federal Reserve outreach update',
            publishedAt: new Date(now - 30 * 60 * 1000).toISOString(),
            tier: 'unknown',
          },
          {
            id: 'fdic-invalid',
            agency: 'FDIC',
            title: 'FDIC malformed timestamp',
            publishedAt: 'not-a-date',
            tier: 'high',
          },
          {
            id: 'fed-old',
            agency: 'Federal Reserve',
            title: 'Old Enforcement Notice',
            publishedAt: new Date(now - 72 * 3600 * 1000).toISOString(),
            tier: 'high',
          },
        ],
      },
    };

    const signals = normalize(extractRegulatoryAction(payload));
    assert.equal(signals.length, 3);
    assert.deepEqual(signals.map((signal) => signal.id), [
      'regulatory:sec-a',
      'regulatory:sec-c',
      'regulatory:fdic-a',
    ]);
    assert.equal(signals[0].severityScore, 3.0);
    assert.equal(signals[0].severity, 'CROSS_SOURCE_SIGNAL_SEVERITY_HIGH');
    assert.equal(signals[1].severityScore, 3.0);
    assert.equal(signals[1].severity, 'CROSS_SOURCE_SIGNAL_SEVERITY_HIGH');
    assert.equal(signals[2].severityScore, 2.0);
    assert.equal(signals[2].severity, 'CROSS_SOURCE_SIGNAL_SEVERITY_MEDIUM');
    assert.equal(signals[0].theater, 'Global Markets');
    assert.equal(signals[0].summary, 'SEC: SEC Charges Issuer');
    assert.ok(signals.every((signal) => Number.isFinite(signal.detectedAt)));
  });
});

describe('detectCompositeEscalation', () => {
  it('fires when policy, financial, and economic signals co-fire in Global Markets', () => {
    const composite = normalize(detectCompositeEscalation([
      {
        id: 'regulatory:sec-a',
        type: 'CROSS_SOURCE_SIGNAL_TYPE_REGULATORY_ACTION',
        theater: 'Global Markets',
        summary: 'SEC: SEC Charges Issuer',
        severity: scoreTier(3.0),
        severityScore: 3.0,
        detectedAt: Date.now(),
        contributingTypes: [],
        signalCount: 0,
      },
      {
        id: 'vix:global',
        type: 'CROSS_SOURCE_SIGNAL_TYPE_VIX_SPIKE',
        theater: 'Global Markets',
        summary: 'VIX elevated',
        severity: scoreTier(2.0),
        severityScore: 2.0,
        detectedAt: Date.now(),
        contributingTypes: [],
        signalCount: 0,
      },
      {
        id: 'commodity:oil',
        type: 'CROSS_SOURCE_SIGNAL_TYPE_COMMODITY_SHOCK',
        theater: 'Global Markets',
        summary: 'Oil shock',
        severity: scoreTier(2.0),
        severityScore: 2.0,
        detectedAt: Date.now(),
        contributingTypes: [],
        signalCount: 0,
      },
    ]));

    assert.equal(composite.length, 1);
    assert.equal(composite[0].type, 'CROSS_SOURCE_SIGNAL_TYPE_COMPOSITE_ESCALATION');
    assert.equal(composite[0].theater, 'Global Markets');
    assert.ok(composite[0].contributingTypes.includes('regulatory action'));
    assert.ok(composite[0].contributingTypes.includes('vix spike'));
    assert.ok(composite[0].contributingTypes.includes('commodity shock'));
  });
});
