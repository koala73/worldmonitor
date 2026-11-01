import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, matchesGlob, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import {
  REFRESH_WORKFLOW_PATH,
  REHEARSAL_TRIGGERS,
  driftResilienceSnapshot,
  needsRehearsal,
  readRehearsedStep,
} from '../scripts/rehearse-resilience-snapshot-refresh.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REHEARSAL_WORKFLOW_PATH = '.github/workflows/resilience-snapshot-rehearsal.yml';

function country(code, fields) {
  return { countryCode: code, countryName: `Country ${code}`, identity: { commonName: code }, ...fields };
}

function snapshot() {
  return {
    capturedAt: '2026-11-01',
    snapshotNote: 'This 2026-11-01 snapshot applies domain design weights.',
    totals: { rankedCountries: 5, greyedOutCount: 3 },
    items: [
      country('CH', { rank: 1, overallScore: 76.4, dimensionCoverage: 0.78, headlineEligible: true, imputationShare: 0.09 }),
      country('NO', { rank: 2, overallScore: 75.3, dimensionCoverage: 0.81, headlineEligible: true, imputationShare: 0.05 }),
      country('DK', { rank: 3, overallScore: 74.9, dimensionCoverage: 0.8, headlineEligible: true, imputationShare: 0.07 }),
      country('SO', { rank: 4, overallScore: 21, dimensionCoverage: 0.71, headlineEligible: true, imputationShare: 0.3 }),
      country('SD', { rank: 5, overallScore: 19.8, dimensionCoverage: 0.73, headlineEligible: true, imputationShare: 0.28 }),
    ],
    greyedOut: [
      country('AD', { rank: null, overallScore: 68, dimensionCoverage: 0.71, headlineEligible: false, imputationShare: 0.14 }),
      country('AG', { rank: null, overallScore: 60, dimensionCoverage: 0.71, headlineEligible: false, imputationShare: 0.2 }),
      country('TW', { rank: null, overallScore: 70, dimensionCoverage: 0.4, headlineEligible: false, imputationShare: 0.42 }),
    ],
  };
}

const byCode = (rows, code) => rows.find((row) => row.countryCode === code);

describe('resilience snapshot refresh rehearsal', () => {
  it('moves the figures a monthly refresh moves while keeping the snapshot valid', () => {
    const original = snapshot();
    const drifted = driftResilienceSnapshot(original, { targetDate: '2026-12-01' });

    assert.equal(drifted.capturedAt, '2026-12-01');
    assert.equal(drifted.snapshotNote, 'This 2026-12-01 snapshot applies domain design weights.');

    assert.deepEqual(drifted.totals, { rankedCountries: 4, greyedOutCount: 4 }, 'the ranked count moves');
    assert.equal(byCode(drifted.greyedOut, 'SD')?.headlineEligible, false, 'the last-ranked country is demoted');
    assert.equal(byCode(drifted.greyedOut, 'SD')?.rank, null);
    assert.deepEqual(drifted.greyedOut.map((row) => row.countryCode), ['AD', 'AG', 'SD', 'TW'], 'greyed-out rows stay in code order');

    assert.deepEqual(drifted.items.map((row) => row.rank), [1, 2, 3, 4], 'ranks stay contiguous');
    assert.deepEqual(drifted.items.map((row) => row.overallScore), [76.4, 75.3, 74.9, 21], 'score order holds');
    for (const code of ['CH', 'NO', 'DK', 'SO']) {
      const before = byCode(original.items, code);
      const after = byCode(drifted.items, code);
      assert.notEqual(after.rank, before.rank, `${code} changes rank`);
      assert.notEqual(after.overallScore, before.overallScore, `${code} changes score`);
      assert.ok(Math.abs(after.rank - before.rank) === 1, `${code} moves one place, so band anchors keep their band`);
      assert.equal(after.countryName, before.countryName, `${code} keeps its identity`);
    }

    for (const code of ['AD', 'AG', 'TW']) {
      assert.notEqual(
        byCode(drifted.greyedOut, code).dimensionCoverage,
        byCode(original.greyedOut, code).dimensionCoverage,
        `${code} changes coverage, even where its code neighbour shared it`,
      );
    }
    assert.ok(drifted.greyedOut.every((row) => row.headlineEligible === false));
    assert.deepEqual(original, snapshot(), 'the committed snapshot is not mutated');
  });

  it('replays the refresh workflow rebuild-and-verify step', () => {
    const step = readRehearsedStep(readFileSync(resolve(repoRoot, REFRESH_WORKFLOW_PATH), 'utf8'));
    assert.match(step.run, /npm run build:crawlable-corpus/);
    assert.match(step.run, /node scripts\/run-data-tests\.mjs/);
    assert.ok(step.env.SNAPSHOT_CONSUMERS, 'the step carries the pattern that selects its verify suites');
  });

  it('rehearses a change to a verify suite, a trigger script or the snapshot, and nothing else', () => {
    const consumers = 'resilienceSnapshot|crawlable-corpus';
    const sources = {
      'tests/crawlable-corpus.test.mjs': "read(repoRoot, manifest.sources.resilienceSnapshot)",
      'tests/unrelated.test.mjs': "assert.equal(1, 1)",
    };
    const readSource = (path) => sources[path] ?? null;
    assert.equal(needsRehearsal(['tests/crawlable-corpus.test.mjs'], { consumers, readSource }), true);
    assert.equal(needsRehearsal(['docs/snapshots/resilience-ranking-2026-12-01.json'], { consumers, readSource }), true);
    assert.equal(needsRehearsal(['scripts/build-crawlable-corpus.mjs'], { consumers, readSource }), true);
    assert.equal(needsRehearsal(['tests/unrelated.test.mjs', 'src/app/App.ts'], { consumers, readSource }), false);
    assert.equal(needsRehearsal(['tests/deleted.test.mjs'], { consumers, readSource }), false, 'a deleted suite cannot pin anything');
  });

  it('runs on every PR that could reach the refresh', () => {
    const rehearsal = parseYaml(readFileSync(resolve(repoRoot, REHEARSAL_WORKFLOW_PATH), 'utf8'));
    const paths = rehearsal.on.pull_request.paths;
    for (const required of [
      'tests/*.test.mjs',
      'tests/*.test.mts',
      'docs/snapshots/resilience-ranking-*.json',
      REFRESH_WORKFLOW_PATH,
      REHEARSAL_WORKFLOW_PATH,
    ]) {
      assert.ok(paths.includes(required), `${REHEARSAL_WORKFLOW_PATH} must run when ${required} changes`);
    }
    const triggerFiles = ['scripts', '.github/workflows', 'docs/snapshots']
      .flatMap((dir) => readdirSync(resolve(repoRoot, dir)).map((name) => `${dir}/${name}`))
      .filter((file) => REHEARSAL_TRIGGERS.some((trigger) => trigger.test(file)));
    assert.ok(triggerFiles.includes('scripts/build-crawlable-corpus.mjs'));
    for (const file of triggerFiles) {
      assert.ok(paths.some((glob) => matchesGlob(file, glob)), `${REHEARSAL_WORKFLOW_PATH} must run when ${file} changes`);
    }
    const steps = rehearsal.jobs.rehearse.steps.map((step) => step.run ?? '').join('\n');
    assert.match(steps, /node scripts\/rehearse-resilience-snapshot-refresh\.mjs --base /);
  });
});
