import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseUsgsValue,
  classifyUsgsStage,
  resolveMineralCountry,
  parseUsgsMcsCsv,
  parseBgsRecords,
  aggregateMineralProduction,
  mergeUsgsThenBgs,
} from '../scripts/shared/mineral-production-parse.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const mcsCsv = readFileSync(resolve(here, 'fixtures/mineral-production/mcs-sample.csv'), 'utf8');
const bgsJson = JSON.parse(readFileSync(resolve(here, 'fixtures/mineral-production/bgs-sample.json'), 'utf8'));

describe('parseUsgsValue', () => {
  it('does not treat withheld W as zero', () => {
    const parsed = parseUsgsValue('W');
    assert.equal(parsed.kind, 'withheld');
    assert.equal(parsed.value, undefined);
  });

  it('parses grouped numeric strings', () => {
    assert.deepEqual(parseUsgsValue('226,000'), { kind: 'number', value: 226000 });
  });

  it('classifies em-dash and NA as non-numeric', () => {
    assert.equal(parseUsgsValue('—').kind, 'nil');
    assert.equal(parseUsgsValue('NA').kind, 'na');
  });
});

describe('classifyUsgsStage', () => {
  it('splits copper mine vs refinery details', () => {
    assert.equal(
      classifyUsgsStage('World Mine and Refinery Production and Reserves', 'Mine production'),
      'mine',
    );
    assert.equal(
      classifyUsgsStage('World Mine and Refinery Production and Reserves', 'Refinery production'),
      'refinery',
    );
  });

  it('treats gallium primary production as refinery', () => {
    assert.equal(
      classifyUsgsStage('World Low-Purity Production and Production Capacity', 'Primary production'),
      'refinery',
    );
  });
});

describe('resolveMineralCountry', () => {
  it('maps Congo (Kinshasa) and Korea, North', () => {
    assert.equal(resolveMineralCountry('Congo (Kinshasa)').iso2, 'CD');
    assert.equal(resolveMineralCountry('Korea, North').iso2, 'KP');
    assert.equal(resolveMineralCountry('Korea, Republic of').iso2, 'KR');
  });

  it('keeps Other countries as a residual bucket', () => {
    const resolved = resolveMineralCountry('Other countries');
    assert.equal(resolved.residual, true);
    assert.equal(resolved.unmapped, false);
  });
});

describe('parseUsgsMcsCsv + aggregate', () => {
  const { rows, unmapped } = parseUsgsMcsCsv(mcsCsv);
  const commodities = aggregateMineralProduction(rows, { preferredYear: 2024 });

  it('parses real MCS fixture rows for the starter set', () => {
    assert.ok(rows.length > 20);
    assert.ok(commodities.cobalt);
    assert.ok(commodities.lithium);
    assert.ok(commodities.copper);
  });

  it('maps Congo (Kinshasa) on cobalt and does not silently drop it', () => {
    const congo = commodities.cobalt.stages.mine.countries.find((c) => c.iso2 === 'CD');
    assert.ok(congo, 'Congo (Kinshasa) missing from cobalt mine stage');
    assert.equal(congo.output, 226000);
    assert.equal(unmapped.filter((u) => /congo/i.test(u.country)).length, 0);
  });

  it('preserves lithium US withheld instead of converting W to 0', () => {
    const us = commodities.lithium.stages.mine.countries.find((c) => c.iso2 === 'US');
    assert.ok(us, 'US lithium row missing');
    assert.equal(us.withheld, true);
    assert.equal(us.output, null);
    assert.equal(us.share, null);
    const shares = commodities.lithium.stages.mine.countries
      .filter((c) => c.share != null)
      .reduce((sum, c) => sum + c.share, 0);
    assert.ok(shares > 99 && shares < 101);
    assert.ok(commodities.lithium.stages.mine.withheldCount >= 1);
  });

  it('reconciles cobalt 2024 top-3 shares against MCS figures', () => {
    const mine = commodities.cobalt.stages.mine;
    const top3 = mine.countries.filter((c) => !c.withheld).slice(0, 3);
    assert.equal(top3[0].iso2, 'CD');
    assert.equal(top3[0].output, 226000);
    assert.ok(Math.abs(top3[0].share - ((226000 / mine.worldTotal) * 100)) < 0.2);
    assert.equal(top3[1].iso2, 'ID');
    assert.equal(top3[1].output, 35000);
    assert.equal(top3[2].iso2, 'RU');
    assert.equal(top3[2].output, 8000);
    assert.ok(mine.hhi > 5000, `cobalt HHI ${mine.hhi} should show extreme concentration`);
  });

  it('exposes copper mine and refinery stages separately', () => {
    const mine = commodities.copper.stages.mine;
    const refine = commodities.copper.stages.refinery;
    assert.ok(mine);
    assert.ok(refine);
    const chileMine = mine.countries.find((c) => c.iso2 === 'CL');
    const chinaRefine = refine.countries.find((c) => c.iso2 === 'CN');
    assert.equal(chileMine.output, 5510);
    assert.equal(chinaRefine.output, 12400);
    assert.ok(chinaRefine.share > chileMine.share);
  });
});

describe('BGS fill', () => {
  it('fills uranium and germanium when USGS world tables are absent', () => {
    const usgs = parseUsgsMcsCsv(mcsCsv);
    const bgs = parseBgsRecords(bgsJson);
    const merged = mergeUsgsThenBgs(usgs.rows, bgs.rows);
    const commodities = aggregateMineralProduction(merged);
    assert.ok(commodities.uranium?.stages.mine, 'uranium mine stage should come from BGS');
    assert.equal(commodities.uranium.stages.mine.countries[0].iso2, 'KZ');
    assert.deepEqual(commodities.uranium.sources, ['bgs']);
    assert.ok(commodities.germanium?.stages.mine || commodities.germanium?.stages.refinery);
    assert.ok(commodities.cobalt.sources.includes('usgs-mcs'));
    assert.ok(!commodities.cobalt.sources.includes('bgs'));
  });
});
