#!/usr/bin/env node
// One-time / offline backfill for the strategic reservoir level series (not a Railway cron).
//
// For each watchlist entry: list every granule of the entry's product (ATL13 by default,
// ATL06 when `product` is "atl06") over its core box since the start of the ICESat-2
// mission (NASA CMR), subset them to the core polygon on the public SlideRule Earth
// cluster, and reduce the segments to per-pass statistics as a stream.
// Progress is saved per reservoir in a scratch directory after every batch, so an
// interrupted run resumes where it stopped. When every entry is finished the per-entry
// files are assembled into scripts/data/reservoir-levels-baseline.json, which the daily
// seeder merges with its Redis state.
//
// Usage:
//   node scripts/backfill-reservoir-levels.mjs [--only id,id] [--scratch DIR] [--concurrency 3]
//   node scripts/backfill-reservoir-levels.mjs --assemble        # write the baseline from scratch files
//   node scripts/backfill-reservoir-levels.mjs --report [--from-scratch]
//   node scripts/backfill-reservoir-levels.mjs --reset id,id     # forget scratch progress (after a core box, product or level window change)
//   --watchlist FILE reads entries from another file of the same shape (candidate trials,
//   cross-checks); --assemble refuses it so the baseline always matches the real watchlist.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync, lstatSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  MISSION_START_ISO,
  DEFAULT_PRODUCT,
  bboxToPolygon,
  cadenceReport,
  classifyPasses,
  createPassAccumulator,
  fetchSegments,
  granuleDate,
  listGranules,
  mergePasses,
  passToTuple,
  productOf,
  tupleToPass,
} from './_reservoir-levels.mjs';
import { allSettledWithConcurrency } from './_seed-utils.mjs';

// Same per-entry despike override as the seeder (kept local: importing the seeder would run
// its env loading).
const despikeOpts = (e) => (e.despikePerGapDayM != null ? { perGapDayM: e.despikePerGapDayM } : {});

const __dirname = dirname(fileURLToPath(import.meta.url));
export const WATCHLIST_PATH = join(__dirname, 'data', 'strategic-reservoirs.json');
export const BASELINE_PATH = join(__dirname, 'data', 'reservoir-levels-baseline.json');
const MAX_GRANULE_ATTEMPTS = 3;

function parseArgs(argv) {
  // Per-user default: /tmp is shared on Linux, and the run trusts what it finds here.
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
  const a = { concurrency: 3, scratch: join(process.env.TMPDIR || '/tmp', `reservoir-levels-backfill-${uid}`) };
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
    else if (k === '--watchlist') a.watchlist = argv[++i];
  }
  return a;
}

export function loadWatchlist(path = WATCHLIST_PATH) {
  return JSON.parse(readFileSync(path, 'utf8')).reservoirs;
}

const SCRATCH_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

// Reservoir ids become file names, so only plain slugs are allowed: no separators or "..".
function scratchFile(dir, id) {
  if (!SCRATCH_ID_RE.test(String(id))) throw new Error(`unsafe reservoir id for a scratch path: ${JSON.stringify(id)}`);
  return join(dir, `${id}.json`);
}

// The scratch directory holds progress the baseline is built from, so other local users
// must not be able to plant or swap files in it.
export function ensurePrivateScratchDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`scratch path ${dir} is not a plain directory`);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new Error(`scratch directory ${dir} belongs to another user`);
  }
  if (process.platform === 'win32') return;
  // A directory others could write may already hold planted files; tightening it now
  // would keep them, so start over in a fresh directory instead.
  if ((st.mode & 0o022) !== 0) {
    throw new Error(`scratch directory ${dir} is writable by other users; remove it or pass --scratch with a fresh directory`);
  }
  if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
}

function loadScratch(dir, entry) {
  const f = scratchFile(dir, entry.id);
  const product = productOf(entry).id;
  const levelWindowM = entry.levelWindowM ?? null;
  if (!existsSync(f)) return { id: entry.id, core: entry.core, refid: entry.refid ?? null, product, levelWindowM, granules: null, processed: [], failures: {}, passes: [], done: false };
  const s = JSON.parse(readFileSync(f, 'utf8'));
  if (s.id !== entry.id) throw new Error(`${entry.id}: scratch file is labelled ${JSON.stringify(s.id)}; run --reset ${entry.id}`);
  if (JSON.stringify(s.core) !== JSON.stringify(entry.core) || (s.refid ?? null) !== (entry.refid ?? null)
    || (s.product ?? DEFAULT_PRODUCT) !== product || JSON.stringify(s.levelWindowM ?? null) !== JSON.stringify(levelWindowM)) {
    throw new Error(`${entry.id}: scratch was built for a different core box, refid, product or level window; run --reset ${entry.id}`);
  }
  return s;
}

export function saveScratch(dir, s) {
  const f = scratchFile(dir, s.id);
  // Remove any leftover temp entry and create it exclusively, so a planted symlink is
  // never followed. rename replaces the target entry itself.
  rmSync(`${f}.tmp`, { force: true });
  writeFileSync(`${f}.tmp`, JSON.stringify(s), { flag: 'wx', mode: 0o600 });
  renameSync(`${f}.tmp`, f);
}

async function backfillOne(entry, dir, untilIso) {
  const s = loadScratch(dir, entry);
  if (s.done) { console.log(`${entry.id}: already done (${s.passes.length} passes)`); return; }
  const t0 = Date.now();
  const prod = productOf(entry);
  if (!s.granules) {
    s.granules = await listGranules(entry.core, MISSION_START_ISO, undefined, { untilIso: untilIso ? `${untilIso}T00:00:00Z` : null, product: prod.id });
    saveScratch(dir, s);
  }
  const poly = bboxToPolygon(entry.core);
  const processed = new Set(s.processed);
  // Up to MAX_GRANULE_ATTEMPTS rounds: the first round covers every granule, later rounds
  // retry the granules that failed server-side.
  for (let round = 0; round < MAX_GRANULE_ATTEMPTS; round++) {
    const todo = s.granules.filter((g) => !processed.has(g) && (s.failures[g] || 0) < MAX_GRANULE_ATTEMPTS);
    if (!todo.length) break;
    // Retry rounds use quarter-size batches so one bad granule holds back fewer others.
    const batchSize = round === 0 ? prod.batchSize : Math.max(1, Math.floor(prod.batchSize / 4));
    for (let i = 0; i < todo.length; i += batchSize) {
      const batch = todo.slice(i, i + batchSize);
      const acc = createPassAccumulator({ refid: entry.refid ?? null, product: prod.id, levelWindow: entry.levelWindowM ?? null });
      const r = await fetchSegments(poly, batch, (row) => acc.add(row), undefined, {
        product: prod.id,
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
  const rep = cadenceReport(classifyPasses(s.passes.map(tupleToPass), despikeOpts(entry)));
  console.log(`${entry.id}: DONE ${rep.ok}/${rep.passes} ok passes, ${Object.keys(s.failures).length} granules ever failed, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

export function assembleBaseline(watchlist, dir, nowIso = new Date().toISOString()) {
  const reservoirs = {};
  let through = null;
  for (const entry of watchlist) {
    if (!existsSync(scratchFile(dir, entry.id))) throw new Error(`${entry.id}: no scratch file`);
    // loadScratch checks the scratch was built for this entry's core box, refid, product
    // and level window, so a trial or cross-check run cannot leak into the baseline.
    const s = loadScratch(dir, entry);
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
    const rep = cadenceReport(classifyPasses((r?.passes || []).map(tupleToPass), despikeOpts(e)));
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
  const watchlist = loadWatchlist(a.watchlist ?? WATCHLIST_PATH);
  ensurePrivateScratchDir(a.scratch);
  if (a.reset) {
    const known = new Set(watchlist.map((e) => e.id));
    for (const id of a.reset) if (!known.has(id)) throw new Error(`--reset ${id}: not in the watchlist`);
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
        if (existsSync(f)) { const s = loadScratch(a.scratch, e); reservoirs[e.id] = { passes: s.passes, failedGranules: s.failures }; }
      }
      baseline = { reservoirs };
    } else baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
    printReport(reportRows(watchlist.filter((e) => !a.only || a.only.includes(e.id)), baseline));
    return;
  }
  if (a.assemble) {
    if (a.watchlist) throw new Error('--assemble writes the committed baseline; it always uses the committed watchlist');
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
