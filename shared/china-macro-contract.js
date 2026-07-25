export const CHINA_MACRO_SCHEMA_VERSION = 2;
export const CHINA_MACRO_CACHE_KEY = 'economic:china:macro:v2';
export const CHINA_MACRO_PROVENANCE_FAMILY = 'china_macro_official_numeric_observation';
export const CHINA_MACRO_MAX_TRANSPORT_AGE_MIN = 3 * 24 * 60;
export const CHINA_MACRO_MAX_CONTENT_AGE_MIN = 45 * 24 * 60;

export const CHINA_MACRO_REQUIRED_SERIES = Object.freeze([
  'nbs_industrial_value_added_yoy',
  'nbs_fixed_asset_investment_yoy',
  'nbs_real_estate_investment_yoy',
  'safe_fx_reserves',
  'safe_bank_fx_settlement',
]);

export const CHINA_MACRO_SERIES_MAX_AGE_DAYS = Object.freeze({
  nbs_industrial_value_added_yoy: 75,
  nbs_fixed_asset_investment_yoy: 75,
  nbs_real_estate_investment_yoy: 75,
  safe_fx_reserves: 45,
  safe_bank_fx_settlement: 45,
});

export const CHINA_MACRO_PUBLISHER_IDS = Object.freeze({
  nbs: 'publisher:nbs-cn',
  pboc: 'publisher:pboc-cn',
  safe: 'publisher:safe-cn',
  gacc: 'publisher:gacc-cn',
});

export const CHINA_MACRO_SERIES_CONTRACT = Object.freeze({
  nbs_industrial_value_added_yoy: Object.freeze({
    pillar: 'activity', unit: '%', periodKind: 'month',
    source: 'National Bureau of Statistics of China', publisherId: CHINA_MACRO_PUBLISHER_IDS.nbs,
    sourceHost: 'www.stats.gov.cn', sourcePathPrefix: '/english/PressRelease/',
  }),
  nbs_fixed_asset_investment_yoy: Object.freeze({
    pillar: 'investment_property', unit: '%', periodKind: 'cumulative_year',
    source: 'National Bureau of Statistics of China', publisherId: CHINA_MACRO_PUBLISHER_IDS.nbs,
    sourceHost: 'www.stats.gov.cn', sourcePathPrefix: '/english/PressRelease/',
  }),
  nbs_real_estate_investment_yoy: Object.freeze({
    pillar: 'investment_property', unit: '%', periodKind: 'cumulative_year',
    source: 'National Bureau of Statistics of China', publisherId: CHINA_MACRO_PUBLISHER_IDS.nbs,
    sourceHost: 'www.stats.gov.cn', sourcePathPrefix: '/english/PressRelease/',
  }),
  safe_fx_reserves: Object.freeze({
    pillar: 'external_pressure', unit: 'USD 100 million', periodKind: 'point_in_time',
    source: 'State Administration of Foreign Exchange', publisherId: CHINA_MACRO_PUBLISHER_IDS.safe,
    sourceHost: 'www.safe.gov.cn', sourcePathPrefix: '/safe/',
  }),
  safe_bank_fx_settlement: Object.freeze({
    pillar: 'external_pressure', unit: 'CNY 100 million', periodKind: 'month',
    source: 'State Administration of Foreign Exchange', publisherId: CHINA_MACRO_PUBLISHER_IDS.safe,
    sourceHost: 'www.safe.gov.cn', sourcePathPrefix: '/safe/',
  }),
  pboc_aggregate_financing_flow: Object.freeze({
    pillar: 'credit_liquidity', unit: 'CNY 100 million', periodKind: 'month',
    source: 'People’s Bank of China', publisherId: CHINA_MACRO_PUBLISHER_IDS.pboc,
    sourceHost: 'www.pbc.gov.cn', sourcePathPrefix: '/',
  }),
  pboc_new_rmb_loans: Object.freeze({
    pillar: 'credit_liquidity', unit: 'CNY 100 million', periodKind: 'month',
    source: 'People’s Bank of China', publisherId: CHINA_MACRO_PUBLISHER_IDS.pboc,
    sourceHost: 'www.pbc.gov.cn', sourcePathPrefix: '/',
  }),
  pboc_m2_yoy: Object.freeze({
    pillar: 'credit_liquidity', unit: '%', periodKind: 'month',
    source: 'People’s Bank of China', publisherId: CHINA_MACRO_PUBLISHER_IDS.pboc,
    sourceHost: 'www.pbc.gov.cn', sourcePathPrefix: '/',
  }),
  pboc_policy_liquidity_operation: Object.freeze({
    pillar: 'credit_liquidity', unit: 'CNY 100 million', periodKind: 'point_in_time',
    source: 'People’s Bank of China', publisherId: CHINA_MACRO_PUBLISHER_IDS.pboc,
    sourceHost: 'www.pbc.gov.cn', sourcePathPrefix: '/',
  }),
  gacc_exports: Object.freeze({
    pillar: 'trade', unit: 'USD million', periodKind: 'month',
    source: 'General Administration of Customs of China', publisherId: CHINA_MACRO_PUBLISHER_IDS.gacc,
    sourceHost: 'english.customs.gov.cn', sourcePathPrefix: '/',
  }),
  gacc_imports: Object.freeze({
    pillar: 'trade', unit: 'USD million', periodKind: 'month',
    source: 'General Administration of Customs of China', publisherId: CHINA_MACRO_PUBLISHER_IDS.gacc,
    sourceHost: 'english.customs.gov.cn', sourcePathPrefix: '/',
  }),
  gacc_trade_balance: Object.freeze({
    pillar: 'trade', unit: 'USD million', periodKind: 'month',
    source: 'General Administration of Customs of China', publisherId: CHINA_MACRO_PUBLISHER_IDS.gacc,
    sourceHost: 'english.customs.gov.cn', sourcePathPrefix: '/',
  }),
});

export const CHINA_MACRO_SERIES_IDS = Object.freeze(Object.keys(CHINA_MACRO_SERIES_CONTRACT));

export function chinaMacroObservationDateMs(value) {
  if (typeof value !== 'string' || !value) return null;
  const month = /^(\d{4})-(\d{2})$/.exec(value);
  const parsed = month
    ? Date.UTC(Number(month[1]), Number(month[2]), 0, 23, 59, 59)
    : Date.parse(`${value}${/^\d{4}-\d{2}-\d{2}$/.test(value) ? 'T23:59:59Z' : ''}`);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isChinaMacroObservationStale(seriesId, observationPeriod, now = Date.now()) {
  const maxAgeDays = CHINA_MACRO_SERIES_MAX_AGE_DAYS[seriesId];
  const observedAt = chinaMacroObservationDateMs(observationPeriod);
  return !Number.isFinite(maxAgeDays)
    || observedAt == null
    || now - observedAt > maxAgeDays * 86_400_000;
}
