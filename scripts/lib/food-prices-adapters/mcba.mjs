import { unzipSync } from 'fflate';
import * as XLSX from '@e965/xlsx';
import * as cptable from '@e965/xlsx/dist/cpexcel.full.mjs';
import { isoDate } from '../food-prices.mjs';
import { positive, priceReport } from './monthly.mjs';

XLSX.set_cptable(cptable);
export const PAGE_URL = 'https://mercadocentral.gob.ar/informaci%C3%B3n/precios-mayoristas';
const MONTHS = ['ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO', 'JULIO', 'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE'];

/** Read modal wholesale prices per kg, excluding ambiguous or unweighted quotes. */
export function parseMercado(rows) {
  const header = rows[0];
  const match = /^MO(\d{2})(\d{2})(\d{2})$/.exec(header?.[9]);
  const date = match ? isoDate(2000 + Number(match[3]), match[2], match[1]) : '';
  if (!date || header.slice(0, 8).join('|') !== 'ESP|VAR|PROC|ENV|KG|CAL|TAM|GRADO' || header[12] !== 'MOPK') throw new Error('Mercado Central XLS columns changed');
  const quotes = new Map();
  const ambiguous = new Set();
  for (const row of rows.slice(1)) {
    if (!row[0] || !positive(row[12])) continue;
    // Summary rows and bunch/unit packages with no kg weight cannot safely be treated as per-kg quotes.
    if (!positive(row[4])) continue;
    if (!row[2] || Number(row[12]) < Number(row[13]) || Number(row[12]) > Number(row[11])) throw new Error('Mercado Central modal price outside range');
    // Keep variety, packaging, size and grade distinct; the published modal-per-kg column is already normalised.
    const item = [row[0], row[1], `${row[3]} ${row[4]} kg`, row[5], row[6], row[7]].filter(Boolean).join(' · ');
    const value = { item, market: 'Mercado Central de Buenos Aires', marketType: 'wholesale', unit: 'kg', currency: 'ARS', date, price: Number(row[12]), origin: String(row[2]) };
    const key = `${item}|${value.origin}`;
    if (ambiguous.has(key)) continue;
    if (quotes.has(key) && quotes.get(key).price !== value.price) { quotes.delete(key); ambiguous.add(key); continue; }
    quotes.set(key, value);
  }
  if (!quotes.size) throw new Error('Mercado Central has no food prices');
  return [...quotes.values()];
}

/** Decode bounded legacy XLS archives and reject oversized or unexpected workbooks. */
export function readMercadoArchive(bytes) {
  let expanded = 0;
  let count = 0;
  const files = unzipSync(bytes, { filter: file => {
    if (++count > 100 || (expanded += file.originalSize) > 20_000_000) throw new Error('Mercado Central archive exceeds size limit');
    return /\.xls$/i.test(file.name);
  } });
  return Object.values(files).map(data => {
    const book = XLSX.read(data, { type: 'array', codepage: 28591, sheetRows: 2001 });
    const sheet = book.Sheets[book.SheetNames[0]];
    const range = XLSX.utils.decode_range(sheet['!fullref'] ?? sheet['!ref'] ?? 'A1');
    if (range.e.r >= 2000 || range.e.c > 20 || book.SheetNames.length !== 1) throw new Error('Mercado Central sheet exceeds size limit');
    return parseMercado(XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }));
  });
}

/** Discover fruit and vegetable archives, allowing prior-month fallback during early rollover. */
export async function collect(ctx) {
  const links = ctx.links(await ctx.get(PAGE_URL), PAGE_URL);
  const observations = [];
  const dates = [ctx.now];
  if (ctx.now.getUTCDate() <= 14) dates.push(new Date(Date.UTC(ctx.now.getUTCFullYear(), ctx.now.getUTCMonth() - 1, 15)));
  for (const [offset, month] of dates.entries()) {
    for (const kind of ['FRUT', 'HORTALIZ']) {
      const archive = links.find(link => {
        let path;
        try { path = decodeURIComponent(new URL(link.url).pathname).toUpperCase(); }
        catch { return false; } // An unrelated malformed publisher link must not block valid archives.
        const year = month.getUTCFullYear();
        return path.endsWith('.ZIP') && path.includes(kind) && path.includes(MONTHS[month.getUTCMonth()]) && new RegExp(`(?:${year}|${String(year).slice(-2)})(?:_\\d+)?\\.ZIP$`).test(path);
      });
      if (!archive) { ctx.warn(`Mercado Central ${offset ? 'prior' : 'current'} ${kind} archive missing`); continue; }
      try {
        const reports = readMercadoArchive(await ctx.get(archive.url, { binary: true }));
        observations.push(...reports.flat().filter(row => row.date.slice(0, 7) === month.toISOString().slice(0, 7) && row.date <= ctx.dated(ctx.now, 0)));
      } catch (error) { if (!offset && !/HTTP 404\b/.test(error.message)) throw error; ctx.warn(`${offset ? 'prior' : 'current'}-month ${kind} unavailable: ${error.message}`); }
    }
  }
  const latest = observations.map(row => row.date).sort().at(-1);
  const prior = latest ? ctx.dated(new Date(`${latest}T00:00:00Z`), -7) : '';
  return priceReport(observations.filter(row => row.date === latest || row.date === prior), PAGE_URL, ctx.now);
}
