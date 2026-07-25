import { readFileSync } from 'node:fs';

import { fetchChinaMacroSnapshot } from '../../scripts/china-macro/adapters.mjs';

const fixture = (name) => readFileSync(
  new URL(`../fixtures/china-macro/${name}`, import.meta.url),
  'utf8',
);
const routes = new Map([
  ['https://www.stats.gov.cn/english/PressRelease/', fixture('nbs-list.html')],
  ['https://www.stats.gov.cn/english/PressRelease/202607/t20260717_1964159.html', fixture('nbs-industrial.html')],
  ['https://www.stats.gov.cn/english/PressRelease/202607/t20260717_1964158.html', fixture('nbs-fai.html')],
  ['https://www.stats.gov.cn/english/PressRelease/202607/t20260717_1964157.html', fixture('nbs-property.html')],
  ['https://www.safe.gov.cn/safe/sjjd/index.html', fixture('safe-list.html')],
  ['https://www.safe.gov.cn/safe/2026/0706/27661.html', fixture('safe-reserves.html')],
  ['https://www.safe.gov.cn/safe/2026/0717/27704.html', fixture('safe-settlement.html')],
]);

export const CHINA_MACRO_FIXTURE_RETRIEVAL_TIME = '2026-07-25T14:30:00.000Z';

export const CHINA_MACRO_FIXTURE_SERIES_IDS = Object.freeze([
  'nbs_industrial_value_added_yoy',
  'nbs_fixed_asset_investment_yoy',
  'nbs_real_estate_investment_yoy',
  'safe_fx_reserves',
  'safe_bank_fx_settlement',
  'pboc_aggregate_financing_flow',
  'pboc_new_rmb_loans',
  'pboc_m2_yoy',
  'pboc_policy_liquidity_operation',
  'gacc_exports',
  'gacc_imports',
  'gacc_trade_balance',
]);

export async function buildOfficialChinaMacroFixture() {
  return fetchChinaMacroSnapshot({
    now: Date.parse(CHINA_MACRO_FIXTURE_RETRIEVAL_TIME),
    readCachedFn: async () => null,
    fetchFn: async (input) => {
      const url = String(input);
      if (
        url === 'https://www.stats.gov.cn/robots.txt'
        || url === 'https://www.safe.gov.cn/robots.txt'
      ) {
        return new Response('not found', { status: 404 });
      }
      if (url === 'https://www.pbc.gov.cn/robots.txt') {
        return new Response('User-agent: *\nDisallow: /\n');
      }
      if (url === 'https://english.customs.gov.cn/robots.txt') {
        throw Object.assign(new Error('self signed certificate in certificate chain'), {
          code: 'SELF_SIGNED_CERT_IN_CHAIN',
        });
      }
      const body = routes.get(url);
      if (!body) throw new Error(`unexpected fixture request ${url}`);
      return new Response(body);
    },
    onDecision: () => {},
  });
}
