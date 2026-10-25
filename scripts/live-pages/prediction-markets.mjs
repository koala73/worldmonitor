import {
  escapeHtml,
  finiteNumber,
  formatStaticDateTime,
  formatUsdCompact,
  metric,
  renderLiveSection,
  requireFreshTimestamp,
  UnpublishableReading,
} from './common.mjs';

// The seed refreshes often; health flags it after 90 minutes (api/health.js).
const MAX_AGE_MS = 6 * 3_600_000;
const LISTED_MARKETS = 15;

const SOURCE_LABELS = {
  MARKET_SOURCE_POLYMARKET: 'Polymarket',
  MARKET_SOURCE_KALSHI: 'Kalshi',
};

const SOURCE_HOSTS = {
  Polymarket: /^https:\/\/(?:www\.)?polymarket\.com\//,
  Kalshi: /^https:\/\/(?:www\.)?kalshi\.com\//,
};

function formatDate(timestamp) {
  return new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(timestamp));
}

export function predictionMarketsRecord(payload, now = Date.now()) {
  if (payload?.dataAvailable === false || !Array.isArray(payload?.markets)) {
    throw new UnpublishableReading('prediction markets: data unavailable');
  }
  const asOf = requireFreshTimestamp(payload.fetchedAt, { now, maxAgeMs: MAX_AGE_MS, label: 'prediction markets' });
  const markets = payload.markets
    .map((market) => {
      const yes = finiteNumber(market.yesPrice);
      const source = SOURCE_LABELS[market.source] || null;
      if (!market.title || yes === null || yes < 0 || yes > 1 || !source) return null;
      const closesAt = finiteNumber(market.closesAt);
      return {
        title: String(market.title),
        // One decimal, as the venues show it; rounding yes * 100 to a whole
        // number turned 0.145 into 14% (14.4999… in floating point).
        yesPct: Math.round(yes * 1000) / 10,
        volumeUsd: finiteNumber(market.volume) ?? 0,
        closes: closesAt && closesAt > now ? formatDate(closesAt) : null,
        source,
        url: SOURCE_HOSTS[source].test(market.url || '') ? market.url : null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.volumeUsd - a.volumeUsd);
  if (markets.length === 0) throw new UnpublishableReading('prediction markets: no publishable markets');
  return {
    asOf,
    total: markets.length,
    totalVolumeUsd: markets.reduce((sum, market) => sum + market.volumeUsd, 0),
    markets: markets.slice(0, LISTED_MARKETS),
  };
}

function answerText(record) {
  if (!record) return 'World Monitor has no current prediction market reading. The captured markets are older than six hours or unavailable.';
  const top = record.markets[0];
  return `As of ${formatStaticDateTime(record.asOf)}, World Monitor tracks ${record.total} Polymarket and Kalshi ${record.total === 1 ? 'market' : 'markets'}. The most traded is "${top.title}" on ${top.source}, priced at ${top.yesPct}% yes with ${formatUsdCompact(top.volumeUsd, 1)} traded.`;
}

function bodyHtml(record) {
  if (!record) return '        <p class="tool-note">Open the live dashboard for the Predictions panel.</p>';
  const rows = record.markets
    .map((market) => `            <tr><td>${market.url ? `<a href="${escapeHtml(market.url)}" rel="nofollow">${escapeHtml(market.title)}</a>` : escapeHtml(market.title)}</td><td>${market.yesPct}%</td><td>${escapeHtml(formatUsdCompact(market.volumeUsd, 1))}</td><td>${escapeHtml(market.closes || '—')}</td><td>${escapeHtml(market.source)}</td></tr>`)
    .join('\n');
  return `        <div class="grid">
${metric('Markets tracked', String(record.total))}
${metric('Volume traded, all tracked markets', formatUsdCompact(record.totalVolumeUsd, 1))}
        </div>
        <div class="table-scroll">
          <table>
            <caption>${record.markets.length < record.total ? `The ${record.markets.length} most traded of ${record.total} tracked markets` : 'Tracked markets by volume'}: the price of "yes" read as a probability</caption>
            <thead><tr><th scope="col">Question</th><th scope="col">Yes</th><th scope="col">Volume</th><th scope="col">Closes</th><th scope="col">Venue</th></tr></thead>
            <tbody>
${rows}
            </tbody>
          </table>
        </div>`;
}

export const predictionMarketsPage = Object.freeze({
  slug: 'prediction-markets',
  path: '/tools/prediction-markets/',
  statusPath: '/api/prediction/v1/list-prediction-markets?public=1',
  title: 'Prediction Markets Today: Live Polymarket and Kalshi Odds | World Monitor',
  h1: 'Prediction markets today',
  question: 'What are prediction markets pricing right now?',
  description: 'The most traded Polymarket and Kalshi questions on geopolitics, economics and technology, with the current yes probability, volume and close date, updated live.',
  dashboardPanel: 'Predictions',
  record: predictionMarketsRecord,
  renderSection(record, { live }) {
    return renderLiveSection({
      slug: this.slug,
      question: this.question,
      record,
      live,
      answer: answerText(record),
      bodyHtml: bodyHtml(record),
      asOf: record?.asOf,
      sourceHtml: 'Sources: Polymarket (<a href="https://polymarket.com/" rel="nofollow">polymarket.com</a>) and Kalshi (<a href="https://kalshi.com/" rel="nofollow">kalshi.com</a>). Prices are market odds, not forecasts by World Monitor.',
    });
  },
  explainer: `      <h2>How to read a prediction market price</h2>
      <p>Each market is a yes-or-no question that pays out if the event happens. The price of a "yes" share, between 0 and 100 cents, is what traders currently pay for it, and is commonly read as the market's probability of the event. Thinly traded markets can move on small orders, so volume is shown beside each price.</p>
      <h2>Which markets are listed</h2>
      <p>World Monitor follows geopolitical, economic and technology markets on Polymarket and Kalshi and ranks them here by volume traded. Markets whose titles name sports leagues, entertainment awards or celebrities are filtered out. World Monitor's own scenario forecasts, scored against outcomes, are published separately on the <a href="/accuracy/">forecast accuracy page</a>.</p>`,
});
