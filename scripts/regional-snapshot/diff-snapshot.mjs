// @ts-check
// Diff engine. Compares prev vs curr snapshot and returns a SnapshotDiff
// that drives all alert types. Single source of truth for state changes.

const SCENARIO_JUMP_THRESHOLD = 0.15;
const LEVERAGE_SHIFT_THRESHOLD = 0.15;
const BUFFER_FAILURE_THRESHOLD = 0.20;

/**
 * @param {import('../../shared/regions.types.js').RegionalSnapshot | null} prev
 * @param {import('../../shared/regions.types.js').RegionalSnapshot} curr
 * @returns {import('../../shared/regions.types.js').SnapshotDiff}
 */
export function diffRegionalSnapshot(prev, curr) {
  const diff = {
    regime_changed: null,
    scenario_jumps: [],
    trigger_activations: [],
    trigger_deactivations: [],
    corridor_breaks: [],
    leverage_shifts: [],
    buffer_failures: [],
    reroute_waves: null,
    mobility_disruptions: [],
  };

  if (!prev) {
    // First snapshot ever for this region: anything notable counts as a one-time mark.
    if (curr.regime?.label && curr.regime.label !== 'calm') {
      diff.regime_changed = { from: '', to: curr.regime.label };
    }
    diff.trigger_activations = curr.triggers.active.map((t) => ({ id: t.id, description: t.description }));
    return diff;
  }

  // ── Regime ──
  if (prev.regime?.label !== curr.regime?.label) {
    diff.regime_changed = { from: prev.regime?.label ?? '', to: curr.regime.label };
  }

  // ── Scenario probability jumps (per horizon) ──
  for (const currSet of curr.scenario_sets) {
    const prevSet = prev.scenario_sets?.find((s) => s.horizon === currSet.horizon);
    if (!prevSet) continue;
    for (const currLane of currSet.lanes) {
      const prevLane = prevSet.lanes.find((l) => l.name === currLane.name);
      if (!prevLane) continue;
      const delta = Math.abs(currLane.probability - prevLane.probability);
      if (delta > SCENARIO_JUMP_THRESHOLD) {
        diff.scenario_jumps.push({
          horizon: currSet.horizon,
          lane: currLane.name,
          from: prevLane.probability,
          to: currLane.probability,
        });
      }
    }
  }

  // ── Trigger activations / deactivations ──
  const prevActive = new Set(prev.triggers.active.map((t) => t.id));
  const currActive = new Set(curr.triggers.active.map((t) => t.id));
  for (const t of curr.triggers.active) {
    if (!prevActive.has(t.id)) diff.trigger_activations.push({ id: t.id, description: t.description });
  }
  for (const t of prev.triggers.active) {
    if (!currActive.has(t.id)) diff.trigger_deactivations.push({ id: t.id });
  }

  // ── Corridor breaks (severity escalation in transmission paths) ──
  // Compared by chokepoint state via the maritime_access driver descriptions.
  // Phase 0: detect via balance.maritime_access drop.
  const prevMaritime = prev.balance?.maritime_access ?? 1;
  const currMaritime = curr.balance?.maritime_access ?? 1;
  if (prevMaritime - currMaritime > 0.3) {
    diff.corridor_breaks.push({
      corridor_id: 'aggregate',
      from: prevMaritime.toFixed(2),
      to: currMaritime.toFixed(2),
    });
  }

  // ── Leverage shifts ──
  const prevActors = new Map((prev.actors ?? []).map((a) => [a.actor_id, a.leverage_score]));
  for (const a of curr.actors ?? []) {
    const prevScore = prevActors.get(a.actor_id) ?? 0;
    const delta = a.leverage_score - prevScore;
    if (Math.abs(delta) > LEVERAGE_SHIFT_THRESHOLD) {
      diff.leverage_shifts.push({
        actor_id: a.actor_id,
        from: prevScore,
        to: a.leverage_score,
        delta,
      });
    }
  }

  // ── Buffer failures ──
  const bufferAxes = ['alliance_cohesion', 'maritime_access', 'energy_leverage'];
  for (const axis of bufferAxes) {
    const prevVal = prev.balance?.[axis] ?? 1;
    const currVal = curr.balance?.[axis] ?? 1;
    if (prevVal - currVal > BUFFER_FAILURE_THRESHOLD) {
      diff.buffer_failures.push({ axis, from: prevVal, to: currVal });
    }
  }

  // ── Reroute waves and mobility disruptions ──
  // Phase 0: empty (mobility lane and corridor reroute tracking are Phase 2)

  return diff;
}

/**
 * Pick a trigger_reason from a SnapshotDiff in priority order.
 *
 * @param {import('../../shared/regions.types.js').SnapshotDiff} diff
 * @returns {import('../../shared/regions.types.js').TriggerReason}
 */
export function inferTriggerReason(diff) {
  if (diff.regime_changed) return 'regime_shift';
  if (diff.trigger_activations.length > 0) return 'trigger_activation';
  if (diff.corridor_breaks.length > 0) return 'corridor_break';
  if (diff.leverage_shifts.length > 0) return 'leverage_shift';
  return 'scheduled_6h';
}
