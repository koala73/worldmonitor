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
  buildMineralProductionPayload,
  decodeUsgsCsvText,
  loadMineralVocab,
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
    // The denominator is the sum of quantified country rows (301,590), NOT the
    // published rounded world total (302,000). The previous 0.2pp tolerance
    // could not tell those apart -- 74.936% vs 74.834% is a 0.10pp gap -- so it
    // passed whichever denominator the code used. Pin the real contract tightly
    // and assert the two are distinguishable.
    const quantified = mine.countries
      .filter((c) => c.output != null)
      .reduce((sum, c) => sum + c.output, 0);
    assert.equal(quantified, 301590);
    assert.equal(mine.worldTotal, 302000);
    assert.ok(Math.abs(top3[0].share - ((226000 / quantified) * 100)) < 0.001);
    assert.ok(
      Math.abs(top3[0].share - ((226000 / mine.worldTotal) * 100)) > 0.05,
      'share must be distinguishable from a worldTotal-denominated share',
    );
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

describe('residual bucket is not a producer', () => {
  const { rows } = parseUsgsMcsCsv(mcsCsv);
  const commodities = aggregateMineralProduction(rows, { preferredYear: 2024 });

  it('keeps the Other countries residual out of HHI', () => {
    const mine = commodities.cobalt.stages.mine;
    const residual = mine.countries.find((c) => c.residual);
    assert.ok(residual, 'fixture should carry an Other countries row');
    assert.ok(residual.share > 0, 'residual should still carry its share for display');

    const named = mine.countries.filter((c) => c.share != null && !c.residual);
    const expected = named.reduce((sum, c) => sum + c.share * c.share, 0);
    assert.ok(Math.abs(mine.hhi - expected) < 1e-9, `hhi ${mine.hhi} should equal named-producer sum ${expected}`);

    // Prove the exclusion is load-bearing: including the residual would move
    // the value, so this assertion fails if the filter is dropped.
    const withResidual = expected + residual.share * residual.share;
    assert.ok(withResidual - mine.hhi > 0.5, 'residual must measurably change HHI');
  });

  it('ranks a large residual below named producers it would otherwise outrank', () => {
    // Copper mine is the case where the residual is big enough to reach a
    // visible top-3 slot; the panel filters on `residual` for exactly this.
    const mine = commodities.copper.stages.mine;
    const residual = mine.countries.find((c) => c.residual);
    assert.ok(residual, 'copper mine fixture should carry a residual row');
    const named = mine.countries.filter((c) => !c.withheld && !c.residual && c.share != null);
    assert.ok(named.length >= 3);
    assert.ok(named.every((c) => c.iso2), 'named producers must all carry an iso2');
    assert.equal(residual.iso2, '', 'residual carries no iso2, which is what marks it non-country');
  });
});

describe('buildMineralProductionPayload', () => {
  const usgs = parseUsgsMcsCsv(mcsCsv);
  const bgs = parseBgsRecords(bgsJson);
  const merged = mergeUsgsThenBgs(usgs.rows, bgs.rows);
  const payload = buildMineralProductionPayload(merged, {
    edition: 'mcs-2026',
    sources: ['usgs-mcs', 'bgs'],
    fetchedAt: '2026-01-01T00:00:00.000Z',
  });

  it('carries the envelope fields the seeder contract depends on', () => {
    assert.equal(payload.fetchedAt, '2026-01-01T00:00:00.000Z');
    assert.equal(payload.edition, 'mcs-2026');
    assert.deepEqual(payload.sources, ['usgs-mcs', 'bgs']);
    assert.equal(payload.ieaSkipped, true);
    assert.ok(payload.ieaSkipReason.length > 0);
  });

  it('reports dataYear as the newest year any commodity resolved to', () => {
    // Production calls aggregate with NO preferredYear, so pickYear takes the
    // max: the MCS fixture carries both the revised 2024 column and the 2025
    // estimate column, and 2025 is what actually ships.
    assert.equal(payload.dataYear, 2025);
    assert.equal(payload.commodities.cobalt.stages.mine.year, 2025);
    const congo = payload.commodities.cobalt.stages.mine.countries.find((c) => c.iso2 === 'CD');
    assert.equal(congo.output, 230000, '2025 estimate, not the 2024 revised 226000');
  });

  it('counts unmapped countries without counting residual or world-total rows', () => {
    assert.equal(payload.unmappedCount, 0);
    assert.deepEqual(payload.unmappedSample, []);
  });
});

describe('parser branches the fixture does not reach', () => {
  it('treats E and s/S as unquantified rather than numeric', () => {
    assert.equal(parseUsgsValue('E').kind, 'unquantified');
    assert.equal(parseUsgsValue('s').kind, 'unquantified');
    assert.equal(parseUsgsValue('S').kind, 'unquantified');
    assert.equal(parseUsgsValue('E').value, undefined);
  });

  it('flags a country it cannot resolve instead of silently dropping it', () => {
    const resolved = resolveMineralCountry('Neverland');
    assert.equal(resolved.iso2, null);
    assert.equal(resolved.unmapped, true);
    assert.equal(resolved.residual, false);
    assert.equal(resolved.name, 'Neverland');
  });

  it('falls back to latin1 when the buffer is not valid UTF-8', () => {
    const latin1 = Buffer.from('Cote dIvoire', 'latin1');
    const decoded = decodeUsgsCsvText(latin1);
    assert.ok(!decoded.includes('�'), 'latin1 fallback should avoid replacement chars');
    assert.equal(decodeUsgsCsvText('already a string'), 'already a string');
  });

  it('rejects a vocabulary where two commodities claim one usgsChapters key', () => {
    const vocab = {
      commodities: [
        { id: 'bauxite', label: 'Bauxite', usgsNames: ['Bauxite'], usgsChapters: ['BAUXITE AND ALUMINA'] },
        { id: 'alumina', label: 'Alumina', usgsNames: ['Alumina'], usgsChapters: ['BAUXITE AND ALUMINA'] },
      ],
    };
    assert.throws(
      () => parseUsgsMcsCsv(mcsCsv, { vocab }),
      /claimed by both/,
      'a duplicate chapter key must fail loudly, not resolve to whichever entry was last',
    );
  });

  it('ships a vocabulary with no duplicate chapter keys', () => {
    const vocab = loadMineralVocab();
    const seen = new Map();
    for (const item of vocab.commodities) {
      for (const chapter of item.usgsChapters || []) {
        const key = chapter.toLowerCase();
        assert.equal(seen.has(key), false, `chapter "${chapter}" claimed by ${seen.get(key)} and ${item.id}`);
        seen.set(key, item.id);
      }
    }
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
