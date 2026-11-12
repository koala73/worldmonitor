import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import {
  REFRESH_WORKFLOW_PATH,
  driftLivePulseCapture,
  readRehearsedSteps,
} from '../scripts/rehearse-crawlable-pulse-refresh.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REHEARSAL_WORKFLOW_PATH = '.github/workflows/crawlable-pulse-rehearsal.yml';

function capture() {
  return {
    capturedAt: '2026-10-19',
    capturedAtMs: Date.parse('2026-10-19T04:55:00Z'),
    countries: {
      AE: { partial: false, score: '50', band: 'Normal', trend: 'Unchanged', geoConvergence: 0, advisory: 'Reconsider Travel', methodologyVersion: 'v8', asOf: '2026-10-19T04:53:47.151Z' },
      IR: { partial: false, score: '80', band: 'High', trend: 'Rising', geoConvergence: 14, advisory: 'Do Not Travel', methodologyVersion: 'v8', asOf: '2026-10-19T04:53:47.151Z' },
      NR: { partial: true, score: null, band: null, trend: null, geoConvergence: null, advisory: 'Exercise Normal Precautions', methodologyVersion: '', asOf: null },
    },
    chokepoints: {
      hormuz_strait: { disruptionScore: '70', status: 'Red', officialLatestDate: null, officialLatestTotal: null, officialAvg7d: null, description: 'Hormuz', baselineFrom: '2024-10-19', asOf: '2026-10-19T04:53:51.886Z' },
      suez: { disruptionScore: '35', status: 'Yellow', officialLatestDate: '2026-10-11', officialLatestTotal: 43, officialAvg7d: 44.3, description: 'Suez', baselineFrom: '2024-10-19', asOf: '2026-10-19T04:53:51.886Z' },
    },
    forecastScorecard: { attemptedAt: '2026-10-19', attemptedAtMs: Date.parse('2026-10-19T04:55:00Z'), capturedAt: '2026-10-19' },
  };
}

describe('crawlable pulse refresh rehearsal', () => {
  it('moves every value a weekly refresh routinely moves', () => {
    const original = capture();
    const drifted = driftLivePulseCapture(original, { targetDate: '2026-10-26' });

    assert.equal(drifted.capturedAt, '2026-10-26');
    assert.equal(drifted.capturedAtMs - original.capturedAtMs, 7 * 86_400_000);
    assert.equal(drifted.forecastScorecard.attemptedAt, '2026-10-26');
    assert.equal(drifted.forecastScorecard.capturedAt, '2026-10-26');
    assert.equal(drifted.forecastScorecard.attemptedAtMs - original.forecastScorecard.attemptedAtMs, 7 * 86_400_000);
    assert.equal(drifted.countries.AE.asOf, '2026-10-26T04:53:47.151Z');
    assert.equal(drifted.chokepoints.suez.asOf, '2026-10-26T04:53:51.886Z');
    assert.equal(drifted.chokepoints.suez.baselineFrom, '2024-10-19', 'calendar facts other than the capture date stay put');

    assert.equal(drifted.countries.AE.methodologyVersion, 'v9');
    assert.equal(drifted.countries.NR.methodologyVersion, '', 'an unscored country carries no version to bump');

    assert.deepEqual(
      [drifted.countries.AE.score, drifted.countries.AE.band, drifted.countries.IR.score, drifted.countries.IR.band],
      ['80', 'High', '50', 'Normal'],
      'scored countries trade readings',
    );
    assert.equal(drifted.countries.AE.advisory, 'Reconsider Travel', 'country-specific text stays with its country');
    assert.equal(drifted.countries.NR.score, null, 'partial countries are not given a score');

    assert.equal(drifted.chokepoints.hormuz_strait.disruptionScore, '35');
    assert.equal(drifted.chokepoints.hormuz_strait.status, 'Yellow');
    assert.equal(drifted.chokepoints.hormuz_strait.description, 'Hormuz', 'a chokepoint keeps its identity');
    for (const id of ['hormuz_strait', 'suez']) {
      assert.deepEqual(
        [drifted.chokepoints[id].officialLatestDate, drifted.chokepoints[id].officialLatestTotal],
        ['2026-10-11', 43],
        `${id} publishes a PortWatch day, as a capture with none withheld does`,
      );
    }

    assert.deepEqual(original, capture(), 'the committed capture is not mutated');
  });

  it('empties whichever PortWatch side a capture holds, so neither can be assumed', () => {
    const allWithheld = capture();
    Object.assign(allWithheld.chokepoints.suez, { officialLatestDate: null, officialLatestTotal: null, officialAvg7d: null });
    const published = driftLivePulseCapture(allWithheld, { targetDate: '2026-10-26' });
    for (const reading of Object.values(published.chokepoints)) {
      assert.equal(reading.officialLatestDate, '2026-10-18');
      assert.ok(reading.officialLatestTotal > 0, 'a capture with no published day is rehearsed with every day published');
    }

    const allPublished = capture();
    Object.assign(allPublished.chokepoints.hormuz_strait, { officialLatestDate: '2026-10-11', officialLatestTotal: 4, officialAvg7d: 3.7 });
    const withheld = driftLivePulseCapture(allPublished, { targetDate: '2026-10-26' });
    for (const reading of Object.values(withheld.chokepoints)) {
      assert.equal(reading.officialLatestTotal, null, 'a capture with no withheld day is rehearsed with every day withheld');
      assert.equal(reading.officialLatestDate, null);
    }
  });

  it('empties the minority PortWatch side of a mixed capture, so a pin on it fails', () => {
    const mostlyWithheld = capture();
    mostlyWithheld.chokepoints.bab_el_mandeb = { ...mostlyWithheld.chokepoints.hormuz_strait, description: 'Bab el-Mandeb' };
    const drifted = driftLivePulseCapture(mostlyWithheld, { targetDate: '2026-10-26' });
    for (const reading of Object.values(drifted.chokepoints)) {
      assert.equal(reading.officialLatestTotal, null, 'two withheld days to one published rehearse with none published');
    }

    const mostlyPublished = capture();
    mostlyPublished.chokepoints.bab_el_mandeb = { ...mostlyPublished.chokepoints.suez, description: 'Bab el-Mandeb' };
    const published = driftLivePulseCapture(mostlyPublished, { targetDate: '2026-10-26' });
    for (const reading of Object.values(published.chokepoints)) {
      assert.ok(reading.officialLatestTotal > 0, 'two published days to one withheld rehearse with none withheld');
    }
  });

  it('drifts values but not dates when the capture is already today', () => {
    const drifted = driftLivePulseCapture(capture(), { targetDate: '2026-10-19' });
    assert.equal(drifted.capturedAt, '2026-10-19');
    assert.equal(drifted.countries.AE.methodologyVersion, 'v9');
  });

  it('replays the refresh workflow build and verify steps', () => {
    const steps = readRehearsedSteps(readFileSync(resolve(repoRoot, REFRESH_WORKFLOW_PATH), 'utf8'));
    assert.deepEqual(steps.map(({ name }) => name), ['Rebuild published artifacts', 'Verify published artifacts']);
    assert.match(steps[0].run, /npm run build:crawlable-corpus/);
    assert.match(steps[1].run, /node --import tsx --test/);
    assert.equal(steps[0].env.CRAWLABLE_DEVELOPMENTS_COVERAGE_RATIO, '', 'a workflow expression resolves to empty, as on the schedule');
  });

  it('rehearses every PR that touches a refresh verify test', () => {
    const [, verify] = readRehearsedSteps(readFileSync(resolve(repoRoot, REFRESH_WORKFLOW_PATH), 'utf8'));
    const verifyTests = verify.run.match(/tests\/[\w.-]+\.test\.m[jt]s/g);
    assert.ok(verifyTests.length > 0);
    const rehearsal = parseYaml(readFileSync(resolve(repoRoot, REHEARSAL_WORKFLOW_PATH), 'utf8'));
    const paths = rehearsal.on.pull_request.paths;
    for (const testPath of [...verifyTests, 'tests/rehearse-crawlable-pulse-refresh.test.mjs']) {
      assert.ok(paths.includes(testPath), `${REHEARSAL_WORKFLOW_PATH} must run when ${testPath} changes`);
    }
  });
});
