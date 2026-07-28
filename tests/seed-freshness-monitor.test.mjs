import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import YAML from 'yaml';

import {
  applyAcceptanceBaseline,
  findOperationalProblems,
  findStaleSeedProblems,
  isOnDemandProblem,
  validateAcceptanceBaseline,
  validateCompactHealthPayload,
} from '../scripts/check-seed-freshness.mjs';

describe('scheduled seed freshness monitor', () => {
  it('alerts only when seed metadata has exceeded maxStaleMin', () => {
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

    assert.deepEqual(findStaleSeedProblems(payload), [
      {
        name: 'wildfire',
        seedAgeMin: 361,
        maxStaleMin: 360,
      },
    ]);
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

  it('exempts on-demand sources by the source marker, not the status suffix', () => {
    // EMPTY_ON_DEMAND is the ONLY *_ON_DEMAND status api/health.js emits, and it
    // covers just the absent/zero-record branches. An on-demand key that HAS
    // data and goes stale is plain STALE_SEED (api/health.js classifyKey), and
    // chinaCoverage degrades to CHINA_DEGRADED -- both are on-demand sources
    // that a suffix-only test would grade as ingestion failures.
    assert.equal(isOnDemandProblem({ status: 'EMPTY_ON_DEMAND' }), true);
    assert.equal(isOnDemandProblem({ status: 'STALE_SEED', onDemand: true }), true);
    assert.equal(isOnDemandProblem({ status: 'CHINA_DEGRADED', onDemand: true }), true);
    assert.equal(isOnDemandProblem({ status: 'STALE_SEED' }), false);
    assert.equal(isOnDemandProblem({ status: 'SEED_ERROR', onDemand: false }), false);
    // Boundary: contains the token but does not end with it, and non-string.
    assert.equal(isOnDemandProblem({ status: 'EMPTY_ON_DEMAND_LEGACY' }), false);
    assert.equal(isOnDemandProblem({ status: 42 }), false);
    assert.equal(isOnDemandProblem({}), false);

    assert.deepEqual(
      findOperationalProblems({
        status: 'WARNING',
        problems: {
          shippingRates: { status: 'STALE_SEED', onDemand: true, seedAgeMin: 716, maxStaleMin: 420 },
          gdeltIntel: { status: 'SEED_ERROR', records: 1 },
        },
      }).map((p) => p.name),
      ['gdeltIntel'],
    );
  });

  it('treats an all-on-demand payload as clean', () => {
    assert.deepEqual(
      findOperationalProblems({
        status: 'WARNING',
        problems: {
          newsRecallBenchmark: { status: 'EMPTY_ON_DEMAND', records: 0 },
          chinaCoverage: { status: 'CHINA_DEGRADED', onDemand: true, records: 15 },
        },
      }),
      [],
    );
  });

  it('rejects payloads that cannot prove compact seed freshness', () => {
    assert.throws(() => validateCompactHealthPayload(null), /object/);
    assert.deepEqual(findStaleSeedProblems({ status: 'HEALTHY' }), []);
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
