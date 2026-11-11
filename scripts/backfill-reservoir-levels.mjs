#!/usr/bin/env node
// One-time / offline backfill for the strategic reservoir level series (not a Railway cron).
//
// For each watchlist entry: list every ATL13 granule over the entry's core box since the
// start of the ICESat-2 mission (NASA CMR), subset them to the core polygon on the public
// SlideRule Earth cluster, and reduce the segments to per-pass statistics as a stream.
// Progress is saved per reservoir in a scratch directory after every batch, so an
// interrupted run resumes where it stopped. When every entry is finished the per-entry
// files are assembled into scripts/data/reservoir-levels-baseline.json, which the daily
// seeder merges with its Redis state.
//
// Usage:
//   node scripts/backfill-reservoir-levels.mjs [--only id,id] [--scratch DIR] [--concurrency 3]
//   node scripts/backfill-reservoir-levels.mjs --assemble        # write the baseline from scratch files
//   node scripts/backfill-reservoir-levels.mjs --report [--from-scratch]
//   node scripts/backfill-reservoir-levels.mjs --reset id,id     # forget scratch progress (after a core box change)

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  MISSION_START_ISO,
  bboxToPolygon,
  cadenceReport,
  classifyPasses,
  createPassAccumulator,
  fetchAtl13Segments,
  granuleDate,
  listGranules,
  mergePasses,
  passToTuple,
  tupleToPass,
} from './_reservoir-levels.mjs';
import { allSettledWithConcurrency } from './_seed-utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const WATCHLIST_PATH = join(__dirname, 'data', 'strategic-reservoirs.json');
export const BASELINE_PATH = join(__dirname, 'data', 'reservoir-levels-baseline.json');
const MAX_GRANULE_ATTEMPTS = 3;

function parseArgs(argv) {
  const a = { concurrency: 3, scratch: join(process.env.TMPDIR || '/tmp', 'reservoir-levels-backfill') };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--only') a.only = argv[++i].split(',');
    else if (k === '--scratch') a.scratch = argv[++i];
    else if (k === '--concurrency') a.concurrency = Math.min(3, Math.max(1, Number(argv[++i]) || 1));
    else if (k === '--assemble') a.assemble = true;
    else if (k === '--report') a.report = true;
    else if (k === '--from-scratch') a.fromScratch = true;
    else if (k === '--reset') a.reset = argv[++i].split(',');
    else if (k === '--until') a.until = argv[++i];
  }
  return a;
}

export function loadWatchlist(path = WATCHLIST_PATH) {
  return JSON.parse(readFileSync(path, 'utf8')).reservoirs;
}

function scratchFile(dir, id) { return join(dir, `${id}.json`); }

function loadScratch(dir, entry) {
  const f = scratchFile(dir, entry.id);
  if (!existsSync(f)) return { id: entry.id, core: entry.core, refid: entry.refid ?? null, granules: null, processed: [], failures: {}, passes: [], done: false };
  const s = JSON.parse(readFileSync(f, 'utf8'));
  if (JSON.stringify(s.core) !== JSON.stringify(entry.core) || (s.refid ?? null) !== (entry.refid ?? null)) {
    throw new Error(`${entry.id}: scratch was built for a different core box or refid; run --reset ${entry.id}`);
  }
  return s;
}

function saveScratch(dir, s) {
  const f = scratchFile(dir, s.id);
  writeFileSync(`${f}.tmp`, JSON.stringify(s));
  renameSync(`${f}.tmp`, f);
}

async function backfillOne(entry, dir, untilIso) {
  const s = loadScratch(dir, entry);
  if (s.done) { console.log(`${entry.id}: already done (${s.passes.length} passes)`); return; }
  const t0 = Date.now();
  if (!s.granules) {
    s.granules = await listGranules(entry.core, MISSION_START_ISO, undefined, { untilIso: untilIso ? `${untilIso}T00:00:00Z` : null });
    saveScratch(dir, s);
  }
  const poly = bboxToPolygon(entry.core);
  const processed = new Set(s.processed);
  // Up to MAX_GRANULE_ATTEMPTS rounds: the first round covers every granule, later rounds
  // retry the granules that failed server-side.
  for (let round = 0; round < MAX_GRANULE_ATTEMPTS; round++) {
    const todo = s.granules.filter((g) => !processed.has(g) && (s.failures[g] || 0) < MAX_GRANULE_ATTEMPTS);
    if (!todo.length) break;
    const batchSize = round === 0 ? 20 : 5;
    for (let i = 0; i < todo.length; i += batchSize) {
      const batch = todo.slice(i, i + batchSize);
      const acc = createPassAccumulator({ refid: entry.refid ?? null });
      const r = await fetchAtl13Segments(poly, batch, (row) => acc.add(row), undefined, {
        batchSize,
        log: (m) => console.log(`${entry.id}:${m}`),
      });
      const fresh = acc.finish();
      s.passes = mergePasses(s.passes.map(tupleToPass), fresh).map(passToTuple);
      for (const g of r.processed) processed.add(g);
      for (const g of r.failed) s.failures[g] = (s.failures[g] || 0) + 1;
      s.processed = [...processed].sort();
      saveScratch(dir, s);
      console.log(`${entry.id}: ${processed.size}/${s.granules.length} granules, ${s.passes.length} passes, ${r.rows} rows, failed ${r.failed.length}, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
  }
  s.done = true;
  s.processedThrough = s.processed.map(granuleDate).sort().at(-1) ?? null;
  saveScratch(dir, s);
  const rep = cadenceReport(classifyPasses(s.passes.map(tupleToPass)));
  console.log(`${entry.id}: DONE ${rep.ok}/${rep.passes} ok passes, ${Object.keys(s.failures).length} granules ever failed, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

export function assembleBaseline(watchlist, dir, nowIso = new Date().toISOString()) {
  const reservoirs = {};
  let through = null;
  for (const entry of watchlist) {
    const f = scratchFile(dir, entry.id);
    if (!existsSync(f)) throw new Error(`${entry.id}: no scratch file`);
    const s = JSON.parse(readFileSync(f, 'utf8'));
    if (!s.done) throw new Error(`${entry.id}: backfill not finished`);
    const processed = new Set(s.processed);
    // Granules that never succeeded stay listed so the seeder can retry them.
    const failedGranules = Object.fromEntries(Object.entries(s.failures).filter(([g]) => !processed.has(g)).sort());
    reservoirs[entry.id] = {
      passes: s.passes,
      processedThrough: s.processedThrough,
      failedGranules,
    };
    if (s.processedThrough && (!through || s.processedThrough > through)) through = s.processedThrough;
  }
  return { generatedAt: nowIso, through, reservoirs };
}

export function reportRows(watchlist, baseline) {
  return watchlist.map((e) => {
    const r = baseline.reservoirs[e.id];
    const rep = cadenceReport(classifyPasses((r?.passes || []).map(tupleToPass)));
    return { id: e.id, ...rep, failedGranules: Object.keys(r?.failedGranules || {}).length };
  });
}

function printReport(rows) {
  const cols = ['id', 'passes', 'ok', 'passesPerYear', 'medianGapDays', 'maxGapDays', 'first', 'last', 'medianMadM', 'despiked', 'yearsWithSixPlus', 'failedGranules'];
  console.log(cols.join('\t'));
  for (const r of rows) console.log(cols.map((c) => r[c] ?? '-').join('\t'));
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const watchlist = loadWatchlist();
  mkdirSync(a.scratch, { recursive: true });
  if (a.reset) {
    for (const id of a.reset) rmSync(scratchFile(a.scratch, id), { force: true });
    console.log(`reset ${a.reset.join(', ')}`);
    return;
  }
  if (a.report) {
    let baseline;
    if (a.fromScratch) {
      const reservoirs = {};
      for (const e of watchlist) {
        const f = scratchFile(a.scratch, e.id);
        if (existsSync(f)) { const s = JSON.parse(readFileSync(f, 'utf8')); reservoirs[e.id] = { passes: s.passes, failedGranules: s.failures }; }
      }
      baseline = { reservoirs };
    } else baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
    printReport(reportRows(watchlist.filter((e) => !a.only || a.only.includes(e.id)), baseline));
    return;
  }
  if (a.assemble) {
    const baseline = assembleBaseline(watchlist, a.scratch);
    writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline)}\n`);
    console.log(`wrote ${BASELINE_PATH} (${Object.keys(baseline.reservoirs).length} reservoirs, through ${baseline.through})`);
    return;
  }
  const todo = watchlist.filter((e) => !a.only || a.only.includes(e.id));
  const results = await allSettledWithConcurrency(todo, a.concurrency, (e) => backfillOne(e, a.scratch, a.until));
  let failed = 0;
  results.forEach((r, i) => { if (r.status === 'rejected') { failed++; console.error(`${todo[i].id}: ERROR ${r.reason?.message || r.reason}`); } });
  console.log(`backfill finished: ${todo.length - failed}/${todo.length} reservoirs`);
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
