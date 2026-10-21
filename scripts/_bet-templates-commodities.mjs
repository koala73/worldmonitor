// Commodity price bet templates (Phase 1 pilot, fast-resolving lane / #5233).
//
// Source feed: market:commodities-bootstrap:v1, live shape (post-unwrap)
//   { quotes: [ { symbol, name, price, change /* daily % */, ... } ] }
// Unlike the weekly EIA feed, commodity prices update daily, so these bets use a
// SHORT (~4-day) horizon and resolve within the week — the fast Gate-1 evidence
// lane. The metricKey reads back through the resolver's existing `price()` fn as
// `market:commodities-bootstrap:v1|price(symbol==<SYMBOL>)`.
//
// Pure: templates are declarative; generateBets drives them with an injected
// (unwrapped) feed snapshot + nowMs.

export const COMMODITY_FEED = 'market:commodities-bootstrap:v1';
const DAY_MS = 24 * 60 * 60 * 1000;
// ~4 calendar days: lands the deadline within the week for near-real-time price
// resolution (markets settle daily), the fast Gate-1 signal.
const COMMODITY_HORIZON_MS = 4 * DAY_MS;
// Threshold move over the horizon — a plausible ~4-day commodity swing. The bet
// asks whether the latest daily direction continues by at least this much.
const MOVE_FRACTION = 0.025;

const COMMODITIES = [
  { symbol: 'CL=F', subject: 'the WTI crude oil price', unit: 'USD/bbl' },
  { symbol: 'BZ=F', subject: 'the Brent crude oil price', unit: 'USD/bbl' },
  { symbol: 'NG=F', subject: 'the US natural gas price', unit: 'USD/MMBtu' },
  { symbol: 'GC=F', subject: 'the gold price', unit: 'USD/oz' },
];

function findQuote(feed, symbol) {
  const quotes = Array.isArray(feed?.quotes) ? feed.quotes : Array.isArray(feed) ? feed : null;
  if (!quotes) return null;
  return quotes.find((q) => q && q.symbol === symbol) || null;
}

function buildCommodityTemplate({ symbol, subject, unit }) {
  return {
    id: `commodity:${symbol}`,
    feedKey: COMMODITY_FEED,
    domain: 'market',

    extractMetric(feed) {
      const q = findQuote(feed, symbol);
      const price = Number(q?.price);
      // Prices are strictly positive; a 0/negative quote is a broken feed. Skip
      // it (a zero baseline would mint a guaranteed-YES bet).
      if (!q || !Number.isFinite(price) || price <= 0) return null;
      // daily % change — null when absent (Yahoo omits `change` on non-trading
      // sessions). Kept as a sentinel so the spec builder can skip a bet whose
      // direction is undetermined rather than silently defaulting it to "up".
      const changePct = Number(q.change);
      return { subject, symbol, value: price, changePct: Number.isFinite(changePct) ? changePct : null, unit };
    },

    horizonPolicy({ nowMs }) {
      return nowMs + COMMODITY_HORIZON_MS;
    },

    buildResolutionSpec({ metric, deadlineMs }) {
      const { value, changePct } = metric;
      const magnitude = Math.abs(value) * MOVE_FRACTION;
      if (!(magnitude > 0)) return null;
      // Direction = continuation of the latest daily move. Undetermined
      // (absent or exactly-flat change) → emit no bet, so a missing-data day
      // never skews the shadow pool bullish.
      if (changePct == null || changePct === 0) return null;
      const wantUp = changePct > 0;
      const threshold = round(wantUp ? value + magnitude : value - magnitude);
      return {
        kind: 'hard',
        metricKey: `${COMMODITY_FEED}|price(symbol==${symbol})`,
        operator: 'crosses',
        threshold,
        baselineValue: round(value),
        window: 'at-deadline',
        deadline: deadlineMs,
        sourceFeed: COMMODITY_FEED,
        question: buildQuestion(metric, wantUp, threshold, deadlineMs),
      };
    },

    buildQuestion({ spec }) {
      return spec.question;
    },

    buildTitle({ metric, spec }) {
      const dir = spec.threshold >= spec.baselineValue ? 'rise' : 'fall';
      return `${capitalize(metric.subject)}: ${dir} to ${spec.threshold} ${metric.unit}?`;
    },

    userValueScore() {
      return symbol === 'CL=F' || symbol === 'BZ=F' ? 0.7 : 0.6;
    },
  };
}

function buildQuestion(metric, wantUp, threshold, deadlineMs) {
  const dir = wantUp ? 'rise to at least' : 'fall to at most';
  return `Will ${metric.subject} ${dir} ${threshold} ${metric.unit} by ${isoDate(deadlineMs)}?`;
}

export const COMMODITY_BET_TEMPLATES = COMMODITIES.map(buildCommodityTemplate);

function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function capitalize(text) {
  const s = String(text || '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Prices read at 2 decimals so the question is clean (69.62, not 69.62475).
// The spec threshold and the displayed threshold are the same value, so
// resolution stays exact against what the question states.
function round(value) {
  if (!Number.isFinite(value)) return value;
  return Math.round(value * 100) / 100;
}
