#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed, readCanonicalValue, httpRetryError } from './_seed-utils.mjs';
loadEnvFile(import.meta.url);

const AAII_KEY = 'market:aaii-sentiment:v1';
const AAII_TTL = 604800; // 7 days (weekly data)

const AAII_HTML_URL = 'https://www.aaii.com/sentimentsurvey';

const CFB_MAGIC = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
const CFB_END_OF_CHAIN = 0xFFFFFFFE;
// sentiment.xls is ~1.3 MB and grows by roughly 20 KB a year; refuse anything far larger.
const MAX_XLS_BYTES = 32 * 1024 * 1024;

// Read the Workbook stream out of an OLE2 compound file. The stream's sectors
// follow the FAT chain and are not contiguous, so BIFF records cannot be
// scanned from the start of the file.
function readWorkbookStream(bytes) {
  if (bytes.length < 512 || bytes.length > MAX_XLS_BYTES || CFB_MAGIC.some((b, j) => bytes[j] !== b)) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sectorSize = 1 << dv.getUint16(0x1E, true);
  const numFatSectors = dv.getUint32(0x2C, true);
  const firstDirSector = dv.getUint32(0x30, true);
  const miniCutoff = dv.getUint32(0x38, true);
  let difatSector = dv.getUint32(0x44, true);
  const sectorOffset = (n) => (n + 1) * sectorSize;

  // Header fields come from the download; a file cannot hold more sectors than
  // its length allows, so bound the FAT and the DIFAT walk by that (a DIFAT
  // sector that points at itself would otherwise expand without limit).
  const maxSectors = Math.floor(bytes.length / sectorSize);
  const fatSectorCount = Math.min(numFatSectors, maxSectors);
  const fatSectors = [];
  for (let j = 0; j < 109 && fatSectors.length < fatSectorCount; j++) fatSectors.push(dv.getUint32(0x4C + j * 4, true));
  const perDifat = sectorSize / 4 - 1;
  for (let guard = 0; fatSectors.length < fatSectorCount && difatSector < CFB_END_OF_CHAIN && guard < maxSectors; guard++) {
    const off = sectorOffset(difatSector);
    if (off + sectorSize > bytes.length) return null;
    for (let j = 0; j < perDifat && fatSectors.length < fatSectorCount; j++) fatSectors.push(dv.getUint32(off + j * 4, true));
    difatSector = dv.getUint32(off + perDifat * 4, true);
  }

  const fat = [];
  for (const fs of fatSectors) {
    const off = sectorOffset(fs);
    if (off + sectorSize > bytes.length) return null;
    for (let j = 0; j < sectorSize; j += 4) fat.push(dv.getUint32(off + j, true));
  }

  const readChain = (start, size) => {
    if (size > bytes.length) return null; // a stream cannot be larger than the file holding it
    const out = new Uint8Array(size);
    let written = 0;
    for (let sec = start, guard = 0; sec < CFB_END_OF_CHAIN && written < size && guard <= fat.length; sec = fat[sec], guard++) {
      const off = sectorOffset(sec);
      const n = Math.min(sectorSize, size - written, bytes.length - off);
      if (n <= 0) return null;
      out.set(bytes.subarray(off, off + n), written);
      written += n;
    }
    return written === size ? out : null;
  };

  // Directory entries are 128 bytes; walk the directory chain until the end.
  const dirBytes = [];
  for (let sec = firstDirSector, guard = 0; sec < CFB_END_OF_CHAIN && guard <= fat.length; sec = fat[sec], guard++) {
    const off = sectorOffset(sec);
    if (off + sectorSize > bytes.length) return null;
    dirBytes.push(bytes.subarray(off, off + sectorSize));
  }
  for (const chunk of dirBytes) {
    const cdv = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    for (let e = 0; e + 128 <= chunk.length; e += 128) {
      const nameLen = cdv.getUint16(e + 0x40, true);
      const type = chunk[e + 0x42];
      if (type !== 2 || nameLen < 2 || nameLen > 64) continue;
      let name = '';
      for (let j = 0; j < nameLen / 2 - 1; j++) name += String.fromCharCode(cdv.getUint16(e + j * 2, true));
      if (name !== 'Workbook' && name !== 'Book') continue;
      const start = cdv.getUint32(e + 0x74, true);
      const size = cdv.getUint32(e + 0x78, true);
      // A workbook below the mini-stream cutoff (4 KB) cannot hold the survey history.
      if (size < miniCutoff) return null;
      return readChain(start, size);
    }
  }
  return null;
}

function decodeRk(rk) {
  let val;
  if (rk & 0x02) {
    val = rk >> 2;
  } else {
    const view = new DataView(new ArrayBuffer(8));
    view.setInt32(4, rk & 0xFFFFFFFC, true);
    val = view.getFloat64(0, true);
  }
  return rk & 0x01 ? val / 100 : val;
}

// Parse the shared string table. Strings can cross CONTINUE record boundaries;
// a string that does restarts with a fresh option byte (BIFF8 spec 2.5.293).
function parseSst(segments) {
  const strings = [];
  let seg = 0;
  let pos = 8; // skip cstTotal / cstUnique
  const remaining = () => segments[seg].length - pos;
  const advanceIfDone = () => {
    while (seg < segments.length && pos >= segments[seg].length) { seg++; pos = 0; }
    return seg < segments.length;
  };
  const readBytes = (n) => {
    let out = 0;
    for (let k = 0; k < n; k++) {
      if (!advanceIfDone()) return null;
      out |= segments[seg][pos++] << (8 * k);
    }
    return out >>> 0;
  };
  const skip = (n) => {
    while (n > 0) {
      if (!advanceIfDone()) return false;
      const step = Math.min(n, remaining());
      pos += step;
      n -= step;
    }
    return true;
  };

  while (advanceIfDone()) {
    const cch = readBytes(2);
    let flags = readBytes(1);
    if (cch == null || flags == null) break;
    const cRun = flags & 0x08 ? readBytes(2) : 0;
    const cbExtRst = flags & 0x04 ? readBytes(4) : 0;
    let s = '';
    let left = cch;
    while (left > 0) {
      if (!advanceIfDone()) return strings;
      if (pos === 0 && s.length > 0) flags = segments[seg][pos++]; // continuation option byte
      const wide = flags & 0x01;
      const fit = Math.min(left, Math.floor(remaining() / (wide ? 2 : 1)));
      if (fit <= 0) { pos = segments[seg].length; continue; }
      for (let j = 0; j < fit; j++) {
        s += String.fromCharCode(wide ? segments[seg][pos] | (segments[seg][pos + 1] << 8) : segments[seg][pos]);
        pos += wide ? 2 : 1;
      }
      left -= fit;
      if (left > 0 && remaining() === 0) { seg++; pos = 0; }
    }
    strings.push(s);
    if (!skip(4 * cRun + cbExtRst)) break;
  }
  return strings;
}

// Returns the cell grid (first 10 columns) of the worksheet that carries the
// Bullish/Bearish header, or of the first worksheet when none does.
export function parseXlsRows(buffer) {
  const stream = readWorkbookStream(new Uint8Array(buffer));
  if (!stream) return [];
  const sdv = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);

  const sstSegments = [];
  let inSst = false;
  const sheets = [];
  let current = null;
  for (let i = 0; i + 4 <= stream.length;) {
    const recType = sdv.getUint16(i, true);
    const recLen = sdv.getUint16(i + 2, true);
    const p = i + 4;
    if (p + recLen > stream.length) break;
    const rec = stream.subarray(p, p + recLen);
    i = p + recLen;

    if (recType === 0x003C && inSst) { sstSegments.push(rec); continue; } // CONTINUE
    inSst = false;

    if (recType === 0x0809) { // BOF
      current = recLen >= 4 && sdv.getUint16(p + 2, true) === 0x0010 ? new Map() : null;
      if (current) sheets.push(current);
      continue;
    }
    if (recType === 0x000A) { current = null; continue; } // EOF
    if (recType === 0x00FC) { sstSegments.push(rec); inSst = true; continue; } // SST
    if (!current || recLen < 6) continue;

    const row = sdv.getUint16(p, true);
    const col = sdv.getUint16(p + 2, true);
    if (recType === 0x0203 && recLen >= 14) { // NUMBER
      current.set(`${row},${col}`, sdv.getFloat64(p + 6, true));
    } else if (recType === 0x027E && recLen >= 10) { // RK
      current.set(`${row},${col}`, decodeRk(sdv.getUint32(p + 6, true)));
    } else if (recType === 0x00BD && recLen >= 12) { // MULRK
      const n = (recLen - 6) / 6;
      for (let k = 0; k < n; k++) current.set(`${row},${col + k}`, decodeRk(sdv.getUint32(p + 4 + k * 6 + 2, true)));
    } else if (recType === 0x0006 && recLen >= 14) { // FORMULA: cached numeric result unless bytes 6-7 are 0xFFFF
      if (sdv.getUint16(p + 12, true) !== 0xFFFF) current.set(`${row},${col}`, sdv.getFloat64(p + 6, true));
    } else if (recType === 0x00FD && recLen >= 10) { // LABELSST
      current.set(`${row},${col}`, { sst: sdv.getUint32(p + 6, true) });
    }
  }

  const strings = sstSegments.length ? parseSst(sstSegments) : [];
  const resolve = (v) => (v && typeof v === 'object' ? strings[v.sst] ?? null : v);
  const hasHeader = (cells) => {
    for (const v of cells.values()) {
      const t = String(resolve(v) ?? '').toLowerCase().trim();
      if (t === 'bullish') return true;
    }
    return false;
  };
  const cells = sheets.find(hasHeader) ?? sheets[0];
  if (!cells || cells.size === 0) return [];

  let maxRow = 0, maxCol = 0;
  for (const key of cells.keys()) {
    const [r, c] = key.split(',').map(Number);
    if (r > maxRow) maxRow = r;
    if (c > maxCol) maxCol = c;
  }

  const rows = [];
  const colLimit = Math.min(maxCol + 1, 10);
  for (let r = 0; r <= maxRow; r++) {
    const row = [];
    for (let c = 0; c < colLimit; c++) row.push(resolve(cells.get(`${r},${c}`) ?? null));
    rows.push(row);
  }
  return rows;
}

export function excelDateToISO(serial) {
  if (typeof serial !== 'number' || serial < 1) return null;
  // Excel serial: 1 = Jan 1, 1900. Lotus 1-2-3 bug: serial 60 = fake Feb 29, 1900.
  // For serial > 59: real days from Jan 1, 1900 = serial - 2
  // For serial <= 59: real days from Jan 1, 1900 = serial - 1
  const daysFromJan1 = serial > 59 ? serial - 2 : serial - 1;
  const d = new Date(Date.UTC(1900, 0, 1 + daysFromJan1));
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function extractSentimentData(rows) {
  // Find header row containing "Bullish" / "Bearish" / "Neutral"
  let headerIdx = -1;
  let bullCol = -1, neutralCol = -1, bearCol = -1, dateCol = -1;

  // The sheet has multi-row headers; group labels such as "Bullish Average"
  // span rows above the real header, so require Bullish and Bearish on one row.
  for (let r = 0; r < Math.min(rows.length, 20); r++) {
    const labels = rows[r].map((v) => String(v ?? '').toLowerCase().trim());
    const bull = labels.indexOf('bullish');
    const bear = labels.indexOf('bearish');
    if (bull < 0 || bear < 0) continue;
    headerIdx = r;
    bullCol = bull;
    bearCol = bear;
    neutralCol = labels.indexOf('neutral');
    dateCol = 0; // date is always first column
    break;
  }

  if (headerIdx < 0 || bullCol < 0 || bearCol < 0) return [];

  const data = [];
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    const rawDate = row[dateCol];
    const bull = typeof row[bullCol] === 'number' ? row[bullCol] : null;
    const bear = typeof row[bearCol] === 'number' ? row[bearCol] : null;
    const neutral = neutralCol >= 0 && typeof row[neutralCol] === 'number' ? row[neutralCol] : null;

    if (bull == null || bear == null) continue;

    let date;
    if (typeof rawDate === 'number' && rawDate > 30000) {
      date = excelDateToISO(rawDate);
    } else if (typeof rawDate === 'string') {
      // Strict formats only: footer rows like "Max '01" or "Count '25" parse as dates in V8.
      // Build the date in UTC; new Date('1/2/2026') is local midnight and shifts east of UTC.
      const t = rawDate.trim();
      const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      const mdy = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      const [y, m, d] = iso ? [+iso[1], +iso[2], +iso[3]] : mdy ? [+mdy[3], +mdy[1], +mdy[2]] : [];
      if (y) {
        const parsed = new Date(Date.UTC(y, m - 1, d));
        if (parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d) date = parsed.toISOString().slice(0, 10);
      }
    }
    if (!date) continue;

    // Convert fractions to percentages if needed
    const bullPct = bull > 1 ? bull : bull * 100;
    const bearPct = bear > 1 ? bear : bear * 100;
    const neutralPct = neutral != null ? (neutral > 1 ? neutral : neutral * 100) : +(100 - bullPct - bearPct).toFixed(1);
    const spread = +(bullPct - bearPct).toFixed(1);

    data.push({
      date,
      bullish: +bullPct.toFixed(1),
      bearish: +bearPct.toFixed(1),
      neutral: +neutralPct.toFixed(1),
      spread,
    });
  }

  // Sort by date descending (most recent first)
  data.sort((a, b) => b.date.localeCompare(a.date));
  return data;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function mostRecentThursdayUTC(now = new Date()) {
  // UTC arithmetic: local-TZ math can drift by a day on Railway when TZ != UTC
  const dayOfWeek = now.getUTCDay();
  const daysToThursday = (dayOfWeek >= 4) ? dayOfWeek - 4 : dayOfWeek + 3;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysToThursday)).toISOString().slice(0, 10);
}

// AAII reports each week on the Thursday after the survey week closes, which is
// the date the XLS uses; map "Week ending October 21, 2026" to that Thursday.
function reportedDateFromWeekEnding(html) {
  const m = html.match(/Week ending\s+([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/i);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].toLowerCase());
  if (month < 0) return null;
  const end = new Date(Date.UTC(+m[3], month, +m[2]));
  if (end.getUTCFullYear() !== +m[3] || end.getUTCMonth() !== month || end.getUTCDate() !== +m[2]) return null;
  const daysToThursday = ((4 - end.getUTCDay() + 7) % 7) || 7;
  return new Date(end.getTime() + daysToThursday * 86400000).toISOString().slice(0, 10);
}

export function parseHtmlSentiment(html) {
  const rows = [];
  const date = reportedDateFromWeekEnding(html);
  if (!date) return rows;

  // Current page: <div class="ssv2-snum bull">36.9%</div>, one per bull/neut/bear.
  const byClass = {};
  for (const m of html.matchAll(/class="ssv2-snum\s+(bull|neut|bear)"[^>]*>\s*([\d.]+)%/g)) {
    byClass[m[1]] ??= parseFloat(m[2]);
  }
  if (byClass.bull != null && byClass.neut != null && byClass.bear != null) {
    rows.push({
      date,
      bullish: byClass.bull,
      neutral: byClass.neut,
      bearish: byClass.bear,
      spread: +(byClass.bull - byClass.bear).toFixed(1),
    });
    return rows;
  }

  // Pre-2026-10 page: tableTxt cells in Bullish, Neutral, Bearish order.
  const pcts = [...html.matchAll(/<td[^>]*class="tableTxt"[^>]*>([\d.]+)%/g)]
    .map(m => parseFloat(m[1]));

  if (pcts.length >= 3) {
    rows.push({
      date,
      bullish: pcts[0],
      neutral: pcts[1],
      bearish: pcts[2],
      spread: +(pcts[0] - pcts[2]).toFixed(1),
    });
  }
  return rows;
}

async function fetchAaiiSentiment({ fetchDeadlineAtMs }) {
  const retained = await readCanonicalValue(AAII_KEY, { strict: true });
  if (Date.now() >= fetchDeadlineAtMs) {
    throw Object.assign(new Error('AAII fetch deadline reached'), { nonRetryable: true });
  }
  let data = [];
  // AAII robots.txt disallows /files/*, including sentiment.xls.
  try {
    const resp = await fetch(AAII_HTML_URL, {
      redirect: 'error',
      headers: { 'User-Agent': CHROME_UA, Accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) {
      const err = httpRetryError(resp);
      const retryAfter = resp.headers.get('Retry-After');
      const seconds = Number(retryAfter);
      const retryAt = Date.parse(retryAfter);
      // AAII requires the full provider delay; the shared helper caps it at 60s.
      if (Number.isFinite(seconds) && seconds > 0) err.retryAfterMs = seconds * 1000;
      else if (Number.isFinite(retryAt)) err.retryAfterMs = Math.max(0, retryAt - Date.now());
      throw err;
    }
    data = parseHtmlSentiment(await resp.text());
  } catch (e) {
    // AAII's crawl delay also applies to retries after transport failures.
    if (!e.nonRetryable) {
      e.retryAfterMs = Math.max(10_000, e.retryAfterMs ?? 0);
      if (e.retryAfterMs >= fetchDeadlineAtMs - Date.now()) {
        e.nonRetryable = true;
        e.message += ': required retry delay exceeds the remaining AAII fetch budget';
      }
    }
    throw e;
  }

  if (data.length === 0) {
    throw Object.assign(new Error('AAII sources returned no usable sentiment rows'), { nonRetryable: true });
  }

  if (data[0].date !== mostRecentThursdayUTC() || !isValidWeek(data[0])) {
    throw Object.assign(new Error('AAII HTML has no valid current source-dated reading'), { nonRetryable: true });
  }

  const priorWeeks = retained?.fallback === false && ['html', 'xls'].includes(retained.source) ? retained.weeks : [];
  if (!Array.isArray(priorWeeks) || priorWeeks.some(w => !isValidWeek(w) || w.date > data[0].date)) {
    throw Object.assign(new Error('AAII retained history is invalid or newer than the live source'), { nonRetryable: true });
  }
  const byDate = new Map(priorWeeks.map(w => [w.date, w]));
  for (const week of data) byDate.set(week.date, week);
  const weeks = [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 52);
  const latest = weeks[0];
  const prev = weeks.length > 1 ? weeks[1] : null;
  const historicalAvg = { bullish: 37.5, bearish: 31.0, neutral: 31.5 };

  // Compute rolling averages
  const last8 = weeks.slice(0, 8);
  const avg8w = last8.length > 0 ? {
    bullish: +(last8.reduce((s, w) => s + w.bullish, 0) / last8.length).toFixed(1),
    bearish: +(last8.reduce((s, w) => s + w.bearish, 0) / last8.length).toFixed(1),
    neutral: +(last8.reduce((s, w) => s + w.neutral, 0) / last8.length).toFixed(1),
    spread: +(last8.reduce((s, w) => s + w.spread, 0) / last8.length).toFixed(1),
  } : null;

  const extremeSpreads = weeks.filter(w => w.spread <= -20).length;
  const bullishExtremes = weeks.filter(w => w.bullish >= 50).length;
  const bearishExtremes = weeks.filter(w => w.bearish >= 50).length;

  return {
    seededAt: new Date().toISOString(),
    fallback: false,
    source: 'html',
    latest,
    previous: prev,
    avg8w,
    historicalAvg,
    extremes: {
      spreadBelow20: extremeSpreads,
      bullishAbove50: bullishExtremes,
      bearishAbove50: bearishExtremes,
    },
    weeks,
  };
}

function isValidWeek(week) {
  if (!week || typeof week.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(week.date)) return false;
  const timestamp = Date.parse(week.date);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== week.date) return false;
  if (![week.bullish, week.neutral, week.bearish].every(n => Number.isFinite(n) && n >= 0 && n <= 100)) return false;
  return Number.isFinite(week.spread) && Math.abs(week.bullish + week.neutral + week.bearish - 100) <= 0.2
    && Math.abs(week.spread - (week.bullish - week.bearish)) <= 0.11;
}

function validate(data) {
  return data?.latest?.bullish != null && data?.weeks?.length > 0;
}

export function declareRecords(data) {
  return Array.isArray(data?.weeks) ? data.weeks.length : 0;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[\\/]/, ''));
if (isMain) {
  runSeed('market', 'aaii-sentiment', AAII_KEY, fetchAaiiSentiment, {
    validateFn: validate,
    ttlSeconds: AAII_TTL,
    extendTtlOnFailure: false,
    recordCount: (data) => data?.weeks?.length ?? 0,
    sourceVersion: 'aaii-html-retained-v2',
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 20160,
  }).catch((err) => {
    console.error('FATAL:', err.message || err);
    process.exit(1);
  });
}
