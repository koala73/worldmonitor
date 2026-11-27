'use strict';

// Delivery-time clamp for the free alert ladder (#4273) — the relay's
// layer-3 defense. Mirrors the FREE_* constants in
// shared/alert-capabilities.ts (the relay is CJS and cannot import TS);
// keep the two in step. The write path constrains NEW rules to the ladder;
// this clamp is what keeps a legacy wider-than-plan row, or a row from a
// later-downgraded account, from delivering past the ladder regardless.

const FREE_DELIVERY_CHANNELS = new Set(['web_push', 'email']);

// Free realtime delivery is critical-only — the same invariant the write
// path enforces for every realtime rule (assertCompatibleDeliveryMode),
// applied here against the EVENT severity so a legacy free row whose stored
// sensitivity is wider cannot widen delivery.
const FREE_DELIVERY_SEVERITIES = new Set(['critical']);

/**
 * Whether a rule owner at `tier` may receive this event at all.
 * `tier` null = unresolved entitlement (fail-closed upstream, never here).
 */
function freeTierAllowsEvent(tier, eventSeverity) {
  if (tier >= 1) return true;
  return FREE_DELIVERY_SEVERITIES.has(String(eventSeverity));
}

// Event types the free ladder does not include at all: Orbital Watch
// watched-site alerts and reservoir level alerts are Pro-only outright
// (convex/alertRules.ts assertOrbitalAlertEntitlement and
// assertReservoirAlertEntitlement; mirrors ORBITAL_SITE_ALERT_EVENT_TYPES +
// RESERVOIR_ALERT_EVENT_TYPE in shared/alert-rule-shape.ts — keep them in
// step). Those gates run once, at write time, so delivery must re-apply the
// set or a later-downgraded account keeps the paid stream on its leftover
// rule: these opt-in types bypass the realtime sensitivity gate and carry no
// country attribution, so the severity and scope rungs alone cannot be
// relied on to stop them.
const FREE_EXCLUDED_EVENT_TYPES = new Set(['orbital_imaging_window', 'orbital_site_change', 'reservoir_level_alert']);

/** Whether a rule owner at `tier` may receive events of this type at all. */
function freeTierAllowsEventType(tier, eventType) {
  if (tier >= 1) return true;
  return !FREE_EXCLUDED_EVENT_TYPES.has(String(eventType));
}

/** Whether a rule owner at `tier` may receive on this channel type. */
function freeTierAllowsChannel(tier, channelType) {
  if (tier >= 1) return true;
  return FREE_DELIVERY_CHANNELS.has(String(channelType));
}

// Mirrors FREE_ALERT_MAX_COUNTRIES in shared/alert-capabilities.ts.
const FREE_DELIVERY_MAX_COUNTRIES = 3;

/**
 * The country scope a rule owner at `tier` may deliver on. Paid tiers keep
 * the rule's scope as is. Free tiers must have an explicit scope — the
 * write path enforces that for new rules, and this clamp covers legacy
 * worldwide free rows at delivery time: `ok: false` means do not deliver;
 * otherwise deliver only within the first FREE_DELIVERY_MAX_COUNTRIES
 * entries, mirroring the write-path cap.
 */
function freeTierCountryScope(tier, countries) {
  if (tier >= 1) return { ok: true, countries };
  if (!Array.isArray(countries) || countries.length === 0) return { ok: false, countries: [] };
  return { ok: true, countries: countries.slice(0, FREE_DELIVERY_MAX_COUNTRIES) };
}

module.exports = {
  FREE_DELIVERY_CHANNELS,
  FREE_DELIVERY_SEVERITIES,
  FREE_DELIVERY_MAX_COUNTRIES,
  FREE_EXCLUDED_EVENT_TYPES,
  freeTierAllowsEvent,
  freeTierAllowsEventType,
  freeTierAllowsChannel,
  freeTierCountryScope,
};
