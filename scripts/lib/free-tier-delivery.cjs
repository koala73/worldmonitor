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

/** Whether a rule owner at `tier` may receive on this channel type. */
function freeTierAllowsChannel(tier, channelType) {
  if (tier >= 1) return true;
  return FREE_DELIVERY_CHANNELS.has(String(channelType));
}

module.exports = {
  FREE_DELIVERY_CHANNELS,
  FREE_DELIVERY_SEVERITIES,
  freeTierAllowsEvent,
  freeTierAllowsChannel,
};
