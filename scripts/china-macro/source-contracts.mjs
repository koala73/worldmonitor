import {
  CHINA_MACRO_PUBLISHER_IDS,
  CHINA_MACRO_SERIES_CONTRACT,
} from '../_china-macro-contract.mjs';

export const NBS_LIST_URL = 'https://www.stats.gov.cn/english/PressRelease/';
export const SAFE_LIST_URL = 'https://www.safe.gov.cn/safe/sjjd/index.html';
export const NBS_ROBOTS_URL = 'https://www.stats.gov.cn/robots.txt';
export const SAFE_ROBOTS_URL = 'https://www.safe.gov.cn/robots.txt';
export const PBOC_ROBOTS_URL = 'https://www.pbc.gov.cn/robots.txt';
export const GACC_ROBOTS_URL = 'https://english.customs.gov.cn/robots.txt';

export const NBS_MAX_REQUESTS_PER_RUN = 8;
export const SAFE_MAX_REQUESTS_PER_RUN = 6;
export const PBOC_MAX_REQUESTS_PER_RUN = 2;
export const GACC_MAX_REQUESTS_PER_RUN = 2;

export const SOURCE_POLICIES = Object.freeze({
  nbs: Object.freeze({
    origin: 'https://www.stats.gov.cn',
    path: (pathname) => pathname.startsWith('/english/PressRelease/'),
  }),
  nbsRobots: Object.freeze({
    origin: 'https://www.stats.gov.cn',
    path: (pathname) => pathname === '/robots.txt',
  }),
  safe: Object.freeze({
    origin: 'https://www.safe.gov.cn',
    path: (pathname) => pathname.startsWith('/safe/'),
  }),
  safeRobots: Object.freeze({
    origin: 'https://www.safe.gov.cn',
    path: (pathname) => pathname === '/robots.txt',
  }),
  pboc: Object.freeze({
    origin: 'https://www.pbc.gov.cn',
    path: (pathname) => pathname === '/robots.txt',
  }),
  gacc: Object.freeze({
    origin: 'https://english.customs.gov.cn',
    path: (pathname) => pathname === '/robots.txt',
  }),
});

export const PUBLISHERS = Object.freeze({
  nbs: {
    id: CHINA_MACRO_PUBLISHER_IDS.nbs,
    name: 'National Bureau of Statistics of China',
    sourceName: 'NBS (China)',
  },
  safe: {
    id: CHINA_MACRO_PUBLISHER_IDS.safe,
    name: 'State Administration of Foreign Exchange',
    sourceName: 'SAFE (China)',
  },
});

const UNAVAILABLE_LABELS = Object.freeze({
  pboc_aggregate_financing_flow: 'Aggregate Financing Flow',
  pboc_new_rmb_loans: 'New RMB Loans',
  pboc_m2_yoy: 'M2 Growth (YoY)',
  pboc_policy_liquidity_operation: 'Policy Liquidity Operation',
  gacc_exports: 'Exports',
  gacc_imports: 'Imports',
  gacc_trade_balance: 'Trade Balance',
});

export const UNAVAILABLE_DEFINITIONS = Object.freeze(
  Object.entries(UNAVAILABLE_LABELS).map(([seriesId, label]) => {
    const contract = CHINA_MACRO_SERIES_CONTRACT[seriesId];
    if (!contract) throw new Error(`Missing canonical China macro contract for ${seriesId}`);
    return Object.freeze({
      seriesId,
      label,
      pillar: contract.pillar,
      unit: contract.unit,
      periodKind: contract.periodKind,
      source: contract.source,
      sourceUrl: `https://${contract.sourceHost}/`,
    });
  }),
);
