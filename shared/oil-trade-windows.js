// Window arithmetic for the per-country oil supply and trade series
// (energy:oil-trade-series:v1). Shared by the seeder and the MCP tool so a
// "last N complete months vs the N before" answer is computed one way.
//
// Every average is day-weighted over the months a source actually covers. A
// month a source does not cover is absent, never zero: a window with no
// covered month has kbd null, and a window with fewer covered months than it
// spans is reported as incomplete.

const MONTH_RE = /^(\d{4})-(\d{2})$/;

/** @param {string} month */
function parseMonth(month) {
  const m = MONTH_RE.exec(month);
  if (!m) throw new Error(`invalid month ${month}`);
  return { year: Number(m[1]), month: Number(m[2]) };
}

/** @param {string} month @param {number} delta */
export function shiftMonth(month, delta) {
  const { year, month: mon } = parseMonth(month);
  const index = year * 12 + (mon - 1) + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/** Days in a YYYY-MM month. */
export function monthDays(month) {
  const { year, month: mon } = parseMonth(month);
  return new Date(Date.UTC(year, mon, 0)).getUTCDate();
}

/** The month before the read month, in UTC: the newest month that has ended. */
export function lastCompleteMonth(nowMs) {
  const now = new Date(nowMs);
  const current = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  return shiftMonth(current, -1);
}

/** Inclusive list of months from `from` to `to`. */
export function monthRange(from, to) {
  const out = [];
  for (let m = from; m <= to; m = shiftMonth(m, 1)) out.push(m);
  return out;
}

/**
 * Value getters, one per comparable metric. Each returns a kb/d number or null.
 * Mirror metrics are handled separately because they need a matched basis.
 */
const SIMPLE_METRICS = {
  production: (r) => r.production?.kbd ?? null,
  jodiCrudeExports: (r) => r.jodi?.crudeExportsKbd ?? null,
  jodiProductExports: (r) => r.jodi?.productExportsKbd ?? null,
  aisTankerLoadings: (r) => r.ais?.loadingsKbd ?? null,
};

const MIRROR_METRICS = {
  mirrorCrudeImports: 'crudeKbd',
  mirrorProductImports: 'productsKbd',
};

function windowAverage(byMonth, months, getter) {
  let barrels = 0;
  let days = 0;
  let covered = 0;
  for (const month of months) {
    const record = byMonth.get(month);
    const value = record ? getter(record) : null;
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    barrels += value * monthDays(month);
    days += monthDays(month);
    covered++;
  }
  return { kbd: covered ? barrels / days : null, monthsCovered: covered };
}

function pctChange(current, base) {
  if (current == null || base == null || !(base > 0)) return null;
  return ((current - base) / base) * 100;
}

function compareMetric(byMonth, windows, getter, n) {
  const current = windowAverage(byMonth, windows.current, getter);
  const prior = windowAverage(byMonth, windows.prior, getter);
  const yearAgo = windowAverage(byMonth, windows.yearAgo, getter);
  return {
    current,
    prior,
    yearAgo,
    // The current average yoyPct compares against yearAgo. For these metrics it
    // is current itself; mirror metrics can use a different buyer basis.
    currentForYoy: current,
    changePct: pctChange(current.kbd, prior.kbd),
    yoyPct: pctChange(current.kbd, yearAgo.kbd),
    complete: current.monthsCovered === n && prior.monthsCovered === n,
  };
}

const filedIn = (byMonth, month, field) => {
  const reporters = byMonth.get(month)?.mirror?.reporters ?? {};
  return new Set(Object.keys(reporters).filter((r) => typeof reporters[r]?.[field] === 'number'));
};

/**
 * Buyers (ISO3) to compare a recent window against a base window on.
 *
 * Start from the buyers that filed in every month of the base window, then
 * cover only the recent months in which all of them filed. A buyer that files
 * a month late (India) costs the comparison its newest month instead of
 * leaving the basis; a buyer that stopped filing (Singapore after April 2026,
 * China after 2024-12) leaves the basis once keeping it would cover less than
 * half the window. Comparing only these buyers keeps a change in who files
 * from reading as a change in exports.
 */
function mirrorBasis(byMonth, recent, base, field) {
  let basis = null;
  for (const month of base) {
    const filed = filedIn(byMonth, month, field);
    basis = basis === null ? filed : new Set([...basis].filter((r) => filed.has(r)));
  }
  if (!basis || basis.size === 0) return [];
  const minMonths = Math.ceil(recent.length / 2);
  for (;;) {
    const filings = new Map([...basis].map((r) => [r, recent.filter((m) => filedIn(byMonth, m, field).has(r)).length]));
    const covered = recent.filter((m) => [...basis].every((r) => filedIn(byMonth, m, field).has(r))).length;
    if (covered >= minMonths || basis.size <= 1) break;
    const weakest = [...filings].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))[0][0];
    basis.delete(weakest);
  }
  return [...basis].sort();
}

function compareMirror(byMonth, windows, field, n) {
  const sumOver = (reporters) => (record) => {
    const rows = record.mirror?.reporters;
    if (!rows || reporters.length === 0) return null;
    let total = 0;
    for (const r of reporters) {
      const value = rows[r]?.[field];
      if (typeof value !== 'number') return null;
      total += value;
    }
    return total;
  };
  const basis = mirrorBasis(byMonth, windows.current, windows.prior, field);
  const yoyBasis = mirrorBasis(byMonth, windows.current, windows.yearAgo, field);
  const current = windowAverage(byMonth, windows.current, sumOver(basis));
  const prior = windowAverage(byMonth, windows.prior, sumOver(basis));
  const currentYoy = windowAverage(byMonth, windows.current, sumOver(yoyBasis));
  const yearAgo = windowAverage(byMonth, windows.yearAgo, sumOver(yoyBasis));
  return {
    current,
    prior,
    yearAgo,
    // yoyPct compares this against yearAgo, on basis.yoyReporters.
    currentForYoy: currentYoy,
    changePct: pctChange(current.kbd, prior.kbd),
    yoyPct: pctChange(currentYoy.kbd, yearAgo.kbd),
    complete: current.monthsCovered === n && prior.monthsCovered === n,
    basis: { reporters: basis, yoyReporters: yoyBasis },
  };
}

/**
 * Compare the last `windowMonths` complete months with the `windowMonths`
 * before them, plus the same months a year earlier, for every metric.
 *
 * @param {{ months: Array<Record<string, any>> }} country
 * @param {{ nowMs?: number, windowMonths?: number }} [opts]
 */
export function compareOilWindows(country, { nowMs = Date.now(), windowMonths = 6 } = {}) {
  const n = Math.max(1, Math.min(12, Math.trunc(windowMonths) || 6));
  const end = lastCompleteMonth(nowMs);
  const windows = {
    current: monthRange(shiftMonth(end, -(n - 1)), end),
    prior: monthRange(shiftMonth(end, -(2 * n - 1)), shiftMonth(end, -n)),
    yearAgo: monthRange(shiftMonth(end, -(n - 1) - 12), shiftMonth(end, -12)),
  };
  const byMonth = new Map((country?.months ?? []).map((m) => [m.month, m]));
  const metrics = {};
  for (const [name, getter] of Object.entries(SIMPLE_METRICS)) {
    metrics[name] = compareMetric(byMonth, windows, getter, n);
  }
  for (const [name, field] of Object.entries(MIRROR_METRICS)) {
    metrics[name] = compareMirror(byMonth, windows, field, n);
  }
  const span = (months) => ({ from: months[0], to: months.at(-1) });
  return {
    windowMonths: n,
    windows: { current: span(windows.current), prior: span(windows.prior), yearAgo: span(windows.yearAgo) },
    metrics,
  };
}

// ── Storage form ────────────────────────────────────────────────────────────
// The seeder stores each country column-wise (one array per measure, aligned
// to `from`..`to`) to keep 24 countries x 24 months well under the per-key
// payload budget. expandCountry rebuilds the month records compareOilWindows
// and the MCP tool read. null stays null through the round trip.

const round1 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
const column = (records, pick) => records.map((r) => round1(pick(r)));
const anyValue = (values) => values.some((v) => v !== null);

export function compactCountry(country) {
  const records = country.months;
  const reporterCodes = [...new Set(records.flatMap((r) => Object.keys(r.mirror?.reporters ?? {})))].sort();
  const reporters = {};
  for (const code of reporterCodes) {
    reporters[code] = {
      crudeKbd: column(records, (r) => r.mirror?.reporters?.[code]?.crudeKbd),
      productsKbd: column(records, (r) => r.mirror?.reporters?.[code]?.productsKbd),
    };
  }
  const provisional = records.filter((r) => r.production?.provisional).map((r) => r.month);
  return {
    iso2: country.iso2,
    iso3: country.iso3,
    name: country.name,
    from: records[0]?.month ?? null,
    to: records.at(-1)?.month ?? null,
    sources: country.sources,
    production: {
      kbd: column(records, (r) => r.production?.kbd),
      provisionalFrom: provisional[0] ?? null,
    },
    jodi: {
      crudeExportsKbd: column(records, (r) => r.jodi?.crudeExportsKbd),
      productExportsKbd: column(records, (r) => r.jodi?.productExportsKbd),
      crudeProductionKbd: column(records, (r) => r.jodi?.crudeProductionKbd),
    },
    mirror: {
      crudeKbd: column(records, (r) => r.mirror?.crudeKbd),
      productsKbd: column(records, (r) => r.mirror?.productsKbd),
      otherCrudeKbd: column(records, (r) => r.mirror?.otherKbd?.crudeKbd),
      otherProductsKbd: column(records, (r) => r.mirror?.otherKbd?.productsKbd),
      reporters,
    },
    ais: {
      loadingsKbd: column(records, (r) => r.ais?.loadingsKbd),
      exportTankerKt: column(records, (r) => r.ais?.exportTankerKt),
      tankerCalls: records.map((r) => (typeof r.ais?.tankerCalls === 'number' ? r.ais.tankerCalls : null)),
      complete: records.map((r) => (r.ais ? r.ais.complete === true : null)),
    },
  };
}

export function expandCountry(compact) {
  if (!compact?.from || !compact?.to) return { ...compact, months: [] };
  const months = monthRange(compact.from, compact.to);
  const at = (values, i) => (Array.isArray(values) ? values[i] ?? null : null);
  const records = months.map((month, i) => {
    const productionKbd = at(compact.production?.kbd, i);
    const jodi = {
      crudeExportsKbd: at(compact.jodi?.crudeExportsKbd, i),
      productExportsKbd: at(compact.jodi?.productExportsKbd, i),
      crudeProductionKbd: at(compact.jodi?.crudeProductionKbd, i),
    };
    const reporters = {};
    for (const [code, series] of Object.entries(compact.mirror?.reporters ?? {})) {
      const row = {};
      const crude = at(series.crudeKbd, i);
      const products = at(series.productsKbd, i);
      if (crude !== null) row.crudeKbd = crude;
      if (products !== null) row.productsKbd = products;
      if (Object.keys(row).length) reporters[code] = row;
    }
    const mirrorCrude = at(compact.mirror?.crudeKbd, i);
    const mirrorProducts = at(compact.mirror?.productsKbd, i);
    const otherCrude = at(compact.mirror?.otherCrudeKbd, i);
    const otherProducts = at(compact.mirror?.otherProductsKbd, i);
    const aisComplete = at(compact.ais?.complete, i);
    return {
      month,
      production: productionKbd === null ? null : {
        kbd: productionKbd,
        provisional: compact.production?.provisionalFrom != null && month >= compact.production.provisionalFrom,
      },
      jodi: anyValue(Object.values(jodi)) ? jodi : null,
      mirror: mirrorCrude === null && mirrorProducts === null ? null : {
        crudeKbd: mirrorCrude,
        productsKbd: mirrorProducts,
        reporters,
        otherKbd: otherCrude === null && otherProducts === null ? null : { crudeKbd: otherCrude, productsKbd: otherProducts },
      },
      ais: aisComplete === null ? null : {
        complete: aisComplete,
        loadingsKbd: at(compact.ais?.loadingsKbd, i),
        exportTankerKt: at(compact.ais?.exportTankerKt, i),
        tankerCalls: at(compact.ais?.tankerCalls, i),
      },
    };
  });
  const { production: _p, jodi: _j, mirror: _m, ais: _a, ...rest } = compact;
  return { ...rest, months: records };
}
