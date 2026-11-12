// Strategic reservoir water levels from NASA ICESat-2 lidar: ATL13 (inland water surface
// height) by default, ATL06 (land ice height) for water bodies ATL13 covers poorly.
//
// Pure helpers shared by the daily seeder (seed-reservoir-levels.mjs) and the offline
// backfill (backfill-reservoir-levels.mjs). The only I/O is through an injected fetch.
//
// Data path (keyless):
//   1. NASA CMR lists ATL13 (or ATL06) v007 granules that intersect a reservoir's core box.
//   2. The public SlideRule Earth cluster subsets those granules to the core polygon
//      (POST /source/atl13x or /source/atl06x): ATL13 native dataframe columns preserve
//      segment RGT; ATL06 uses CSV output inside native records.
//   3. Segments are reduced to one robust level per overpass (UTC date + reference ground
//      track), filtered, despiked, and turned into change metrics.
//
// Levels are orthometric water-surface heights in metres above the EGM2008 geoid: ATL13
// `ht_ortho`, or ATL06 `h_li - geoid_h`. They are lake levels, not storage volumes.
//
// ATL06 has no water mask, so every land segment inside the box arrives too. Its passes are
// reduced to the lowest flat cluster of heights first (lowestCluster): a water surface is
// the lowest flat surface in a box drawn over the lake. The rest of the pipeline is shared.

import { CHROME_UA, withRetry } from './_seed-utils.mjs';

export const CMR_GRANULES_URL = 'https://cmr.earthdata.nasa.gov/search/granules.json';
export const SLIDERULE_ATL13_URL = 'https://sliderule.slideruleearth.io/source/atl13x';
export const SLIDERULE_ATL06_URL = 'https://sliderule.slideruleearth.io/source/atl06x';
export const MISSION_START_ISO = '2018-10-01';
export const ATL13_VERSION = '007';
export const ATL06_VERSION = '007';
// Single-resource responses keep segment columns separate from granule metadata.
// The v5.8 proxy cannot merge an ancillary rgt column with its metadata rgt.
export const SLIDERULE_BATCH_SIZE = 1;
// ATL06 returns every land segment in the box as well as the water: about 10x the rows of
// ATL13 for the same box. Smaller batches bound the per-batch row buffer.
export const SLIDERULE_ATL06_BATCH_SIZE = 5;
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
export const UNTRUSTED_TRACK_MIN_SPIKES = 2;

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

// ATL06 lowest-cluster rule. ATL06 has no water mask: the box returns land as well as
// water, and a falling reservoir exposes its bed inside the box. A water surface is the
// lowest flat surface in a box drawn over the lake, so:
//   1. Keep segments with atl06_quality_summary == ATL06_GOOD_QUALITY whose along-track
//      slope |dh_fit_dx| is at most ATL06_MAX_SLOPE. On Lake Mead and Ataturk 94-97% of
//      water segments pass it. Without it, thousands of hillside segments fill every
//      height gap and chain the water into one cluster 100-300 m tall: in the first
//      cross-check 41 of 77 Lake Mead passes and 50 of 66 Ataturk passes came out with a
//      MAD above 1 m.
//   2. Sort the heights, split them wherever consecutive heights differ by more than
//      ATL06_CLUSTER_GAP_M, and read the pass from the lowest cluster holding at least
//      max(ATL06_CLUSTER_MIN_POINTS, ATL06_CLUSTER_MIN_FRACTION of the kept segments).
//      Smaller low clusters are noise (a canal, a stray low return) and are skipped.
// The cluster then goes through the same pass statistics and quality rules as ATL13.
export const ATL06_MAX_SLOPE = 0.01;
export const ATL06_CLUSTER_GAP_M = 0.5;
export const ATL06_CLUSTER_MIN_POINTS = 5;
export const ATL06_CLUSTER_MIN_FRACTION = 0.1;
export const ATL06_GOOD_QUALITY = 0;

const GRANULE_RE = /ATL(?:06|13)_\d{14}_\d{8}_\d{3}_\d{2}\.h5/g;
const GRANULE_EXACT_RE = /^(ATL(?:06|13))_(\d{14})_(\d{8})_(\d{3})_(\d{2})\.h5$/;

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
  const t = m[2];
  return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
}

/** Orbit identity without the release revision (`_01`, `_02`). */
export function granuleBase(name) {
  const m = GRANULE_EXACT_RE.exec(name);
  return m ? `${m[1]}_${m[2]}_${m[3]}_${m[4]}` : null;
}

/** Release revision of a granule name (`_01` -> 1, `_02` -> 2), or null. */
export function granuleRevision(name) {
  const m = GRANULE_EXACT_RE.exec(name);
  return m ? Number(m[5]) : null;
}

/** Reference ground track encoded in a granule name (`_RRRRCCSS_`), or null. */
export function granuleRgt(name) {
  const m = GRANULE_EXACT_RE.exec(name);
  return m ? Number(m[3].slice(0, 4)) : null;
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
// Products
// ---------------------------------------------------------------------------

/**
 * Per-product request and row handling. A watchlist entry picks one with `product`
 * ("atl13" when absent). `slim` keeps only the columns the reduction reads (null drops the
 * row) and `height` turns a slim or raw CSV row into metres above EGM2008.
 */
export const PRODUCTS = Object.freeze({
  atl13: Object.freeze({
    id: 'atl13',
    shortName: 'ATL13',
    version: ATL13_VERSION,
    url: SLIDERULE_ATL13_URL,
    batchSize: SLIDERULE_BATCH_SIZE,
    parms: (poly, resources) => ({
      resource: resources[0],
      key_space: 0,
      parms: { poly, atl13: { anc_fields: ['atl13refid', 'rgt'] } },
    }),
    slim: (r) => ({ time_ns: r.time_ns, rgt: r.rgt, gt: r.gt, ht_ortho: r.ht_ortho, atl13refid: r.atl13refid, sourceRgt: r.sourceRgt }),
    height: (r) => csvNumber(r.ht_ortho),
  }),
  atl06: Object.freeze({
    id: 'atl06',
    shortName: 'ATL06',
    version: ATL06_VERSION,
    url: SLIDERULE_ATL06_URL,
    batchSize: SLIDERULE_ATL06_BATCH_SIZE,
    parms: (poly, resources) => ({
      poly,
      resources,
      atl06_fields: ['dem/geoid_h'],
      output: { path: 'atl06.csv', format: 'csv', open_on_complete: false },
    }),
    // Quality and slope are filtered here so rejected land segments are never buffered.
    slim: (r) => (atl06SegmentOk(r)
      ? { time_ns: r.time_ns, rgt: r.rgt, gt: r.gt, ht_ortho: String(atl06OrthoHeight(r)) }
      : null),
    height: (r) => (r.ht_ortho != null ? csvNumber(r.ht_ortho) : (atl06SegmentOk(r) ? atl06OrthoHeight(r) : NaN)),
  }),
});

export const DEFAULT_PRODUCT = 'atl13';

/** The product config for a watchlist entry, or for a product id. Throws on an unknown id. */
export function productOf(entryOrId) {
  const id = typeof entryOrId === 'string' ? entryOrId : (entryOrId?.product ?? DEFAULT_PRODUCT);
  const p = PRODUCTS[id];
  if (!p) throw new Error(`unknown reservoir product ${id}`);
  return p;
}

// A CSV field as a number; an empty or missing field is NaN, never 0 (Number('') is 0, which
// would pass the slope guard or turn an absent geoid into an ellipsoidal height).
function csvNumber(v) {
  if (v == null) return NaN;
  const t = String(v).trim();
  return t === '' ? NaN : Number(t);
}

/** ATL06 segment filter: good quality flag and a flat along-track fit (see ATL06_MAX_SLOPE). */
function atl06SegmentOk(r) {
  if (csvNumber(r.atl06_quality_summary) !== ATL06_GOOD_QUALITY) return false;
  const slope = Math.abs(csvNumber(r.dh_fit_dx));
  return Number.isFinite(slope) && slope <= ATL06_MAX_SLOPE;
}

// h_li is the height above the WGS84 ellipsoid; dem/geoid_h is the EGM2008 geoid height
// above the same ellipsoid, so the difference is the orthometric height ATL13 reports as
// ht_ortho. Sign and datum confirmed against ATL13 and the USBR Mead gauge
// (tests/reservoir-levels-atl06-crosscheck.test.mjs).
function atl06OrthoHeight(r) {
  const h = csvNumber(r.h_li);
  const geoid = csvNumber(r['dem/geoid_h'] ?? r.geoid_h);
  return Number.isFinite(h) && Number.isFinite(geoid) ? h - geoid : NaN;
}

// ---------------------------------------------------------------------------
// CMR granule discovery
// ---------------------------------------------------------------------------

/**
 * List ATL13 (or opts.product) granules intersecting `bbox` ([W,S,E,N]) with start time
 * >= sinceIso. Paginates with CMR-Search-After. Returns deduplicated granule names, oldest
 * first.
 */
export async function listGranules(bbox, sinceIso, fetchImpl = (...a) => globalThis.fetch(...a), opts = {}) {
  const { untilIso = null, retries = 3, retryDelayMs = 2000, maxPages = 20, timeoutMs = CMR_TIMEOUT_MS, product = DEFAULT_PRODUCT } = opts;
  const prod = productOf(product);
  const temporal = `${sinceIso.length === 10 ? `${sinceIso}T00:00:00Z` : sinceIso},${untilIso ?? ''}`;
  const params = new URLSearchParams({
    short_name: prod.shortName,
    version: prod.version,
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
      if (name && name.startsWith(`${prod.shortName}_`)) names.push(name);
    }
    if (entries.length < CMR_PAGE_SIZE || !next) break;
    searchAfter = next;
  }
  return dedupeGranules(names);
}

// ---------------------------------------------------------------------------
// SlideRule native record stream
// ---------------------------------------------------------------------------

// Ceilings on what the upstream stream may declare. Real records are file chunks of at
// most a few MB and CSV lines are under 200 bytes; anything far beyond means a corrupt
// or hostile stream, and failing the batch (retried next run, last-good kept) is safer
// than buffering it.
export const MAX_RECORD_BYTES = 64 * 1024 * 1024;
export const MAX_CSV_LINE_BYTES = 64 * 1024;

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
          if (header.typeSize < 0 || header.dataSize < 0 || need > MAX_RECORD_BYTES) {
            throw new Error(`SlideRule record size out of range (type ${header.typeSize}, data ${header.dataSize})`);
          }
          if (need === 0) { header = null; need = 8; }
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
      if (tail.length > MAX_CSV_LINE_BYTES) throw new Error(`SlideRule CSV line exceeds ${MAX_CSV_LINE_BYTES} bytes`);
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
 * Stream one SlideRule request (atl13x or atl06x at `url`) and feed CSV rows to onRow.
 * Returns { rows, fileSize, csvBytes, gotEof, events }.
 */
export async function streamSlideRuleRequest(url, parms, onRow, fetchImpl, { timeoutMs = SLIDERULE_BATCH_TIMEOUT_MS } = {}) {
  const res = await fetchImpl(url, {
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

/** Read ATL13's segment RGT without the v5.8 proxy's metadata/column collision.
 * Wire layout: SlideRule GeoDataFrame.h, geodataframe record, 160-byte header.
 * Only the four required columns and beam metadata are retained. No rows escape
 * until all six beam EOFs and the complete native record stream are verified.
 */
export async function streamAtl13Request(poly, resource, onRow, fetchImpl, { timeoutMs = SLIDERULE_BATCH_TIMEOUT_MS } = {}) {
  const res = await fetchImpl(SLIDERULE_ATL13_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': CHROME_UA },
    body: JSON.stringify(PRODUCTS.atl13.parms(poly, [resource])),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`SlideRule HTTP ${res.status}`);
  const ctype = res.headers?.get('content-type');
  if (ctype && !ctype.startsWith('application/octet-stream')) throw new Error(`SlideRule unexpected content-type ${ctype}`);
  const frames = new Map();
  const events = [];
  const columns = {
    time_ns: [11, 8, (b, i) => b.readBigInt64LE(i).toString()],
    rgt: [1, 2, (b, i) => b.readInt16LE(i)],
    ht_ortho: [9, 4, (b, i) => b.readFloatLE(i)],
    atl13refid: [3, 8, (b, i) => b.readBigInt64LE(i).toString()],
  };
  const parser = createRecordParser((type, d) => {
    if (type !== 'geodataframe') {
      const ev = decodeEventRecord(type, d);
      if (ev) events.push(ev);
      return;
    }
    if (d.length < 160) throw new Error('short ATL13 dataframe header');
    const key = d.readBigUInt64LE(0).toString();
    let f = frames.get(key);
    if (!f) frames.set(key, (f = { columns: {}, done: false }));
    if (f.done) throw new Error('ATL13 data after beam EOF');
    const kind = d.readUInt32LE(16);
    const size = d.readUInt32LE(20);
    const encoding = d.readUInt32LE(24) & 0xFFFF;
    const n = d.readUInt32LE(28);
    const name = cstr(d.subarray(32, 160));
    if (kind === 3) {
      // EOF appends a uint32 column count after the header, with size still zero.
      if (size !== 0 || d.length !== 164) throw new Error('invalid ATL13 beam EOF');
      f.done = true;
      f.n = n;
      return;
    }
    if (kind === 0 && Object.hasOwn(columns, name)) {
      const [code, width, read] = columns[name];
      if (encoding !== code || size !== n * width || d.length !== 160 + size || f.columns[name]) throw new Error(`invalid ATL13 column ${name}`);
      f.columns[name] = Array.from({ length: n }, (_, i) => read(d, 160 + i * width));
    } else if (kind === 1 && name === 'gt') {
      if (encoding !== 4 || size !== 1 || d.length !== 161) throw new Error('invalid ATL13 beam');
      f.gt = d.readUInt8(160);
    }
  });
  for await (const chunk of res.body) parser.push(chunk);
  parser.end();
  // A readable stream can report a source-granule failure. Keep that distinct
  // from a transport/protocol outage so the seeder can persist its retry count.
  if (failedGranulesFromEvents(events).includes(resource)) return { rows: 0, fileSize: 0, csvBytes: 0, gotEof: true, events };
  if (frames.size !== 6 || [...frames.values()].some(f => !f.done)) throw new Error('incomplete ATL13 beam response');
  const error = events.find(e => e.level >= EVENT_ERROR_LEVEL || e.code < 0);
  if (error) throw new Error(error.msg);
  for (const f of frames.values()) {
    if (Object.values(f.columns).some(values => values.length !== f.n)) throw new Error('invalid ATL13 beam row count');
    if (!f.n) continue;
    if (f.gt == null || Object.keys(columns).some(name => !f.columns[name])) throw new Error('missing ATL13 segment column');
    if (f.columns.rgt.some(rgt => rgt < 1 || rgt > 1387)) throw new Error('invalid ATL13 segment RGT');
  }
  const sourceRgt = granuleRgt(resource);
  let rows = 0;
  for (const f of frames.values()) {
    for (let i = 0; i < f.n; i++) {
      onRow({ time_ns: f.columns.time_ns[i], rgt: f.columns.rgt[i], gt: f.gt, ht_ortho: f.columns.ht_ortho[i], atl13refid: f.columns.atl13refid[i], sourceRgt });
      rows++;
    }
  }
  return { rows, fileSize: 0, csvBytes: 0, gotEof: true, events };
}

const EMPTY_SELECTION_RE = /no resources to process|received 0 x 0 dataframe|produced an empty dataframe|invalid dataframe/i;

/**
 * Fetch segments of opts.product (ATL13 by default) for `granules` inside `poly`, in
 * batches of the product's batch size. Rows go to onRow(slimRow, granuleBatch); the slim
 * row keeps only the columns the reduction reads, to bound memory while a batch is
 * buffered (ATL06 rows that fail the quality flag are dropped there). Never throws for upstream failures: returns
 * { processed: [...granules that completed], failed: [...granules to retry],
 * skipped: [...granules not attempted because deadlineAtMs passed], rows, errors,
 * okBatches, failedBatches }. A batch whose request completed counts as ok even when some
 * of its granules failed server-side: the service was reachable.
 * A whole-request failure marks every granule in that batch failed; a per-granule error
 * event marks only that granule failed and keeps the rest of the batch.
 */
export async function fetchSegments(poly, granules, onRow, fetchImpl = (...a) => globalThis.fetch(...a), opts = {}) {
  const prod = productOf(opts.product ?? DEFAULT_PRODUCT);
  const {
    batchSize: requestedBatchSize = prod.batchSize,
    timeoutMs = SLIDERULE_BATCH_TIMEOUT_MS,
    deadlineAtMs = Infinity,
    log = () => {},
  } = opts;
  const batchSize = prod.id === 'atl13' ? 1 : requestedBatchSize;
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
    // Rows are buffered per batch so a batch that dies mid-stream contributes nothing:
    // a half-delivered pass would otherwise be stored as if complete.
    const batchRows = [];
    try {
      const collect = (row) => {
        const slim = prod.slim(row);
        if (slim) batchRows.push(slim);
      };
      const streamOpts = {
        timeoutMs: Math.max(30_000, Math.min(timeoutMs, remainingMs)),
      };
      const r = prod.id === 'atl13'
        ? await streamAtl13Request(poly, batch[0], collect, fetchImpl, streamOpts)
        : await streamSlideRuleRequest(prod.url, prod.parms(poly, batch), collect, fetchImpl, streamOpts);
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
 * ATL13 water body (when the row carries `atl13refid`). With product 'atl06' the row height
 * is h_li - geoid_h (or the slim row's ht_ortho), and each pass is first cut down to its
 * lowest cluster (lowestCluster); a pass with no qualifying cluster is dropped.
 * Optional `levelWindow` [minM, maxM] (watchlist `levelWindowM`) drops segments outside the
 * heights the water surface can take. ATL06 needs it where a pass can miss the water and
 * cross only land: its lowest flat cluster is then a plateau hundreds of metres up (Gibe
 * III: 8 of 65 passes read 1142-1254 m, one of them the newest pass, against an observed
 * water range of 819-894 m).
 */
export function createPassAccumulator({ heightField = 'ht_ortho', refid = null, product = DEFAULT_PRODUCT, levelWindow = null } = {}) {
  const prod = productOf(product);
  const isAtl06 = prod.id === 'atl06';
  const groups = new Map();
  return {
    add(row) {
      if (refid != null && row.atl13refid != null && row.atl13refid !== '' && Number(row.atl13refid) !== refid) return;
      const h = isAtl06 ? prod.height(row) : csvNumber(row[heightField]);
      if (!Number.isFinite(h) || Math.abs(h) > ATL13_HEIGHT_FILL_LIMIT_M) return;
      if (levelWindow && (h < levelWindow[0] || h > levelWindow[1])) return;
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
      for (const g of groups.values()) {
        const surface = isAtl06 ? lowestClusterGroup(g) : g;
        if (surface) out.push(passStats(surface));
      }
      out.sort(comparePasses);
      return out;
    },
  };
}

/**
 * ATL06 lowest-cluster rule (see ATL06_CLUSTER_* above). Returns { lo, hi, count } of the
 * lowest cluster of sorted heights, split at gaps > gapM, that holds at least
 * max(minPoints, minFraction x heights.length) points; null when none does.
 */
export function lowestCluster(heights, {
  gapM = ATL06_CLUSTER_GAP_M,
  minPoints = ATL06_CLUSTER_MIN_POINTS,
  minFraction = ATL06_CLUSTER_MIN_FRACTION,
} = {}) {
  const s = heights.filter(Number.isFinite).sort((a, b) => a - b);
  const need = Math.max(minPoints, Math.ceil(minFraction * s.length));
  let start = 0;
  for (let i = 1; i <= s.length; i++) {
    if (i === s.length || s[i] - s[i - 1] > gapM) {
      if (i - start >= need) return { lo: s[start], hi: s[i - 1], count: i - start };
      start = i;
    }
  }
  return null;
}

function lowestClusterGroup(g) {
  const c = lowestCluster(g.h);
  if (!c) return null;
  const inside = (x) => x >= c.lo && x <= c.hi;
  const byBeam = new Map();
  for (const [beam, v] of g.byBeam) {
    const kept = v.filter(inside);
    if (kept.length) byBeam.set(beam, kept);
  }
  return { ...g, h: g.h.filter(inside), byBeam };
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

// Compact tuple storage: [timeIso, rgt, levelM, madM, n, beamSpreadM|null, revision?].
// The complete day's candidate-orbit revision sum is stored only when above 1, so the
// committed baseline keeps its six-element form.
export function passToTuple(p) {
  const t = [p.time, p.rgt, p.levelM, p.madM, p.n, p.beamSpreadM ?? null];
  if ((p.revision ?? 1) > 1) t.push(p.revision);
  return t;
}

export function tupleToPass(t) {
  const [time, rgt, levelM, madM, n, beamSpreadM, revision] = t;
  const iso = String(time);
  const date = iso.slice(0, 10);
  return { time: iso.length === 10 ? `${iso}T12:00Z` : iso, date, rgt: Number(rgt), levelM: Number(levelM), madM: Number(madM), n: Number(n), beamSpreadM: beamSpreadM == null ? null : Number(beamSpreadM), revision: revision == null ? 1 : Number(revision) };
}

/**
 * Merge new pass stats into a stored list. Keyed by UTC date + RGT. A higher complete-day
 * revision sum always wins: NASA reprocesses granules to correct them, so their values
 * replace the earlier ones whatever their segment count. Within one revision sum (the same
 * complete day re-processed) the record with more segments
 * wins, then lower deviation, then lower height, so merging is idempotent and
 * order-independent.
 */
export function mergePasses(existing, incoming) {
  const byKey = new Map();
  const better = (p, prev) => {
    const rp = p.revision ?? 1, rq = prev.revision ?? 1;
    if (rp !== rq) return rp > rq;
    return p.n > prev.n || (p.n === prev.n && (p.madM < prev.madM || (p.madM === prev.madM && p.levelM < prev.levelM)));
  };
  for (const p of [...existing, ...incoming]) {
    const k = passKey(p);
    const prev = byKey.get(k);
    if (!prev || better(p, prev)) byKey.set(k, p);
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
 *
 * `perGapDayM` (watchlist `despikePerGapDayM`) raises the per-day allowance for a reservoir
 * whose real level moves faster than 0.05 m/day between sparse passes. Gibe III moves up
 * to 0.55 m/day in the Omo flood and drops about 0.27 m/day in the dry season; at the
 * default rate 6 of its 60 passes, all real seasonal minima with agreeing beams, were
 * despiked and the record low read 847 m instead of 819 m.
 */
export function classifyPasses(passes, { perGapDayM = DESPIKE_PER_GAP_DAY_M } = {}) {
  const out = [...passes].sort(comparePasses).map((p) => ({ ...p, ok: passIsOk(p), spike: false }));
  const ok = out.filter((p) => p.ok);
  for (;;) {
    let worst = -1;
    let worstExcess = 0;
    for (let i = 1; i < ok.length - 1; i++) {
      const a = ok[i - 1], b = ok[i], c = ok[i + 1];
      const gapDays = Math.max(Date.parse(b.time) - Date.parse(a.time), Date.parse(c.time) - Date.parse(b.time)) / DAY_MS;
      const outside = Math.max(b.levelM - Math.max(a.levelM, c.levelM), Math.min(a.levelM, c.levelM) - b.levelM);
      const excess = outside - (DESPIKE_BASE_M + perGapDayM * gapDays);
      if (excess > worstExcess) { worstExcess = excess; worst = i; }
    }
    if (worst < 0) break;
    const [p] = ok.splice(worst, 1);
    p.ok = false;
    p.spike = true;
  }
  // The newest pass has one neighbour, so the rule above can never test it, and it is the
  // pass every headline metric reads. Ground tracks repeat: a track that clips a river arm
  // or an edge pool does so on every revisit. When at least half of a track's earlier
  // quality-passing passes over this water body were despiked (and at least
  // UNTRUSTED_TRACK_MIN_SPIKES of them), a newest pass from that track that departs from
  // its only neighbour by more than the despike limit is dropped too.
  while (ok.length >= 2) {
    const last = ok[ok.length - 1];
    const prev = ok[ok.length - 2];
    const sameTrack = out.filter((p) => p.rgt === last.rgt && p !== last && (p.ok || p.spike));
    const spikes = sameTrack.filter((p) => p.spike).length;
    if (spikes < UNTRUSTED_TRACK_MIN_SPIKES || spikes * 2 < sameTrack.length) break;
    const gapDays = (Date.parse(last.time) - Date.parse(prev.time)) / DAY_MS;
    if (Math.abs(last.levelM - prev.levelM) <= DESPIKE_BASE_M + perGapDayM * gapDays) break;
    ok.pop();
    last.ok = false;
    last.spike = true;
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
 * Seasonal baseline at time tMs: the ok-pass levels from earlier seasons (1 = about a year
 * before tMs) whose day of year is within SEASONAL_WINDOW_DAYS of tMs. Returns null unless
 * SEASONAL_MIN_PRIOR_YEARS distinct earlier seasons contribute. Counting seasons back from
 * tMs keeps a window that wraps the new year from counting as two years.
 */
export function seasonalBaseline(okPasses, tMs) {
  const doy = dayOfYear(tMs);
  const sample = [];
  const seasons = new Set();
  for (const p of okPasses) {
    const t = Date.parse(p.time);
    const seasonsBack = Math.round((tMs - t) / (365.25 * DAY_MS));
    if (seasonsBack < 1) continue;
    if (circularDoyDiff(dayOfYear(t), doy) > SEASONAL_WINDOW_DAYS) continue;
    sample.push(p.levelM);
    seasons.add(seasonsBack);
  }
  if (seasons.size < SEASONAL_MIN_PRIOR_YEARS) return null;
  const m = median(sample);
  return { medianM: m, sigmaM: Math.max(1.4826 * mad(sample, m), SEASONAL_MIN_SIGMA_M) };
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
    seasonalAnomalyM: null, seasonalZ: null, change90dExcessM: null,
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

  // Seasonal anomaly vs earlier years at the same time of year.
  const baseline = seasonalBaseline(ok, tLatest);
  if (baseline) {
    out.seasonalAnomalyM = round(latest.levelM - baseline.medianM);
    out.seasonalZ = round((latest.levelM - baseline.medianM) / baseline.sigmaM, 2);
  }

  // 90-day change beyond the usual seasonal swing. A monsoon or snowmelt reservoir rises
  // tens of metres every year (Tarbela +29 m, Nurek +34 m in the 2026 baseline, both within
  // 1 m of their seasonal norm); only the part of the move the calendar does not explain is
  // a signal. Null when either end lacks a seasonal baseline.
  const t90 = tLatest - 90 * DAY_MS;
  const baseline90 = out.change90dM == null ? null : seasonalBaseline(ok, t90);
  if (baseline && baseline90) {
    out.change90dExcessM = round(out.change90dM - (baseline.medianM - baseline90.medianM));
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
  // Fast change: the level must have moved by the limit over 90 days and, where a seasonal
  // baseline exists, by the limit beyond the usual seasonal swing as well. Both are needed:
  // the raw move alone flags every monsoon fill, and the excess alone calls a reservoir that
  // rose 13 m "falling" because it usually rises 22 m. A reservoir with no seasonal baseline
  // (still filling) is judged on the raw move.
  const seasonal = m.seasonalZ != null;
  const raw = m.change90dM;
  const excess = m.change90dExcessM;
  if (raw != null && raw <= -fast && (!seasonal || (excess != null && excess <= -fast))) return 'falling_fast';
  if (raw != null && raw >= fast && (!seasonal || (excess != null && excess >= fast))) return 'rising_fast';
  // Low / high: the seasonal z-score decides when it exists. Percent of the record range
  // misreads a seasonal water body at its normal annual minimum (Tonle Sap in July sits at
  // 13% of range and 0.1 m from its seasonal norm), so it is the fallback only.
  if (m.seasonalZ != null) {
    if (m.seasonalZ <= -SEASONAL_Z_ALERT) return 'low';
    if (m.seasonalZ >= SEASONAL_Z_ALERT) return 'high';
    return 'normal';
  }
  if (m.percentOfRange != null && m.percentOfRange <= LOW_PERCENT) return 'low';
  if (m.percentOfRange != null && m.percentOfRange >= HIGH_PERCENT) return 'high';
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
