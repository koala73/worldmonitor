import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  ingestHistory,
  processResolutionCycle,
  processResolutionCycleWithJudges,
  receiptNeedsRearchive,
} from '../scripts/seed-forecast-resolutions.mjs';
import { attachResolutionSpecs } from '../scripts/_forecast-resolution.mjs';
import { extractMetricValue, parseMetricKey, resolveHardSpec, shapeResolutionFeeds } from '../scripts/_forecast-resolution-eval.mjs';
import { RECEIPT_VOID_REASON_LABELS, buildPublicReceipts } from '../scripts/_forecast-scorecard.mjs';
import { buildHistoryForecastEntry, detectSupplyChainScenarios, loadCountryCodes, normalizeChokepoints, resolveCountryName } from '../scripts/seed-forecasts.mjs';
import { scoreToStatus } from '../server/worldmonitor/supply-chain/v1/_scoring.mjs';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const at = (iso) => Date.parse(iso);
const CHOKEPOINT_FEED = 'supply_chain:chokepoints:v4';

const noJudges = {
  judgeModels: [
    async () => { throw new Error('no judged row is due in this test'); },
    async () => { throw new Error('no judged row is due in this test'); },
  ],
};

// The resolver's production call shape (buildLedgerForRun).
async function run(ledger, nowMs, feeds = {}) {
  return processResolutionCycleWithJudges(ingestHistory(ledger, [], nowMs), [], feeds, [], nowMs, noJudges);
}

const chokepointFeed = (score) => ({
  chokepoints: [{ id: 'kerch', name: 'Kerch Strait', disruptionScore: score, status: scoreToStatus(score) }],
});

function emittedChokepointForecast(score, generatedAt) {
  const inputs = { chokepoints: normalizeChokepoints(chokepointFeed(score)) };
  const predictions = detectSupplyChainScenarios(inputs);
  attachResolutionSpecs(predictions, inputs, generatedAt);
  return predictions;
}

describe('chokepoint forecasts resolve on the gate that emitted them (#8990)', () => {
  const generatedAt = at('2026-10-01T06:00:00Z');
  const [emitted] = emittedChokepointForecast(100, generatedAt);
  const deadline = Number(emitted.resolution.deadline);

  const outcomeAt = (score) => resolveHardSpec(
    { generatedAt, deadline, spec: emitted.resolution },
    null,
    [{ ts: deadline + HOUR_MS, value: score }],
    deadline + 2 * HOUR_MS,
  ).outcome;

  it('a deadline reading is YES exactly when the detector would still call the chokepoint disrupted', () => {
    assert.equal(emitted.resolution.kind, 'hard');
    const disagreements = [];
    for (let score = 0; score <= 100; score += 1) {
      const stillDisrupted = emittedChokepointForecast(score, generatedAt).length > 0;
      if ((outcomeAt(score) === 'YES') !== stillDisrupted) disagreements.push(score);
    }
    assert.deepEqual(disagreements, []);
  });

  it('the shared floor is the feed\'s own red boundary', async () => {
    const { CHOKEPOINT_DISRUPTED_MIN_SCORE } = await import('../scripts/_forecast-resolution.mjs');
    assert.equal(scoreToStatus(CHOKEPOINT_DISRUPTED_MIN_SCORE), 'red');
    assert.notEqual(scoreToStatus(CHOKEPOINT_DISRUPTED_MIN_SCORE - 1), 'red');
    assert.equal(emitted.resolution.threshold, CHOKEPOINT_DISRUPTED_MIN_SCORE);
  });

  it('a current emission read back from history opens windows already on the rule, with nothing superseded', () => {
    const entry = JSON.parse(JSON.stringify(buildHistoryForecastEntry(emitted)));
    const { ledger } = processResolutionCycle({}, [{ generatedAt, predictions: [entry] }], {}, generatedAt + HOUR_MS);
    const windows = Object.values(ledger);
    assert.equal(windows.length, 1);
    for (const window of windows) {
      assert.equal(window.spec.rule, emitted.resolution.rule, window.key);
      assert.equal(window.spec.supersededThreshold, undefined, window.key);
    }
  });

  const metricKey = `${CHOKEPOINT_FEED}|riskScore(route==Kerch Strait)`;
  const legacySpec = (overrides = {}) => ({
    kind: 'hard', deadline: at('2026-10-13T22:02:03Z'), metricKey, operator: '>=', threshold: 60, window: 'at-deadline', sourceFeed: CHOKEPOINT_FEED, ...overrides,
  });
  const row = (key, overrides) => ({
    key, id: 'fc-supply_chain-89d5ab89', domain: 'supply_chain', region: 'Kerch Strait', title: 'Supply chain disruption: Kerch Strait',
    generationOrigin: 'legacy_detector', probability: 0.6, generatedAt, deadline: at('2026-10-13T22:02:03Z'), spec: legacySpec(), ...overrides,
  });

  it('moves pending rows to the shared rule once and keeps their old threshold', async () => {
    const { CHOKEPOINT_DISRUPTED_MIN_SCORE, CHOKEPOINT_RESOLUTION_RULE, CHOKEPOINT_RESOLUTION_RULE_VERSION } = await import('../scripts/_forecast-resolution.mjs');
    const pending = row('fc-supply_chain-89d5ab89@1', { status: 'pending' });
    const horizon = row('fc-supply_chain-89d5ab89@1@d30', {
      status: 'pending', parentKey: 'fc-supply_chain-89d5ab89@1',
      spec: legacySpec({ horizon: 'd30', timeHorizon: '30d', semantics: 'point_in_time', sampleToleranceMs: DAY_MS }),
    });
    const resolved = row('fc-supply_chain-89d5ab89@0', {
      status: 'resolved', outcome: 'YES', resolvedAt: at('2026-10-07T06:03:40Z'),
      evidence: { metricValue: 70, comparison: '70 >= 60', metricKey, envelopeAware: true },
    });
    const ledger = { [pending.key]: pending, [horizon.key]: horizon, [resolved.key]: resolved };
    const nowMs = at('2026-10-09T06:02:00Z');
    const first = await run(structuredClone(ledger), nowMs);
    const fields = (spec) => [spec.operator, spec.threshold, spec.rule, spec.ruleVersion, spec.supersededThreshold];
    const expected = ['>=', CHOKEPOINT_DISRUPTED_MIN_SCORE, CHOKEPOINT_RESOLUTION_RULE, CHOKEPOINT_RESOLUTION_RULE_VERSION, 60];
    assert.deepEqual(fields(first.ledger[pending.key].spec), expected);
    assert.deepEqual(fields(first.ledger[horizon.key].spec), expected);
    assert.deepEqual(first.ledger[resolved.key], resolved, 'a resolved row keeps the rule it was graded on');
    const second = await run(structuredClone(first.ledger), nowMs + DAY_MS);
    assert.deepEqual(second.ledger[pending.key].spec, first.ledger[pending.key].spec);
  });

  it('migrates a row that carries an older rule version without losing its original threshold', async () => {
    const { CHOKEPOINT_DISRUPTED_MIN_SCORE, CHOKEPOINT_RESOLUTION_RULE, CHOKEPOINT_RESOLUTION_RULE_VERSION } = await import('../scripts/_forecast-resolution.mjs');
    const current = row('k@current', { status: 'pending', spec: legacySpec({ threshold: CHOKEPOINT_DISRUPTED_MIN_SCORE, rule: CHOKEPOINT_RESOLUTION_RULE, ruleVersion: CHOKEPOINT_RESOLUTION_RULE_VERSION }) });
    const older = row('k@older', { id: 'fc-other', status: 'pending', spec: legacySpec({ threshold: 55, rule: CHOKEPOINT_RESOLUTION_RULE, ruleVersion: CHOKEPOINT_RESOLUTION_RULE_VERSION - 1, supersededThreshold: 60 }) });
    const { ledger } = processResolutionCycle({ [current.key]: structuredClone(current), [older.key]: structuredClone(older) }, [], {}, at('2026-10-09T06:02:00Z'));
    assert.deepEqual(ledger[current.key].spec, current.spec);
    assert.deepEqual([ledger[older.key].spec.threshold, ledger[older.key].spec.ruleVersion, ledger[older.key].spec.supersededThreshold], [CHOKEPOINT_DISRUPTED_MIN_SCORE, CHOKEPOINT_RESOLUTION_RULE_VERSION, 60]);
  });
});

describe('a period feed grades on the deadline day\'s observation (#8990)', () => {
  const FEED = 'economic:fred:v1:DGS10:0';
  const deadline = at('2026-09-09T05:04:26.694Z');
  const entry = {
    key: 'macro:DGS10:the 10-year US Treasury yield@1788930266694',
    generatedAt: at('2026-09-02T05:04:26Z'),
    deadline,
    spec: { kind: 'hard', deadline, metricKey: `${FEED}|value(metric==DGS10)`, sourceFeed: FEED, operator: 'crosses', threshold: 4.77375, baselineValue: 4.75, window: 'at-deadline' },
    samples: { count: 2, recent: [{ ts: at('2026-09-08T00:00:00Z'), value: 4.8 }, { ts: at('2026-09-09T00:00:00Z'), value: 4.83 }] },
  };
  const feeds = shapeResolutionFeeds({ [FEED]: { series: { observations: [{ date: '2026-09-09', value: 4.83 }, { date: '2026-09-10', value: 4.7 }] } } });

  it('reads the sample dated the deadline day, not the live value at resolution', () => {
    const result = resolveHardSpec(entry, feeds[FEED], entry.samples, at('2026-09-11T06:04:00Z'));
    assert.equal(result.evidence.readTs, at('2026-09-09T00:00:00Z'));
    assert.equal(result.evidence.metricValue, 4.83);
    assert.equal(result.outcome, 'YES');
  });

  it('never reads a sample dated before the deadline day', () => {
    const early = { ...entry, samples: { count: 1, recent: [{ ts: at('2026-09-08T00:00:00Z'), value: 4.8 }] } };
    const result = resolveHardSpec(early, feeds[FEED], early.samples, at('2026-09-11T06:04:00Z'));
    assert.equal(result.evidence.metricValue, 4.7);
  });
});

describe('every country the detector names resolves back to its code (#8990)', () => {
  const codes = Object.keys(loadCountryCodes());
  const matches = (name, record) => extractMetricValue(parseMetricKey(`infra:outages:v1|present(country==${name})`), [record]) === 1;

  it('matches each emitted name to a record carrying its ISO code, and the code to a record carrying the name', () => {
    assert.ok(codes.length > 150);
    const failures = codes.filter((code) => {
      const name = resolveCountryName(code);
      return !matches(name, { country: code }) || !matches(code, { country: name });
    });
    assert.deepEqual(failures, []);
  });

  it('never matches an emitted name to another country\'s code', () => {
    const collisions = [];
    for (const code of codes) {
      const name = resolveCountryName(code);
      for (const other of codes) if (other !== code && matches(name, { country: other })) collisions.push(`${name}->${other}`);
    }
    assert.deepEqual(collisions, []);
  });
});

describe('VOIDs from a feed the resolver could not read are labelled so (#9013)', () => {
  const REASON = 'resolver_could_not_read_feed';
  const voidRow = (key, sourceFeed, metricKey, resolvedAt, overrides = {}) => ({
    key, id: key.split('@')[0], domain: 'supply_chain', region: 'Eastern Mediterranean', title: key, generationOrigin: 'legacy_detector',
    probability: 0.5, generatedAt: resolvedAt - 8 * DAY_MS, deadline: resolvedAt - DAY_MS,
    spec: { kind: 'hard', deadline: resolvedAt - DAY_MS, metricKey, operator: '>=', threshold: 3, window: 'at-deadline', sourceFeed },
    status: 'resolved', outcome: 'VOID', resolvedAt, sealedAt: resolvedAt, receiptArchivedAt: resolvedAt + HOUR_MS,
    evidence: { reason: 'no_establishable_metric', metricKey, resolvedAt },
    samples: { count: 1, recent: [{ ts: resolvedAt - DAY_MS, error: 'metric_not_found' }] },
    ...overrides,
  });
  const GPS = ['intelligence:gpsjam:v2', 'intelligence:gpsjam:v2|hexCount(region==Eastern Mediterranean)'];
  const INFRA = ['infra:outages:v1', 'infra:outages:v1|present(country==Tanzania)'];
  const MARKET = ['prediction:markets-bootstrap:v1', 'prediction:markets-bootstrap:v1|yesPrice(market==Israel military action against Lebanon on September 26?)'];
  const CHOKE = [CHOKEPOINT_FEED, `${CHOKEPOINT_FEED}|riskScore(route==Suez Canal)`];
  const COMMODITY = ['market:commodities-bootstrap:v1', 'market:commodities-bootstrap:v1|price(symbol==BZ=F)'];

  const relabelled = [
    voidRow('gps-last-before-fix@1', ...GPS, at('2026-10-07T14:46:00Z'), { evidence: { reason: 'no_establishable_metric', metricKey: GPS[1], envelopeAware: true } }),
    voidRow('gps-early@1', ...GPS, at('2026-07-19T06:03:00Z')),
    voidRow('infra@1', ...INFRA, at('2026-07-09T03:42:45Z'), { samples: { count: 0, recent: [] } }),
    voidRow('market@1', ...MARKET, at('2026-10-01T06:03:00Z')),
    voidRow('chokepoint@1', ...CHOKE, at('2026-09-30T06:00:00Z')),
  ];
  const kept = [
    voidRow('gps-after-fix@1', ...GPS, at('2026-10-08T06:01:00Z')),
    voidRow('infra-after-fix@1', ...INFRA, at('2026-10-07T12:44:00Z')),
    voidRow('chokepoint-after-fix@1', ...CHOKE, at('2026-10-06T04:57:00Z')),
    voidRow('gps-other-reason@1', ...GPS, at('2026-07-19T06:03:00Z'), { evidence: { reason: 'unsupported_window', metricKey: GPS[1] } }),
    voidRow('commodity@1', ...COMMODITY, at('2026-09-01T06:03:00Z')),
    voidRow('gps-no@1', ...GPS, at('2026-07-19T06:03:00Z'), { outcome: 'NO', evidence: { reason: 'no_establishable_metric', metricKey: GPS[1] } }),
  ];
  const nowMs = at('2026-10-09T06:02:00Z');
  const ledgerOf = (rows) => Object.fromEntries(rows.map((r) => [r.key, structuredClone(r)]));

  it('relabels exactly the rows sealed before each feed\'s reader fix and keeps the old reason as superseded', async () => {
    const { ledger } = await run(ledgerOf([...relabelled, ...kept]), nowMs);
    for (const original of relabelled) {
      const entry = ledger[original.key];
      assert.equal(entry.outcome, 'VOID', original.key);
      assert.equal(entry.evidence.reason, REASON, original.key);
      assert.deepEqual(entry.evidence.supersededEvidence, original.evidence, original.key);
      assert.equal(entry.evidence.voidedAt, nowMs, original.key);
      assert.equal(entry.resolvedAt, original.resolvedAt, original.key);
      assert.equal(receiptNeedsRearchive(entry), true, `${original.key} is archived again`);
    }
    for (const original of kept) assert.deepEqual(ledger[original.key], original, original.key);
  });

  it('is a no-op on a second run', async () => {
    const first = await run(ledgerOf(relabelled), nowMs);
    const second = await run(structuredClone(first.ledger), nowMs + DAY_MS);
    for (const { key } of relabelled) assert.deepEqual(second.ledger[key], first.ledger[key]);
  });

  it('publishes the accurate label on the receipt', async () => {
    const { ledger } = await run(ledgerOf([relabelled[0]]), nowMs);
    const [receipt] = buildPublicReceipts(ledger, nowMs);
    assert.equal(receipt.voidReason, REASON);
    assert.equal(RECEIPT_VOID_REASON_LABELS[REASON], 'Our resolver could not read this feed correctly');
  });

  it('registers the reason in every VOID-reason surface', () => {
    const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
    const label = RECEIPT_VOID_REASON_LABELS[REASON];
    assert.ok(read('../src/components/forecast-record.ts').includes(`'${REASON}'`), 'client VOID_REASON_CODES');
    assert.ok(read('../api/mcp/registry/cache-tools.ts').includes(`'${REASON}'`), 'MCP reason set');
    assert.ok(read('../api/mcp/ui/forecasts-app.ts').includes(`${REASON}: "${label}"`), 'MCP forecasts app label');
    assert.equal(JSON.parse(read('../src/locales/en.json')).components.forecast.resolution.void[REASON], label);
    assert.equal(JSON.parse(read('../scripts/locale-baselines/app.json'))[`components.forecast.resolution.void.${REASON}`], label);
  });
});
