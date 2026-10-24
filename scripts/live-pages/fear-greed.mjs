import {
  escapeHtml,
  finiteNumber,
  formatStaticDateTime,
  metric,
  renderLiveSection,
  requireFreshTimestamp,
  UnpublishableReading,
} from './common.mjs';

// The seed runs every 6 hours and health flags it after 12 (api/health.js).
const MAX_AGE_MS = 24 * 3_600_000;

const CATEGORY_LABELS = [
  ['sentiment', 'Sentiment'],
  ['volatility', 'Volatility'],
  ['positioning', 'Positioning'],
  ['trend', 'Trend'],
  ['breadth', 'Breadth'],
  ['momentum', 'Momentum'],
  ['liquidity', 'Liquidity'],
  ['credit', 'Credit'],
  ['macro', 'Macro'],
  ['crossAsset', 'Cross-asset'],
];

function round1(value) {
  return Math.round(value * 10) / 10;
}

export function fearGreedRecord(payload, now = Date.now()) {
  const score = finiteNumber(payload?.compositeScore);
  if (score === null || score < 0 || score > 100 || !payload?.compositeLabel) {
    throw new UnpublishableReading('fear & greed: no composite score');
  }
  const asOf = requireFreshTimestamp(payload.seededAt, { now, maxAgeMs: MAX_AGE_MS, label: 'fear & greed' });
  const categories = CATEGORY_LABELS
    .map(([key, label]) => {
      const category = payload[key];
      const categoryScore = finiteNumber(category?.score);
      if (categoryScore === null) return null;
      return {
        label,
        score: round1(categoryScore),
        weightPct: Math.round((finiteNumber(category.weight) ?? 0) * 100),
        partial: category.degraded === true,
      };
    })
    .filter(Boolean);
  const cnnScore = finiteNumber(payload.cnnFearGreed);
  const aaiiBull = finiteNumber(payload.aaiiBull);
  const aaiiBear = finiteNumber(payload.aaiiBear);
  // The handler sends vix: 0 when VIX is unavailable.
  const vix = finiteNumber(payload.vix);
  return {
    asOf,
    score: round1(score),
    label: String(payload.compositeLabel),
    previousScore: finiteNumber(payload.previousScore),
    categories,
    cnn: cnnScore !== null && cnnScore > 0 && payload.cnnLabel ? { score: cnnScore, label: String(payload.cnnLabel) } : null,
    aaii: aaiiBull !== null && aaiiBear !== null && aaiiBull + aaiiBear > 0 ? { bull: round1(aaiiBull), bear: round1(aaiiBear) } : null,
    vix: vix !== null && vix > 0 ? vix : null,
  };
}

function answerText(record) {
  if (!record) return 'World Monitor has no current Fear & Greed reading. The seeded index is older than 24 hours or unavailable.';
  const parts = [`As of ${formatStaticDateTime(record.asOf)}, the World Monitor Fear & Greed Index reads ${record.score} out of 100, which is ${record.label}.`];
  if (record.cnn) parts.push(`CNN's Fear & Greed Index reads ${record.cnn.score} (${record.cnn.label}).`);
  if (record.aaii) parts.push(`The latest AAII survey shows ${record.aaii.bull}% bullish and ${record.aaii.bear}% bearish.`);
  return parts.join(' ');
}

function bodyHtml(record) {
  if (!record) return '        <p class="tool-note">Open the live dashboard for the latest market sentiment panels.</p>';
  const metrics = [
    metric('World Monitor index', String(record.score), record.label),
    record.cnn ? metric('CNN Fear & Greed', String(record.cnn.score), record.cnn.label) : '',
    record.aaii ? metric('AAII bullish / bearish', `${record.aaii.bull}% / ${record.aaii.bear}%`) : '',
    record.vix !== null ? metric('VIX', String(record.vix)) : '',
  ].filter(Boolean).join('\n');
  const rows = record.categories
    .map((category) => `            <tr><td>${escapeHtml(category.label)}</td><td>${category.score}${category.partial ? ' (partial inputs)' : ''}</td><td>${category.weightPct}%</td></tr>`)
    .join('\n');
  return `        <div class="grid">
${metrics}
        </div>
        <div class="table-scroll">
          <table>
            <caption>The ten categories behind the World Monitor index (0 is extreme fear, 100 is extreme greed)</caption>
            <thead><tr><th scope="col">Category</th><th scope="col">Score</th><th scope="col">Weight</th></tr></thead>
            <tbody>
${rows}
            </tbody>
          </table>
        </div>`;
}

export const fearGreedPage = Object.freeze({
  slug: 'fear-and-greed-index',
  path: '/tools/fear-and-greed-index/',
  statusPath: '/api/market/v1/get-fear-greed-index?public=1',
  title: 'Fear & Greed Index Today: Live Stock Market Sentiment | World Monitor',
  h1: 'Fear & Greed Index today',
  question: 'What is the Fear & Greed Index today?',
  description: 'The current stock market Fear & Greed reading: World Monitor\'s ten-category composite beside CNN\'s index and the AAII investor sentiment survey, updated live.',
  dashboardPanel: 'Fear & Greed',
  record: fearGreedRecord,
  renderSection(record, { live }) {
    return renderLiveSection({
      slug: this.slug,
      question: this.question,
      record,
      live,
      answer: answerText(record),
      bodyHtml: bodyHtml(record),
      asOf: record?.asOf,
      sourceHtml: 'Sources: World Monitor composite; CNN Business Fear &amp; Greed (<a href="https://www.cnn.com/markets/fear-and-greed" rel="nofollow">cnn.com</a>); AAII Sentiment Survey (<a href="https://www.aaii.com/sentimentsurvey" rel="nofollow">aaii.com</a>); Cboe VIX.',
    });
  },
  explainer: `      <h2>How the World Monitor index is built</h2>
      <p>The index blends ten categories of market evidence into one 0 to 100 score: sentiment, volatility, positioning, price trend, market breadth, momentum, liquidity, credit spreads, macro stress and cross-asset moves. Each category is scored on its own and weighted; a category scored from only some of its inputs is marked "partial inputs" in the table above. A score of 20 or below reads as extreme fear, 21 to 40 as fear, 41 to 60 as neutral, 61 to 80 as greed and above 80 as extreme greed.</p>
      <h2>How it differs from CNN's Fear &amp; Greed Index</h2>
      <p>CNN's index uses seven US stock market indicators. World Monitor shows CNN's reading beside its own composite, with credit to CNN, so the two can be compared at a glance. They often differ: World Monitor's composite also weighs credit, liquidity, macro and cross-asset conditions.</p>
      <h2>The AAII investor sentiment survey</h2>
      <p>The American Association of Individual Investors asks its members each week whether they expect stocks to rise, fall or stay flat over the next six months. The bullish and bearish shares above are the latest weekly results as captured by World Monitor.</p>`,
});
