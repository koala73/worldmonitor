// Strategic reservoir water levels from NASA ICESat-2 ATL13 (inland water surface height).
//
// Pure helpers shared by the daily seeder (seed-reservoir-levels.mjs) and the offline
// backfill (backfill-reservoir-levels.mjs). The only I/O is through an injected fetch.
//
// Data path (keyless):
//   1. NASA CMR lists ATL13 v007 granules that intersect a reservoir's core box.
//   2. The public SlideRule Earth cluster subsets those granules to the core polygon
//      (POST /source/atl13x) and streams the segments back as a CSV inside native records.
//   3. Segments are reduced to one robust level per overpass (UTC date + reference ground
//      track), filtered, despiked, and turned into change metrics.
//
// Levels are orthometric water-surface heights (`ht_ortho`, metres above the EGM2008
// geoid). They are lake levels, not storage volumes.

import { CHROME_UA, withRetry } from './_seed-utils.mjs';

export const CMR_GRANULES_URL = 'https://cmr.earthdata.nasa.gov/search/granules.json';
export const SLIDERULE_ATL13_URL = 'https://sliderule.slideruleearth.io/source/atl13x';
export const MISSION_START_ISO = '2018-10-01';
export const ATL13_VERSION = '007';
export const SLIDERULE_BATCH_SIZE = 20;
export const SLIDERULE_BATCH_TIMEOUT_MS = 8 * 60 * 1000;
export const CMR_TIMEOUT_MS = 30_000;
export const CMR_PAGE_SIZE = 2000;
export const ATL13_HEIGHT_FILL_LIMIT_M = 1e4; // fill value is ~3.4e38
export const DAY_MS = 86_400_000;

// Per-pass quality rule and neighbour despike. Thresholds are the ones validated in the
// Lake Mead comparison against the USBR daily gauge (SDI 1930, 2018-10..2026-09): with
// these rules 141 matched passes gave RMSE 0.05 m after a 0.04 m datum offset, max error
// 0.15 m, r = 0.9999, while the unfiltered pass medians had 28 of 188 passes off by
// 5-27 m (passes over the river inflow arm). Do not loosen them without re-running the
// validation test (tests/reservoir-levels-validation.test.mjs).
export const PASS_MIN_SEGMENTS = 5;
export const PASS_MAX_MAD_M = 0.25;
export const PASS_MAX_BEAM_SPREAD_M = 0.3;
export const CLIP_SIGMA = 3;
export const CLIP_FLOOR_M = 0.05;
export const DESPIKE_BASE_M = 1;
export const DESPIKE_PER_GAP_DAY_M = 0.05;

// Change-metric windows.
export const CHANGE_WINDOWS = Object.freeze([
  { field: 'change30dM', days: 30, toleranceDays: 20 },
  { field: 'change90dM', days: 90, toleranceDays: 45 },
  { field: 'change365dM', days: 365, toleranceDays: 45 },
]);
export const SEASONAL_WINDOW_DAYS = 30;
export const SEASONAL_MIN_PRIOR_YEARS = 3;
export const SEASONAL_MIN_SIGMA_M = 0.25;
export const RECORD_MIN_YEARS = 3;
export const RECORD_MIN_RANGE_M = 1;
export const NO_RECENT_DATA_DAYS = 150;
export const FAST_CHANGE_MIN_M = 2;
export const FAST_CHANGE_RANGE_FRACTION = 0.15;
export const LOW_PERCENT = 15;
export const HIGH_PERCENT = 85;
export const SEASONAL_Z_ALERT = 1.5;
export const SERIES_MONTHS = 36;

const GRANULE_RE = /ATL13_\d{14}_\d{8}_\d{3}_\d{2}\.h5/g;
const GRANULE_EXACT_RE = /^ATL13_(\d{14})_(\d{8})_(\d{3})_(\d{2})\.h5$/;

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

export function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function mad(values, m = median(values)) {
  if (!values.length) return null;
  return median(values.map((x) => Math.abs(x - m)));
}

const round = (x, digits = 3) => (x == null || !Number.isFinite(x) ? null : Number(x.toFixed(digits)));

export function bboxToPolygon([w, s, e, n]) {
  return [
    { lon: w, lat: s }, { lon: e, lat: s }, { lon: e, lat: n }, { lon: w, lat: n }, { lon: w, lat: s },
  ];
}

// ---------------------------------------------------------------------------
// Granule names
// ---------------------------------------------------------------------------

export function granuleDate(name) {
  const m = GRANULE_EXACT_RE.exec(name);
  if (!m) return null;
  const t = m[1];
  return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
}

/** Orbit identity without the release revision (`_01`, `_02`). */
export function granuleBase(name) {
  const m = GRANULE_EXACT_RE.exec(name);
  return m ? `ATL13_${m[1]}_${m[2]}_${m[3]}` : null;
}

/**
 * Keep one granule per orbit, preferring the highest revision. CMR can list a reprocessed
 * `_02` next to the original `_01`; processing both would double-count the pass.
 */
export function dedupeGranules(names) {
  const best = new Map();
  for (const name of names) {
    const base = granuleBase(name);
    if (!base) continue;
    const prev = best.get(base);
    if (!prev || name > prev) best.set(base, name);
  }
  return [...best.values()].sort();
}

// ---------------------------------------------------------------------------
// CMR granule discovery
// ---------------------------------------------------------------------------

/**
 * List ATL13 granules intersecting `bbox` ([W,S,E,N]) with start time >= sinceIso.
 * Paginates with CMR-Search-After. Returns deduplicated granule names, oldest first.
 */
export async function listGranules(bbox, sinceIso, fetchImpl = (...a) => globalThis.fetch(...a), opts = {}) {
  const { untilIso = null, retries = 3, retryDelayMs = 2000, maxPages = 20, timeoutMs = CMR_TIMEOUT_MS } = opts;
  const temporal = `${sinceIso.length === 10 ? `${sinceIso}T00:00:00Z` : sinceIso},${untilIso ?? ''}`;
  const params = new URLSearchParams({
    short_name: 'ATL13',
    version: ATL13_VERSION,
    bounding_box: bbox.join(','),
    temporal,
    sort_key: 'start_date',
    page_size: String(CMR_PAGE_SIZE),
  });
  const url = `${CMR_GRANULES_URL}?${params}`;
  const names = [];
  let searchAfter = null;
  for (let page = 0; page < maxPages; page++) {
    const { entries, next } = await withRetry(async () => {
      const headers = { 'User-Agent': CHROME_UA, Accept: 'application/json' };
      if (searchAfter) headers['CMR-Search-After'] = searchAfter;
      const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) {
        const err = new Error(`CMR HTTP ${res.status}`);
        if (res.status >= 400 && res.status < 500 && res.status !== 429) err.nonRetryable = true;
        throw err;
      }
      const body = await res.json();
      const nextHeader = typeof res.headers?.get === 'function' ? res.headers.get('cmr-search-after') : null;
      return { entries: Array.isArray(body?.feed?.entry) ? body.feed.entry : [], next: nextHeader };
    }, retries, retryDelayMs);
    for (const e of entries) {
      const name = typeof e?.producer_granule_id === 'string' && GRANULE_EXACT_RE.test(e.producer_granule_id)
        ? e.producer_granule_id
        : (typeof e?.title === 'string' ? (e.title.match(GRANULE_RE) || [])[0] : null);
      if (name) names.push(name);
    }
    if (entries.length < CMR_PAGE_SIZE || !next) break;
    searchAfter = next;
  }
  return dedupeGranules(names);
}

// ---------------------------------------------------------------------------
// SlideRule native record stream
// ---------------------------------------------------------------------------

const cstr = (buf) => {
  const z = buf.indexOf(0);
  return buf.subarray(0, z < 0 ? buf.length : z).toString('utf8');
};

/**
 * Incremental parser for SlideRule's native record stream. Each record is an 8-byte
 * big-endian header (int16 version = 2, int16 typeSize, int32 dataSize), a NUL-terminated
 * type string of typeSize bytes, then dataSize payload bytes. Chunks may split a record at
 * any byte. Returns { push(chunk), end() }; end() throws on a truncated trailing record.
 */
export function createRecordParser(onRecord) {
  let parts = [];
  let have = 0;
  let need = 8;
  let header = null;
  const take = (n) => {
    const buf = parts.length === 1 ? parts[0] : Buffer.concat(parts, have);
    const out = buf.subarray(0, n);
    const rest = buf.subarray(n);
    parts = rest.length ? [rest] : [];
    have = rest.length;
    return out;
  };
  return {
    push(chunk) {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      if (!b.length) return;
      parts.push(b);
      have += b.length;
      while (have >= need) {
        if (!header) {
          const h = take(8);
          const version = h.readInt16BE(0);
          if (version !== 2) throw new Error(`bad SlideRule record version ${version}`);
          header = { typeSize: h.readInt16BE(2), dataSize: h.readInt32BE(4) };
          need = header.typeSize + header.dataSize;
          if (need <= 0) { header = null; need = 8; }
        } else {
          const { typeSize } = header;
          const rec = Buffer.from(take(need)); // copy: detach from the shared chunk buffer
          header = null;
          need = 8;
          onRecord(cstr(rec.subarray(0, typeSize)), rec.subarray(typeSize));
        }
      }
    },
    end() {
      if (have > 0 || header) throw new Error(`truncated SlideRule record stream (${have} bytes pending)`);
    },
  };
}

/** Decode an eventrec / exceptrec payload into { kind, level, code, msg }. */
export function decodeEventRecord(type, d) {
  if (type === 'eventrec') {
    return { kind: 'event', level: d.length >= 12 ? d.readUInt32LE(8) : 0, msg: d.length > 60 ? cstr(d.subarray(60)) : '' };
  }
  if (type === 'exceptrec') {
    return {
      kind: 'exception',
      code: d.length >= 4 ? d.readInt32LE(0) : 0,
      level: d.length >= 8 ? d.readUInt32LE(4) : 0,
      msg: d.length > 8 ? cstr(d.subarray(8, 8 + 256)) : '',
    };
  }
  return null;
}

// SlideRule event levels: 0 debug, 1 info, 2 warning, 3 error, 4 critical.
export const EVENT_ERROR_LEVEL = 3;

/** Granule names that an error-level event or exception blames. */
export function failedGranulesFromEvents(events) {
  const failed = new Set();
  for (const e of events) {
    const isError = e.level >= EVENT_ERROR_LEVEL || (e.kind === 'exception' && e.code < 0);
    if (!isError) continue;
    for (const g of e.msg.match(GRANULE_RE) || []) failed.add(g);
  }
  return [...failed].sort();
}

/**
 * Line-oriented CSV reader for chunks of a CSV file. The server's CSV writer emits only
 * numeric and enum columns, so no quoting/escaping is needed beyond stripping quotes in
 * the header. Calls onRow(object) for every data line.
 */
export function createCsvLineReader(onRow) {
  let head = null;
  let tail = '';
  const decoder = new TextDecoder();
  const line = (l) => {
    if (l.endsWith('\r')) l = l.slice(0, -1);
    if (!l) return;
    if (!head) { head = l.split(',').map((h) => h.replace(/"/g, '').trim()); return; }
    const c = l.split(',');
    const row = {};
    for (let i = 0; i < head.length; i++) row[head[i]] = c[i];
    onRow(row);
  };
  return {
    push(bytes) {
      const text = tail + decoder.decode(bytes, { stream: true });
      const lines = text.split('\n');
      tail = lines.pop();
      for (const l of lines) line(l);
    },
    end() {
      const rest = tail + decoder.decode();
      tail = '';
      if (rest) line(rest);
    },
    reset() { head = null; tail = ''; },
    get columns() { return head; },
  };
}

/**
 * Stream one SlideRule atl13x request and feed CSV rows to onRow.
 * Returns { rows, fileSize, csvBytes, gotEof, events }.
 */
export async function streamAtl13Request(parms, onRow, fetchImpl, { timeoutMs = SLIDERULE_BATCH_TIMEOUT_MS } = {}) {
  const res = await fetchImpl(SLIDERULE_ATL13_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': CHROME_UA },
    body: JSON.stringify({ parms }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    let text = '';
    try { text = (await res.text()).slice(0, 200); } catch { /* ignore */ }
    throw new Error(`SlideRule HTTP ${res.status}: ${text}`);
  }
  const ctype = typeof res.headers?.get === 'function' ? res.headers.get('content-type') : null;
  if (ctype && !ctype.startsWith('application/octet-stream')) {
    throw new Error(`SlideRule unexpected content-type ${ctype}`);
  }
  let rows = 0;
  let fileSize = null;
  let csvBytes = 0;
  let gotEof = false;
  const events = [];
  const csv = createCsvLineReader((row) => { rows++; onRow(row); });
  const parser = createRecordParser((type, d) => {
    if (type === 'arrowrec.meta') {
      fileSize = d.length >= 136 ? Number(d.readBigInt64LE(128)) : null;
      csv.reset();
    } else if (type === 'arrowrec.data') {
      const bytes = d.subarray(128);
      csvBytes += bytes.length;
      csv.push(bytes);
    } else if (type === 'arrowrec.eof') {
      csv.end();
      gotEof = true;
    } else {
      const ev = decodeEventRecord(type, d);
      if (ev) events.push(ev);
    }
  });
  for await (const chunk of res.body) parser.push(chunk);
  parser.end();
  if (!gotEof) csv.end();
  return { rows, fileSize, csvBytes, gotEof, events };
}

// Keep only the columns the reduction reads, to bound memory while a batch is buffered.
const slimRow = (r) => ({ time_ns: r.time_ns, rgt: r.rgt, gt: r.gt, ht_ortho: r.ht_ortho, atl13refid: r.atl13refid });

const EMPTY_SELECTION_RE = /no resources to process|received 0 x 0 dataframe|produced an empty dataframe|invalid dataframe/i;

/**
 * Fetch ATL13 segments for `granules` inside `poly`, in batches of <= SLIDERULE_BATCH_SIZE.
 * Rows go to onRow(row, granuleBatch). Never throws for upstream failures: returns
 * { processed: [...granules that completed], failed: [...granules to retry],
 * skipped: [...granules not attempted because deadlineAtMs passed], rows, errors,
 * okBatches, failedBatches }. A batch whose request completed counts as ok even when some
 * of its granules failed server-side: the service was reachable.
 * A whole-request failure marks every granule in that batch failed; a per-granule error
 * event marks only that granule failed and keeps the rest of the batch.
 */
export async function fetchAtl13Segments(poly, granules, onRow, fetchImpl = (...a) => globalThis.fetch(...a), opts = {}) {
  const {
    batchSize = SLIDERULE_BATCH_SIZE,
    timeoutMs = SLIDERULE_BATCH_TIMEOUT_MS,
    deadlineAtMs = Infinity,
    ancFields = ['atl13refid'],
    log = () => {},
  } = opts;
  const processed = [];
  const failed = [];
  const skipped = [];
  const errors = [];
  let rows = 0;
  let okBatches = 0;
  for (let i = 0; i < granules.length; i += batchSize) {
    const batch = granules.slice(i, i + batchSize);
    // Past the caller's deadline: leave the rest untouched (neither processed nor failed)
    // so the next run picks them up.
    const remainingMs = deadlineAtMs - Date.now();
    if (remainingMs <= 0) { skipped.push(...granules.slice(i)); break; }
    const parms = {
      poly,
      resources: batch,
      atl13: { anc_fields: ancFields },
      output: { path: 'atl13.csv', format: 'csv', open_on_complete: false },
    };
    // Rows are buffered per batch so a batch that dies mid-stream contributes nothing:
    // a half-delivered pass would otherwise be stored as if complete.
    const batchRows = [];
    try {
      const r = await streamAtl13Request(parms, (row) => batchRows.push(slimRow(row)), fetchImpl, {
        timeoutMs: Math.max(30_000, Math.min(timeoutMs, remainingMs)),
      });
      const empty = r.fileSize == null && r.csvBytes === 0 && r.events.some((e) => EMPTY_SELECTION_RE.test(e.msg));
      // The server announces the file size in arrowrec.meta; arrowrec.eof is not always
      // sent (atl13x on server v5.8 ends the stream without it), so the byte count is the
      // completeness check.
      if (!empty && (r.fileSize == null || r.csvBytes !== r.fileSize)) {
        throw new Error(`incomplete SlideRule output (${r.csvBytes} of ${r.fileSize ?? '?'} bytes)`);
      }
      const bad = new Set(failedGranulesFromEvents(r.events).filter((g) => batch.includes(g)));
      for (const row of batchRows) {
        // Rows carry no granule name, but a failed granule produced no usable rows anyway
        // (the server drops the whole granule on a read failure).
        rows++;
        onRow(row, batch);
      }
      for (const g of batch) (bad.has(g) ? failed : processed).push(g);
      okBatches++;
      if (bad.size) log(`  ${bad.size}/${batch.length} granules failed server-side`);
    } catch (err) {
      errors.push(err?.message || String(err));
      failed.push(...batch);
      log(`  batch of ${batch.length} failed: ${err?.message || err}`);
    }
  }
  return { processed, failed, skipped, rows, errors, okBatches, failedBatches: errors.length };
}

// ---------------------------------------------------------------------------
// Reduction: segments -> per-pass stats
// ---------------------------------------------------------------------------

function rowTimeMs(t) {
  if (t == null) return NaN;
  if (/^\d+$/.test(t)) return Number(BigInt(t) / 1000000n);
  return Date.parse(String(t).replace(' ', 'T').slice(0, 23) + 'Z');
}

/**
 * Streaming accumulator. add(row) groups segments by UTC date + reference ground track.
 * finish() returns one stats record per pass. Optional `refid` keeps only segments of that
 * ATL13 water body (when the row carries `atl13refid`).
 */
export function createPassAccumulator({ heightField = 'ht_ortho', refid = null } = {}) {
  const groups = new Map();
  return {
    add(row) {
      if (refid != null && row.atl13refid != null && row.atl13refid !== '' && Number(row.atl13refid) !== refid) return;
      const h = Number(row[heightField]);
      if (!Number.isFinite(h) || Math.abs(h) > ATL13_HEIGHT_FILL_LIMIT_M) return;
      const ms = rowTimeMs(row.time_ns ?? row.time);
      if (!Number.isFinite(ms)) return;
      const date = new Date(ms).toISOString().slice(0, 10);
      const rgt = Number(row.rgt);
      const key = `${date}|${rgt}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { date, rgt, h: [], byBeam: new Map(), tMin: ms, tMax: ms }));
      g.h.push(h);
      const beam = String(row.gt ?? '');
      let bh = g.byBeam.get(beam);
      if (!bh) g.byBeam.set(beam, (bh = []));
      bh.push(h);
      if (ms < g.tMin) g.tMin = ms;
      if (ms > g.tMax) g.tMax = ms;
    },
    get size() { return groups.size; },
    finish() {
      const out = [];
      for (const g of groups.values()) out.push(passStats(g));
      out.sort(comparePasses);
      return out;
    },
  };
}

function passStats(g) {
  let m = median(g.h);
  let d = mad(g.h, m);
  // One round of 3-sigma (MAD-based) clipping, then recompute.
  const kept = d > 0 ? g.h.filter((x) => Math.abs(x - m) <= CLIP_SIGMA * 1.4826 * d + CLIP_FLOOR_M) : g.h;
  m = median(kept);
  d = mad(kept, m);
  // Beam agreement: medians of beams with enough segments must agree. Catches passes that
  // only clip isolated pools or river reaches at the edge of the box.
  const beamMedians = [...g.byBeam.values()].filter((v) => v.length >= PASS_MIN_SEGMENTS).map((v) => median(v));
  const beamSpread = beamMedians.length >= 2 ? Math.max(...beamMedians) - Math.min(...beamMedians) : null;
  const tMid = new Date(Math.round((g.tMin + g.tMax) / 2)).toISOString().slice(0, 16) + 'Z';
  return {
    time: tMid,
    date: g.date,
    rgt: g.rgt,
    levelM: round(m),
    madM: round(d),
    n: kept.length,
    beamSpreadM: round(beamSpread),
  };
}

/** Accumulate an array of rows (tests, small inputs). */
export function reduceRows(rows, opts) {
  const acc = createPassAccumulator(opts);
  for (const r of rows) acc.add(r);
  return acc.finish();
}

export const passKey = (p) => `${p.date}|${p.rgt}`;

function comparePasses(a, b) {
  return a.time < b.time ? -1 : a.time > b.time ? 1 : a.rgt - b.rgt;
}

// Compact tuple storage: [timeIso, rgt, levelM, madM, n, beamSpreadM|null].
export function passToTuple(p) {
  return [p.time, p.rgt, p.levelM, p.madM, p.n, p.beamSpreadM ?? null];
}

export function tupleToPass(t) {
  const [time, rgt, levelM, madM, n, beamSpreadM] = t;
  const iso = String(time);
  const date = iso.slice(0, 10);
  return { time: iso.length === 10 ? `${iso}T12:00Z` : iso, date, rgt: Number(rgt), levelM: Number(levelM), madM: Number(madM), n: Number(n), beamSpreadM: beamSpreadM == null ? null : Number(beamSpreadM) };
}

/**
 * Merge new pass stats into a stored list. Keyed by UTC date + RGT; when the same pass
 * arrives again (same granule re-processed, or a pass split across granules), the record
 * with more segments wins, so merging is idempotent and order-independent.
 */
export function mergePasses(existing, incoming) {
  const byKey = new Map();
  for (const p of [...existing, ...incoming]) {
    const k = passKey(p);
    const prev = byKey.get(k);
    if (!prev || p.n > prev.n || (p.n === prev.n && (p.madM < prev.madM || (p.madM === prev.madM && p.levelM < prev.levelM)))) byKey.set(k, p);
  }
  return [...byKey.values()].sort(comparePasses);
}

/** Basic per-pass quality rule (before the neighbour despike). */
export function passIsOk(p) {
  return p.n >= PASS_MIN_SEGMENTS
    && p.madM != null && p.madM <= PASS_MAX_MAD_M
    && (p.beamSpreadM == null || p.beamSpreadM <= PASS_MAX_BEAM_SPREAD_M);
}

/**
 * Classify every pass. Returns new objects with `ok` and `spike` set. The despike is
 * recomputed over the full merged series on every call; it is never stored.
 *
 * Despike: an ok pass that lies outside the range of its two ok neighbours by more than
 * DESPIKE_BASE_M + DESPIKE_PER_GAP_DAY_M per day of the larger gap is a mislocated pass
 * (river arm, edge pool) and is dropped. The worst offender is dropped first and the
 * neighbours are re-evaluated, until no pass exceeds the limit.
 *
 * The spike prototype measured the distance from the straight line through the two
 * neighbours, in a single sweep. That also dropped good passes next to every isolated
 * spike (the line to the spike runs far from them) and both edge passes of a real step
 * such as the Kakhovka drawdown. Distance outside the neighbour range never flags a
 * monotone run, and dropping the worst first stops a spike from condemning its
 * neighbours. Thresholds are unchanged; the Lake Mead validation test pins the result.
 */
export function classifyPasses(passes) {
  const out = [...passes].sort(comparePasses).map((p) => ({ ...p, ok: passIsOk(p), spike: false }));
  const ok = out.filter((p) => p.ok);
  for (;;) {
    let worst = -1;
    let worstExcess = 0;
    for (let i = 1; i < ok.length - 1; i++) {
      const a = ok[i - 1], b = ok[i], c = ok[i + 1];
      const gapDays = Math.max(Date.parse(b.time) - Date.parse(a.time), Date.parse(c.time) - Date.parse(b.time)) / DAY_MS;
      const outside = Math.max(b.levelM - Math.max(a.levelM, c.levelM), Math.min(a.levelM, c.levelM) - b.levelM);
      const excess = outside - (DESPIKE_BASE_M + DESPIKE_PER_GAP_DAY_M * gapDays);
      if (excess > worstExcess) { worstExcess = excess; worst = i; }
    }
    if (worst < 0) break;
    const [p] = ok.splice(worst, 1);
    p.ok = false;
    p.spike = true;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Change metrics
// ---------------------------------------------------------------------------

const dayOfYear = (ms) => {
  const d = new Date(ms);
  return (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY_MS;
};
const circularDoyDiff = (a, b) => {
  const d = Math.abs(a - b) % 365.25;
  return Math.min(d, 365.25 - d);
};

/**
 * Level at time t interpolated linearly between the bracketing ok passes. Returns null
 * unless an ok pass lies within toleranceDays of t, or if t is outside the record (no
 * extrapolation).
 */
export function levelAt(okPasses, tMs, toleranceDays) {
  if (!okPasses.length) return null;
  const first = Date.parse(okPasses[0].time);
  const last = Date.parse(okPasses[okPasses.length - 1].time);
  if (tMs < first || tMs > last) return null;
  let nearest = Infinity;
  for (const p of okPasses) nearest = Math.min(nearest, Math.abs(Date.parse(p.time) - tMs));
  if (nearest > toleranceDays * DAY_MS) return null;
  let lo = 0;
  let hi = okPasses.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (Date.parse(okPasses[mid].time) <= tMs) lo = mid; else hi = mid;
  }
  const a = okPasses[lo], b = okPasses[hi];
  const ta = Date.parse(a.time), tb = Date.parse(b.time);
  if (tb === ta) return a.levelM;
  return a.levelM + (b.levelM - a.levelM) * (tMs - ta) / (tb - ta);
}

/**
 * Compute change metrics from classified passes (output of classifyPasses) as of nowMs.
 * Only ok passes are used. Returns a plain object; fields are null when not computable.
 */
export function computeChange(passes, nowMs) {
  const ok = passes.filter((p) => p.ok).sort(comparePasses);
  const empty = {
    latest: null, prevDate: null, changePrevM: null,
    change30dM: null, change90dM: null, change365dM: null,
    seasonalAnomalyM: null, seasonalZ: null,
    recordMinM: null, recordMaxM: null, recordStart: null, percentOfRange: null,
    recordLow: false, recordHigh: false,
    status: 'insufficient_history', series: [],
    okPassCount: 0,
  };
  if (!ok.length) return empty;

  const latest = ok[ok.length - 1];
  const tLatest = Date.parse(latest.time);
  const ageDays = Math.floor((nowMs - tLatest) / DAY_MS);
  const out = { ...empty, okPassCount: ok.length };
  out.latest = { date: latest.date, levelM: latest.levelM, madM: latest.madM, segmentCount: latest.n, ageDays };

  if (ok.length >= 2) {
    const prev = ok[ok.length - 2];
    out.prevDate = prev.date;
    out.changePrevM = round(latest.levelM - prev.levelM);
  }

  for (const w of CHANGE_WINDOWS) {
    const ref = levelAt(ok, tLatest - w.days * DAY_MS, w.toleranceDays);
    out[w.field] = ref == null ? null : round(latest.levelM - ref);
  }

  // Seasonal anomaly vs prior years at the same time of year. Prior years are counted as
  // seasons back from the latest pass (1 = about a year earlier), so a window that wraps
  // the new year is not counted as two years.
  const latestDoy = dayOfYear(tLatest);
  const sample = [];
  const years = new Set();
  for (const p of ok) {
    const t = Date.parse(p.time);
    const seasonsBack = Math.round((tLatest - t) / (365.25 * DAY_MS));
    if (seasonsBack < 1) continue;
    if (circularDoyDiff(dayOfYear(t), latestDoy) > SEASONAL_WINDOW_DAYS) continue;
    sample.push(p.levelM);
    years.add(seasonsBack);
  }
  if (years.size >= SEASONAL_MIN_PRIOR_YEARS) {
    const m = median(sample);
    const sigma = Math.max(1.4826 * mad(sample, m), SEASONAL_MIN_SIGMA_M);
    out.seasonalAnomalyM = round(latest.levelM - m);
    out.seasonalZ = round((latest.levelM - m) / sigma, 2);
  }

  // Record range.
  let min = Infinity, max = -Infinity;
  for (const p of ok) { if (p.levelM < min) min = p.levelM; if (p.levelM > max) max = p.levelM; }
  const recordStartMs = Date.parse(ok[0].time);
  const recordYears = (tLatest - recordStartMs) / (365.25 * DAY_MS);
  const range = max - min;
  out.recordMinM = round(min);
  out.recordMaxM = round(max);
  out.recordStart = ok[0].date;
  const rangeUsable = recordYears >= RECORD_MIN_YEARS && range >= RECORD_MIN_RANGE_M;
  if (rangeUsable) {
    out.percentOfRange = round((latest.levelM - min) / range * 100, 1);
    out.recordLow = latest.levelM === min;
    out.recordHigh = latest.levelM === max;
  }

  out.status = classifyStatus(out, range);

  // Sparkline series: last 36 months of ok passes, one point per UTC day (median).
  const cutoff = new Date(tLatest);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - SERIES_MONTHS);
  const perDay = new Map();
  for (const p of ok) {
    if (Date.parse(p.time) < cutoff.getTime()) continue;
    const arr = perDay.get(p.date) || [];
    arr.push(p.levelM);
    perDay.set(p.date, arr);
  }
  out.series = [...perDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([d, v]) => [d, round(median(v))]);
  return out;
}

export function classifyStatus(m, range) {
  if (!m.latest) return 'insufficient_history';
  if (m.latest.ageDays > NO_RECENT_DATA_DAYS) return 'no_recent_data';
  if (m.recordLow) return 'record_low';
  if (m.recordHigh) return 'record_high';
  const fast = Math.max(FAST_CHANGE_MIN_M, FAST_CHANGE_RANGE_FRACTION * (Number.isFinite(range) ? range : 0));
  if (m.change90dM != null && m.change90dM <= -fast) return 'falling_fast';
  if (m.change90dM != null && m.change90dM >= fast) return 'rising_fast';
  if ((m.percentOfRange != null && m.percentOfRange <= LOW_PERCENT) || (m.seasonalZ != null && m.seasonalZ <= -SEASONAL_Z_ALERT)) return 'low';
  if ((m.percentOfRange != null && m.percentOfRange >= HIGH_PERCENT) || (m.seasonalZ != null && m.seasonalZ >= SEASONAL_Z_ALERT)) return 'high';
  if (m.percentOfRange == null && m.seasonalZ == null) return 'insufficient_history';
  return 'normal';
}

/** Summary counts for one reservoir's classified passes (backfill --report). */
export function cadenceReport(classified) {
  const ok = classified.filter((p) => p.ok);
  const days = [...new Set(ok.map((p) => p.date))].sort();
  const gaps = days.slice(1).map((d, i) => (Date.parse(d) - Date.parse(days[i])) / DAY_MS);
  const spanYears = days.length >= 2 ? (Date.parse(days[days.length - 1]) - Date.parse(days[0])) / (365.25 * DAY_MS) : 0;
  const perYear = {};
  for (const p of ok) perYear[p.date.slice(0, 4)] = (perYear[p.date.slice(0, 4)] || 0) + 1;
  return {
    passes: classified.length,
    ok: ok.length,
    passesPerYear: spanYears > 0 ? round(ok.length / spanYears, 1) : null,
    medianGapDays: gaps.length ? median(gaps) : null,
    maxGapDays: gaps.length ? Math.max(...gaps) : null,
    first: days[0] ?? null,
    last: days[days.length - 1] ?? null,
    medianMadM: ok.length ? round(median(ok.map((p) => p.madM))) : null,
    despiked: classified.filter((p) => p.spike).length,
    perYear,
    yearsWithSixPlus: Object.values(perYear).filter((n) => n >= 6).length,
  };
}
