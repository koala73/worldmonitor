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
 *    a title carrying the live score ("Hormuz Strait: risk score 85"), with a
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
// threshold for the rest of the trading day, so a 1h TTL re-sent it hourly.
// 20h outlives one session and expires before the next one's open.
const MARKET_MOVE_DEDUP_TTL_SECONDS = 20 * HOUR_SECONDS;
// Crypto's change is a rolling 24h window, so the same move is visible for a day.
const CRYPTO_MOVE_DEDUP_TTL_SECONDS = DAY_SECONDS;
// Band-keyed states (corridor risk, shipping stress): an unchanged band is
// re-sent at most once a day.
const STATE_BAND_DEDUP_TTL_SECONDS = DAY_SECONDS;

const VOLATILITY_SYMBOLS = new Set(['^VIX', 'VIX']);

function normalizedSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase();
}

/** A volatility gauge: moves of 10-20% in a day are routine, never critical. */
function isVolatilitySymbol(symbol) {
  return VOLATILITY_SYMBOLS.has(normalizedSymbol(symbol));
}

/** An equity index (^GSPC, ^N225, ^TASI.SR), as opposed to a single stock. */
function isEquityIndexSymbol(symbol) {
  const s = normalizedSymbol(symbol);
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

function corridorRiskBand(score) {
  if (score >= 70) return 'critical';
  if (score >= 50) return 'high';
  return null;
}

function titleCaseId(id) {
  return String(id).replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
}

/**
 * The corridor-risk notification for one corridor, or null below the alert
 * band. corridorId is the chokepoint id (shared/corridor-risk.js maps the feed
 * onto shared/chokepoint-alert-ids.ts), carried as payload.chokepointId so the
 * relay can scope it to the rules that chose that chokepoint.
 */
function corridorRiskNotification(corridorId, riskScore) {
  const score = Number(riskScore);
  if (!corridorId || !Number.isFinite(score)) return null;
  const band = corridorRiskBand(score);
  if (!band) return null;
  return {
    eventType: 'corridor_risk',
    payload: {
      title: `${titleCaseId(corridorId)}: risk score ${score}`,
      source: 'Corridor Risk',
      chokepointId: corridorId,
      coalesceKey: `corridor:${corridorId}:${band}`,
    },
    severity: band,
    dedupTtl: STATE_BAND_DEDUP_TTL_SECONDS,
  };
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
  isGlobalMarketMove,
  isEquityIndexSymbol,
  isVolatilitySymbol,
  corridorRiskNotification,
  shippingStressNotification,
  countryDisplayName,
  weatherAlertNotifyTitle,
  weatherAlertDedupTtlSeconds,
  primaryNewsCountryCode,
};
