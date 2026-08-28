import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import YAML from 'yaml';

import { __testing__ as healthTesting } from '../api/health.js';
import {
  applyAcceptanceBaseline,
  buildAcceptanceObservation,
  findOperationalProblems,
  formatAcceptanceReport,
  isOnDemandProblem,
  validateAcceptanceBaseline,
  validateCompactHealthPayload,
} from '../scripts/check-seed-freshness.mjs';
import { buildSeedHealthStatuses } from '../scripts/update-seed-health-statuses.mjs';
import { validateHealthProbeCutovers } from '../scripts/check-health-probe-cutovers.mts';

const COMMITTED_BASELINE_URL = new URL('../scripts/seed-freshness-baseline.json', import.meta.url);
const PR_TEMPLATE_URL = new URL('../.github/pull_request_template.md', import.meta.url);
const LONG_CRON_RUNBOOK_URL = new URL(
  '../docs/solutions/integration-issues/merged-is-not-ran-long-cron-seeders.md',
  import.meta.url,
);
const RAILWAY_SERVICES_URL = new URL('../scripts/railway-services.json', import.meta.url);
const TEST_WORKFLOW_URL = new URL('../.github/workflows/test.yml', import.meta.url);
const PRE_PUSH_HOOK_URL = new URL('../.husky/pre-push', import.meta.url);
const readCommittedBaseline = () => JSON.parse(readFileSync(COMMITTED_BASELINE_URL, 'utf8'));
const readRailwayServices = () => JSON.parse(readFileSync(RAILWAY_SERVICES_URL, 'utf8'));

describe('scheduled seed freshness monitor', () => {
  it('projects stable per-source statuses without putting changing ages in the incident identity', () => {
    const base = {
      blocking: [
        { name: 'consumerPricesCoverageUS', status: 'COVERAGE_DEGRADED', seedAgeMin: 925 },
        { name: 'jodiGas', status: 'STALE_CONTENT', seedAgeMin: 9266 },
      ],
      acknowledged: [{ name: 'mineralProduction', status: 'EMPTY', issue: 6439 }],
      cleared: [],
      escalated: [],
      expired: false,
      expiresAt: '2026-08-27',
    };
    const statuses = buildSeedHealthStatuses(base);
    assert.deepEqual(statuses, [
      {
        context: 'ingestion/seed/acceptance',
        state: 'pending',
        description: '2 source incidents remain active',
      },
      {
        context: 'ingestion/seed/consumerPricesCoverageUS',
        state: 'failure',
        description: 'COVERAGE_DEGRADED blocks operational acceptance',
      },
      {
        context: 'ingestion/seed/jodiGas',
        state: 'failure',
        description: 'STALE_CONTENT blocks operational acceptance',
      },
      {
        context: 'ingestion/seed/mineralProduction',
        state: 'pending',
        description: 'EMPTY acknowledged by #6439',
      },
    ]);

    const olderAges = structuredClone(base);
    olderAges.blocking[0].seedAgeMin = 1;
    olderAges.blocking[1].seedAgeMin = 2;
    assert.deepEqual(buildSeedHealthStatuses(olderAges), statuses);
  });

  it('makes an expired suppression and a clean recovery machine-visible', () => {
    assert.deepEqual(buildSeedHealthStatuses({
      blocking: [],
      acknowledged: [],
      cleared: [],
      escalated: [],
      expired: true,
      expiresAt: '2026-08-27',
    }), [
      {
        context: 'ingestion/seed/acceptance',
        state: 'pending',
        description: 'accepted-problem baseline requires review',
      },
      {
        context: 'ingestion/seed/baseline',
        state: 'failure',
        description: 'accepted-problem baseline expired on 2026-08-27',
      },
    ]);

    assert.deepEqual(buildSeedHealthStatuses({
      blocking: [],
      acknowledged: [],
      cleared: [],
      escalated: [],
      expired: false,
      expiresAt: '2026-08-27',
    }), [{
      context: 'ingestion/seed/acceptance',
      state: 'success',
      description: 'ingestion operational acceptance passed',
    }]);
  });

  it('builds one structured observation from the same strict acceptance split as the text report', () => {
    const payload = {
      status: 'WARNING',
      checkedAt: '2026-08-17T20:00:00+02:00',
      problems: { submarineCables: { status: 'EMPTY', records: 0 } },
    };
    const observation = buildAcceptanceObservation(payload, {
      expiresAt: '2026-08-27',
      acknowledged: [],
    }, Date.parse('2026-08-17T18:00:00.000Z'));

    assert.equal(observation.version, 1);
    assert.equal(observation.checkedAt, '2026-08-17T18:00:00.000Z');
    assert.deepEqual(observation.acceptance.blocking, [{
      name: 'submarineCables',
      status: 'EMPTY',
      records: 0,
    }]);
    assert.equal(observation.report.failed, true);
  });

  it('refuses an observation without a current valid health timestamp', () => {
    const now = Date.parse('2026-08-17T18:00:00.000Z');
    const baseline = { expiresAt: '2026-08-27', acknowledged: [] };
    const payload = (checkedAt) => ({
      status: 'HEALTHY',
      ...(checkedAt === undefined ? {} : { checkedAt }),
    });

    for (const [label, checkedAt] of [
      ['missing', undefined],
      ['malformed', '2026-08-17 18:00:00Z'],
      ['impossible calendar date', '2026-02-30T18:00:00.000Z'],
      ['future', '2026-08-17T18:00:00.001Z'],
      ['expired cache snapshot', '2026-08-17T17:58:39.999Z'],
    ]) {
      assert.throws(
        () => buildAcceptanceObservation(payload(checkedAt), baseline, now),
        /checkedAt/,
        `${label} checkedAt must not produce a publishable observation`,
      );
    }
  });

  it('grades every actionable status, not only STALE_SEED', () => {
    // The predecessor of this gate filtered on `status === 'STALE_SEED'` alone,
    // so a seeder that errored outright or published an empty key never paged.
    const payload = {
      status: 'UNHEALTHY',
      checkedAt: '2026-07-13T17:45:19.746Z',
      summary: { total: 4, ok: 0, warn: 2, onDemandWarn: 0, staleContent: 0, crit: 2 },
      problems: {
        wildfire: { status: 'STALE_SEED', seedAgeMin: 361, maxStaleMin: 360 },
        frozenFeed: { status: 'STALE_CONTENT', contentAgeMin: 91, maxContentAgeMin: 90 },
        emptyFeed: { status: 'EMPTY', records: 0, maxStaleMin: 180 },
        failedFeed: { status: 'SEED_ERROR', records: 1, maxStaleMin: 120 },
      },
    };

    assert.deepEqual(
      findOperationalProblems(payload).map((p) => p.name),
      ['emptyFeed', 'failedFeed', 'frozenFeed', 'wildfire'],
    );
  });

  it('treats every non-on-demand health problem as an operational failure', () => {
    const payload = {
      status: 'WARNING',
      checkedAt: '2026-07-28T08:56:11.076Z',
      problems: {
        gdeltIntel: { status: 'SEED_ERROR', records: 1 },
        chinaCoverage: { status: 'CHINA_DEGRADED', records: 15 },
        humanitarianSummary: { status: 'SEED_ERROR', records: 1 },
        shippingRates: { status: 'STALE_SEED', seedAgeMin: 528, maxStaleMin: 420 },
        newsRecallBenchmark: { status: 'EMPTY_ON_DEMAND', records: 0 },
      },
    };

    assert.deepEqual(findOperationalProblems(payload), [
      { name: 'chinaCoverage', status: 'CHINA_DEGRADED', records: 15 },
      { name: 'gdeltIntel', status: 'SEED_ERROR', records: 1 },
      { name: 'humanitarianSummary', status: 'SEED_ERROR', records: 1 },
      {
        name: 'shippingRates',
        status: 'STALE_SEED',
        records: undefined,
        seedAgeMin: 528,
        maxStaleMin: 420,
      },
    ]);
  });

  it('exempts on-demand sources only for the states being on-demand explains', () => {
    // The marker means "RPC-populated, or awaiting its first producer run", so
    // it excuses ABSENCE and nothing more. EMPTY_ON_DEMAND is the only
    // *_ON_DEMAND status api/health.js emits and it covers exactly those
    // branches; the marker path must not be broader than the suffix path.
    assert.equal(isOnDemandProblem({ status: 'EMPTY_ON_DEMAND' }), true);
    assert.equal(isOnDemandProblem({ status: 'EMPTY', onDemand: true }), true);
    assert.equal(isOnDemandProblem({ status: 'EMPTY_DATA', onDemand: true }), true);
    assert.equal(isOnDemandProblem({ status: 'STALE_SEED' }), false);
    assert.equal(isOnDemandProblem({ status: 'SEED_ERROR', onDemand: false }), false);
    // Boundary: contains the token but does not end with it, and non-string.
    assert.equal(isOnDemandProblem({ status: 'EMPTY_ON_DEMAND_LEGACY' }), false);
    assert.equal(isOnDemandProblem({ status: 42 }), false);
    assert.equal(isOnDemandProblem({}), false);
  });

  it('never softens a fault status on an on-demand source', () => {
    // api/health.js's ON_DEMAND_KEYS policy block records the incident: a
    // homepage panel sat at 8.2x its staleness budget for 16+ hours undetected
    // because on-demand softening hid a chronic provider failure. `shippingRates`
    // has no ACTIVATION_MARKERS entry, so its marker is permanent -- softening
    // fault statuses would make it unmonitorable forever.
    assert.equal(isOnDemandProblem({ status: 'SEED_ERROR', onDemand: true }), false);
    assert.equal(isOnDemandProblem({ status: 'STALE_SEED', onDemand: true }), false);
    assert.equal(isOnDemandProblem({ status: 'CHINA_DEGRADED', onDemand: true }), false);
    assert.equal(isOnDemandProblem({ status: 'COVERAGE_PARTIAL', onDemand: true }), false);

    assert.deepEqual(
      findOperationalProblems({
        status: 'WARNING',
        problems: {
          shippingRates: { status: 'STALE_SEED', onDemand: true, seedAgeMin: 716, maxStaleMin: 420 },
          gdeltIntel: { status: 'SEED_ERROR', records: 1 },
          newsRecallBenchmark: { status: 'EMPTY_ON_DEMAND', records: 0 },
        },
      }).map((p) => p.name),
      ['gdeltIntel', 'shippingRates'],
    );
  });

  it('blocks when the scheduled shipping data expires after recovery', () => {
    const { SEED_META, STANDALONE_KEYS, classifyKey } = healthTesting;
    const name = 'shippingRates';
    const dataKey = STANDALONE_KEYS[name];
    const metaKey = SEED_META[name].key;
    const now = Date.parse('2026-07-28T21:00:00Z');
    assert.equal(
      dataKey,
      'supply_chain:shipping:v2',
      'health must keep the canonical shipping key registered',
    );
    const entry = classifyKey(name, dataKey, { allowOnDemand: true }, {
      keyStrens: new Map([[dataKey, 0]]),
      keyErrors: new Map(),
      keyMetaValues: new Map([[metaKey, JSON.stringify({
        fetchedAt: now - 9 * 60 * 60 * 1000,
        recordCount: 9,
      })]]),
      keyMetaErrors: new Map(),
      activationStates: new Map(),
      now,
    });
    const committed = readCommittedBaseline();
    const result = applyAcceptanceBaseline(
      findOperationalProblems({ status: 'WARNING', problems: { [name]: entry } }),
      committed,
      now,
    );

    assert.equal(entry.status, 'EMPTY');
    assert.deepEqual(result.blocking.map((problem) => problem.name), [name]);
  });

  it('binds stale shipping health to the producer heartbeat and cadence', () => {
    const { SEED_META, STANDALONE_KEYS, classifyKey } = healthTesting;
    const name = 'shippingRates';
    const dataKey = STANDALONE_KEYS[name];
    const expectedMeta = {
      key: 'seed-meta:supply_chain:shipping',
      maxStaleMin: 420,
    };
    const now = Date.parse('2026-07-28T21:00:00Z');

    assert.deepEqual(
      SEED_META[name],
      expectedMeta,
      'health must read the heartbeat written by the scheduled shipping producer',
    );
    const service = readRailwayServices().find((entry) => entry.service === 'seed-supply-chain-trade');
    assert.equal(service?.cronSchedule, '0 */6 * * *');
    assert.equal(
      expectedMeta.maxStaleMin,
      6 * 60 + 60,
      'health must allow one hour of headroom beyond the six-hour cron',
    );

    const entry = classifyKey(name, dataKey, { allowOnDemand: true }, {
      keyStrens: new Map([[dataKey, 1]]),
      keyErrors: new Map(),
      keyMetaValues: new Map([[expectedMeta.key, JSON.stringify({
        fetchedAt: now - (expectedMeta.maxStaleMin + 1) * 60 * 1000,
        recordCount: 9,
      })]]),
      keyMetaErrors: new Map(),
      activationStates: new Map(),
      now,
    });
    const result = applyAcceptanceBaseline(
      findOperationalProblems({ status: 'WARNING', problems: { [name]: entry } }),
      readCommittedBaseline(),
      now,
    );

    assert.equal(entry.status, 'STALE_SEED');
    assert.equal(entry.maxStaleMin, expectedMeta.maxStaleMin);
    assert.deepEqual(result.blocking.map((problem) => problem.name), [name]);
  });

  it('treats an all-absent on-demand payload as clean', () => {
    assert.deepEqual(
      findOperationalProblems({
        status: 'WARNING',
        problems: {
          newsRecallBenchmark: { status: 'EMPTY_ON_DEMAND', records: 0 },
          resilienceRanking: { status: 'EMPTY', onDemand: true, records: 0 },
        },
      }),
      [],
    );
  });

  it('rejects payloads that cannot prove compact seed freshness', () => {
    assert.throws(() => validateCompactHealthPayload(null), /object/);
    assert.deepEqual(findOperationalProblems({ status: 'HEALTHY' }), []);
    assert.throws(() => validateCompactHealthPayload({ status: 'WARNING' }), /problems/);
    assert.throws(
      () => validateCompactHealthPayload({ status: 'HEALTHY', problems: [] }),
      /problems/,
    );
  });

  describe('accepted-problem baseline', () => {
    const baseline = {
      expiresAt: '2026-08-27',
      acknowledged: [
        { name: 'gdeltIntel', status: 'SEED_ERROR', issue: 5756 },
        { name: 'crossStraitActivityJapanMod', status: 'SEED_ERROR', issue: 5714 },
      ],
    };
    const at = (iso) => Date.parse(iso);

    it('passes a known-degraded source and blocks an unknown one', () => {
      const result = applyAcceptanceBaseline(
        [
          { name: 'crossStraitActivityJapanMod', status: 'SEED_ERROR' },
          { name: 'gdeltIntel', status: 'SEED_ERROR' },
          { name: 'supplyChainTrade', status: 'STALE_SEED' },
        ],
        baseline,
        at('2026-08-01'),
      );
      assert.deepEqual(result.blocking.map((p) => p.name), ['supplyChainTrade']);
      assert.deepEqual(result.acknowledged.map((p) => p.name), ['crossStraitActivityJapanMod', 'gdeltIntel']);
      assert.equal(result.expired, false);
    });

    it('acknowledges a matching problem before its entry-level expiry', () => {
      const rolloutBaseline = {
        ...baseline,
        acknowledged: [{
          name: 'tariffTrendsUs',
          status: 'EMPTY',
          issue: 6377,
          expiresAt: '2026-08-10T12:00:00.000Z',
        }],
      };
      const result = applyAcceptanceBaseline(
        [{ name: 'tariffTrendsUs', status: 'EMPTY' }],
        rolloutBaseline,
        at('2026-08-10T11:59:59.999Z'),
      );

      assert.deepEqual(result.blocking, []);
      assert.deepEqual(result.acknowledged, [
        { name: 'tariffTrendsUs', status: 'EMPTY', issue: 6377 },
      ]);
    });

    it('fails closed at and after an entry-level expiry while the root baseline remains valid', () => {
      const rolloutBaseline = {
        ...baseline,
        acknowledged: [{
          name: 'tariffTrendsUs',
          status: 'EMPTY',
          issue: 6377,
          expiresAt: '2026-08-10T12:00:00.000Z',
        }],
      };
      const problem = { name: 'tariffTrendsUs', status: 'EMPTY' };

      for (const now of [
        '2026-08-10T12:00:00.000Z',
        '2026-08-10T12:00:00.001Z',
      ]) {
        const result = applyAcceptanceBaseline([problem], rolloutBaseline, at(now));
        // The blocking item carries the expired entry's identity so the report
        // can attribute the red line to a scheduled re-page instead of a fresh
        // outage (#6483 review) — the fail-closed split itself is unchanged.
        assert.deepEqual(result.blocking, [
          { ...problem, expiredEntry: '2026-08-10T12:00:00.000Z', issue: 6377 },
        ], now);
        assert.deepEqual(result.acknowledged, [], now);
        assert.deepEqual(result.cleared, [], now);
        assert.deepEqual(result.escalated, [], now);
        assert.equal(result.expired, false, 'the later root expiry keeps its existing semantics');
      }
    });

    it('blocks when a baselined source fails with a DIFFERENT status', () => {
      // A source degrading further is new information, not the accepted state.
      const result = applyAcceptanceBaseline(
        [{ name: 'gdeltIntel', status: 'EMPTY_DATA' }],
        baseline,
        at('2026-08-01'),
      );
      assert.deepEqual(result.blocking.map((p) => p.status), ['EMPTY_DATA']);
      assert.deepEqual(result.acknowledged, []);
    });

    it('reports a recovered source without failing the gate', () => {
      // Deliberately non-fatal: these sources flap between polls, and failing on
      // recovery would red the monitor on exactly the runs proving improvement.
      const result = applyAcceptanceBaseline(
        [{ name: 'gdeltIntel', status: 'SEED_ERROR' }],
        baseline,
        at('2026-08-01'),
      );
      assert.deepEqual(result.cleared, [
        { name: 'crossStraitActivityJapanMod', status: 'SEED_ERROR', issue: 5714 },
      ]);
      assert.equal(result.blocking.length, 0);
    });

    it('calls a baselined source that changed status escalated, never recovered (#6263)', () => {
      // The acknowledgment is keyed on name:status, so a source that gets WORSE
      // stops matching exactly like one that recovers. Both then land in the
      // same "no longer reported" bucket, and the report tells the operator to
      // delete a suppression for a source that is still broken — while the same
      // run fails the gate on the new status. #6263 made this reachable: a
      // blocked source whose data key also expires moves SEED_ERROR -> EMPTY.
      const result = applyAcceptanceBaseline(
        [{ name: 'crossStraitActivityJapanMod', status: 'EMPTY' }],
        baseline,
        at('2026-08-01'),
      );

      assert.equal(
        result.cleared.some((entry) => entry.name === 'crossStraitActivityJapanMod'),
        false,
        'the source is still reporting a problem, so it has not recovered',
      );
      assert.deepEqual(result.escalated, [
        { name: 'crossStraitActivityJapanMod', status: 'SEED_ERROR', observedStatus: 'EMPTY', issue: 5714 },
      ]);
      assert.deepEqual(
        result.blocking.map((p) => p.status),
        ['EMPTY'],
        'the unacknowledged worse status still blocks — escalation is reported, never suppressed',
      );
    });

    it('still reports a genuinely recovered source as recovered', () => {
      // The other side of the same split: absent from the problem set entirely
      // is the only thing that counts as recovery.
      const result = applyAcceptanceBaseline(
        [{ name: 'gdeltIntel', status: 'SEED_ERROR' }],
        baseline,
        at('2026-08-01'),
      );
      assert.deepEqual(result.cleared, [
        { name: 'crossStraitActivityJapanMod', status: 'SEED_ERROR', issue: 5714 },
      ]);
      assert.deepEqual(result.escalated, []);
    });

    it('expires so the baseline cannot silently become permanent', () => {
      assert.equal(applyAcceptanceBaseline([], baseline, at('2026-08-26')).expired, false);
      assert.equal(applyAcceptanceBaseline([], baseline, at('2026-08-28')).expired, true);
    });

    // The expiry exists to stop a SUPPRESSION outliving its cause. Pruning the
    // last recovered entry empties the list, and a date-triggered failure over
    // nothing is a red monitor with nothing to review — which is how people
    // learn to ignore the check that is supposed to page them.
    it('does not expire once the last suppression is pruned', () => {
      const emptied = { ...baseline, acknowledged: [] };
      assert.equal(applyAcceptanceBaseline([], emptied, at('2026-08-28')).expired, false);
    });

    it('requires an owner issue and an expiry on every entry', () => {
      assert.throws(() => validateAcceptanceBaseline({ acknowledged: [] }), /expiresAt/);
      assert.throws(
        () => validateAcceptanceBaseline({ expiresAt: '2026-08-27' }),
        /acknowledged array/,
      );
      assert.throws(
        () => validateAcceptanceBaseline({
          expiresAt: '2026-08-27',
          acknowledged: [{ name: 'x', status: 'SEED_ERROR' }],
        }),
        /owner issue/,
      );
    });

    it('rejects a malformed entry-level expiry when the optional field is supplied', () => {
      assert.doesNotThrow(() => validateAcceptanceBaseline(baseline));
      for (const expiresAt of [undefined, null, 42, 'not-a-date']) {
        assert.throws(
          () => validateAcceptanceBaseline({
            ...baseline,
            acknowledged: [{
              name: 'tariffTrendsUs',
              status: 'EMPTY',
              issue: 6377,
              expiresAt,
            }],
          }),
          /tariffTrendsUs.*ISO expiresAt/,
        );
      }
    });

    it('rejects parseable entry expiries that are not real UTC ISO instants', () => {
      for (const expiresAt of [
        'August 10, 2026',
        '2026-02-30T00:00:00.000Z',
        '2026-08-10T12:00:00',
      ]) {
        assert.throws(
          () => validateAcceptanceBaseline({
            ...baseline,
            acknowledged: [{
              name: 'tariffTrendsUs',
              status: 'EMPTY',
              issue: 6377,
              expiresAt,
            }],
          }),
          /tariffTrendsUs.*UTC ISO expiresAt/,
          expiresAt,
        );
      }

      for (const expiresAt of [
        '2026-08-10T12:00:00Z',
        '2026-08-10T12:00:00.1Z',
        '2026-08-10T12:00:00.123Z',
        '2026-08-10T12:00:00.123456Z',
        '2026-08-10T12:00:00+04:00',
      ]) {
        assert.doesNotThrow(
          () => validateAcceptanceBaseline({
            ...baseline,
            acknowledged: [{
              name: 'tariffTrendsUs',
              status: 'EMPTY',
              issue: 6377,
              expiresAt,
            }],
          }),
          expiresAt,
        );
      }
    });

    it('rejects duplicate name and status entries in either order', () => {
      const expired = {
        name: 'tariffTrendsUs',
        status: 'EMPTY',
        issue: 6377,
        expiresAt: '2026-08-10T12:00:00.000Z',
      };
      const unbounded = {
        name: 'tariffTrendsUs',
        status: 'EMPTY',
        issue: 6378,
      };

      for (const acknowledged of [
        [expired, unbounded],
        [unbounded, expired],
      ]) {
        assert.throws(
          () => validateAcceptanceBaseline({ ...baseline, acknowledged }),
          /duplicate.*tariffTrendsUs:EMPTY/i,
        );
      }
    });

    it('ships a valid, unexpired committed baseline', () => {
      const committed = readCommittedBaseline();
      validateAcceptanceBaseline(committed);
      assert.equal(
        committed.acknowledged.some((entry) => entry.name === 'shippingRates'),
        false,
        'shippingRates recovered across the canonical cadence; do not suppress it again',
      );
      assert.equal(
        committed.acknowledged.some((entry) => entry.name === 'gdeltIntel'),
        false,
        'gdeltIntel recovered after the bulk-materializer cutover; do not suppress it again',
      );
      assert.equal(
        committed.acknowledged.some((entry) => entry.name === 'humanitarianSummary'),
        false,
        'humanitarianSummary recovered; do not suppress a future recurrence',
      );
      assert.equal(
        committed.acknowledged.some((entry) => entry.name === 'crossStraitActivityJapanMod'),
        false,
        'crossStraitActivityJapanMod stopped reporting SEED_ERROR and compact health now counts it OK; do not suppress a future recurrence',
      );
      const japanModFailure = applyAcceptanceBaseline(
        [{ name: 'crossStraitActivityJapanMod', status: 'SEED_ERROR' }],
        committed,
        Date.parse('2026-08-10'),
      );
      assert.deepEqual(
        japanModFailure.blocking.map((problem) => problem.name),
        ['crossStraitActivityJapanMod'],
        'a returning Japan MOD proxy block must reach the gate, not the suppression it used to carry (#5714)',
      );
      assert.deepEqual(japanModFailure.acknowledged, []);
      const humanitarianFailure = applyAcceptanceBaseline(
        [{ name: 'humanitarianSummary', status: 'SEED_ERROR' }],
        committed,
        Date.parse('2026-08-08'),
      );
      assert.deepEqual(
        humanitarianFailure.blocking.map((problem) => problem.name),
        ['humanitarianSummary'],
        'a future humanitarianSummary failure must block the committed acceptance gate',
      );
      assert.deepEqual(humanitarianFailure.acknowledged, []);
      const gdeltFailure = applyAcceptanceBaseline(
        [{ name: 'gdeltIntel', status: 'SEED_ERROR' }],
        committed,
        Date.parse('2026-08-01'),
      );
      assert.deepEqual(
        gdeltFailure.blocking.map((problem) => problem.name),
        ['gdeltIntel'],
        'a recovered gdeltIntel failure must block the committed acceptance gate',
      );
      assert.deepEqual(gdeltFailure.acknowledged, []);
      // These three recovered or changed status; the monitor reported them as
      // "no longer reported; remove it" and #6799 pruned them. staticRefBundleTick
      // and bocValet publish again, and statcanWds's EMPTY never returns — it
      // moved to STALE_CONTENT, which that entry could never have matched.
      for (const [name, why] of [
        ['staticRefBundleTick', 'the static-ref heartbeat publishes again'],
        ['bocValet', 'the Bank of Canada Valet probe publishes again'],
        ['statcanWds', 'its EMPTY escalated to STALE_CONTENT and the content budget now covers the real cadence'],
      ]) {
        assert.equal(
          committed.acknowledged.some((entry) => entry.name === name),
          false,
          `${name} recovered (${why}); do not suppress a future recurrence`,
        );
      }

      // The remaining eight went the same way on 2026-08-20: a live monitor run
      // reported every one as "no longer reported; remove it", and each had
      // ALREADY passed its own entry-level expiresAt (all eight expired on
      // 2026-08-19), so none of them was suppressing anything by then. Removal
      // is therefore a no-op on the gate and pure hygiene — an acknowledgement
      // that outlives its problem is a suppression with nothing to suppress,
      // waiting to absorb a FUTURE outage of the same probe.
      for (const [name, why] of [
        ['canadaAlerts', 'the Canada alerts union probe publishes again'],
        ['canadaAlertsAbSource', 'the Alberta sibling probe publishes again'],
        ['canadaAlertsBcSource', 'the B.C. sibling probe publishes again'],
        ['canadaAlertsSkSource', 'the SaskAlert sibling seed is no longer stale'],
        ['demographicsCapability', 'the demographics-capability probe publishes again'],
        ['manitobaRoads', 'the Manitoba 511 probe publishes again'],
        ['mineralProduction', 'seed-meta:supply-chain:mineral-production carries 12 records'],
        ['staticRefHeavyBundleTick', 'bundle:heartbeat:static-ref-heavy fired at 2026-08-20T04:01:04Z'],
      ]) {
        assert.equal(
          committed.acknowledged.some((entry) => entry.name === name),
          false,
          `${name} recovered (${why}); do not suppress a future recurrence`,
        );
      }

      // These producer contracts were pinned INSIDE the acknowledgement blocks
      // above and nowhere else. Deleting the suppression must not delete the
      // assertion that the producer it was waiting on still exists and still
      // runs on the cadence the ack was sized against — that is how a pruned
      // baseline quietly stops watching anything.
      const staticRefService = readRailwayServices().find((entry) => entry.service === 'seed-bundle-static-ref');
      assert.equal(staticRefService?.cronSchedule, '0 3 * * *');
      const heavyService = readRailwayServices().find((entry) => entry.service === 'seed-bundle-static-ref-heavy');
      // Prove the row EXISTS before asserting a field is absent from it —
      // `Object.hasOwn({}, 'lifecycle')` is false for a deleted row too, so the
      // absence assertion below would pass vacuously without this.
      assert.ok(heavyService, 'seed-bundle-static-ref-heavy must remain in the Railway registry');
      assert.equal(heavyService.cronSchedule, '0 4 * * *');
      // ACTIVE, not planned. Service 6285c37b was provisioned on 2026-08-19 and
      // published its heartbeat at 2026-08-20T04:01:04Z, so `planned` — which
      // removes the entry from the live audit AND from `--apply` — would exempt
      // a running daily cron from the watch-path and deploy-drift checks.
      // Asserting the ABSENCE of the field is what stops it being reinstated to
      // quiet a red gate.
      assert.equal(
        Object.hasOwn(heavyService, 'lifecycle'),
        false,
        'seed-bundle-static-ref-heavy is provisioned and must not carry a lifecycle field',
      );
      // #6806 owns ONE consolidated bundle-tick ack when it owns any at all —
      // never one per member. It owns none now that the heartbeat fired.
      assert.deepEqual(
        committed.acknowledged.filter((entry) => entry.issue === 6806).map((entry) => entry.name),
        [],
      );
      // The consolidation is the point: Railway caps a project at 100 services
      // and the fleet is at 82. Three low-cadence members do not get three.
      for (const retired of ['seed-bundle-arms-suppliers', 'seed-bundle-military-bases']) {
        assert.equal(
          readRailwayServices().find((item) => item.service === retired),
          undefined,
          `${retired} was consolidated into seed-bundle-static-ref-heavy — do not re-add a 1-section sibling`,
        );
      }
      assert.ok(
        Date.parse(committed.expiresAt) > Date.parse('2026-07-28'),
        'committed baseline must not ship already expired',
      );
      for (const entry of committed.acknowledged) {
        assert.ok(entry.reason?.length > 20, `${entry.name} needs a substantive reason`);
      }

      // Every suppression needs an owner that outlives the change that added it.
      // These entries originally all pointed at the PR that introduced the
      // baseline: `Number.isInteger` was satisfied, but the moment that PR
      // merged and closed, four degraded sources were suppressed against a
      // closed PR with nobody owning them. Distinct issue numbers is the
      // cheapest offline proxy for "somebody actually filed these".
      // #6659 is the allowed repeat: one first Railway tick owns the
      // union probe move plus the Alberta, B.C., and Saskatchewan sibling rows.
      const issues = committed.acknowledged.map((entry) => entry.issue);
      assert.ok(
        !issues.includes(5771),
        'recovered chinaCoverage degradation must not remain acknowledged',
      );
      const namesByIssue = new Map();
      for (const entry of committed.acknowledged) {
        const names = namesByIssue.get(entry.issue) ?? [];
        names.push(entry.name);
        namesByIssue.set(entry.issue, names);
      }
      // #6659 is the allowed repeat: one first Railway tick owns the
      // union probe move plus the Alberta, B.C., and Saskatchewan sibling rows.
      const allowedSharedIssues = new Map([
        [6659, ['canadaAlerts', 'canadaAlertsAbSource', 'canadaAlertsBcSource', 'canadaAlertsSkSource']],
      ]);
      for (const [issue, names] of namesByIssue) {
        const allowed = allowedSharedIssues.get(issue);
        if (allowed) {
          assert.deepEqual(
            [...names].sort(),
            [...allowed].sort(),
            `#${issue} may only cover ${allowed.join(', ')}`,
          );
          continue;
        }
        assert.equal(
          names.length,
          1,
          `issue #${issue} is shared by ${names.join(', ')} — each acknowledged degradation needs its OWN tracking issue`,
        );
      }
      for (const entry of committed.acknowledged) {
        assert.doesNotMatch(
          entry.reason,
          /needs (its own|a) tracking issue/i,
          `${entry.name} still says it needs a tracking issue — file it and point issue: at it`,
        );
      }
    });

    it('documents the pre-seed, activation-marker, or expiring-acknowledgement cutover contract', () => {
      const committed = readCommittedBaseline();
      const baselinePolicy = committed.$comment.join('\n');
      const prTemplate = readFileSync(PR_TEMPLATE_URL, 'utf8');
      const runbook = readFileSync(LONG_CRON_RUNBOOK_URL, 'utf8');

      assert.match(baselinePolicy, /entry-level `expiresAt`/i);
      assert.match(baselinePolicy, /first\s+(scheduled\s+)?cron window/i);
      assert.match(baselinePolicy, /durable activation marker/i);
      assert.match(prTemplate, /Railway-side pre-seed/i);
      assert.match(prTemplate, /entry-level `expiresAt`/i);
      assert.match(prTemplate, /durable activation marker/i);
      assert.match(runbook, /Railway-side pre-seed/i);
      assert.match(runbook, /entry-level `expiresAt`/i);
      assert.match(runbook, /first\s+(scheduled\s+)?cron window/i);
      assert.match(runbook, /durable activation marker/i);
    });

    describe('health-probe cutover enforcement', () => {
      const baseSeedMeta = {
        tariffTrendsUs: { key: 'seed-meta:economic:tariff-trends-us' },
        unchanged: { key: 'seed-meta:unchanged', maxStaleMin: 60 },
      };
      const baselineWithoutCutover = { ...baseline, acknowledged: [] };

      it('fails a new or repointed probe without machine-readable cutover evidence', () => {
        assert.throws(
          () => validateHealthProbeCutovers({
            baseSeedMeta,
            headSeedMeta: {
              ...baseSeedMeta,
              tariffTrendsUs: { key: 'seed-meta:trade:tariffs' },
            },
            baseline: baselineWithoutCutover,
          }),
          /tariffTrendsUs.*pre-seed.*expiring acknowledgement/i,
        );
      });

      it('accepts pre-seed evidence bound to the exact key transition', () => {
        const cutover = {
          mode: 'preseed',
          fromKey: 'seed-meta:economic:tariff-trends-us',
          issue: 6377,
          verifiedAt: '2026-08-10T09:00:00.000Z',
          evidence: {
            platform: 'railway',
            service: 'seed-supply-chain-trade',
            probeKey: 'seed-meta:trade:tariffs',
            compactHealthStatus: 'OK',
            reference: 'https://github.com/koala73/worldmonitor/issues/6377#issuecomment-1',
          },
        };
        const headSeedMeta = {
          ...baseSeedMeta,
          tariffTrendsUs: { key: 'seed-meta:trade:tariffs', cutover },
        };

        assert.doesNotThrow(() => validateHealthProbeCutovers({
          baseSeedMeta,
          headSeedMeta,
          baseline: baselineWithoutCutover,
        }));
        assert.throws(
          () => validateHealthProbeCutovers({
            baseSeedMeta: {
              ...baseSeedMeta,
              tariffTrendsUs: { key: 'seed-meta:another-old-key' },
            },
            headSeedMeta,
            baseline: baselineWithoutCutover,
          }),
          /fromKey.*seed-meta:another-old-key/i,
        );
        assert.throws(
          () => validateHealthProbeCutovers({
            baseSeedMeta,
            headSeedMeta: {
              ...headSeedMeta,
              tariffTrendsUs: {
                ...headSeedMeta.tariffTrendsUs,
                cutover: { ...cutover, verifiedAt: 'August 10, 2026' },
              },
            },
            baseline: baselineWithoutCutover,
          }),
          /verifiedAt/i,
        );
        for (const evidence of [
          'unstructured',
          { ...cutover.evidence, platform: 'github' },
          { ...cutover.evidence, service: '' },
          { ...cutover.evidence, probeKey: 'seed-meta:wrong' },
          { ...cutover.evidence, compactHealthStatus: 'EMPTY' },
          { ...cutover.evidence, reference: 'http://example.com/evidence' },
        ]) {
          assert.throws(
            () => validateHealthProbeCutovers({
              baseSeedMeta,
              headSeedMeta: {
                ...headSeedMeta,
                tariffTrendsUs: {
                  ...headSeedMeta.tariffTrendsUs,
                  cutover: { ...cutover, evidence },
                },
              },
              baseline: baselineWithoutCutover,
            }),
            /Railway.*service.*probe.*compact health OK.*HTTPS/i,
          );
        }
      });

      it('accepts an owner-bound acknowledgement that expires by the first cron run', () => {
        const headSeedMeta = {
          ...baseSeedMeta,
          tariffTrendsUs: {
            key: 'seed-meta:trade:tariffs',
            cutover: {
              mode: 'expiring-ack',
              fromKey: 'seed-meta:economic:tariff-trends-us',
              issue: 6377,
              status: 'EMPTY',
            },
          },
        };
        const cutoverEntry = {
          name: 'tariffTrendsUs',
          status: 'EMPTY',
          issue: 6377,
          expiresAt: '2026-08-10T06:00:00.000Z',
          cutover: {
            probeKey: 'seed-meta:trade:tariffs',
            activatedAt: '2026-08-10T00:00:00.000Z',
            firstScheduledRunAt: '2026-08-10T06:00:00.000Z',
          },
        };

        assert.doesNotThrow(() => validateHealthProbeCutovers({
          baseSeedMeta,
          headSeedMeta,
          baseline: { ...baseline, acknowledged: [cutoverEntry] },
        }));
        for (const badEntry of [
          { ...cutoverEntry, expiresAt: '2026-08-10T06:00:00.001Z' },
          { ...cutoverEntry, expiresAt: '2026-08-09T23:59:59.999Z' },
          {
            ...cutoverEntry,
            cutover: {
              ...cutoverEntry.cutover,
              firstScheduledRunAt: '2026-08-11T00:00:00.001Z',
            },
          },
        ]) {
          assert.throws(
            () => validateHealthProbeCutovers({
              baseSeedMeta,
              headSeedMeta,
              baseline: { ...baseline, acknowledged: [badEntry] },
            }),
            /activation|first scheduled run|24 hours/i,
          );
        }
        assert.throws(
          () => validateHealthProbeCutovers({
            baseSeedMeta,
            headSeedMeta: {
              ...headSeedMeta,
              tariffTrendsUs: {
                ...headSeedMeta.tariffTrendsUs,
                cutover: { ...headSeedMeta.tariffTrendsUs.cutover, status: 'SEED_ERROR' },
              },
            },
            baseline: { ...baseline, acknowledged: [cutoverEntry] },
          }),
          /exact health status|expiring acknowledgement/i,
        );
      });

      it('accepts a durable activation marker bound to the new probe', () => {
        const activationKey = 'seed-activated:market:physical-premium';
        const headSeedMeta = {
          ...baseSeedMeta,
          physicalPremiums: {
            key: 'seed-meta:market:physical-premium',
            activationKey,
            cutover: {
              mode: 'activation-marker',
              fromKey: null,
              issue: 6436,
              activationKey,
            },
          },
        };

        assert.doesNotThrow(() => validateHealthProbeCutovers({
          baseSeedMeta,
          headSeedMeta,
          baseline: baselineWithoutCutover,
        }));
        for (const badActivationKey of [
          '',
          'market:physical-premium',
          'seed-activated:market:other',
        ]) {
          assert.throws(
            () => validateHealthProbeCutovers({
              baseSeedMeta,
              headSeedMeta: {
                ...headSeedMeta,
                physicalPremiums: {
                  ...headSeedMeta.physicalPremiums,
                  cutover: {
                    ...headSeedMeta.physicalPremiums.cutover,
                    activationKey: badActivationKey,
                  },
                },
              },
              baseline: baselineWithoutCutover,
            }),
            /activation-marker.*config\.activationKey.*seed-activated/i,
          );
        }
      });

      it('runs in the pull-request workflow and the pre-push hook', () => {
        const workflow = readFileSync(TEST_WORKFLOW_URL, 'utf8');
        const hook = readFileSync(PRE_PUSH_HOOK_URL, 'utf8');

        assert.match(
          workflow,
          /unit:[\s\S]*?fetch-depth: 0[\s\S]*?name: Enforce health-probe cutovers[\s\S]*?node --import tsx scripts\/check-health-probe-cutovers\.mts/,
        );
        assert.match(
          hook,
          /changed '[^']*scripts\/check-health-probe-cutovers\\\.mts/,
        );
        assert.match(
          hook,
          /node --import tsx scripts\/check-health-probe-cutovers\.mts origin\/main/,
        );
      });

      // #7021 — the pre-push hook above compares against origin/main, but CI
      // compared against `github.event.pull_request.base.sha`. GitHub PINS that
      // SHA when the PR is opened and never advances it as main moves, while
      // actions/checkout builds refs/pull/N/merge — the PR merged onto main's
      // CURRENT tip. So the gate diffs today's tree against a base that can be
      // weeks old: every probe added to main after the PR opened reads as
      // brand-new on every run, re-litigating a cutover the PR never touched.
      // That is latent until the probe's acknowledgement is legitimately pruned,
      // at which point the PR fails outright demanding an entry nobody should
      // restore. #7021 died exactly this way on tpsMci (#7035) once #7120
      // retired the acknowledgement, naming a closed issue as its owner.
      //
      // The merge ref's FIRST parent is the base tip the tree was merged onto,
      // so it cannot drift away from what is actually being tested.
      it('bases the cutover diff on the merged tree, not the pinned base.sha', () => {
        const workflow = readFileSync(TEST_WORKFLOW_URL, 'utf8');

        // Matches the interpolation, not the prose: the step's own comment names
        // the rejected expression to explain why it is rejected.
        assert.doesNotMatch(
          workflow,
          /\$\{\{\s*github\.event\.pull_request\.base\.sha/,
          'pull_request.base.sha is pinned at PR creation, so it re-litigates every probe added after the PR opened',
        );
        assert.match(workflow, /git rev-parse HEAD\^1/);
      });
    });
  });

  // The run's ORDER of output is not observable through the split functions
  // above, which is how an early `return` on expiry suppressed the blocking
  // list without a single assertion noticing.
  describe('acceptance report', () => {
    const blocked = {
      name: 'supplyChainTrade', status: 'STALE_SEED', records: 3, seedAgeMin: 900, maxStaleMin: 360,
    };
    const baselineResult = (overrides) => ({
      blocking: [], acknowledged: [], cleared: [], escalated: [], expired: false, expiresAt: '2026-08-27', ...overrides,
    });

    it('names every blocking problem, not just the count', () => {
      const report = formatAcceptanceReport(baselineResult({ blocking: [blocked] }), '2026-07-28T12:00:00Z');
      assert.equal(report.failed, true);
      assert.deepEqual(report.errors, [
        'Ingestion operational acceptance failed: 1 unacknowledged problem(s).',
        '- supplyChainTrade: status=STALE_SEED records=3 age=900m max=360m',
      ]);
    });

    it('a STALE_CONTENT row prints the clock that fired, not the one that did not', () => {
      // Health runs two independent clocks. STALE_CONTENT is decided by
      // contentAgeMin vs maxContentAgeMin, but this line used to print the SEED
      // pair unconditionally — which for that status is ALWAYS inside budget.
      // Production read `euFsi: status=STALE_CONTENT age=1200m max=5760m`, so
      // the only available conclusion was that the monitor was wrong. The
      // numbers that explain it were on the wire and were being dropped by the
      // projection before the formatter ever saw them.
      const payload = {
        status: 'DEGRADED',
        checkedAt: '2026-08-17T10:00:00.000Z',
        summary: { total: 1, ok: 0, warn: 1, crit: 0 },
        problems: {
          euFsi: {
            status: 'STALE_CONTENT',
            records: 252,
            seedAgeMin: 1200,
            maxStaleMin: 5760,
            contentAgeMin: 19230,
            maxContentAgeMin: 14400,
          },
        },
      };
      const [problem] = findOperationalProblems(payload);
      assert.equal(problem.contentAgeMin, 19230, 'the projection must carry the content clock');
      assert.equal(problem.maxContentAgeMin, 14400);

      const report = formatAcceptanceReport(
        baselineResult({ blocking: [problem] }),
        '2026-08-17T10:00:00.000Z',
      );
      const line = report.errors.find((row) => row.includes('euFsi'));
      assert.match(line, /contentAge=19230m maxContentAge=14400m/, 'the breached pair must be named');
      assert.match(line, /seed age=1200m ok/, 'and the healthy clock marked as such, not omitted');
      assert.doesNotMatch(
        line,
        /\bage=1200m max=5760m/,
        'the bare seed pair must not be presented as the reason for a content breach',
      );
    });

    it('names an UNREADABLE content clock rather than falling back to the seed pair', () => {
      // health scores `contentAgeMin == null` as stale (fail-closed), so a source
      // can be STALE_CONTENT because nothing in the payload carries a date at
      // all. jodiGas reads exactly this way in production. Printing the seed
      // pair here would reproduce the original bug on the other branch: the
      // reader again sees a clock that is comfortably inside budget.
      const problem = {
        name: 'jodiGas',
        status: 'STALE_CONTENT',
        records: 57,
        seedAgeMin: 8793,
        maxStaleMin: 57600,
        contentAgeMin: null,
        maxContentAgeMin: 267840,
      };
      const report = formatAcceptanceReport(
        baselineResult({ blocking: [problem] }),
        '2026-08-17T10:00:00.000Z',
      );
      const line = report.errors.find((row) => row.includes('jodiGas'));
      assert.match(line, /contentAge=unknown/, 'an unreadable clock must be named as unreadable');
      assert.match(line, /scored stale/, 'and the fail-closed scoring made explicit');
      assert.doesNotMatch(
        line,
        /\bage=8793m max=57600m/,
        'the passing seed pair must not be offered as the reason',
      );
    });

    it('does not present the seed pair when the content clock is operator-only', () => {
      // health also reaches STALE_CONTENT via requireContentFreshness — a
      // per-country verdict. That detail names WHICH country is stale, so
      // api/health.js strips it from the public compact shape (#6060) this
      // monitor reads, and the row arrives with NO content fields at all.
      // portwatchPortActivity reads exactly this way. Falling back to the seed
      // pair here reproduced the original bug a third time: `age=297m
      // max=2160m` is inside budget and explains nothing.
      const problem = {
        name: 'portwatchPortActivity',
        status: 'STALE_CONTENT',
        records: 174,
        seedAgeMin: 297,
        maxStaleMin: 2160,
      };
      const report = formatAcceptanceReport(
        baselineResult({ blocking: [problem] }),
        '2026-08-17T17:00:00.000Z',
      );
      const line = report.errors.find((row) => row.includes('portwatchPortActivity'));
      assert.match(line, /contentAge=operator-only/, 'the withheld clock must be named as withheld');
      assert.match(line, /detailed \/api\/health/, 'and the operator pointed at where it lives');
      assert.doesNotMatch(
        line,
        /\bage=297m max=2160m/,
        'the passing seed pair must never stand in as the reason for a content verdict',
      );
    });

    it('still reports the blocking problems on the run where the baseline expires', () => {
      const report = formatAcceptanceReport(
        baselineResult({ blocking: [blocked], expired: true, expiresAt: '2020-01-01' }),
        '2026-07-28T12:00:00Z',
      );
      assert.equal(report.failed, true);
      assert.match(report.errors.join('\n'), /baseline expired on 2020-01-01/);
      assert.match(
        report.errors.join('\n'),
        /supplyChainTrade: status=STALE_SEED/,
        'the expiry run must still name what is actually broken',
      );
      // Order matters: the actionable list must precede the expiry notice, so a
      // truncated CI log still shows what to fix.
      assert.ok(
        report.errors.findIndex((line) => line.includes('supplyChainTrade'))
          < report.errors.findIndex((line) => line.includes('expired on')),
      );
    });

    it('fails on expiry even when nothing else is blocking', () => {
      const report = formatAcceptanceReport(baselineResult({ expired: true }), '2026-07-28T12:00:00Z');
      assert.equal(report.failed, true);
      assert.equal(report.info.length, 0, 'a failing run must not also claim it passed');
    });

    it('passes cleanly and still surfaces acknowledged and recovered entries', () => {
      const report = formatAcceptanceReport(
        baselineResult({
          acknowledged: [{ name: 'gdeltIntel', status: 'SEED_ERROR', records: 1, issue: 5766 }],
          cleared: [{ name: 'shippingRates', status: 'STALE_SEED', issue: 5769 }],
        }),
        '2026-07-28T12:00:00Z',
      );
      assert.equal(report.failed, false);
      assert.deepEqual(report.errors, []);
      assert.match(report.info[0], /acknowledged \(#5766\): gdeltIntel: status=SEED_ERROR records=1/);
      assert.match(report.info[1], /recovered: shippingRates:STALE_SEED/);
      assert.match(report.info[2], /acceptance passed at 2026-07-28T12:00:00Z.*\(1 acknowledged\)/);
    });

    it('never tells the operator to prune a suppression for a source that escalated', () => {
      const report = formatAcceptanceReport(
        baselineResult({
          blocking: [{ name: 'crossStraitActivityJapanMod', status: 'EMPTY', records: 0 }],
          escalated: [{
            name: 'crossStraitActivityJapanMod',
            status: 'SEED_ERROR',
            observedStatus: 'EMPTY',
            issue: 5714,
          }],
        }),
        '2026-07-28T12:00:00Z',
      );

      assert.equal(report.failed, true, 'the worse status is unacknowledged and must still fail the gate');
      const escalation = report.info.find((line) => line.includes('crossStraitActivityJapanMod'));
      assert.match(escalation, /escalated .*SEED_ERROR -> EMPTY/);
      assert.doesNotMatch(
        escalation,
        /remove it from|recovered/,
        'pruning advice on an escalation is how a live suppression gets deleted',
      );
    });
  });

  it('runs on a schedule without grading pre-deployment ingestion pushes', () => {
    const workflow = readFileSync(
      new URL('../.github/workflows/seed-freshness-monitor.yml', import.meta.url),
      'utf8',
    );

    // Parse rather than grep. This assertion is the entire mechanism keeping
    // the gate off ingestion pushes (a push probes production before Railway
    // has deployed or executed the revision), and a regex for one spelling of
    // one key is bypassed by 4-space indentation, a quoted "push": key, a flow
    // mapping on the `on:` line, or a sequence `on: [push, schedule]`. Pinning
    // the whole trigger set closes all of them at once.
    const parsed = YAML.parse(workflow);
    // `on` is a YAML 1.1 boolean keyword. The yaml package defaults to 1.2 (so
    // the key stays the string "on"), but read both spellings so a schema or
    // version change cannot silently turn this assertion into a no-op against
    // an undefined trigger map.
    const on = parsed.on ?? parsed[true];
    assert.ok(on, 'workflow must declare triggers');
    const triggers = Array.isArray(on) ? on : Object.keys(on);
    assert.deepEqual(
      [...triggers].sort(),
      ['schedule', 'workflow_dispatch'],
      'the monitor must run only on a schedule or an explicit manual dispatch',
    );
    assert.equal(on.schedule[0].cron, '*/15 * * * *');
    assert.match(workflow, /actions\/setup-node@[a-f0-9]+/);
    assert.match(workflow, /node-version:\s*['"]24['"]/);
    assert.match(workflow, /context\s*==\s*"gate"/);
    assert.match(workflow, /gate_state.*success/s);
    assert.match(workflow, /node scripts\/check-seed-freshness\.mjs/);
  });
});
