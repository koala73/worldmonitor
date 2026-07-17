// Shared staged-serving predicate. The shadow path uses this to stop measuring a
// tier once the serving path owns its served/fallback latency telemetry.
export function isBootstrapKvServingTier(env, tier) {
  const mode = env?.BOOTSTRAP_KV_SERVE;
  return mode === 'all' || (mode === 'slow' && tier === 'slow');
}
