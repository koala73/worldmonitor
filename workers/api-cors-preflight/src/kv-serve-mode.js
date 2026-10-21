// Shared staged-serving predicate. The shadow path uses this to stop measuring a
// tier once the serving path owns its served/fallback latency telemetry.
// Production is mode === 'all' (both public tiers). 'slow' keeps fast on origin
// as a kill-switch; anything else (including unset) serves nothing.
export function isBootstrapKvServingTier(env, tier) {
  const mode = env?.BOOTSTRAP_KV_SERVE;
  return mode === 'all' || (mode === 'slow' && tier === 'slow');
}
