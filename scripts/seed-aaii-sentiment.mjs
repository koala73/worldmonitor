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
      if (!isNaN(parsed.getTime())) {
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

const FALLBACK_DATA = [
  { date: '2026-04-03', bullish: 35.7, bearish: 43.0, neutral: 21.3, spread: -7.3 },
  { date: '2026-03-27', bullish: 22.4, bearish: 55.8, neutral: 21.8, spread: -33.4 },
  { date: '2026-03-20', bullish: 19.2, bearish: 57.1, neutral: 23.7, spread: -37.9 },
  { date: '2026-03-13', bullish: 20.5, bearish: 54.5, neutral: 25.0, spread: -34.0 },
  { date: '2026-03-06', bullish: 19.4, bearish: 59.2, neutral: 21.4, spread: -39.8 },
  { date: '2026-02-27', bullish: 22.8, bearish: 52.2, neutral: 25.0, spread: -29.4 },
  { date: '2026-02-20', bullish: 31.3, bearish: 44.1, neutral: 24.6, spread: -12.8 },
  { date: '2026-02-13', bullish: 36.1, bearish: 41.0, neutral: 22.9, spread: -4.9 },
  { date: '2026-02-06', bullish: 29.2, bearish: 40.9, neutral: 29.9, spread: -11.7 },
  { date: '2026-01-30', bullish: 33.3, bearish: 37.5, neutral: 29.2, spread: -4.2 },
  { date: '2026-01-23', bullish: 25.4, bearish: 40.6, neutral: 34.0, spread: -15.2 },
  { date: '2026-01-16', bullish: 34.7, bearish: 29.4, neutral: 35.9, spread: 5.3 },
  { date: '2026-01-09', bullish: 38.4, bearish: 34.0, neutral: 27.6, spread: 4.4 },
  { date: '2026-01-02', bullish: 43.1, bearish: 25.3, neutral: 31.6, spread: 17.8 },
  { date: '2025-12-26', bullish: 37.9, bearish: 34.1, neutral: 28.0, spread: 3.8 },
  { date: '2025-12-19', bullish: 40.2, bearish: 30.4, neutral: 29.4, spread: 9.8 },
  { date: '2025-12-12', bullish: 48.3, bearish: 23.7, neutral: 28.0, spread: 24.6 },
  { date: '2025-12-05', bullish: 45.5, bearish: 27.5, neutral: 27.0, spread: 18.0 },
  { date: '2025-11-28', bullish: 49.8, bearish: 22.1, neutral: 28.1, spread: 27.7 },
  { date: '2025-11-21', bullish: 47.3, bearish: 25.7, neutral: 27.0, spread: 21.6 },
  { date: '2025-11-14', bullish: 50.8, bearish: 20.3, neutral: 28.9, spread: 30.5 },
  { date: '2025-11-07', bullish: 49.8, bearish: 22.1, neutral: 28.1, spread: 27.7 },
  { date: '2025-10-31', bullish: 37.7, bearish: 31.8, neutral: 30.5, spread: 5.9 },
  { date: '2025-10-24', bullish: 40.6, bearish: 28.2, neutral: 31.2, spread: 12.4 },
  { date: '2025-10-17', bullish: 45.5, bearish: 25.6, neutral: 28.9, spread: 19.9 },
  { date: '2025-10-10', bullish: 49.0, bearish: 24.6, neutral: 26.4, spread: 24.4 },
  { date: '2025-10-03', bullish: 45.3, bearish: 25.2, neutral: 29.5, spread: 20.1 },
  { date: '2025-09-26', bullish: 42.2, bearish: 27.0, neutral: 30.8, spread: 15.2 },
  { date: '2025-09-19', bullish: 46.3, bearish: 24.5, neutral: 29.2, spread: 21.8 },
  { date: '2025-09-12', bullish: 44.4, bearish: 26.1, neutral: 29.5, spread: 18.3 },
  { date: '2025-09-05', bullish: 38.6, bearish: 28.4, neutral: 33.0, spread: 10.2 },
  { date: '2025-08-29', bullish: 41.2, bearish: 27.0, neutral: 31.8, spread: 14.2 },
  { date: '2025-08-22', bullish: 40.0, bearish: 30.1, neutral: 29.9, spread: 9.9 },
  { date: '2025-08-15', bullish: 41.1, bearish: 26.8, neutral: 32.1, spread: 14.3 },
  { date: '2025-08-08', bullish: 44.7, bearish: 29.1, neutral: 26.2, spread: 15.6 },
  { date: '2025-08-01', bullish: 33.7, bearish: 37.5, neutral: 28.8, spread: -3.8 },
  { date: '2025-07-25', bullish: 36.0, bearish: 29.4, neutral: 34.6, spread: 6.6 },
  { date: '2025-07-18', bullish: 40.3, bearish: 27.4, neutral: 32.3, spread: 12.9 },
  { date: '2025-07-11', bullish: 42.5, bearish: 25.0, neutral: 32.5, spread: 17.5 },
  { date: '2025-07-04', bullish: 46.2, bearish: 27.6, neutral: 26.2, spread: 18.6 },
  { date: '2025-06-27', bullish: 40.9, bearish: 31.1, neutral: 28.0, spread: 9.8 },
  { date: '2025-06-20', bullish: 44.6, bearish: 26.5, neutral: 28.9, spread: 18.1 },
  { date: '2025-06-13', bullish: 44.0, bearish: 25.6, neutral: 30.4, spread: 18.4 },
  { date: '2025-06-06', bullish: 41.0, bearish: 28.0, neutral: 31.0, spread: 13.0 },
  { date: '2025-05-30', bullish: 41.3, bearish: 32.3, neutral: 26.4, spread: 9.0 },
  { date: '2025-05-23', bullish: 36.1, bearish: 33.3, neutral: 30.6, spread: 2.8 },
  { date: '2025-05-16', bullish: 39.1, bearish: 31.0, neutral: 29.9, spread: 8.1 },
  { date: '2025-05-09', bullish: 36.0, bearish: 37.5, neutral: 26.5, spread: -1.5 },
  { date: '2025-05-02', bullish: 28.5, bearish: 44.7, neutral: 26.8, spread: -16.2 },
  { date: '2025-04-25', bullish: 25.3, bearish: 52.2, neutral: 22.5, spread: -26.9 },
  { date: '2025-04-18', bullish: 21.8, bearish: 55.6, neutral: 22.6, spread: -33.8 },
  { date: '2025-04-11', bullish: 28.5, bearish: 52.1, neutral: 19.4, spread: -23.6 },
];

async function fetchAaiiSentiment() {
  let data = [];
  let source = 'fallback';

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

  // Strategy 3: Use fallback data
  const isFallback = data.length === 0;
  if (isFallback) {
    console.log('  Using fallback data');
    data = FALLBACK_DATA;
    source = 'fallback';
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
    seededAt: isFallback ? new Date(latest.date + 'T12:00:00Z').toISOString() : new Date().toISOString(),
    fallback: isFallback,
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

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[\\/]/, ''));
if (isMain) {
  runSeed('market', 'aaii-sentiment', AAII_KEY, fetchAaiiSentiment, {
    validateFn: validate,
    ttlSeconds: AAII_TTL,
    recordCount: (data) => data?.weeks?.length ?? 0,
    sourceVersion: 'aaii-xls-html-v1',
  }).catch((err) => {
    console.error('FATAL:', err.message || err);
    process.exit(1);
  });
}
