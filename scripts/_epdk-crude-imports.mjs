// Turkey's crude oil imports by country of origin, from the monthly petroleum
// market sector reports of EPDK (Enerji Piyasası Düzenleme Kurumu, the energy
// market regulator). Turkey files no partner-level HS 2709 imports to UN
// Comtrade, so this is the only recurring origin source for it.
//
// The listing page links one entry per report month. Reports up to 2025 are
// Word files whose table 2.1.1 gives the month's imports by country; from
// 2026 the tables ship as an Excel annex whose Tablo 2 is cumulative from
// January, so a month is the difference of two cumulative tables. Quantities
// are tonnes ("Ham Petrol" column), so shares from them are volume shares.

import { createRequire } from 'node:module';
import { inflateRawSync } from 'node:zlib';
import JSZip from 'jszip';

export const EPDK_LISTING_URL = 'https://www.epdk.gov.tr/Detay/Icerik/3-0-104/aylik-sektor-raporu';
const EPDK_ORIGIN = 'https://www.epdk.gov.tr';

const TR_MONTHS = ['ocak', 'şubat', 'mart', 'nisan', 'mayıs', 'haziran', 'temmuz', 'ağustos', 'eylül', 'ekim', 'kasım', 'aralık'];
const MONTH_WORD = TR_MONTHS.join('|');

const lowerTr = (s) => String(s ?? '').toLocaleLowerCase('tr');
const pad2 = (n) => String(n).padStart(2, '0');

function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

const plainText = (html) => decodeEntities(String(html).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** "2026 Yılı Petrol Piyasası Ağustos Ayı Sektör Raporu" -> "2026-08"; null without one year and one month name. */
export function monthFromLabel(label) {
  const text = lowerTr(label).replace(/[_-]/g, ' ');
  const year = text.match(/\b(20\d{2})\b/);
  const month = text.match(new RegExp(`(?:^|[^\\p{L}])(${MONTH_WORD})(?=$|[^\\p{L}])`, 'u'));
  if (!year || !month) return null;
  return `${year[1]}-${pad2(TR_MONTHS.indexOf(month[1]) + 1)}`;
}

/** True only for https://www.epdk.gov.tr URLs: listing links and fetches never leave that origin. */
export function isEpdkUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.origin === EPDK_ORIGIN;
  } catch {
    return false;
  }
}

/**
 * Report months on the listing page, each with its downloads in page order.
 * `kind` comes from the link's icon: word, excel or pdf.
 * @returns {Array<{month: string, label: string, documents: Array<{url: string, kind: string}>}>}
 */
export function parseEpdkListing(html) {
  const reports = [];
  const items = String(html).split(/<li\b[^>]*class="accordion-pop"[^>]*>/).slice(1);
  for (const item of items) {
    const labelMatch = item.match(/<a\b[^>]*data-toggle="collapse"[^>]*>([\s\S]*?)<\/a>/);
    if (!labelMatch) continue;
    const label = plainText(labelMatch[1]);
    const month = monthFromLabel(label);
    if (!month) continue;
    // Downloads sit between this label and the next nested item.
    const own = item.slice(labelMatch.index + labelMatch[0].length).split(/<li\b/)[0];
    const documents = [];
    for (const a of own.matchAll(/<a\b[^>]*href="([^"]*DownloadDocument\?id=[^"]*)"[^>]*>([\s\S]*?)<\/a>/g)) {
      const icon = a[2].match(/\/(word|excel|pdf)\.png/);
      let url;
      try {
        url = new URL(decodeEntities(a[1]), EPDK_ORIGIN).href;
      } catch {
        continue;
      }
      // An absolute or protocol-relative href could point anywhere.
      if (!isEpdkUrl(url)) continue;
      documents.push({ url, kind: icon ? icon[1] : 'unknown' });
    }
    if (documents.length > 0) reports.push({ month, label, documents });
  }
  return reports;
}

const TABLE_TITLE = /^Tablo\s*\d+(?:\.\d+)*\s*[:.]/;

// Elements named `name` (`<c` matches `<c>` and `<c r=..>`, not `<col`), as
// their attribute text and inner XML (null when self-closing). indexOf only,
// for the same linear-time reason as elementSpans below.
function* xmlElements(xml, name) {
  const open = `<${name}`;
  const close = `</${name}>`;
  let at = 0;
  for (;;) {
    const start = xml.indexOf(open, at);
    if (start < 0) return;
    if (/[\w:-]/.test(xml[start + open.length] ?? '')) {
      at = start + open.length;
      continue;
    }
    const tagEnd = xml.indexOf('>', start);
    if (tagEnd < 0) return;
    const attrs = xml.slice(start + open.length, tagEnd);
    if (attrs.endsWith('/')) {
      yield { attrs: attrs.slice(0, -1), body: null };
      at = tagEnd + 1;
      continue;
    }
    const end = xml.indexOf(close, tagEnd);
    if (end < 0) return;
    yield { attrs, body: xml.slice(tagEnd + 1, end) };
    at = end + close.length;
  }
}

const xmlAttr = (attrs, name) => attrs.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))?.[1] ?? null;

// Text of an <si> or <is>: its <t> runs joined, phonetic (<rPh>) runs dropped.
const runText = (xml) => decodeEntities(
  [...String(xml).replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((m) => m[1]).join(''),
);

// "AB12" -> { col: 28, row: 12 }
function cellRef(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref ?? '');
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + ch.charCodeAt(0) - 64;
  return { col, row: Number(m[2]) };
}

function cellValue(attrs, body, sharedStrings) {
  if (body === null) return undefined;
  const type = xmlAttr(attrs, 't');
  if (type === 'inlineStr') return runText(body.match(/<is>([\s\S]*?)<\/is>/)?.[1] ?? '');
  const v = body.match(/<v>([^<]*)<\/v>/)?.[1];
  if (v === undefined) return undefined;
  if (type === 's') return sharedStrings[Number(v)] ?? '';
  if (type === 'str') return decodeEntities(v);
  if (type === 'b') return v === '1';
  if (type === 'e') return decodeEntities(v);
  const n = Number(v);
  return Number.isFinite(n) ? n : decodeEntities(v);
}

/**
 * Rows of every worksheet in workbook order, each a sparse array indexed
 * from column A at 0. A merged range's cells all read as its top-left value.
 * Reads only cell values: a full workbook model (ExcelJS) needed ~480 MB for
 * a 514 KB annex with ~2,100 merged ranges.
 */
async function xlsxSheetRows(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const read = (path) => zip.file(path)?.async('string') ?? Promise.resolve(null);
  const sstXml = await read('xl/sharedStrings.xml');
  const sharedStrings = sstXml ? [...xmlElements(sstXml, 'si')].map((si) => runText(si.body ?? '')) : [];
  const relsXml = await read('xl/_rels/workbook.xml.rels') ?? '';
  const targets = new Map([...xmlElements(relsXml, 'Relationship')].map((r) => [xmlAttr(r.attrs, 'Id'), xmlAttr(r.attrs, 'Target')]));
  const sheets = [];
  for (const sheet of xmlElements(await read('xl/workbook.xml') ?? '', 'sheet')) {
    const target = targets.get(xmlAttr(sheet.attrs, 'r:id'));
    if (!target) continue;
    const xml = await read(target.startsWith('/') ? target.slice(1) : `xl/${target}`);
    if (!xml) continue;
    const rows = new Map();
    for (const row of xmlElements(xml, 'row')) {
      if (row.body === null) continue;
      const rowNumber = Number(xmlAttr(row.attrs, 'r'));
      const cells = [];
      for (const c of xmlElements(row.body, 'c')) {
        const ref = cellRef(xmlAttr(c.attrs, 'r'));
        const value = cellValue(c.attrs, c.body, sharedStrings);
        if (ref && value !== undefined) cells[ref.col - 1] = value;
      }
      if (Number.isInteger(rowNumber)) rows.set(rowNumber, cells);
    }
    for (const merge of xmlElements(xml, 'mergeCell')) {
      const [from, to] = (xmlAttr(merge.attrs, 'ref') ?? '').split(':').map(cellRef);
      if (!from || !to) continue;
      const master = rows.get(from.row)?.[from.col - 1];
      if (master === undefined) continue;
      for (let r = from.row; r <= to.row; r++) {
        if (!rows.has(r)) rows.set(r, []);
        for (let col = from.col; col <= to.col; col++) rows.get(r)[col - 1] = master;
      }
    }
    sheets.push([...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, cells]) => cells));
  }
  return sheets;
}

/** Tables of an .xlsx, each titled by the nearest "Tablo N:" row above it. */
export async function tablesFromXlsx(buffer) {
  const tables = [];
  for (const rows of await xlsxSheetRows(buffer)) {
    let current = null;
    for (const row of rows) {
      if (!row.some((v) => v !== undefined)) continue;
      const cells = row.map((v) => (typeof v === 'string' ? v.trim() : v));
      const title = cells.find((c) => typeof c === 'string' && TABLE_TITLE.test(c));
      if (title) {
        current = { title, rows: [] };
        tables.push(current);
        continue;
      }
      if (current) current.rows.push(cells);
    }
  }
  return tables;
}

// Word splits one word across runs ("202" + "5"), so text is the runs joined
// as written, never tags replaced by spaces.
const wordText = (xml) => decodeEntities(
  [...String(xml).matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/g)].map((m) => m[1] ?? ' ').join(''),
).replace(/\s+/g, ' ').trim();

// Element spans found with indexOf, never a lazy `[\s\S]*?` regex: that
// rescans the rest of the document for every unclosed tag. `open` is the tag
// name without `>`, so `<w:p` matches `<w:p>` and `<w:p w:rsidR=..>` but not
// `<w:pPr>`. Stops at the first unclosed element.
function elementSpans(xml, open, close) {
  const spans = [];
  let at = 0;
  for (;;) {
    const start = xml.indexOf(open, at);
    if (start < 0) return spans;
    if (/[\w:-]/.test(xml[start + open.length] ?? '')) {
      at = start + open.length;
      continue;
    }
    const end = xml.indexOf(close, start + open.length);
    if (end < 0) return spans;
    spans.push(xml.slice(start, end + close.length));
    at = end + close.length;
  }
}

/** Tables of a .docx, each titled by the last paragraph before it. */
export async function tablesFromDocx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file('word/document.xml');
  if (!file) return [];
  const xml = await file.async('string');
  const tables = [];
  let cursor = 0;
  let lastParagraph = '';
  for (;;) {
    const start = xml.indexOf('<w:tbl>', cursor);
    if (start < 0) break;
    const end = xml.indexOf('</w:tbl>', start);
    if (end < 0) break;
    for (const p of elementSpans(xml.slice(cursor, start), '<w:p', '</w:p>')) {
      const text = wordText(p);
      if (text) lastParagraph = text;
    }
    cursor = end + '</w:tbl>'.length;
    const rows = elementSpans(xml.slice(start, cursor), '<w:tr', '</w:tr>')
      .map((r) => elementSpans(r, '<w:tc', '</w:tc>').map(wordText));
    tables.push({ title: lastParagraph, rows });
  }
  return tables;
}

/** 2.923.092,68 (Word) or a number (Excel) -> tonnes; blank -> 0; anything else null. */
export function parseTonnes(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v ?? '').trim();
  if (s === '' || s === '-') return 0;
  if (!/^-?[\d.]+(,\d+)?$/.test(s)) return null;
  const n = Number(s.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/**
 * Crude imports by country from one table, or null when the table is not the
 * imports-by-country table. `cumulative` marks a January-to-month table.
 * @returns {{month: string, cumulative: boolean, totalT: number, rows: Array<{name: string, tonnes: number}>} | null}
 */
export function crudeImportsFromTable(table) {
  const title = String(table?.title ?? '');
  if (!/Ülkelere Göre/.test(title) || !/İthalat/.test(title)) return null;
  const t = lowerTr(title);
  const range = t.match(new RegExp(`ocak\\s*-\\s*(${MONTH_WORD})\\s+(20\\d{2})`, 'u'));
  const single = t.match(new RegExp(`(${MONTH_WORD})\\s+(20\\d{2})\\s+dönemi`, 'u'))
    ?? (/kümülatif/.test(t) ? t.match(new RegExp(`\\((${MONTH_WORD})\\s+(20\\d{2})\\)`, 'u')) : null);
  const hit = range ?? single;
  if (!hit) return null;
  const month = `${hit[2]}-${pad2(TR_MONTHS.indexOf(hit[1]) + 1)}`;
  const cumulative = Boolean(range) || /kümülatif/.test(t);
  const rows = table.rows ?? [];
  const headerAt = rows.findIndex((r) => r.includes('Ülke') && r.includes('Ham Petrol'));
  if (headerAt < 0) return null;
  const nameCol = rows[headerAt].indexOf('Ülke');
  const crudeCol = rows[headerAt].indexOf('Ham Petrol');
  const out = [];
  let totalT = null;
  for (const r of rows.slice(headerAt + 1)) {
    const name = String(r[nameCol] ?? '').trim();
    if (!name) continue;
    const tonnes = parseTonnes(r[crudeCol]);
    if (tonnes === null || tonnes < 0) return null;
    if (name === 'Toplam') {
      totalT = tonnes;
      break;
    }
    out.push({ name, tonnes });
  }
  if (totalT === null) return null;
  return { month, cumulative, totalT, rows: out };
}

/** Turkish country name -> ISO2, from ICU region names plus the forms EPDK uses. */
const ALIASES = {
  'rusya federasyonu': 'RU',
  abd: 'US',
  'amerika birleşik devletleri': 'US',
  ingiltere: 'GB',
  'birleşik krallık': 'GB',
  bae: 'AE',
  'kktc': 'CY',
  hollanda: 'NL',
  'güney kore': 'KR',
  'kuzey makedonya': 'MK',
  'fildişi sahili': 'CI',
  'kongo cumhuriyeti': 'CG',
  'demokratik kongo cumhuriyeti': 'CD',
  'ekvator ginesi': 'GQ',
  'ekvatoral gine': 'GQ',
};

const normalizeName = (name) => lowerTr(name).replace(/[.()]/g, '').replace(/\s+/g, ' ').trim();

let nameIndex = null;
function countryNameIndex() {
  if (nameIndex) return nameIndex;
  const iso3ToIso2 = createRequire(import.meta.url)('./shared/iso3-to-iso2.json');
  const display = new Intl.DisplayNames(['tr'], { type: 'region' });
  nameIndex = new Map();
  for (const iso2 of new Set(Object.values(iso3ToIso2))) {
    const name = display.of(iso2);
    if (name && name !== iso2) nameIndex.set(normalizeName(name), iso2);
  }
  for (const [name, iso2] of Object.entries(ALIASES)) nameIndex.set(normalizeName(name), iso2);
  return nameIndex;
}

export function iso2FromTurkishName(name) {
  return countryNameIndex().get(normalizeName(name)) ?? null;
}

/**
 * Per-month crude tonnes by origin, from parsed tables (any order). A month
 * comes from its own monthly table, else from its cumulative table less the
 * previous month's of the same year (January's cumulative is the month).
 * A month is void (absent) when a row with crude cannot be named, the rows
 * do not add up to the table total within 0.5% (a derived month is checked
 * again: two tables each within tolerance can difference to one outside
 * it), or a difference goes negative beyond rounding.
 * @returns {{months: Map<string, {totalT: number, byIso2: Record<string, number>}>, unmatched: string[]}}
 */
const addsUp = (byIso2, totalT) => {
  const sum = Object.values(byIso2).reduce((a, b) => a + b, 0);
  return Math.abs(sum - totalT) <= Math.max(1, totalT * 0.005);
};

export function monthlyCrudeByOrigin(parsed) {
  const unmatched = new Set();
  const named = (entry) => {
    const byIso2 = {};
    for (const { name, tonnes } of entry.rows) {
      if (!(tonnes > 0)) continue;
      const iso2 = iso2FromTurkishName(name);
      if (!iso2) {
        unmatched.add(name);
        return null;
      }
      byIso2[iso2] = (byIso2[iso2] ?? 0) + tonnes;
    }
    if (!addsUp(byIso2, entry.totalT)) return null;
    return { totalT: entry.totalT, byIso2 };
  };
  const monthly = new Map();
  const cumulative = new Map();
  for (const entry of parsed) {
    const target = entry.cumulative && !entry.month.endsWith('-01') ? cumulative : monthly;
    if (target.has(entry.month)) continue;
    const value = named(entry);
    if (value) target.set(entry.month, value);
  }
  const months = new Map(monthly);
  for (const [month, cum] of cumulative) {
    if (months.has(month)) continue;
    const m = Number(month.slice(5, 7));
    const prevKey = `${month.slice(0, 4)}-${pad2(m - 1)}`;
    const prev = cumulative.get(prevKey) ?? (m - 1 === 1 ? monthly.get(prevKey) : undefined);
    if (!prev) continue;
    const byIso2 = {};
    let ok = true;
    for (const iso2 of new Set([...Object.keys(cum.byIso2), ...Object.keys(prev.byIso2)])) {
      const diff = (cum.byIso2[iso2] ?? 0) - (prev.byIso2[iso2] ?? 0);
      if (diff < -1) ok = false;
      if (diff > 0.5) byIso2[iso2] = diff;
    }
    const totalT = cum.totalT - prev.totalT;
    if (ok && totalT > 0 && addsUp(byIso2, totalT)) months.set(month, { totalT, byIso2 });
  }
  return { months, unmatched: [...unmatched].sort() };
}

/**
 * The importer columns the shock model reads, aligned to `months`: World
 * and Gulf crude tonnes, plus the SA, AE and IQ parts. A month without data
 * is null in every column.
 */
export function epdkImporterColumns(byMonth, months, gulfIso2, bypassIso2) {
  const gulf = new Set(gulfIso2);
  const round = (v) => Math.round(v * 1000) / 1000;
  const worldT = [];
  const gulfT = [];
  const bypass = Object.fromEntries(bypassIso2.map((p) => [p, []]));
  for (const month of months) {
    const m = byMonth.get(month);
    if (!m || !(m.totalT > 0)) {
      worldT.push(null);
      gulfT.push(null);
      for (const p of bypassIso2) bypass[p].push(null);
      continue;
    }
    worldT.push(round(m.totalT));
    gulfT.push(round(Object.entries(m.byIso2).filter(([iso2]) => gulf.has(iso2)).reduce((s, [, v]) => s + v, 0)));
    for (const p of bypassIso2) bypass[p].push(round(m.byIso2[p] ?? 0));
  }
  return { worldT, gulfT, bypassPartnersT: bypass };
}

const isZip = (buf) => buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b;

// A real report inflates to a few MB; the cap only stops a crafted archive.
export const EPDK_MAX_INFLATED_BYTES = 200 * 1024 * 1024;

/**
 * Throws unless every entry of the ZIP inflates to at most `maxBytes` in
 * total. Entries are inflated with a bounded output, so the sizes the archive
 * declares are not trusted. Run before JSZip inflates anything.
 */
export function assertZipExpansionWithin(buf, maxBytes) {
  const bad = (why) => new Error(`not a readable ZIP (${why})`);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw bad('no end of central directory');
  // Walk records by signature, as JSZip does: the declared entry count can
  // understate the directory and leave entries unmeasured.
  const declared = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  let total = 0;
  let seen = 0;
  while (at + 46 <= buf.length && buf.readUInt32LE(at) === 0x02014b50) {
    seen++;
    const method = buf.readUInt16LE(at + 10);
    const compressed = buf.readUInt32LE(at + 20);
    const local = buf.readUInt32LE(at + 42);
    at += 46 + buf.readUInt16LE(at + 28) + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
    if (compressed === 0xffffffff || local === 0xffffffff) throw bad('ZIP64');
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw bad('local header');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (start + compressed > buf.length) throw bad('truncated entry');
    const data = buf.subarray(start, start + compressed);
    const left = maxBytes - total;
    if (method === 0) {
      total += data.length;
    } else if (method === 8) {
      try {
        total += inflateRawSync(data, { maxOutputLength: left + 1 }).length;
      } catch (err) {
        if (err?.code === 'ERR_BUFFER_TOO_LARGE') total = maxBytes + 1;
        else throw bad(err.message);
      }
    } else {
      throw bad(`compression method ${method}`);
    }
    if (total > maxBytes) throw new Error(`document expands past ${maxBytes} bytes`);
  }
  if (seen === 0 || seen < declared) throw bad('central directory');
}

/**
 * Downloads each wanted month's report (Word first, then Excel; PDF is not
 * parsed) until one carries the imports-by-country table for that month.
 * `fetchBuffer(url)` resolves to a Buffer. A listing that cannot be read
 * throws. `failedMonths` are wanted months EPDK lists but that yielded no
 * usable month (download, parse or consistency failure, or the deadline);
 * months EPDK has not published yet are not failures.
 */
export async function fetchEpdkCrudeImports({ wantedMonths, fetchText, fetchBuffer, log = () => {}, deadlineAtMs = Infinity, maxInflatedBytes = EPDK_MAX_INFLATED_BYTES }) {
  const reports = parseEpdkListing(await fetchText(EPDK_LISTING_URL));
  if (reports.length === 0) throw new Error('EPDK listing has no report months');
  const wanted = new Set(wantedMonths);
  const listed = new Set();
  const parsed = [];
  const failures = [];
  const rank = { word: 0, excel: 1 };
  for (const report of reports) {
    if (!wanted.has(report.month)) continue;
    listed.add(report.month);
    if (Date.now() >= deadlineAtMs) {
      failures.push(`${report.month}: deadline`);
      continue;
    }
    const docs = report.documents.filter((d) => d.kind in rank).sort((a, b) => rank[a.kind] - rank[b.kind]);
    let found = null;
    for (const doc of docs) {
      if (Date.now() >= deadlineAtMs) {
        failures.push(`${report.month}: deadline`);
        break;
      }
      try {
        const buf = await fetchBuffer(doc.url);
        if (!isZip(buf)) continue;
        assertZipExpansionWithin(buf, maxInflatedBytes);
        const zip = await JSZip.loadAsync(buf);
        const tables = zip.file('word/document.xml') ? await tablesFromDocx(buf) : zip.file('xl/workbook.xml') ? await tablesFromXlsx(buf) : [];
        const entries = tables.map(crudeImportsFromTable).filter((e) => e && e.month === report.month);
        // A Word report has both the month and January-to-month tables; keep the month's.
        found = entries.find((e) => !e.cumulative) ?? entries[0] ?? null;
        if (found) break;
      } catch (err) {
        failures.push(`${report.month}: ${err.message}`);
      }
    }
    if (found) parsed.push(found);
  }
  if (failures.length > 0) log(`  EPDK: ${failures.length} document(s) failed (${failures.slice(0, 3).join('; ')})`);
  const result = monthlyCrudeByOrigin(parsed);
  const failedMonths = [...listed].filter((m) => !result.months.has(m)).sort();
  return { ...result, failedMonths };
}
