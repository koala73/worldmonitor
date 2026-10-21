import {
  escapeHtml,
  finiteNumber,
  formatStaticDate,
  metric,
  renderLiveSection,
  requireFreshTimestamp,
  UnpublishableReading,
} from './common.mjs';

// Treasury publishes each business day's curve that afternoon. A three-day
// weekend plus a holiday leaves the latest curve about five days old.
const MAX_AGE_MS = 7 * 24 * 3_600_000;

const MATURITIES = [
  ['oneMonth', '1 month'],
  ['oneAndAHalfMonth', '1.5 months'],
  ['twoMonth', '2 months'],
  ['threeMonth', '3 months'],
  ['fourMonth', '4 months'],
  ['sixMonth', '6 months'],
  ['oneYear', '1 year'],
  ['twoYear', '2 years'],
  ['threeYear', '3 years'],
  ['fiveYear', '5 years'],
  ['sevenYear', '7 years'],
  ['tenYear', '10 years'],
  ['twentyYear', '20 years'],
  ['thirtyYear', '30 years'],
];

function spreadBp(long, short) {
  return long === null || short === null ? null : Math.round((long - short) * 100);
}

export function treasuryYieldCurveRecord(payload, now = Date.now()) {
  const curves = Array.isArray(payload?.curves) ? payload.curves : [];
  const curve = curves.at(-1);
  if (payload?.unavailable === true || !curve) {
    throw new UnpublishableReading('treasury yield curve: no curve');
  }
  const asOf = requireFreshTimestamp(finiteNumber(curve.date), { now, maxAgeMs: MAX_AGE_MS, label: 'treasury yield curve' });
  const points = MATURITIES
    .map(([key, label]) => ({ key, label, pct: finiteNumber(curve[key]) }))
    .filter((point) => point.pct !== null);
  const yieldOf = (key) => points.find((point) => point.key === key)?.pct ?? null;
  const tenYear = yieldOf('tenYear');
  if (tenYear === null) throw new UnpublishableReading('treasury yield curve: no 10-year yield');
  const twoYear = yieldOf('twoYear');
  const threeMonth = yieldOf('threeMonth');
  return {
    asOf,
    points,
    tenYear,
    twoYear,
    threeMonth,
    thirtyYear: yieldOf('thirtyYear'),
    tenTwoBp: spreadBp(tenYear, twoYear),
    tenThreeMonthBp: spreadBp(tenYear, threeMonth),
  };
}

function signedBp(bp) {
  return `${bp > 0 ? '+' : ''}${bp} basis points`;
}

function shapeText(bp) {
  if (bp > 0) return 'so the curve was not inverted';
  if (bp < 0) return 'so the curve was inverted';
  return 'so the curve was flat between those two maturities';
}

function answerText(record) {
  if (!record) return 'World Monitor has no current Treasury yield curve. The latest curve is older than seven days or unavailable.';
  const levels = [`the 10-year at ${record.tenYear}%`];
  if (record.twoYear !== null) levels.push(`the 2-year at ${record.twoYear}%`);
  if (record.threeMonth !== null) levels.push(`the 3-month at ${record.threeMonth}%`);
  const last = levels.pop();
  const parts = [`On ${formatStaticDate(record.asOf)}, the US Treasury par yield curve had ${levels.length ? `${levels.join(', ')} and ${last}` : last}.`];
  if (record.tenTwoBp !== null) parts.push(`The 10-year minus 2-year spread was ${signedBp(record.tenTwoBp)}, ${shapeText(record.tenTwoBp)}.`);
  if (record.tenThreeMonthBp !== null) parts.push(`The 10-year minus 3-month spread was ${signedBp(record.tenThreeMonthBp)}.`);
  return parts.join(' ');
}

function bodyHtml(record) {
  if (!record) return '        <p class="tool-note">Open the live dashboard for the latest yield curve and rates panel.</p>';
  const metrics = [
    metric('10-year yield', `${record.tenYear}%`),
    record.twoYear !== null ? metric('2-year yield', `${record.twoYear}%`) : '',
    record.tenTwoBp !== null ? metric('10Y minus 2Y', signedBp(record.tenTwoBp), record.tenTwoBp < 0 ? 'Inverted' : 'Not inverted') : '',
    record.tenThreeMonthBp !== null ? metric('10Y minus 3M', signedBp(record.tenThreeMonthBp), record.tenThreeMonthBp < 0 ? 'Inverted' : 'Not inverted') : '',
  ].filter(Boolean).join('\n');
  const rows = record.points
    .map((point) => `            <tr><td>${escapeHtml(point.label)}</td><td>${point.pct.toFixed(2)}%</td></tr>`)
    .join('\n');
  return `        <div class="grid">
${metrics}
        </div>
        <div class="table-scroll">
          <table>
            <caption>Treasury par yields by maturity for ${escapeHtml(formatStaticDate(record.asOf))}</caption>
            <thead><tr><th scope="col">Maturity</th><th scope="col">Par yield</th></tr></thead>
            <tbody>
${rows}
            </tbody>
          </table>
        </div>`;
}

export const treasuryYieldCurvePage = Object.freeze({
  slug: 'treasury-yield-curve',
  path: '/tools/treasury-yield-curve/',
  statusPath: '/api/economic/v1/get-us-treasury-par-yield-curve?public=1',
  title: 'US Treasury Yield Curve Today: 10Y-2Y Spread and Par Yields | World Monitor',
  h1: 'US Treasury yield curve today',
  question: 'What is the US Treasury yield curve today?',
  description: 'The latest US Treasury par yield curve from 1 month to 30 years, with the 10-year minus 2-year and 10-year minus 3-month spreads and whether the curve is inverted.',
  dashboardPanel: 'Yield Curve & Rates',
  record: treasuryYieldCurveRecord,
  renderSection(record, { live }) {
    return renderLiveSection({
      slug: this.slug,
      question: this.question,
      record,
      live,
      answer: answerText(record),
      bodyHtml: bodyHtml(record),
      asOf: record?.asOf,
      dateOnly: true,
      sourceHtml: 'Source: US Department of the Treasury, Daily Treasury Par Yield Curve Rates (<a href="https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve" rel="nofollow">home.treasury.gov</a>).',
    });
  },
  explainer: `      <h2>What the yield curve shows</h2>
      <p>The yield curve plots what the US government pays to borrow for different lengths of time, from one month to thirty years. Treasury publishes a par yield for each maturity at the close of every business day. Usually longer loans pay more, so the curve slopes upward.</p>
      <h2>What an inverted yield curve means</h2>
      <p>The curve is inverted when a short maturity yields more than a long one. The two spreads watched most are the 10-year minus the 2-year and the 10-year minus the 3-month. Both have turned negative before most US recessions since the 1970s, usually many months in advance, though an inversion is not a forecast of when a recession starts or whether one follows.</p>
      <h2>Par yields and the yields quoted elsewhere</h2>
      <p>The rates above are Treasury's par yield curve, the official daily series. The constant-maturity yields that the Federal Reserve and FRED publish (such as DGS10) come from this same curve, so the values match for the same day.</p>`,
});
