'use strict';

/**
 * Delivery tiers for relay-published events (#10873).
 *
 * A rule with no countries used to receive every critical event in the world,
 * and a country-scoped rule never received a global event without a country.
 * Each event type now belongs to one tier, decided here rather than by each
 * publisher:
 *
 *  - global: every realtime rule, scoped or not. A market-wide move (index,
 *    commodity, crypto), global shipping stress, a national air-traffic
 *    collapse, and news that names no single country or clears the critical
 *    importance bar.
 *  - local: only rules that list the event's country (or, for regional_*
 *    events, a member country of its region). A rule with no countries gets
 *    none, and an event with no resolvable country goes nowhere.
 *  - opt_in: the type's own scope decides (tickers, chokepoints, watched
 *    sites, reservoirs); country scope does not apply.
 *
 * An event type missing from the table is local, so a new publisher cannot
 * broadcast worldwide by default; tests/notification-delivery-tiers.test.mjs
 * fails when a published type has no explicit tier.
 */

const { isGlobalMarketMove } = require('./notification-publish-policy.cjs');

const TIER_GLOBAL = 'global';
const TIER_LOCAL = 'local';
const TIER_OPT_IN = 'opt_in';

// relayComputeImportanceScore's critical threshold (IMPORTANCE_SCORE_LIVE
// realtime gate in notification-relay.cjs): single-country news at or above it
// still reaches everyone.
const NEWS_GLOBAL_IMPORTANCE_SCORE = 82;
// The realtime bar for a local news story on a rule scoped to its country
// (#10977): a single tier-1 to tier-3 critical copy (88, 83, 78) clears it,
// a lone tier-4 copy (73) needs corroboration.
const { LOCAL_CRITICAL_IMPORTANCE_SCORE: NEWS_LOCAL_IMPORTANCE_SCORE } = require('./news-story-key.cjs');

const EVENT_TIERS = Object.freeze({
  shipping_stress: TIER_GLOBAL,
  aviation_traffic_collapse: TIER_GLOBAL,
  // Resolved per event: global for a market-wide move, local otherwise.
  market_alert: 'market',
  // Resolved per event: see newsTier.
  rss_alert: 'news',
  weather_alert: TIER_LOCAL,
  aviation_closure: TIER_LOCAL,
  notam_closure: TIER_LOCAL,
  oref_siren: TIER_LOCAL,
  conflict_escalation: TIER_LOCAL,
  cyber_threat: TIER_LOCAL,
  china_cross_strait_baseline_transition: TIER_LOCAL,
  china_activity_nowcast_transition: TIER_LOCAL,
  regional_regime_shift: TIER_LOCAL,
  regional_trigger_activation: TIER_LOCAL,
  regional_corridor_break: TIER_LOCAL,
  regional_buffer_failure: TIER_LOCAL,
  watchlist_story_alert: TIER_OPT_IN,
  chokepoint_disruption: TIER_OPT_IN,
  orbital_imaging_window: TIER_OPT_IN,
  orbital_site_change: TIER_OPT_IN,
  reservoir_level_alert: TIER_OPT_IN,
});

// Template-literal types (china-decision-alerts.mjs `china_${domain}_decision_signal`).
const LOCAL_TYPE_PATTERNS = [/^china_[a-z_]+_decision_signal$/, /^regional_[a-z_]+$/];

function tableTierFor(eventType) {
  if (typeof eventType !== 'string') return null;
  if (Object.prototype.hasOwnProperty.call(EVENT_TIERS, eventType)) return EVENT_TIERS[eventType];
  return LOCAL_TYPE_PATTERNS.some((re) => re.test(eventType)) ? TIER_LOCAL : null;
}

/** Whether the type has an explicit tier (the table or a pattern). */
function hasExplicitTier(eventType) {
  return tableTierFor(eventType) !== null;
}

function newsTier(event) {
  // primaryCountryCode from the headline classifier, or the countryCode a
  // single-country feed already attributes (saudi-civil-defense-alerts.cjs).
  const primary = event?.payload?.primaryCountryCode ?? event?.payload?.countryCode;
  const country = typeof primary === 'string' && /^[A-Za-z]{2}$/.test(primary.trim()) ? primary.trim().toUpperCase() : null;
  // No single country named (or an event from before the field existed): the
  // story is not about one place, so it stays global as it always was.
  if (!country) return { tier: TIER_GLOBAL };
  const score = Number(event?.payload?.importanceScore);
  if (Number.isFinite(score) && score >= NEWS_GLOBAL_IMPORTANCE_SCORE) return { tier: TIER_GLOBAL };
  return { tier: TIER_LOCAL, country };
}

/**
 * The event's delivery tier, and for a local news event the country it is
 * about. Other local events carry their country in the payload as before.
 */
function resolveDeliveryTier(event) {
  const tier = tableTierFor(event?.eventType) ?? TIER_LOCAL;
  if (tier === 'market') return { tier: isGlobalMarketMove(event?.payload) ? TIER_GLOBAL : TIER_LOCAL };
  if (tier === 'news') return newsTier(event);
  return { tier };
}

module.exports = {
  TIER_GLOBAL,
  TIER_LOCAL,
  TIER_OPT_IN,
  NEWS_GLOBAL_IMPORTANCE_SCORE,
  NEWS_LOCAL_IMPORTANCE_SCORE,
  EVENT_TIERS,
  hasExplicitTier,
  resolveDeliveryTier,
};
