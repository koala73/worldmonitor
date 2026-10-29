import { Agent, Dispatcher1Wrapper } from 'undici';
import { setTimeout as delay } from 'node:timers/promises';
import sources from '../shared/food-price-sources.json' with { type: 'json' };
import { CHROME_UA } from '../_seed-utils.mjs';
import { decodeHtmlEntities } from '../_html-entities.mjs';
import {
  discoverReports, giewsCountries, isoDate, parseCbsl, parseDa, parseGiews,
  parseOnagri, parsePbs, parsePihps, parseSniim, plainText,
} from './food-prices.mjs';

const DAY = 86400000;
const dated = (now, offset) => new Date(now.getTime() + offset * DAY).toISOString().slice(0, 10);
const dmy = date => date.split('-').reverse().join('/');
const SNIIM_QUERY = 'https://www.economia-sniim.gob.mx/nuevo/Consultas/MercadosNacionales/PreciosDeMercado/Agricolas/ConsultaFrutasYHortalizas.aspx?SubOpcion=4';

async function pdfPages(bytes) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, isEvalSupported: false });
  try {
    const doc = await task.promise;
    if (doc.numPages > 25) throw new Error('food PDF page limit exceeded');
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const content = await (await doc.getPage(i)).getTextContent();
      pages.push(content.items.filter(item => item.str?.trim()).map(item => ({ text: item.str, x: item.transform[4], y: item.transform[5] })));
    }
    return pages;
  } finally { await task.destroy(); }
}

function links(html, base) {
  return [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].flatMap(match => {
    try { return [{ url: new URL(decodeHtmlEntities(match[1]), base).href, text: plainText(match[2]) }]; } catch { return []; }
  });
}

function selectOptions(html, name) {
  const select = new RegExp(`<select\\b[^>]*name=["']${name}["'][^>]*>([\\s\\S]*?)<\\/select>`, 'i').exec(html)?.[1] ?? '';
  return [...select.matchAll(/<option\b[^>]*value=["']([^"']+)["'][^>]*>([\s\S]*?)<\/option>/gi)].map(match => ({ id: decodeHtmlEntities(match[1]), name: plainText(match[2]) }));
}

async function readBytes(response, limit = 8_000_000) {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new Error('food report exceeds size limit');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('empty food report body');
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error('food report exceeds size limit');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}

export async function collectFoodSource(id, { now = new Date(), fetchFn = (...args) => globalThis.fetch(...args), pause = delay, budgetMs = 230_000 } = {}) {
  const source = sources.find(source => source.id === id);
  if (!source) throw new Error('unknown food-price source');
  const agent = new Agent({ connect: { family: 4, timeout: 15_000 } });
  const dispatcher = new Dispatcher1Wrapper(agent);
  const deadline = Date.now() + budgetMs;
  let requested = false;
  const host = new URL(source.url).hostname;
  const get = async (url, binary = false) => {
    if (requested) await pause(id === 'pihps' ? 500 : 250);
    requested = true;
    let target = new URL(url);
    for (let redirects = 0; redirects <= 4; redirects++) {
      if (target.protocol !== 'https:' || target.hostname !== host || target.username || target.password) throw new Error('food source URL left its publisher');
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('food source fetch budget exceeded');
      const response = await fetchFn(target.href, {
        headers: { 'User-Agent': CHROME_UA, Accept: '*/*' },
        dispatcher, redirect: 'manual', signal: AbortSignal.timeout(Math.min(20_000, remaining)),
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw new Error('food source redirect missing location');
        target = new URL(location, target);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`${id} HTTP ${response.status}`);
      }
      const bytes = await readBytes(response);
      return binary ? bytes : bytes.toString('utf8');
    }
    throw new Error('food source redirect limit exceeded');
  };
  try {
    let observations = [];
    const refreshedReports = [];
    let contexts = [];
    let reportUrl = source.url;
    if (id === 'pihps') {
      const base = 'https://www.bi.go.id/hargapangan/WebSite/TabelHarga/';
      const payload = JSON.parse(await get(`${base}GetRefCommodityAndCategory`));
      const commodities = payload.data?.filter(item => /^com_\d+$/.test(item.id));
      if (!commodities?.length || commodities.length > 50) throw new Error('PIHPS commodity list changed');
      for (const commodity of commodities) {
        const query = new URLSearchParams({ price_type_id: '1', comcat_id: commodity.id, province_id: '', regency_id: '', showKota: 'false', showPasar: 'false', tipe_laporan: '1', start_date: dated(now, -14), end_date: dated(now, 0) });
        const rows = parsePihps(JSON.parse(await get(`${base}GetGridDataKomoditas?${query}`)), commodity);
        if (!rows.length) throw new Error(`PIHPS commodity ${commodity.id} has no national prices`);
        observations.push(...rows);
      }
    } else if (id === 'pbs' || id === 'da' || id === 'cbsl') {
      const index = await get(source.url);
      const reports = discoverReports(index, id).filter(report => report.date <= dated(now, 0));
      const latest = reports[0];
      if (!latest) throw new Error(`${id} has no report links`);
      reportUrl = latest.url;
      const priorDate = dated(new Date(`${latest.date}T00:00:00Z`), -7);
      const prior = reports.find(report => report.date === priorDate);
      for (const report of [latest, prior].filter(Boolean)) {
        try {
          let rows;
          if (id === 'pbs') {
            const annex = /\.xlsx$/i.test(report.url) ? report : links(await get(report.url), report.url).find(link => /\/annex[^/]*\.xlsx$/i.test(new URL(link.url).pathname));
            if (!annex) throw new Error('PBS annex workbook link missing');
            const bytes = await get(annex.url, true);
            const { unzipSync } = await import('fflate');
            let expanded = 0;
            unzipSync(new Uint8Array(bytes), { filter: file => {
              expanded += file.originalSize;
              if (expanded > 50_000_000) throw new Error('PBS workbook exceeds expansion limit');
              return false;
            } });
            const { default: ExcelJS } = await import('exceljs');
            const book = new ExcelJS.Workbook();
            await book.xlsx.load(bytes);
            const sheets = book.worksheets.map(sheet => {
              const rows = [];
              sheet.eachRow({ includeEmpty: true }, row => rows.push(row.values.slice(1).map(cell => cell?.result ?? cell)));
              return rows;
            });
            rows = parsePbs(sheets);
          } else {
            const pages = await pdfPages(await get(report.url, true));
            rows = id === 'da' ? parseDa(pages.slice(0, 3), report.date) : parseCbsl([pages[1] ?? []], report.date);
          }
          if (!rows.length || rows.some(row => row.date !== report.date)) throw new Error(`${id} report date/price mismatch`);
          observations.push(...rows);
          refreshedReports.push({ date: report.date });
        } catch (error) {
          if (report === latest) throw error;
          console.warn(`${id} prior-week report unavailable: ${error.message}`);
        }
      }
    } else if (id === 'sniim') {
      const form = await get(SNIIM_QUERY);
      const all = selectOptions(form, 'ddlProducto');
      const basket = [/^Cebolla Bola - Primera$/, /^Cebolla Morada - Primera$/, /^Chile Jalapeño - Primera$/, /^Tomate Saladette - Primera$/, /^Papa Alpha - Primera$/];
      const products = basket.map(pattern => {
        const product = all.find(product => pattern.test(product.name));
        if (!product) throw new Error('SNIIM basket product missing');
        return product;
      });
      const latest = new Date(`${dated(now, -1)}T00:00:00Z`);
      while ([0, 6].includes(latest.getUTCDay())) latest.setUTCDate(latest.getUTCDate() - 1);
      for (const offset of [0, -7]) {
        for (const product of products) {
          const date = dated(latest, offset);
          const query = new URLSearchParams({ fechaInicio: dmy(date), fechaFinal: dmy(date), ProductoId: product.id, OrigenId: '-1', Origen: 'Todos', DestinoId: '-1', Destino: 'Todos', PreciosPorId: '2', RegistrosPorPagina: '500' });
          const url = new URL(`ResultadosConsultaFechaFrutasYHortalizas.aspx?${query}`, SNIIM_QUERY).href;
          try {
            const rows = parseSniim(await get(url), product.name, date);
            if (rows.some(row => row.date !== date)) throw new Error('SNIIM report date mismatch');
            observations.push(...rows);
            refreshedReports.push({ date, item: product.name });
          } catch (error) {
            if (offset === 0) throw error;
            console.warn(`SNIIM prior-week report unavailable: ${error.message}`);
          }
        }
      }
    } else if (id === 'giews') {
      const index = await get(source.url);
      const countries = giewsCountries(index);
      if (countries.length < 100 || countries.length > 150) throw new Error('GIEWS country catalog changed');
      for (const country of countries) {
        const url = `https://www.fao.org/giews/countrybrief/country.jsp?code=${country.code}&lang=en`;
        try {
          contexts.push({ ...parseGiews(country.code === 'BGD' ? index : await get(url), country), fetchedAt: now.toISOString() });
        } catch (error) {
          console.warn(`GIEWS ${country.code}: ${error.message}`);
          contexts.push({ countryCode: country.code, country: country.name, referenceDate: '', title: `GIEWS country brief: ${country.name}`, url, fetchedAt: '', fetchFailed: true });
        }
      }
    } else if (id === 'onagri') {
      const reports = discoverReports(await get(source.url), id);
      const latest = reports.find(report => report.date <= dated(now, 0));
      if (!latest) throw new Error('ONAGRI monthly report link missing');
      reportUrl = latest.url;
      observations = parseOnagri(await get(latest.url), latest.date);
      contexts = [{ countryCode: 'TN', country: 'Tunisia', referenceDate: latest.date, title: 'Bir El Kassaa monthly wholesale report', url: latest.url }];
    }
    if (id === 'giews' ? !contexts.some(context => context.referenceDate) : !observations.length) throw new Error(`${id} has no dated records`);
    if (observations.some(row => !isoDate(...row.date.split('-')) || row.date > dated(now, 0))) throw new Error('invalid or future food observation');
    return { observations, contexts, reportUrl, fetchedAt: now.toISOString(), ...(refreshedReports.length ? { refreshedReports } : {}) };
  } finally { await agent.close(); }
}
