// Shared yield-curve seed model used by every seed-yield-curve-*.mjs seeder
// and their tests. The server-side twin lives in
// server/worldmonitor/economic/v1/government-yield-curves.ts; both sides keep
// the same canonical shape: { curves: [{ date: 'YYYY-MM-DD', tenors: {...} }] }.
//
// Tenor keys are lowercase maturity labels ("3m", "1y", "10y", …).

/** Parse 'YYYY-MM-DD' or 'YYYY/M/D' into 'YYYY-MM-DD', or null. */
export function normalizeDateLabel(raw) {
  const token = String(raw ?? '').trim();
  const match = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(token);
  if (!match) return null;
  const [, y, m, d] = match;
  const iso = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  return Number.isFinite(Date.parse(`${iso}T00:00:00Z`)) ? iso : null;
}

/** Number coercion that treats European decimal commas and missing markers. */
export function parseYieldNumber(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const token = raw.trim();
  if (token === '' || token === '.' || token === '-' || token === '–') return null;
  const normalized = token.replace(',', '.');
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

/** Sort ascending by date and dedupe (later entries win per tenor). */
export function collapseCurves(points) {
  const byDate = new Map();
  for (const point of points) {
    if (!point?.date) continue;
    const previous = byDate.get(point.date);
    byDate.set(point.date, previous
      ? { date: point.date, tenors: { ...previous.tenors, ...point.tenors } }
      : { date: point.date, tenors: { ...point.tenors } });
  }
  return [...byDate.values()].sort((left, right) => (left.date < right.date ? -1 : 1));
}

/** Slice one calendar year out of a canonical payload. */
export function yearShard(payload, year) {
  const prefix = `${year}-`;
  return { curves: (payload?.curves ?? []).filter((curve) => curve?.date?.startsWith(prefix)) };
}

export function countCurves(payload) {
  return Array.isArray(payload?.curves) ? payload.curves.length : 0;
}

/** Read-merge-write accumulation for sources that expose only recent windows. */
export function mergeCurveHistory(previous, fetched) {
  const previousCurves = Array.isArray(previous?.curves) ? previous.curves : [];
  return { curves: collapseCurves([...previousCurves, ...fetched]) };
}
