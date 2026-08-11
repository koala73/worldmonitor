import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CHINA_FACTORY_CLUSTERS,
  CHINA_FACTORY_REFERENCE_CLUSTERS,
  CHINA_FACTORY_REVIEWED_CLUSTERS,
  chinaFactoryClusterById,
} from '../shared/china-factory-clusters';
import {
  chinaFactoryFiltersFromSearch,
  chinaFactoryUrl,
  isChinaFactoryPath,
  selectObservedChinaFactoryTrade,
} from '../src/features/china-factory/china-factory-route';

test('China factory registry has an official-source reference set and both requested footwear clusters', () => {
  assert.ok(CHINA_FACTORY_REFERENCE_CLUSTERS.length >= 20);
  assert.ok(CHINA_FACTORY_CLUSTERS.length >= 22);
  assert.deepEqual(CHINA_FACTORY_REVIEWED_CLUSTERS.map((cluster) => cluster.id), [
    'huidong-womens-footwear',
    'putian-licheng-sports-footwear',
  ]);
  for (const cluster of CHINA_FACTORY_CLUSTERS) {
    assert.match(cluster.source.url, /^https:\/\//);
    assert.match(cluster.source.publishedAt, /^20\d{2}-\d{2}-\d{2}$/);
  }
  for (const cluster of CHINA_FACTORY_REFERENCE_CLUSTERS) {
    assert.equal(cluster.statisticsEligible, false);
    assert.equal(cluster.hsMappings.length, 0);
  }
  assert.deepEqual(chinaFactoryClusterById('huidong-womens-footwear').hsMappings.map((mapping) => mapping.hs2), ['64']);
  assert.deepEqual(chinaFactoryClusterById('putian-licheng-sports-footwear').hsMappings.map((mapping) => mapping.hs2), ['64']);
});

test('China factory route normalizes untrusted filters to a known cluster/year/HS2', () => {
  assert.equal(isChinaFactoryPath('/china-factory'), true);
  assert.equal(isChinaFactoryPath('/china-factory/'), true);
  assert.equal(isChinaFactoryPath('/china-factory/unknown'), false);
  assert.deepEqual(chinaFactoryFiltersFromSearch('?cluster=unknown&period=2024-04&hs2=not-a-code'), {
    clusterId: 'huidong-womens-footwear', period: '2024', hs2: '64',
  });
  assert.equal(chinaFactoryUrl({ clusterId: 'putian-licheng-sports-footwear', period: '2023', hs2: '64' }),
    '/china-factory?cluster=putian-licheng-sports-footwear&period=2023&hs2=64');
});

test('all value-bearing China factory views share reporter, period and HS2 filters', () => {
  const selected = selectObservedChinaFactoryTrade([
    { reporterCode: '156', partnerCode: 'US', partnerName: 'United States', cmdCode: '6404', cmdDesc: 'Footwear', year: 2024, tradeValueUsd: 30, netWeightKg: 3 },
    { reporterCode: '156', partnerCode: 'JP', partnerName: 'Japan', cmdCode: '6403', cmdDesc: 'Footwear', year: 2024, tradeValueUsd: 20, netWeightKg: 2 },
    { reporterCode: '156', partnerCode: 'US', partnerName: 'United States', cmdCode: '8517', cmdDesc: 'Telephones', year: 2024, tradeValueUsd: 500, netWeightKg: 50 },
    { reporterCode: '156', partnerCode: 'US', partnerName: 'United States', cmdCode: '6404', cmdDesc: 'Footwear', year: 2023, tradeValueUsd: 900, netWeightKg: 90 },
    { reporterCode: '842', partnerCode: 'CN', partnerName: 'China', cmdCode: '6404', cmdDesc: 'Footwear', year: 2024, tradeValueUsd: 800, netWeightKg: 80 },
  ], { clusterId: 'huidong-womens-footwear', period: '2024', hs2: '64' });
  assert.deepEqual(selected.map((record) => record.partnerCode), ['US', 'JP']);
  assert.ok(selected.every((record) => record.reporterCode === '156' && record.year === 2024 && record.cmdCode.startsWith('64')));
});
