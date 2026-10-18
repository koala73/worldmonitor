#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';
loadEnvFile(import.meta.url);

const AAII_KEY = 'market:aaii-sentiment:v1';
const AAII_TTL = 604800; // 7 days (weekly data)

const AAII_XLS_URL = 'https://www.aaii.com/files/surveys/sentiment.xls';
const AAII_HTML_URL = 'https://www.aaii.com/sentimentsurvey';

export function parseXlsRows(buffer) {
  const rows = [];
  const bytes = new Uint8Array(buffer);
  const len = bytes.length;

  const strings = [];
  let i = 0;
  while (i < len - 4) {
    const recType = bytes[i] | (bytes[i + 1] << 8);
    const recLen = bytes[i + 2] | (bytes[i + 3] << 8);
    if (recLen > 100000 || recLen < 0) { i++; continue; }

    // SST record (shared string table)
    if (recType === 0x00FC && recLen > 8) {
      let pos = i + 4 + 8; // skip total/unique counts
      while (pos < i + 4 + recLen && strings.length < 10000) {
        if (pos + 3 > len) break;
        const charCount = bytes[pos] | (bytes[pos + 1] << 8);
        const flags = bytes[pos + 2];
        pos += 3;
        let cRun = 0;
        let cbExtRst = 0;
        if (flags & 0x08) {
          // rich text: cRun (u16) = number of formatting runs (4 bytes each) after char data
          cRun = bytes[pos] | (bytes[pos + 1] << 8);
          pos += 2;
        }
        if (flags & 0x04) {
          // extended string: cbExtRst (u32) = byte length of ext-rst block after char data
          cbExtRst = bytes[pos] | (bytes[pos + 1] << 8) | (bytes[pos + 2] << 16) | (bytes[pos + 3] << 24);
          pos += 4;
        }
        if (flags & 0x01) {
          // UTF-16
          const strBytes = charCount * 2;
          if (pos + strBytes > len) break;
          let s = '';
          for (let j = 0; j < charCount; j++) {
            s += String.fromCharCode(bytes[pos + j * 2] | (bytes[pos + j * 2 + 1] << 8));
          }
          strings.push(s);
          pos += strBytes;
        } else {
          if (pos + charCount > len) break;
          let s = '';
          for (let j = 0; j < charCount; j++) s += String.fromCharCode(bytes[pos + j]);
          strings.push(s);
          pos += charCount;
        }
        // Skip trailing formatting-run and ext-rst bytes (BIFF8 spec)
        if (flags & 0x08) pos += 4 * cRun;
        if (flags & 0x04) pos += cbExtRst;
      }
    }
    i += 4 + recLen;
  }

  // Extract NUMBER records (type 0x0203) and RK records (type 0x027E)
  // and LABEL/SST refs for dates
  const cells = new Map(); // "row,col" -> value
  i = 0;
  while (i < len - 4) {
    const recType = bytes[i] | (bytes[i + 1] << 8);
    const recLen = bytes[i + 2] | (bytes[i + 3] << 8);
    if (recLen > 100000 || recLen < 0) { i++; continue; }

    if (recType === 0x0203 && recLen >= 14) { // NUMBER
      const row = bytes[i + 4] | (bytes[i + 5] << 8);
      const col = bytes[i + 6] | (bytes[i + 7] << 8);
      const buf8 = new ArrayBuffer(8);
      const view = new DataView(buf8);
      for (let j = 0; j < 8; j++) view.setUint8(j, bytes[i + 10 + j]);
      const val = view.getFloat64(0, true);
      cells.set(`${row},${col}`, val);
    } else if (recType === 0x027E && recLen >= 10) { // RK
      const row = bytes[i + 4] | (bytes[i + 5] << 8);
      const col = bytes[i + 6] | (bytes[i + 7] << 8);
      const rkVal = bytes[i + 10] | (bytes[i + 11] << 8) | (bytes[i + 12] << 16) | (bytes[i + 13] << 24);
      let val;
      if (rkVal & 0x02) {
        val = (rkVal >> 2);
      } else {
        const buf8 = new ArrayBuffer(8);
        const view = new DataView(buf8);
        view.setInt32(4, rkVal & 0xFFFFFFFC, true);
        val = view.getFloat64(0, true);
      }
      if (rkVal & 0x01) val /= 100;
      cells.set(`${row},${col}`, val);
    } else if (recType === 0x00FD && recLen >= 10) { // LABELSST
      const row = bytes[i + 4] | (bytes[i + 5] << 8);
      const col = bytes[i + 6] | (bytes[i + 7] << 8);
      const sstIdx = bytes[i + 10] | (bytes[i + 11] << 8) | (bytes[i + 12] << 16) | (bytes[i + 13] << 24);
      if (sstIdx < strings.length) {
        cells.set(`${row},${col}`, strings[sstIdx]);
      }
    }
    i += 4 + recLen;
  }

  if (cells.size === 0) return rows;

  // Find max row/col
  let maxRow = 0, maxCol = 0;
  for (const key of cells.keys()) {
    const [r, c] = key.split(',').map(Number);
    if (r > maxRow) maxRow = r;
    if (c > maxCol) maxCol = c;
  }

  // Build row arrays (first 10 columns, first 2000 rows max)
  const limit = Math.min(maxRow + 1, 2000);
  const colLimit = Math.min(maxCol + 1, 10);
  for (let r = 0; r < limit; r++) {
    const row = [];
    for (let c = 0; c < colLimit; c++) {
      row.push(cells.get(`${r},${c}`) ?? null);
    }
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
  let bullCol = -1, neutralCol = -1, bearCol = -1, dateCol = -1, spreadCol = -1, sp500CloseCol = -1;

  for (let r = 0; r < Math.min(rows.length, 20); r++) {
    const row = rows[r];
    for (let c = 0; c < row.length; c++) {
      const v = String(row[c] ?? '').toLowerCase().trim();
      if (v === 'bullish') { bullCol = c; headerIdx = r; }
      if (v === 'neutral') { neutralCol = c; }
      if (v === 'bearish') { bearCol = c; }
      if (v.includes('bull-bear') || v.includes('spread')) { spreadCol = c; }
      if (v.includes('close') || v.includes('s&p') || v.includes('sp 500')) { sp500CloseCol = c; }
    }
    if (headerIdx === r) {
      dateCol = 0; // date is always first column
      break;
    }
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
      const parsed = new Date(rawDate);
      if (!Number.isNaN(parsed.getTime())) {
        date = parsed.toISOString().slice(0, 10);
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

export function parseHtmlSentiment(html) {
  const rows = [];
  // Match table rows with percentage data
  // The AAII page has tableTxt cells: Bullish%, Neutral%, Bearish%
  const pcts = [...html.matchAll(/<td[^>]*class="tableTxt"[^>]*>([\d.]+)%/g)]
    .map(m => parseFloat(m[1]));

  if (pcts.length >= 3) {
    // AAII publishes on Thursdays; find the most recent Thursday in UTC
    // (local-TZ arithmetic can drift by a day on Railway when TZ != UTC)
    const nowUTC = new Date();
    const dayOfWeek = nowUTC.getUTCDay();
    const daysToThursday = (dayOfWeek >= 4) ? dayOfWeek - 4 : dayOfWeek + 3;
    const tsThursday = Date.UTC(nowUTC.getUTCFullYear(), nowUTC.getUTCMonth(), nowUTC.getUTCDate() - daysToThursday);
    const date = new Date(tsThursday).toISOString().slice(0, 10);

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

async function fetchAaiiSentiment() {
  let data = [];
  let source;

  // Strategy 1: Fetch the XLS file and parse it
  try {
    console.log('  Attempting XLS download...');
    const resp = await fetch(AAII_XLS_URL, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/vnd.ms-excel,*/*' },
      signal: AbortSignal.timeout(15_000),
    });
    if (resp.ok) {
      const buffer = await resp.arrayBuffer();
      console.log(`  XLS downloaded: ${(buffer.byteLength / 1024).toFixed(0)} KB`);
      const rows = parseXlsRows(buffer);
      console.log(`  XLS parsed: ${rows.length} raw rows`);
      if (rows.length > 10) {
        data = extractSentimentData(rows);
        if (data.length > 0) {
          source = 'xls';
          console.log(`  XLS extracted: ${data.length} sentiment rows`);
        }
      }
    } else {
      console.warn(`  XLS fetch: HTTP ${resp.status}`);
    }
  } catch (e) {
    console.warn(`  XLS fetch failed: ${e.message}`);
  }

  // Strategy 2: Scrape the HTML page for current reading
  if (data.length === 0) {
    try {
      console.log('  Attempting HTML scrape...');
      const resp = await fetch(AAII_HTML_URL, {
        headers: { 'User-Agent': CHROME_UA, Accept: 'text/html,application/xhtml+xml' },
        signal: AbortSignal.timeout(8_000),
      });
      if (resp.ok) {
        const html = await resp.text();
        data = parseHtmlSentiment(html);
        if (data.length > 0) {
          source = 'html';
          console.log(`  HTML scraped: ${data.length} rows`);
        }
      }
    } catch (e) {
      console.warn(`  HTML scrape failed: ${e.message}`);
    }
  }

  if (data.length === 0) {
    throw Object.assign(new Error('AAII sources returned no usable sentiment rows'), { nonRetryable: true });
  }

  // Keep last 52 weeks
  const weeks = data.slice(0, 52);
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
    source,
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
    sourceVersion: 'aaii-xls-html-v1',
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 20160,
  }).catch((err) => {
    console.error('FATAL:', err.message || err);
    process.exit(1);
  });
}
