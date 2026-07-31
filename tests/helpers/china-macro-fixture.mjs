import { readFileSync } from 'node:fs';

import { fetchChinaMacroSnapshot } from '../../scripts/china-macro/adapters.mjs';

const fixture = (name) => readFileSync(
  new URL(`../fixtures/china-macro/${name}`, import.meta.url),
  'utf8',
);

// The recorded HTML describes a real release: June 2026 data, published
// mid-July 2026. Those dates are load-bearing -- the adapter derives
// observationPeriod and releaseTime from them, and two read paths then age
// those against the wall clock (transport 72h, content 45-75d per series).
// Left literal, the fixture rots on a calendar date and reddens `main` for
// every branch at once (#5762).
//
// So the dates are rebased per build instead. The shape is preserved exactly --
// "previous month's data, published recently" -- which is what the fixture is
// actually asserting about. Rebasing keeps `observed <= published <= retrieved`
// and both freshness budgets satisfied for ANY clock, so no calendar date can
// expire it.
const MONTHS_EN = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const pad = (n) => String(n).padStart(2, '0');

function fixtureDates(now) {
  // Publication: two days back. Two rather than one because the recorded NBS
  // release carries a 10:00 clock time -- a same-day or one-day-back date could
  // still land in the future relative to `now` and break the
  // published <= retrieved ordering the adapter enforces.
  const pub = new Date(now - 2 * 86_400_000);
  // Observation period: the month BEFORE the publication month. A statistical
  // release always reports a month that has already ended, and the adapter
  // rejects a release dated inside its own reporting month as schema drift.
  // Age is then at most ~32 days, inside even the tightest series budget
  // (SAFE, 45d), for every possible `now`.
  const period = new Date(Date.UTC(pub.getUTCFullYear(), pub.getUTCMonth() - 1, 1));
  return {
    periodYear: period.getUTCFullYear(),
    periodMonth: period.getUTCMonth() + 1,
    periodNameEn: MONTHS_EN[period.getUTCMonth()],
    pubYear: pub.getUTCFullYear(),
    pubMonth: pub.getUTCMonth() + 1,
    pubDay: pub.getUTCDate(),
  };
}

// Ordered longest-first: '20260717' and '2026/0717' must not be partially
// rewritten by the shorter '202607' rule.
function rebase(text, d) {
  const { periodYear, periodMonth, periodNameEn, pubYear, pubMonth, pubDay } = d;
  return text
    .replaceAll('20260717', `${pubYear}${pad(pubMonth)}${pad(pubDay)}`)
    .replaceAll('2026/0717', `${pubYear}/${pad(pubMonth)}${pad(pubDay)}`)
    .replaceAll('2026/0706', `${pubYear}/${pad(pubMonth)}${pad(pubDay)}`)
    .replaceAll('2026/07/16', `${pubYear}/${pad(pubMonth)}/${pad(pubDay)}`)
    .replaceAll('2026-07-07', `${pubYear}-${pad(pubMonth)}-${pad(pubDay)}`)
    .replaceAll('2026-07-17', `${pubYear}-${pad(pubMonth)}-${pad(pubDay)}`)
    .replaceAll('202607', `${pubYear}${pad(pubMonth)}`)
    .replaceAll('June 2026', `${periodNameEn} ${periodYear}`)
    .replaceAll('2026年1-6月', `${periodYear}年1-${periodMonth}月`)
    .replaceAll('2026年6月', `${periodYear}年${periodMonth}月`);
}

function buildRoutes(now) {
  // now === null means "recorded verbatim": the no-argument default reproduces
  // the fixture exactly as captured, because tests that assert on the snapshot
  // itself pin literal release times (tests/macro-tiles-china-ui.test.mts).
  // Rebasing is opt-in, for the consumers that re-derive freshness live.
  if (now === null) {
    return new Map([
      ['https://www.stats.gov.cn/english/PressRelease/', fixture('nbs-list.html')],
      ['https://www.stats.gov.cn/english/PressRelease/202607/t20260717_1964159.html', fixture('nbs-industrial.html')],
      ['https://www.stats.gov.cn/english/PressRelease/202607/t20260717_1964158.html', fixture('nbs-fai.html')],
      ['https://www.stats.gov.cn/english/PressRelease/202607/t20260717_1964157.html', fixture('nbs-property.html')],
      ['https://www.safe.gov.cn/safe/sjjd/index.html', fixture('safe-list.html')],
      ['https://www.safe.gov.cn/safe/2026/0706/27661.html', fixture('safe-reserves.html')],
      ['https://www.safe.gov.cn/safe/2026/0717/27704.html', fixture('safe-settlement.html')],
    ]);
  }
  const d = fixtureDates(now);
  return new Map([
    ['https://www.stats.gov.cn/english/PressRelease/', rebase(fixture('nbs-list.html'), d)],
    [rebase('https://www.stats.gov.cn/english/PressRelease/202607/t20260717_1964159.html', d), rebase(fixture('nbs-industrial.html'), d)],
    [rebase('https://www.stats.gov.cn/english/PressRelease/202607/t20260717_1964158.html', d), rebase(fixture('nbs-fai.html'), d)],
    [rebase('https://www.stats.gov.cn/english/PressRelease/202607/t20260717_1964157.html', d), rebase(fixture('nbs-property.html'), d)],
    ['https://www.safe.gov.cn/safe/sjjd/index.html', rebase(fixture('safe-list.html'), d)],
    [rebase('https://www.safe.gov.cn/safe/2026/0706/27661.html', d), rebase(fixture('safe-reserves.html'), d)],
    [rebase('https://www.safe.gov.cn/safe/2026/0717/27704.html', d), rebase(fixture('safe-settlement.html'), d)],
  ]);
}

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

/**
 * Build the recorded official China macro snapshot.
 *
 * `now` sets the snapshot's retrieval clock. It defaults to the pinned
 * CHINA_MACRO_FIXTURE_RETRIEVAL_TIME, which keeps the snapshot byte-stable for
 * tests that assert on it directly.
 *
 * Tests that go through a read path which RE-DERIVES freshness against the wall
 * clock must pass `Date.now()` instead. The MCP projection
 * (api/mcp/registry/cache-tools.ts -> normalizeChinaMacroObservations) does
 * exactly that, and against the pinned literal it flips
 * `transportStatus: 'fresh'` to `'stale'` once real time passes
 * CHINA_MACRO_MAX_TRANSPORT_AGE_MIN (72h) after it -- turning the assertion into
 * a calendar time bomb that reddens `main` for every branch at once (#5762).
 * Passing the live clock makes those tests time-invariant rather than re-armed.
 *
 * Note the adapter derives all provenance and vintage lineage from this clock,
 * so the snapshot stays internally consistent; re-stamping a built snapshot by
 * hand does not, because the vintage ledger carries its own provenance claims.
 */
export async function buildOfficialChinaMacroFixture(now) {
  const rebase = now !== undefined;
  const clock = rebase ? now : Date.parse(CHINA_MACRO_FIXTURE_RETRIEVAL_TIME);
  const routes = buildRoutes(rebase ? clock : null);
  return fetchChinaMacroSnapshot({
    now: clock,
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
