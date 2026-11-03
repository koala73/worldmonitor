// Correlation engine for the Phenomena view: bins events from every source
// into a sources × time heatmap, builds the composite "global signal noise"
// waveform from the live instrument series, and flags time-stamped overlaps
// between anomalies of different kinds (a solar flare a few hours before a
// neutrino alert, a geomagnetic storm during a swarm of quakes). Pure functions.

const H = 3600000;

// --- heatmap ----------------------------------------------------------------------------

// rows: one per source (or group) that has events; cols: time bins ending now.
export function heatmap(events, { now = Date.now(), bins = 48, binMs = H, by = 'group', order = null } = {}) {
  const start = now - bins * binMs;
  const rows = new Map();
  for (const e of events) {
    if (!e.at || e.at < start || e.at > now + binMs) continue;
    const key = by === 'group' ? e.group : e.source;
    let row = rows.get(key);
    if (!row) {
      row = { key, label: by === 'group' ? key : e.sourceLabel || e.source, cells: new Float32Array(bins), counts: new Uint16Array(bins), max: 0 };
      rows.set(key, row);
    }
    const i = Math.min(bins - 1, Math.max(0, Math.floor((e.at - start) / binMs)));
    const w = e.intensity === null || e.intensity === undefined ? 0.15 : 0.15 + 0.85 * e.intensity;
    row.cells[i] += w;
    row.counts[i] += 1;
    if (row.cells[i] > row.max) row.max = row.cells[i];
  }
  const list = [...rows.values()];
  if (order) list.sort((a, b) => (order.indexOf(a.key) < 0 ? 99 : order.indexOf(a.key)) - (order.indexOf(b.key) < 0 ? 99 : order.indexOf(b.key)));
  else list.sort((a, b) => b.max - a.max);
  return { rows: list, bins, binMs, start, now };
}

// --- composite waveform ---------------------------------------------------------------------

// Normalise a signal to 0..1 over its declared range (log scale when asked).
export function normalize(signal, v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const { min, max, log } = signal;
  if (log) {
    const lo = Math.log10(Math.max(1e-12, min));
    const hi = Math.log10(Math.max(min * 10, max));
    return Math.max(0, Math.min(1, (Math.log10(Math.max(1e-12, v)) - lo) / (hi - lo)));
  }
  if (signal.id === 'geomag') return Math.max(0, Math.min(1, Math.abs(v) / Math.max(1, max)));
  return Math.max(0, Math.min(1, (v - min) / (max - min || 1)));
}

// Resample every signal onto `n` samples spanning `spanMs` and stack them.
// Returns { samples: [{ t, value, parts: { id: v } }], peak, contributors }.
export function composite(signals, { now = Date.now(), spanMs = 24 * H, n = 240 } = {}) {
  const step = spanMs / n;
  const samples = [];
  const contributors = [];
  for (const s of signals) {
    const pts = (s.points || []).filter((p) => p[0] >= now - spanMs - step && p[0] <= now + step);
    if (pts.length) contributors.push({ id: s.id, label: s.label, unit: s.unit, current: s.current, level: normalize(s, s.current), warn: s.warn, source: s.source });
  }
  for (let i = 0; i < n; i++) {
    const t = now - spanMs + (i / Math.max(1, n - 1)) * spanMs; // the last sample is now
    const parts = {};
    let sum = 0;
    let k = 0;
    for (const s of signals) {
      const v = valueAt(s.points, t, step * 2);
      const z = normalize(s, v);
      if (z === null) continue;
      parts[s.id] = z;
      sum += z;
      k += 1;
    }
    samples.push({ t, value: k ? sum / k : 0, parts });
  }
  const peak = samples.reduce((a, s) => Math.max(a, s.value), 0);
  return { samples, peak, contributors, spanMs, now };
}

function valueAt(points, t, tol) {
  if (!points || !points.length) return null;
  // Points are time-sorted; binary search the last one at or before t.
  let lo = 0;
  let hi = points.length - 1;
  if (points[0][0] > t + tol) return null;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (points[mid][0] <= t) lo = mid;
    else hi = mid - 1;
  }
  const p = points[lo];
  // Slow series (weekly CO2, daily flux) hold their last value; fast ones must be near.
  const gap = points.length > 1 ? points[points.length - 1][0] - points[points.length - 2][0] : tol;
  return t - p[0] <= Math.max(tol, gap * 1.5) ? p[1] : null;
}

// --- overlaps -----------------------------------------------------------------------------------

const KIND_RATE = { alert: 2, event: 2, measurement: 1, paper: 40, news: 60, document: 20 };

// Anomalies: events worth correlating (instrument alerts and measurements with
// some intensity), not papers or press.
export function anomalies(events, { now = Date.now(), windowMs = 72 * H, minIntensity = 0.25 } = {}) {
  return events.filter((e) => e.at && e.at >= now - windowMs && e.at <= now + H && ['alert', 'event', 'measurement'].includes(e.kind) && (e.intensity ?? 0) >= minIntensity);
}

// Pairs of anomalies from different sources that happened within `gapMs`
// of each other, scored by intensity and rarity. Earlier event first.
export function overlaps(events, { now = Date.now(), gapMs = 6 * H, windowMs = 72 * H, limit = 12 } = {}) {
  const list = anomalies(events, { now, windowMs }).sort((a, b) => a.at - b.at);
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    for (let j = i + 1; j < list.length && list[j].at - a.at <= gapMs; j++) {
      const b = list[j];
      if (a.source === b.source || a.group === b.group) continue;
      const gap = b.at - a.at;
      const rarity = 1 / Math.sqrt((KIND_RATE[a.kind] || 10) * (KIND_RATE[b.kind] || 10));
      const score = (a.intensity + b.intensity) / 2 * (1 - gap / gapMs * 0.5) * (0.5 + rarity * 5);
      out.push({ a, b, gapMs: gap, score, text: `${a.title} → ${fmtGap(gap)} later → ${b.title}` });
    }
  }
  out.sort((x, y) => y.score - x.score);
  return out.slice(0, limit);
}

export function fmtGap(ms) {
  if (ms < 60000) return `${Math.round(ms / 1000)} s`;
  if (ms < H) return `${Math.round(ms / 60000)} min`;
  if (ms < 48 * H) return `${(ms / H).toFixed(1)} h`;
  return `${(ms / (24 * H)).toFixed(1)} d`;
}

// One line of status for the oscilloscope header: the hottest contributors now.
export function noiseLevel(comp) {
  const last = comp.samples[comp.samples.length - 1];
  const level = last ? last.value : 0;
  const hot = comp.contributors.filter((c) => c.level !== null && c.level >= 0.5).sort((a, b) => b.level - a.level);
  return { level, label: level >= 0.6 ? 'ELEVATED' : level >= 0.35 ? 'ACTIVE' : 'QUIET', hot };
}
