// Forbes & Warnock (2012) capital-flow episode classifier.
//
// Reference: Forbes, K. & Warnock, F. (2012), "Capital flow waves: Surges,
// stops, flight, and retrenchment", Journal of International Economics 88(2).
//
// Inputs are quarterly GROSS flows from the IMF BOP financial account
// (BPM6), excluding reserves:
//   gross inflows  = L_NIL_T (net incurrence of liabilities) of D_F + P_F + O_F
//                    — foreigners putting money into the country
//   gross outflows = A_NFA_T (net acquisition of financial assets) of D_F + P_F + O_F
//                    — residents putting money abroad
//
// Method (quarterly adaptation of FW, as in their paper):
//   C_t   = sum of the last 4 quarters of flows
//   ΔC_t  = C_t − C_{t−4}
//   mean/sd of ΔC over the trailing 20 quarters (5 years), ending at t
//   An episode starts when ΔC_t moves more than 1 sd from the mean, ends when
//   it moves back within 1 sd, must reach 2 sd at least once, and must last
//   more than one quarter.
//
//   inflows up   → surge          inflows down  → stop
//   outflows up  → flight         outflows down → retrenchment

export const WINDOW_QUARTERS = 20;
// Minimum ΔC history before a z-score is trusted. FW use the full 5-year
// window; we allow 16 so recently-reporting countries are not silently dropped.
export const MIN_WINDOW_QUARTERS = 16;
export const START_Z = 1;
export const PEAK_Z = 2;

export const FLOW_COMPONENTS = ['D_F', 'P_F', 'O_F'];

export function nextQuarter(period) {
  const m = /^(\d{4})-Q([1-4])$/.exec(period);
  if (!m) throw new Error(`bad quarter: ${period}`);
  const y = Number(m[1]);
  const q = Number(m[2]);
  return q === 4 ? `${y + 1}-Q1` : `${y}-Q${q + 1}`;
}

// Sum FDI + portfolio + other investment for one accounting entry. A quarter
// is kept only when all three components are reported; a partial sum would
// read as a collapse in flows.
export function sumGrossFlows(rows, entry) {
  const byPeriod = new Map();
  for (const r of rows) {
    if (r.entry !== entry || !FLOW_COMPONENTS.includes(r.indicator)) continue;
    const v = Number(r.value);
    if (!Number.isFinite(v)) continue;
    if (!byPeriod.has(r.period)) byPeriod.set(r.period, {});
    byPeriod.get(r.period)[r.indicator] = v;
  }
  const periods = [];
  const values = [];
  for (const p of [...byPeriod.keys()].sort()) {
    const parts = byPeriod.get(p);
    if (!FLOW_COMPONENTS.every((c) => c in parts)) continue;
    periods.push(p);
    values.push(FLOW_COMPONENTS.reduce((s, c) => s + parts[c], 0));
  }
  return { periods, values };
}

// Returns Map(period → ΔC_t). Requires 8 consecutive quarters ending at t.
export function rollingFourQuarterChange(periods, values) {
  const out = new Map();
  let run = []; // consecutive {period, value}
  for (let i = 0; i < periods.length; i++) {
    if (run.length > 0 && nextQuarter(run[run.length - 1].period) !== periods[i]) run = [];
    run.push({ period: periods[i], value: Number(values[i]) });
    if (run.length >= 8) {
      const n = run.length;
      let c = 0;
      let cPrev = 0;
      for (let k = 0; k < 4; k++) {
        c += run[n - 1 - k].value;
        cPrev += run[n - 5 - k].value;
      }
      out.set(periods[i], c - cPrev);
    }
  }
  return out;
}

function meanSd(xs) {
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return { mean: m, sd: Math.sqrt(v) };
}

// Map(period → ΔC) → per-quarter z-scores plus up/down episodes.
export function classifyEpisodes(delta) {
  const periods = [...delta.keys()];
  const vals = periods.map((p) => delta.get(p));
  const z = new Map();
  for (let i = 0; i < periods.length; i++) {
    // The window must be consecutive quarters; rollingFourQuarterChange
    // already breaks on gaps, but ΔC keys can still jump across a gap.
    const lo = Math.max(0, i - WINDOW_QUARTERS + 1);
    let start = i;
    while (start > lo && nextQuarter(periods[start - 1]) === periods[start]) start--;
    const win = vals.slice(start, i + 1);
    if (win.length < MIN_WINDOW_QUARTERS) continue;
    const { mean, sd } = meanSd(win);
    if (!(sd > 0)) continue;
    z.set(periods[i], (vals[i] - mean) / sd);
  }

  const collect = (sign) => {
    const episodes = [];
    let cur = null;
    const close = () => {
      if (cur && cur.quarters.length > 1 && cur.peakZ >= PEAK_Z) {
        episodes.push({
          start: cur.quarters[0],
          end: cur.quarters[cur.quarters.length - 1],
          quarters: cur.quarters.length,
          peakZ: Math.round(cur.peakZ * 100) / 100,
          peakPeriod: cur.peakPeriod,
        });
      }
      cur = null;
    };
    let prev = null;
    for (const [p, zv] of z) {
      if (cur && prev && nextQuarter(prev) !== p) close();
      const s = sign * zv;
      if (s > START_Z) {
        if (!cur) cur = { quarters: [], peakZ: -Infinity, peakPeriod: null };
        cur.quarters.push(p);
        if (s > cur.peakZ) { cur.peakZ = s; cur.peakPeriod = p; }
      } else {
        close();
      }
      prev = p;
    }
    close();
    return episodes;
  };

  return { z, up: collect(1), down: collect(-1) };
}

export function classifyCountry({ inflows, outflows }) {
  const inf = classifyEpisodes(rollingFourQuarterChange(inflows.periods, inflows.values));
  const out = classifyEpisodes(rollingFourQuarterChange(outflows.periods, outflows.values));
  return {
    surge: inf.up,
    stop: inf.down,
    flight: out.up,
    retrenchment: out.down,
    inflowZ: inf.z,
    outflowZ: out.z,
  };
}
