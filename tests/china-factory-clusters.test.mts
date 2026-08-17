import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CHINA_COMTRADE_NATIONAL_CAPTION,
  CHINA_FACTORY_CLUSTERS,
  chinaFactoryClusterById,
  selectObservedChinaFactoryTrade,
} from '../shared/china-factory-clusters.ts';

describe('china factory cluster registry', () => {
  it('keeps national Comtrade caption from claiming town-level exports', () => {
    assert.match(CHINA_COMTRADE_NATIONAL_CAPTION, /reporter 156/);
    assert.match(CHINA_COMTRADE_NATIONAL_CAPTION, /not a town/);
  });

  it('joins eligible clusters only on reporter 156 and reviewed HS', () => {
    const huidong = chinaFactoryClusterById('gd-huidong-footwear');
    assert.ok(huidong?.statisticsEligible);
    const rows = selectObservedChinaFactoryTrade([
      { reporterCode: '156', cmdCode: '64', year: 2024, tradeValueUsd: 1_000, flowCode: 'X', partnerCode: '0' },
      { reporterCode: '842', cmdCode: '64', year: 2024, tradeValueUsd: 9_000, flowCode: 'X', partnerCode: '0' },
      { reporterCode: '156', cmdCode: '27', year: 2024, tradeValueUsd: 2_000, flowCode: 'X', partnerCode: '0' },
    ], huidong);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.tradeValueUsd, 1_000);
  });

  it('refuses a numeric join when HS is unreviewed, even if names look unique', () => {
    const yiwu = chinaFactoryClusterById('zj-yiwu-small-commodities');
    assert.ok(yiwu);
    assert.equal(yiwu.statisticsEligible, false);
    const rows = selectObservedChinaFactoryTrade([
      { reporterCode: '156', cmdCode: '64', year: 2024, tradeValueUsd: 1_000, flowCode: 'X', partnerCode: '0' },
    ], yiwu);
    assert.deepEqual(rows, []);
  });

  it('does not merge two clusters that share a product word', () => {
    // Exercises the gate itself. The previous version asserted
    // `!eligible.some(id === cluster.id)` inside `if (!cluster.statisticsEligible)`,
    // where `eligible` was filtered on that same flag — true by construction,
    // and it never called selectObservedChinaFactoryTrade at all.
    const footwear = chinaFactoryClusterById('gd-huidong-footwear');
    const smallCommodities = chinaFactoryClusterById('zj-yiwu-small-commodities');
    assert.ok(footwear);
    assert.ok(smallCommodities);

    // Rows both clusters could plausibly name-match on.
    const records = [
      { reporterCode: '156', cmdCode: '64', year: 2024, tradeValueUsd: 1_000, flowCode: 'X', partnerCode: '0' },
      { reporterCode: '156', cmdCode: '95', year: 2024, tradeValueUsd: 2_000, flowCode: 'X', partnerCode: '0' },
    ];

    const footwearRows = selectObservedChinaFactoryTrade(records, footwear);
    assert.deepEqual(footwearRows.map((row) => row.cmdCode), ['64']);

    // The unmapped cluster must join nothing, even though the same rows exist.
    assert.deepEqual(selectObservedChinaFactoryTrade(records, smallCommodities), []);
  });

  it('admits a full HS subheading under its reviewed chapter', () => {
    const footwear = chinaFactoryClusterById('gd-huidong-footwear');
    assert.ok(footwear);
    const rows = selectObservedChinaFactoryTrade([
      { reporterCode: '156', cmdCode: '640351', year: 2024, tradeValueUsd: 10, flowCode: 'X', partnerCode: '0' },
      { reporterCode: 'CHN', cmdCode: '6405', year: 2024, tradeValueUsd: 20, flowCode: 'X', partnerCode: '0' },
      { reporterCode: '842', cmdCode: '6403', year: 2024, tradeValueUsd: 30, flowCode: 'X', partnerCode: '0' },
    ], footwear);
    assert.deepEqual(rows.map((row) => row.tradeValueUsd), [10, 20]);
  });

  it('keeps world-total rows only, so a caller cannot double-count', () => {
    // Comtrade emits one row per (flow, partner). Summing across partners and
    // both directions would inflate the figure under an OBSERVED_OFFICIAL label.
    const footwear = chinaFactoryClusterById('gd-huidong-footwear');
    assert.ok(footwear);
    const rows = selectObservedChinaFactoryTrade([
      { reporterCode: '156', cmdCode: '64', year: 2024, tradeValueUsd: 500, flowCode: 'X', partnerCode: '0' },
      { reporterCode: '156', cmdCode: '64', year: 2024, tradeValueUsd: 400, flowCode: 'M', partnerCode: '0' },
      { reporterCode: '156', cmdCode: '64', year: 2024, tradeValueUsd: 300, flowCode: 'X', partnerCode: '842' },
    ], footwear, { flowCode: 'X' });
    assert.deepEqual(rows.map((row) => row.tradeValueUsd), [500]);
  });
});
