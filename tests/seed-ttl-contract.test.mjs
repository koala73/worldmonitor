// A key api/health.js monitors must stay in Redis longer than its staleness budget.
// Otherwise a seeder that is merely late lets the data expire first, and health
// reports EMPTY (crit) instead of STALE_SEED (warn) while consumers get nothing.
//
// The values come from running each seeder with runSeed replaced by a recorder
// (tests/helpers/runseed-probe.mjs), and from importing SEED_META itself, so a TTL
// built from an imported constant or a computed key is read exactly. Every health
// entry, every seeder and every key runSeed writes is accounted for: one the check
// cannot read fails the test instead of being skipped.
//
// The lists below are existing debt. They may only shrink; each test also fails
// when an entry no longer applies, so a fixed one must be deleted.
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { isTestRuntime } from '../scripts/_env-file.mjs';
import { probeEnv, recordRunSeedCalls, seedMetaWriters } from './helpers/runseed-probe.mjs';

const SCRIPTS = fileURLToPath(new URL('../scripts/', import.meta.url));
const { __testing__: { SEED_META } } = await import('../api/health.js');

// Health entries whose runSeed data TTL does not outlive maxStaleMin today.
const TTL_DEBT = new Set([
  'aiTokens',
  'bisPolicy',
  'chinaCoverage',
  'chokepointBaselines',
  'climateNews',
  'co2Monitoring',
  'commodityQuotes',
  'correlationCards',
  'crossSourceSignals',
  'cryptoSectors',
  'cyberThreats',
  'defiTokens',
  'ecbFxRates',
  'energyCrisisPolicies',
  'energyPrices',
  'euFsi',
  'euYieldCurve',
  'eurostatCountryData',
  'eurostatGovDebtQ',
  'eurostatHousePrices',
  'eurostatIndProd',
  'fxYoy',
  'goldCbReserves',
  'goldEtfFlows',
  'hormuzTracker',
  'ieaOilStocks',
  'imfExternal',
  'imfGrowth',
  'imfLabor',
  'imfMacro',
  'marketQuotes',
  'otherTokens',
  'portwatch',
  'portwatchChokepointsRef',
  'portwatchDisruptions',
  'recoveryExternalDebt',
  'recoveryFiscalSpace',
  'recoveryReexportShare',
  'recoveryReserveAdequacy',
  'recoverySovereignWealth',
  'sharedFxRates',
  'spending',
  'sprPolicies',
  'wbExternalDebt',
  'weatherAlerts',
  'wildfiresSummary',
]);

// Health entries written outside runSeed (the relay, workers, server handlers and
// direct Redis writes), so this check cannot read their TTL.
const UNRECORDED_WRITERS = new Set([
  'airTrafficHistory',
  'airTrafficHistoryWingbits',
  'aisGaps',
  'albertaRoads',
  'bisDsr',
  'bisPropertyCommercial',
  'bisPropertyResidential',
  'cableHealth',
  'canadaAlerts',
  'chinaMacro',
  'chokepointExposure',
  'chokepointFlowsRelayHeartbeat',
  'chokepointTransits',
  'chokepoints',
  'ciiEconomicStress',
  'ciiStructuralPrior',
  'climateAirQuality',
  'climateNewsRelayHeartbeat',
  'companyMonitoringWorker',
  'comtradeBilateralHs4',
  'comtradeBilateralHs4Ext',
  'consumerPricesCategories',
  'consumerPricesCoverage',
  'consumerPricesCoverageAU',
  'consumerPricesCoverageBR',
  'consumerPricesCoverageGB',
  'consumerPricesCoverageIN',
  'consumerPricesCoverageSA',
  'consumerPricesCoverageSG',
  'consumerPricesCoverageUS',
  'consumerPricesFreshness',
  'consumerPricesMovers',
  'consumerPricesOverview',
  'consumerPricesSpread',
  'corridorrisk',
  'countryHistory',
  'countryStockIndexes',
  'crossStraitActivityJapanMod',
  'crossStraitActivityTaiwanMnd',
  'crudeInventories',
  'customsRevenue',
  'ddosAttacks',
  'digestNotifications',
  'ecbEstr',
  'ecbEuribor1y',
  'ecbEuribor3m',
  'ecbEuribor6m',
  'economicStress',
  'electricityPrices',
  'emberElectricity',
  'energyExposure',
  'energyMixAll',
  'energySpineCountries',
  'faaDelays',
  'flightDelays',
  'forecastBets',
  'forecastFredCpiaucsl',
  'forecastFredDcoilwtico',
  'forecastFredDgs10',
  'forecastFredGdp',
  'forecastFredM2sl',
  'forecastFredT10y2y',
  'forecastFredUnrate',
  'forecastFredVixcls',
  'forecastFredWalcl',
  'forecastFunnel',
  'forecastMarketsResolution',
  'fredBatch',
  'gasStorageCountries',
  'gdeltCountryArticles',
  'gdeltCountryEvents',
  'gdeltDyadTension',
  'globalTendersAlbaniaApp',
  'globalTendersArmeniaArmeps',
  'globalTendersBrazilPncp',
  'globalTendersBulgariaEop',
  'globalTendersCanadaBuys',
  'globalTendersChileMercadoPublico',
  'globalTendersColombiaSecop',
  'globalTendersContractsFinder',
  'globalTendersDominicanRepublicDgcp',
  'globalTendersGeorgiaSpa',
  'globalTendersGets',
  'globalTendersKenyaPpip',
  'globalTendersLatviaIub',
  'globalTendersMalaysiaMyprocurement',
  'globalTendersPakistanEpads',
  'globalTendersPakistanPpra',
  'globalTendersPolandBzp',
  'globalTendersSam',
  'globalTendersSouthAfricaEtenders',
  'globalTendersTed',
  'globalTendersUkraineProzorro',
  'globalTendersWorldBank',
  'goldExtended',
  'gpsjam',
  'gscpi',
  'healthAirQuality',
  'humanitarianSummary',
  'intelHistoryIngestAviationIntl',
  'intelHistoryIngestConflictAcled',
  'intelHistoryIngestConflictUcdp',
  'intelHistoryIngestCyberThreats',
  'intelHistoryIngestEnergyIntelligence',
  'intelHistoryIngestMaritimePortwatch',
  'intelHistoryIngestMilitaryCrossStrait',
  'intelHistoryIngestNaturalEarthquakes',
  'intelHistoryIngestNaturalEvents',
  'intelHistoryIngestUnrestEvents',
  'intlDelays',
  'jodiOil',
  'macroSignals',
  'manitobaRoads',
  'marketImplications',
  'militaryBases',
  'militaryCii',
  'militaryFlights',
  'militaryForecastInputs',
  'militarySurges',
  'natGasStorage',
  'newsDigestWarmRelayHeartbeat',
  'newsFeedHealth',
  'newsRecallBenchmark',
  'newsThreatSummary',
  'no2Activity',
  'notamClosures',
  'oilStocksAnalysis',
  'openDataChokepoints',
  'orbitalSites',
  'orbitalWaterExtent',
  'physicalDivergence',
  'pizzint',
  'pizzintHistory',
  'portwatchPortActivity',
  'positiveGeoEvents',
  'productCatalog',
  'progressData',
  'refineryInputs',
  'regionalBriefs',
  'regionalSnapshots',
  'renewableEnergy',
  'resilienceIntervals',
  'resilienceRanking',
  'resilienceStaticFao',
  'resilienceStaticIndex',
  'riskScores',
  'riskScoresHistory',
  'sanctionsChanges',
  'sanctionsEntities',
  'satellites',
  'sectors',
  'shippingStress',
  'shippingWebhookWorker',
  'socialVelocity',
  'spr',
  'staticRefBundleTick',
  'staticRefHeavyBundleTick',
  'tariffTrendsUs',
  'techEvents',
  'techEventsSeeder',
  'techReadiness',
  'telegramFeed',
  'temporalAnomalies',
  'theaterPosture',
  'tradeFlows',
  'trafficAnomalies',
  'transitSummaries',
  'ucdpEvents',
  'ucdpEventsBootstrap',
  'usHtsDuties',
  'usniFleet',
  'webcams',
  'wsbTickers',
  'xFeed',
]);

// Seeders that never reach runSeed: they write Redis directly.
const DIRECT_WRITERS = new Set([
  'seed-aviation.mjs',
  'seed-cii-economic-stress.mjs',
  'seed-cii-structural-prior.mjs',
  'seed-comtrade-bilateral-hs4-ext.mjs',
  'seed-comtrade-bilateral-hs4.mjs',
  'seed-consumer-prices.mjs',
  'seed-country-history.mjs',
  'seed-digest-notifications.mjs',
  'seed-ecb-short-rates.mjs',
  'seed-electricity-prices.mjs',
  'seed-ember-electricity.mjs',
  'seed-energy-spine.mjs',
  'seed-forecast-bets.mjs',
  'seed-gas-storage-countries.mjs',
  'seed-gta-update.mjs',
  'seed-health-air-quality.mjs',
  'seed-hs2-chokepoint-exposure.mjs',
  'seed-infra.mjs',
  'seed-iran-events.mjs',
  'seed-jodi-oil.mjs',
  'seed-military-bases.mjs',
  'seed-military-cii.mjs',
  'seed-military-flights.mjs',
  'seed-military-maritime-news.mjs',
  'seed-no2-activity.mjs',
  'seed-orbital-sites.mjs',
  'seed-orbital-water-extent.mjs',
  'seed-owid-energy-mix.mjs',
  'seed-portwatch-port-activity.mjs',
  'seed-recall-benchmark.mjs',
  'seed-regional-briefs.mjs',
  'seed-regional-snapshots.mjs',
  'seed-resilience-scores.mjs',
  'seed-resilience-static.mjs',
  'seed-service-statuses.mjs',
  'seed-tps-open-data.mjs',
  'seed-ucdp-events.mjs',
  'seed-wb-indicators.mjs',
  'seed-webcams.mjs',
  'seed-yield-curves-shared.mjs',
]);

// seed-meta keys runSeed writes that no SEED_META entry monitors.
const UNMONITORED = new Set([
  'seed-meta:correlation:market-alerts-snapshot',
  'seed-meta:displacement:summary',
  'seed-meta:economic:bis-extended',
  'seed-meta:economic:china-macro',
  'seed-meta:military:arms-suppliers',
  'seed-meta:military:arms-suppliers-complete',
  'seed-meta:military:defense-industrial',
  'seed-meta:natural:western-pacific-cyclones',
  'seed-meta:resilience:recovery:fuel-stocks',
]);

let results;
let writers;
before(async () => {
  results = await recordRunSeedCalls(SCRIPTS);
  writers = seedMetaWriters(results);
});

const gateSeconds = (entry) => entry.maxStaleMin * 60;
const outlives = (w, entry) => w.ttlSeconds == null || w.ttlSeconds > gateSeconds(entry);
const added = (actual, debt) => actual.filter((x) => !debt.has(x));
const retired = (actual, debt) => [...debt].filter((x) => !actual.includes(x));

describe('seed data TTL against the health staleness budget', () => {
  it('a shorter TTL from any writer of a shared key is the one checked', () => {
    const call = (ttlSeconds) => ({ domain: 'd', resource: 'r', ttlSeconds, extraKeys: [] });
    for (const order of [[600, 60, null], [null, 60, 600], [60, 600, null]]) {
      const merged = seedMetaWriters([{ file: 'x', calls: order.map(call) }]);
      assert.equal(merged.get('seed-meta:d:r').ttlSeconds, 60, `writers in order ${order}`);
    }
  });

  it('never hands a seeder the checkout .env.local', () => {
    const env = probeEnv(fileURLToPath(new URL('..', import.meta.url)));
    assert.ok(isTestRuntime(env), 'mark the probe child as a test runtime so loadEnvFile() stays inert');
    assert.equal(env.WM_ALLOW_ENV_LOAD_IN_TESTS, undefined, 'the probe must not opt back into loading .env.local');
    assert.equal(env.WM_SEED_ENV_FILE, undefined, 'the probe must not point seeders at another env file');
  });

  it('reads every seeder to completion', () => {
    assert.deepEqual(results.filter((r) => r.hung).map((r) => r.file), [], 'these seeders hung under the probe, so their result depends on timing');
    assert.ok(writers.size > 200, `the probe recorded only ${writers.size} seed-meta writers; the recorder is broken`);
  });

  it('every monitored key runSeed writes outlives its staleness budget', () => {
    const short = Object.entries(SEED_META)
      .filter(([, e]) => writers.has(e.key) && !e.expiryIsTheAlarm && !outlives(writers.get(e.key), e))
      .map(([name]) => name);
    const detail = (name) => {
      const e = SEED_META[name]; const w = writers.get(e.key);
      return `${name}: ${w.writer} sets a ${w.ttlSeconds}s TTL, at or under the ${gateSeconds(e)}s health budget`;
    };
    assert.deepEqual(added(short, TTL_DEBT).map(detail), [],
      'raise the TTL above maxStaleMin * 60 in the writer. If the expiry is meant to page, set expiryIsTheAlarm with the reason on its SEED_META entry');
    assert.deepEqual(retired(short, TTL_DEBT), [], 'these now outlive their budget; delete them from TTL_DEBT');
  });

  it('expiryIsTheAlarm is set only where the data expires first', () => {
    const misplaced = Object.entries(SEED_META)
      .filter(([, e]) => e.expiryIsTheAlarm && !(writers.has(e.key) && !outlives(writers.get(e.key), e)))
      .map(([name]) => name);
    assert.deepEqual(misplaced, [], 'the data outlives the budget here, so the expiry no longer pages; remove expiryIsTheAlarm');
  });

  it('every health entry has a writer this check can read', () => {
    const unread = Object.entries(SEED_META).filter(([, e]) => !writers.has(e.key)).map(([name]) => name);
    assert.deepEqual(added(unread, UNRECORDED_WRITERS), [],
      'no runSeed call writes these seed-meta keys, so their TTL is unchecked. Publish them through runSeed or a runSeed extraKeys entry with metaKey, or add them to UNRECORDED_WRITERS');
    assert.deepEqual(retired(unread, UNRECORDED_WRITERS), [], 'these are now written by runSeed or no longer in SEED_META; delete them from UNRECORDED_WRITERS');
  });

  it('every seed-meta key runSeed writes is monitored by health', () => {
    const monitored = new Set(Object.values(SEED_META).map((e) => e.key));
    const unwatched = [...writers.keys()].filter((k) => !monitored.has(k));
    assert.deepEqual(added(unwatched, UNMONITORED).map((k) => `${k} (${writers.get(k).writer})`), [],
      'add a SEED_META entry in api/health.js for these, with a maxStaleMin the data outlives');
    assert.deepEqual(retired(unwatched, UNMONITORED), [], 'these are now monitored or no longer written; delete them from UNMONITORED');
  });

  it('every seeder that skips runSeed is listed', () => {
    const direct = results.filter((r) => r.calls.length === 0).map((r) => r.file);
    assert.deepEqual(added(direct, DIRECT_WRITERS), [],
      'these seeders never reached runSeed, so their TTLs are unchecked. Publish through runSeed, or add them to DIRECT_WRITERS');
    assert.deepEqual(retired(direct, DIRECT_WRITERS), [], 'these now reach runSeed; delete them from DIRECT_WRITERS');
  });
});
