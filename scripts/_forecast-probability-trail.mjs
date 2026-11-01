const DAY_MS = 86_400_000;
export const PROBABILITY_TRAIL_KEY = 'forecast:probability-trail:v1';
export const PROBABILITY_TRAIL_META_KEY = 'seed-meta:forecast:probability-trail';
export const PROBABILITY_TRAIL_TTL_SECONDS = 45 * 24 * 60 * 60;
export const PROBABILITY_TRAIL_ACTIVATION_KEY = 'seed-activated:forecast:probability-trail';

export function buildProbabilityTrail(prior, current, history = []) {
  const now = Number(current.generatedAt);
  if (!Number.isFinite(now)) throw new Error('Probability trail needs a generation timestamp');
  if (prior && (!prior.forecasts || typeof prior.forecasts !== 'object' || Array.isArray(prior.forecasts)
    || !Number.isFinite(prior.generatedAt) || prior.generatedAt > now)) throw new Error('Invalid prior probability trail');
  const forecasts = Object.create(null);
  for (const [id, segment] of Object.entries(prior?.forecasts ?? {})) {
    if (!segment || typeof segment.region !== 'string' || !Number.isFinite(Date.parse(segment.firstSeenAt))
      || !Number.isFinite(Date.parse(segment.lastSeenAt)) || !Number.isFinite(segment.firstSeenProbability)
      || !Array.isArray(segment.points)) throw new Error('Invalid prior probability trail segment');
    if (Date.parse(segment.lastSeenAt) >= now - 35 * DAY_MS) forecasts[id] = structuredClone(segment);
  }
  const snapshots = prior ? [current] : [...history, current].sort((a, b) => a.generatedAt - b.generatedAt);
  for (const snapshot of snapshots) {
    const at = Number(snapshot.generatedAt);
    if (!Number.isFinite(at) || at > now || at < now - 35 * DAY_MS) continue;
    const iso = new Date(at).toISOString();
    for (const row of snapshot.predictions ?? []) {
      if (typeof row?.id !== 'string' || typeof row.region !== 'string'
        || !Number.isFinite(row.probability) || row.probability < 0 || row.probability > 1) continue;
      const previous = forecasts[row.id];
      if (previous && at <= Date.parse(previous.lastSeenAt)) continue;
      const changed = previous && previous.region !== row.region;
      const segment = !previous || changed ? {
        region: row.region, firstSeenAt: iso, firstSeenProbability: row.probability,
        lastSeenAt: iso, points: [], ...(changed ? { subjectChangedAt: iso } : {}),
      } : previous;
      const last = segment.points.at(-1);
      if (!last || Math.abs(row.probability - last[1]) >= 0.005 - Number.EPSILON
        || at - Date.parse(last[0]) >= 6 * 3_600_000) segment.points.push([iso, row.probability]);
      segment.lastSeenAt = iso;
      forecasts[row.id] = segment;
    }
  }
  for (const segment of Object.values(forecasts)) {
    segment.points = segment.points.filter(([at]) => Date.parse(at) >= now - 30 * DAY_MS).slice(-120);
  }
  const trail = { generatedAt: now, forecasts };
  if (Buffer.byteLength(JSON.stringify(trail)) > 250 * 1024 - 1024) throw new Error('Probability trail exceeds 250 KB');
  return trail;
}

export function stampResolutionTrajectories(ledger, trail, nowMs) {
  for (const entry of Object.values(ledger)) {
    if (entry.status !== 'resolved' || entry.resolvedAt !== nowMs || Array.isArray(entry.trajectory)) continue;
    const segment = trail?.forecasts?.[entry.id];
    const firstSeen = Number(entry.firstSeenAt ?? entry.generatedAt);
    if (!segment || segment.region !== entry.region || Date.parse(segment.firstSeenAt) > firstSeen) continue;
    const points = segment.points.filter(([at]) => Date.parse(at) >= firstSeen && Date.parse(at) <= Math.min(nowMs, Number(entry.deadline)));
    entry.trajectory = points.length <= 30 ? structuredClone(points)
      : Array.from({ length: 30 }, (_, i) => structuredClone(points[Math.round(i * (points.length - 1) / 29)]));
  }
}
