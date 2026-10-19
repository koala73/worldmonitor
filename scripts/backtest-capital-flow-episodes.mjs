#!/usr/bin/env node
//
// Back-test the Forbes & Warnock classifier (_capital-flow-episodes.mjs)
// against documented capital-flow episodes, using live IMF BOP data.
//
//   node scripts/backtest-capital-flow-episodes.mjs
//
// The KNOWN table was fixed before the first run; do not tune it to the
// classifier's output. Misses are reported, not hidden.

import { CHROME_UA, imfAuthHeaders } from './_seed-utils.mjs';
import { sumGrossFlows, classifyCountry } from './_capital-flow-episodes.mjs';

const URL =
  'https://api.imf.org/external/sdmx/3.0/data/dataflow/IMF.STA/BOP/+/' +
  '*.A_NFA_T+L_NIL_T.D_F+P_F+O_F.USD.Q?c%5BTIME_PERIOD%5D=ge:1995-Q1&dimensionAtObservation=TIME_PERIOD';

// [iso3, type, windowStart, windowEnd, why]
export const KNOWN = [
  ['USA', 'stop', '2008-Q3', '2009-Q2', 'GFC (Forbes & Warnock 2012)'],
  ['GBR', 'stop', '2008-Q3', '2009-Q2', 'GFC'],
  ['GBR', 'retrenchment', '2008-Q3', '2009-Q2', 'GFC'],
  ['DEU', 'retrenchment', '2008-Q3', '2009-Q2', 'GFC'],
  ['FRA', 'stop', '2008-Q3', '2009-Q2', 'GFC'],
  ['ISL', 'stop', '2008-Q3', '2009-Q2', 'Icelandic banking collapse'],
  ['IRL', 'stop', '2008-Q3', '2010-Q4', 'Irish banking crisis'],
  ['GRC', 'stop', '2010-Q1', '2012-Q4', 'Euro-area sovereign crisis'],
  ['CYP', 'stop', '2012-Q3', '2013-Q4', 'Cyprus bail-in'],
  ['RUS', 'flight', '2014-Q1', '2015-Q1', 'Crimea sanctions'],
  ['RUS', 'flight', '2022-Q1', '2022-Q4', '2022 invasion'],
  ['TUR', 'stop', '2018-Q2', '2019-Q1', 'Lira crisis'],
  ['ARG', 'stop', '2018-Q2', '2019-Q2', 'Argentina 2018'],
  ['GBR', 'stop', '2022-Q3', '2023-Q1', 'Mini-budget / LDI'],
  ['GBR', 'retrenchment', '2022-Q3', '2023-Q1', 'Mini-budget / LDI'],
  ['LBN', 'flight', '2019-Q3', '2020-Q2', 'Lebanon banking crisis'],
];

function shift(p, d) {
  const [y, q] = p.split('-Q').map(Number);
  const i = y * 4 + q - 1 + d;
  return `${Math.floor(i / 4)}-Q${(i % 4) + 1}`;
}

async function fetchRows() {
  const r = await fetch(URL, { headers: { 'User-Agent': CHROME_UA, Accept: 'application/json', ...imfAuthHeaders() }, signal: AbortSignal.timeout(300_000) });
  if (!r.ok) throw new Error(`IMF BOP HTTP ${r.status}`);
  const json = await r.json();
  const st = json.data.structures[0];
  const dims = st.dimensions.series;
  const tv = st.dimensions.observation[0].values;
  const byCountry = {};
  for (const [key, s] of Object.entries(json.data.dataSets[0].series)) {
    const c = key.split(':').map((x, i) => dims[i].values[Number(x)].id);
    for (const [i, o] of Object.entries(s.observations ?? {})) {
      if (o?.[0] == null || o[0] === '') continue;
      (byCountry[c[0]] ??= []).push({ entry: c[1], indicator: c[2], period: tv[Number(i)].value ?? tv[Number(i)].id, value: o[0] });
    }
  }
  return byCountry;
}

async function main() {
  const byCountry = await fetchRows();
  const res = {};
  let quarters = 0;
  const inEpisode = { surge: 0, stop: 0, flight: 0, retrenchment: 0 };
  for (const [c, rows] of Object.entries(byCountry)) {
    const r = classifyCountry({ inflows: sumGrossFlows(rows, 'L_NIL_T'), outflows: sumGrossFlows(rows, 'A_NFA_T') });
    res[c] = r;
    quarters += Math.min(r.inflowZ.size, r.outflowZ.size);
    for (const k of Object.keys(inEpisode)) inEpisode[k] += r[k].reduce((s, e) => s + e.quarters, 0);
  }

  let hit = 0;
  let testable = 0;
  for (const [c, type, a, b, why] of KNOWN) {
    const r = res[c];
    const zmap = r && (type === 'surge' || type === 'stop' ? r.inflowZ : r.outflowZ);
    if (!zmap || (!zmap.has(a) && !zmap.has(b))) {
      console.log(`NO-DATA ${c} ${type} ${a}..${b} (${why})`);
      continue;
    }
    testable++;
    const lo = shift(a, -1);
    const hi = shift(b, 1);
    const eps = r[type].filter((e) => e.end >= lo && e.start <= hi);
    if (eps.length) hit++;
    console.log(`${eps.length ? 'HIT ' : 'MISS'} ${c} ${type} ${a}..${b} ${eps.map((e) => `${e.start}→${e.end} peakZ=${e.peakZ}`).join('; ')} (${why})`);
  }
  console.log(`\nKnown-episode hit rate: ${hit}/${testable} testable (${KNOWN.length} listed)`);
  console.log(`Countries: ${Object.keys(res).length}; country-quarters scored: ${quarters}`);
  for (const [k, v] of Object.entries(inEpisode)) console.log(`  share of quarters in ${k}: ${((100 * v) / quarters).toFixed(1)}%`);
}

if (process.argv[1]?.endsWith('backtest-capital-flow-episodes.mjs')) {
  main().catch((err) => {
    console.error('FATAL:', err.message || err);
    process.exit(1);
  });
}
