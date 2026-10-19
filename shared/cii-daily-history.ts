export const CII_DAY_MS = 86_400_000;
export const CII_HISTORY_MAX_AGE_MS = 30 * 60_000;

export interface CiiDailyPoint {
  d: string;
  v: string;
  s: number;
  u: number;
  c: number;
  m: number;
  n: number;
  t: number;
}

export function parseCiiDailyPoints(raw: unknown, now: number): { points: CiiDailyPoint[]; invalid: boolean } {
  if (!Array.isArray(raw)) return { points: [], invalid: true };
  const byDate = new Map<string, CiiDailyPoint>();
  let invalid = false;
  for (const row of raw) {
    let value: unknown;
    try { value = typeof row === 'string' ? JSON.parse(row) : null; } catch { invalid = true; continue; }
    if (!value || typeof value !== 'object') { invalid = true; continue; }
    const p = value as CiiDailyPoint;
    if (typeof p.d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(p.d)
      || typeof p.v !== 'string' || !p.v.trim()
      || ![p.s, p.u, p.c, p.m, p.n].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100)
      || typeof p.t !== 'number' || !Number.isFinite(p.t) || p.t <= 0 || p.t > now
      || new Date(p.t).toISOString().slice(0, 10) !== p.d) {
      invalid = true;
      continue;
    }
    if (!byDate.has(p.d) || byDate.get(p.d)!.t < p.t) byDate.set(p.d, p);
  }
  return { points: [...byDate.values()].sort((a, b) => a.d.localeCompare(b.d)), invalid };
}

export function buildCiiHistory(points: CiiDailyPoint[], requestedDays: number, methodologyVersion: string, now: number) {
  const startDay = Math.floor(now / CII_DAY_MS) - requestedDays + 1;
  const window = points.filter(p => Math.floor(p.t / CII_DAY_MS) >= startDay && p.t <= now);
  const versionBreaks: Array<{ date: string; from: string; to: string }> = [];
  for (let i = 1; i < window.length; i++) {
    if (window[i - 1]!.v !== window[i]!.v) versionBreaks.push({ date: window[i]!.d, from: window[i - 1]!.v, to: window[i]!.v });
  }
  const current = window.filter(p => p.v === methodologyVersion);
  const first = current[0], last = current[current.length - 1];
  return {
    methodologyVersion,
    requestedDays,
    returnedDays: current.length,
    points: current.map(p => ({
      date: p.d, combinedScore: p.s,
      components: { ciiContribution: p.u, geoConvergence: p.c, militaryActivity: p.m, newsActivity: p.n },
    })),
    change: first && last && current.length > 1
      ? { fromDate: first.d, fromScore: first.s, toDate: last.d, toScore: last.s, delta: last.s - first.s }
      : null,
    versionBreaks,
    stale: !last || now - last.t > CII_HISTORY_MAX_AGE_MS,
  };
}

export function buildCiiMovers(endpoints: ReadonlyMap<string, CiiDailyPoint[]>, days: number, version: string, now: number) {
  const targetDay = Math.floor(now / CII_DAY_MS) - days;
  const rows: Array<{ countryCode: string; fromDate: string; from: number; to: number; delta: number }> = [];
  const insufficient: string[] = [];
  let asOf = 0;
  for (const [countryCode, points] of endpoints) {
    const last = points[points.length - 1];
    const prior = points.filter(p => Math.floor(p.t / CII_DAY_MS) <= targetDay);
    const first = prior[prior.length - 1];
    if (last && last.v === version && last.t <= now && now - last.t <= CII_HISTORY_MAX_AGE_MS) asOf = Math.max(asOf, last.t);
    if (!first || !last || first === last || first.v !== version || last.v !== version
      || last.t > now || now - last.t > CII_HISTORY_MAX_AGE_MS) {
      insufficient.push(countryCode);
      continue;
    }
    const delta = last.s - first.s;
    if (Math.abs(delta) > 1) rows.push({ countryCode, fromDate: first.d, from: first.s, to: last.s, delta });
  }
  return {
    window_days: days,
    as_of: asOf ? new Date(asOf).toISOString() : null,
    methodology_version: version,
    risers: rows.filter(p => p.delta > 1).sort((a, b) => b.delta - a.delta || a.countryCode.localeCompare(b.countryCode)).slice(0, 5),
    fallers: rows.filter(p => p.delta < -1).sort((a, b) => a.delta - b.delta || a.countryCode.localeCompare(b.countryCode)).slice(0, 5),
    insufficient_history: insufficient.sort(),
  };
}
