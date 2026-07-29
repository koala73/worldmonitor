import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import YAML from 'yaml';

import {
  applyAcceptanceBaseline,
  findOperationalProblems,
  formatAcceptanceReport,
  isOnDemandProblem,
  validateAcceptanceBaseline,
  validateCompactHealthPayload,
} from '../scripts/check-seed-freshness.mjs';

describe('scheduled seed freshness monitor', () => {
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

    it('expires so the baseline cannot silently become permanent', () => {
      assert.equal(applyAcceptanceBaseline([], baseline, at('2026-08-26')).expired, false);
      assert.equal(applyAcceptanceBaseline([], baseline, at('2026-08-28')).expired, true);
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

    it('ships a valid, unexpired committed baseline', () => {
      const committed = JSON.parse(
        readFileSync(new URL('../scripts/seed-freshness-baseline.json', import.meta.url), 'utf8'),
      );
      validateAcceptanceBaseline(committed);
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
      const issues = committed.acknowledged.map((entry) => entry.issue);
      assert.ok(
        !issues.includes(5771),
        'recovered chinaCoverage degradation must not remain acknowledged',
      );
      assert.equal(
        new Set(issues).size,
        issues.length,
        'each acknowledged degradation needs its OWN tracking issue, not one shared number',
      );
      for (const entry of committed.acknowledged) {
        assert.doesNotMatch(
          entry.reason,
          /needs (its own|a) tracking issue/i,
          `${entry.name} still says it needs a tracking issue — file it and point issue: at it`,
        );
      }
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
      blocking: [], acknowledged: [], cleared: [], expired: false, expiresAt: '2026-08-27', ...overrides,
    });

    it('names every blocking problem, not just the count', () => {
      const report = formatAcceptanceReport(baselineResult({ blocking: [blocked] }), '2026-07-28T12:00:00Z');
      assert.equal(report.failed, true);
      assert.deepEqual(report.errors, [
        'Ingestion operational acceptance failed: 1 unacknowledged problem(s).',
        '- supplyChainTrade: status=STALE_SEED records=3 age=900m max=360m',
      ]);
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
