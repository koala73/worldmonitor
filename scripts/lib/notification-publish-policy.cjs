'use strict';

/**
 * What ais-relay publishes to the notification queue, and how often (#10873).
 *
 * Realtime rules deliver critical events only, so the severity a publisher
 * picks decides whether a subscriber's phone buzzes. Two failure modes are
 * fixed here:
 *
 *  - Local or routine conditions labelled critical: one stock out of ~100
 *    moving 10%, a VIX swing, a single malicious IP.
 *  - Ongoing STATES re-sent every tick. The publisher dedup key was a hash of
 *    a title carrying the live score ("Global shipping stress: score 91/100"), with a
 *    1h TTL, so an unchanged condition re-notified hourly for as long as it
 *    held. Dedup now keys on the subject plus its band and lasts a day (or the
 *    alert's own lifetime): an unchanged condition is sent once, a crossing
 *    into a higher band is sent once more.
 *
 * Pure functions only, so the rules are unit-testable without booting the
 * relay.
 */

const HOUR_SECONDS = 3_600;
const DAY_SECONDS = 86_400;

// A move is a once-per-session fact: the daily change stays above the
// threshold until the next session opens, through a weekend or a holiday, so
// a 1h TTL re-sent it hourly. The coalesce key carries the session's trade
// date (marketMoveSessionKey), so the next session's move gets a fresh key
// however late today's was published, and the TTL only has to outlive the
// longest closure (a holiday weekend).
const MARKET_MOVE_DEDUP_TTL_SECONDS = 4 * DAY_SECONDS;
// Crypto's change is a rolling 24h window, so the same move is visible for a day.
const CRYPTO_MOVE_DEDUP_TTL_SECONDS = DAY_SECONDS;
// Band-keyed states (shipping stress): an unchanged band is
// re-sent at most once a day.
const STATE_BAND_DEDUP_TTL_SECONDS = DAY_SECONDS;

const VOLATILITY_SYMBOLS = new Set(['^VIX', 'VIX']);
// Catalog symbols (shared/stocks.json) that track a whole market but have no
// caret: uncareted indexes, an index future, and index or country ETFs.
const UNCARETED_EQUITY_INDEXES = new Set(['000001.SS', 'FTSEMIB.MI', 'DFMGI.AE', 'NQ=F', 'QQQ', 'QAT', 'UAE']);

function normalizedSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase();
}

/** A volatility gauge: moves of 10-20% in a day are routine, never critical. */
function isVolatilitySymbol(symbol) {
  return VOLATILITY_SYMBOLS.has(normalizedSymbol(symbol));
}

/** An equity index (^GSPC, ^N225, 000001.SS), as opposed to a single stock. */
function isEquityIndexSymbol(symbol) {
  const s = normalizedSymbol(symbol);
  if (UNCARETED_EQUITY_INDEXES.has(s)) return true;
  return s.startsWith('^') && !isVolatilitySymbol(s);
}

/**
 * Severity of a market move, or null when it is too small to publish.
 *
 * Critical is reserved for moves that matter beyond one holder: an equity
 * index, a commodity, or a crypto asset crashing or surging. A single stock is
 * at most high (it reaches the user who put it on a watchlist through
 * watchlist_story_alert, not every realtime subscriber), and so is a
 * volatility gauge.
 */
function marketMoveSeverity({ assetClass, symbol, changePct }) {
  const abs = Math.abs(Number(changePct));
  if (!Number.isFinite(abs)) return null;
  if (assetClass === 'crypto') {
    if (abs >= 20) return 'critical';
    return abs >= 10 ? 'high' : null;
  }
  if (abs < 5) return null;
  if (isVolatilitySymbol(symbol)) return 'high';
  if (assetClass === 'equity' && !isEquityIndexSymbol(symbol)) return 'high';
  return abs >= 10 ? 'critical' : 'high';
}

function marketMoveDedupTtlSeconds(assetClass) {
  return assetClass === 'crypto' ? CRYPTO_MOVE_DEDUP_TTL_SECONDS : MARKET_MOVE_DEDUP_TTL_SECONDS;
}

/**
 * The session a daily move belongs to, for its coalesce key: the UTC date of
 * the quote's last trade for equities and commodities. A move published at
 * the close cannot block the same move at the next open, and a closed market
 * still showing Friday's change keeps Friday's key all weekend. The wall-clock
 * date is the fallback for a quote without a trade time. Crypto's change is a
 * rolling 24h window with no session, so it has none (its 24h TTL bounds it).
 */
function marketMoveSessionKey(assetClass, lastTradeAtSeconds, now = Date.now()) {
  if (assetClass === 'crypto') return undefined;
  const tradeAt = Number(lastTradeAtSeconds);
  const at = Number.isFinite(tradeAt) && tradeAt > 0 ? tradeAt * 1000 : now;
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * Whether a market_alert is about the market as a whole (an index, a
 * commodity, a crypto asset) rather than one company. Read by the relay's tier
 * gate; an event without these fields is not global.
 */
function isGlobalMarketMove(payload) {
  const assetClass = payload?.assetClass;
  const symbol = payload?.symbol;
  if (isVolatilitySymbol(symbol)) return false;
  if (assetClass === 'commodity' || assetClass === 'crypto') return true;
  return assetClass === 'equity' && isEquityIndexSymbol(symbol);
}

/** The global shipping-stress notification, or null below the alert band. */
function shippingStressNotification(stressScore, stressLevel) {
  const score = Number(stressScore);
  if (!Number.isFinite(score) || score < 75) return null;
  const band = score >= 90 ? 'critical' : 'high';
  return {
    eventType: 'shipping_stress',
    payload: {
      title: `Global shipping stress: score ${score}/100 (${stressLevel})`,
      source: 'Shipping Index',
      coalesceKey: `shipping_stress:${band}`,
    },
    severity: band,
    dedupTtl: STATE_BAND_DEDUP_TTL_SECONDS,
  };
}

let regionNames = null;
function countryDisplayName(iso2) {
  const code = String(iso2 || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return '';
  try {
    regionNames ??= new Intl.DisplayNames(['en'], { type: 'region' });
    const name = regionNames.of(code);
    return name && name !== code ? name : code;
  } catch {
    return code;
  }
}

// Titles that say nothing about the hazard. WMO SWIC carries "CAP Alert" as a
// literal headline and event for some members.
const GENERIC_WEATHER_LABELS = new Set(['cap alert', 'alert', 'warning', 'weather alert', '']);

function isGenericWeatherLabel(label) {
  return GENERIC_WEATHER_LABELS.has(String(label || '').trim().toLowerCase());
}

const WEATHER_SEVERITY_WORD = { Extreme: 'Extreme', Severe: 'Severe' };

function formatUntil(expires, now) {
  const t = Date.parse(expires);
  if (!Number.isFinite(t) || t <= now) return '';
  const d = new Date(t);
  const day = d.getUTCDate();
  const month = d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' });
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `until ${day} ${month} ${hh}:${mm} UTC`;
}

function clip(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/**
 * A weather alert title that says what, where and until when:
 * "Extreme wind warning: Alakol district, Kazakhstan (until 17 Nov 15:00 UTC)".
 *
 * NWS headlines already carry the event, the issuing office and the expiry, so
 * they are kept. WMO SWIC and ECCC titles are a bare WMO event name ("Wind",
 * "CAP Alert") or "event — area", with no country, so they are rebuilt from the
 * event, area, country and expiry.
 */
function weatherAlertNotifyTitle(alert, now = Date.now()) {
  if (alert?.source === 'nws' && alert?.headline) return clip(alert.headline, 200);
  const event = [alert?.event, alert?.headline].find((label) => !isGenericWeatherLabel(label)) || '';
  const severityWord = WEATHER_SEVERITY_WORD[alert?.severity] || '';
  const hazard = event
    ? (/\b(warning|watch|advisory|alert|statement)\b/i.test(event) ? event : `${event} warning`)
    : 'Weather warning';
  const what = severityWord && !hazard.toLowerCase().startsWith(severityWord.toLowerCase())
    ? `${severityWord} ${hazard.charAt(0).toLowerCase()}${hazard.slice(1)}`
    : hazard;
  const country = countryDisplayName(alert?.countryCode);
  const area = clip(alert?.areaDesc, 90);
  const where = [area, country && !area.toLowerCase().includes(country.toLowerCase()) ? country : '']
    .filter(Boolean).join(', ');
  const until = formatUntil(alert?.expires, now);
  return `${what}${where ? `: ${where}` : ''}${until ? ` (${until})` : ''}`;
}

/**
 * How long one weather alert stays deduplicated: until it expires (an active
 * alert is re-read every seed tick, and the old 30-minute default re-sent it
 * each time), between 1h and 24h; 6h when it carries no expiry.
 */
function weatherAlertDedupTtlSeconds(alert, now = Date.now()) {
  const t = Date.parse(alert?.expires);
  if (!Number.isFinite(t)) return 6 * HOUR_SECONDS;
  const seconds = Math.ceil((t - now) / 1000);
  return Math.min(DAY_SECONDS, Math.max(HOUR_SECONDS, seconds));
}

/**
 * The one country a news headline is about, when the title names exactly one.
 * Published as payload.primaryCountryCode, a field the relay's tier gate reads;
 * payload.countryCode stays unset because the relay today treats rss_alert as
 * unattributed and permissive, and setting it would change delivery before the
 * gate lands.
 */
/**
 * Publisher coalesce key for a weather alert: the selector's family key plus
 * the severity band. The dedup lasts the alert's lifetime, so a family key
 * alone would swallow a Severe -> Extreme upgrade of the same alert until the
 * first one expired; with the band in the key the upgrade is sent once more.
 */
function weatherAlertCoalesceKey(familyKey, severity) {
  if (!familyKey) return undefined;
  return `${familyKey}:${severity === 'Extreme' ? 'critical' : 'high'}`;
}

function primaryNewsCountryCode(countryCodes) {
  if (!Array.isArray(countryCodes)) return undefined;
  const unique = [...new Set(countryCodes.map((c) => String(c || '').trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c)))];
  return unique.length === 1 ? unique[0] : undefined;
}

module.exports = {
  MARKET_MOVE_DEDUP_TTL_SECONDS,
  CRYPTO_MOVE_DEDUP_TTL_SECONDS,
  STATE_BAND_DEDUP_TTL_SECONDS,
  marketMoveSeverity,
  marketMoveDedupTtlSeconds,
  marketMoveSessionKey,
  isGlobalMarketMove,
  isEquityIndexSymbol,
  isVolatilitySymbol,
  shippingStressNotification,
  countryDisplayName,
  weatherAlertNotifyTitle,
  weatherAlertDedupTtlSeconds,
  weatherAlertCoalesceKey,
  primaryNewsCountryCode,
};
