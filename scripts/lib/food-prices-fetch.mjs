import { Agent, Dispatcher1Wrapper } from 'undici';
import { createRequire } from 'node:module';
import { randomInt } from 'node:crypto';
import { lookup } from 'node:dns';
import { setTimeout as delay } from 'node:timers/promises';
import { rootCertificates } from 'node:tls';
import sources from '../shared/food-price-sources.json' with { type: 'json' };
import { CHROME_UA, redactProxyCredentials } from '../_seed-utils.mjs';
import { decodeHtmlEntities } from '../_html-entities.mjs';
import {
  discoverReports, giewsCountries, htmlElements, isoDate, parseCbsl, parseDa, parseGiews,
  parseOnagri, parsePbs, parsePihps, parseSniim, plainText,
} from './food-prices.mjs';
import { FOOD_PRICE_ADAPTERS } from './food-prices-adapters/index.mjs';

const { parseProxyConfigForAttempt, proxyFetch } = createRequire(import.meta.url)('../_proxy-utils.cjs');

const DAY = 86400000;
const dated = (now, offset) => new Date(now.getTime() + offset * DAY).toISOString().slice(0, 10);
const dmy = date => date.split('-').reverse().join('/');
const SNIIM_QUERY = 'https://www.economia-sniim.gob.mx/nuevo/Consultas/MercadosNacionales/PreciosDeMercado/Agricolas/ConsultaFrutasYHortalizas.aspx?SubOpcion=4';

export async function pdfPages(bytes, { maxItems = 200_000 } = {}) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, isEvalSupported: false });
  try {
    const doc = await task.promise;
    if (doc.numPages > 40) throw new Error('food PDF page limit exceeded');
    // A small compressed content stream can expand into millions of text items, and getTextContent()
    // would hold them all. Stream each page and keep nothing past the budget (CWE-770). Real documents
    // in these feeds stay in the hundreds per page. The stream is drained rather than cancelled:
    // destroying the document with a text stream in flight never settles.
    const pages = [];
    let total = 0;
    for (let i = 1; i <= doc.numPages && total <= maxItems; i++) {
      const reader = (await doc.getPage(i)).streamTextContent().getReader();
      const page = [];
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        total += chunk.value.items.length;
        if (total > maxItems) continue;
        for (const item of chunk.value.items) if (item.str?.trim()) page.push({ text: item.str, x: item.transform[4], y: item.transform[5] });
      }
      pages.push(page);
    }
    if (total > maxItems) throw new Error('food PDF text item limit exceeded');
    return pages;
  } finally { await task.destroy(); }
}

// The largest real sheet across the three workbook feeds is about 1.3k rows and 30 columns.
const MAX_SHEET_ROWS = 20_000;
const MAX_SHEET_COLUMNS = 512;

export async function readWorkbook(bytes) {
  const { unzipSync } = await import('fflate');
  let expanded = 0;
  unzipSync(new Uint8Array(bytes), { filter: file => {
    expanded += file.originalSize;
    if (expanded > 50_000_000) throw new Error('food workbook exceeds expansion limit');
    return false;
  } });
  const { default: ExcelJS } = await import('exceljs');
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(bytes);
  return book.worksheets.map(sheet => {
    // includeEmpty materialises one array per row up to the last used row, so a lone far-away cell
    // would allocate a million rows; refuse the sheet first (CWE-770).
    if (sheet.rowCount > MAX_SHEET_ROWS || sheet.columnCount > MAX_SHEET_COLUMNS) throw new Error('food workbook sheet exceeds size limit');
    const rows = [];
    sheet.eachRow({ includeEmpty: true }, row => rows.push(row.values.slice(1).map(cell => cell?.result ?? cell)));
    return rows;
  });
}

// Finds each opening tag, then the next </a> through a forward-only pointer, so an anchor that never
// closes cannot make every later opener rescan the page (CWE-1333).
export function links(html, base) {
  const lower = html.toLowerCase();
  const result = [];
  let consumed = 0;
  let close = 0;
  for (const match of html.matchAll(/<a\b[^<>]*?href=["']([^"'<>]+)["'][^<>]*>/gi)) {
    if (match.index < consumed) continue;
    const start = match.index + match[0].length;
    if (close !== -1 && close < start) close = lower.indexOf('</a>', start);
    if (close === -1) break;
    consumed = close + 4;
    try { result.push({ url: new URL(decodeHtmlEntities(match[1]), base).href, text: plainText(html.slice(start, close)) }); } catch { /* Skip hrefs that do not parse. */ }
  }
  return result;
}

export function selectOptions(html, name) {
  const select = htmlElements(html, ['select']).find(([open]) => new RegExp(`name=["']${name}["']`, 'i').test(open))?.[1] ?? '';
  return htmlElements(select, ['option']).flatMap(([open, inner]) => {
    const value = /value=["']([^"']+)["']/i.exec(open)?.[1];
    return value ? [{ id: decodeHtmlEntities(value), name: plainText(inner) }] : [];
  });
}

// Fetch exposes header bytes as Latin-1; some publishers send raw UTF-8 file names in Location.
export function utf8Header(value) {
  if (!value || !/[\x80-\xff]/.test(value) || /[^\x00-\xff]/.test(value)) return value;
  const decoded = Buffer.from(value, 'latin1').toString('utf8');
  return decoded.includes('\uFFFD') ? value : decoded;
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

const PROXY_EXITS = 3;
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/**
 * Sends one request through the shared PROXY_URL CONNECT tunnel and returns it as a fetch Response, so redirects,
 * cookies and the size limit stay in the caller's loop. The proxy resolves the publisher's host name, which is what
 * lets MakStat answer when Railway's resolver cannot. Each attempt takes the next Decodo sticky exit (as NRCan does):
 * a dead or refused exit (CONNECT failure, or an origin 403) moves on; a gateway 4xx means the credentials are wrong
 * everywhere. Each exit gets its own timeout and a share of the source budget, so one hung exit cannot spend the
 * time the others need. When every exit fails before the publisher answers, the error carries `proxyUnreachable`.
 */
async function fetchViaProxy(url, init, { proxyAuth, proxyFetchFn, firstExit, deadline }) {
  let last;
  let answered = false;
  for (let attempt = 0; attempt < PROXY_EXITS; attempt++) {
    const proxyConfig = parseProxyConfigForAttempt(proxyAuth, firstExit + attempt);
    if (!proxyConfig) throw new Error('food source proxy: invalid PROXY_URL');
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    // Exits still to try share what is left, so a hung first exit leaves time for the others.
    const timeoutMs = Math.max(1, Math.min(init.timeoutMs, Math.floor(remaining / (PROXY_EXITS - attempt))));
    try {
      const result = await proxyFetchFn(url, proxyConfig, {
        method: init.method, body: init.body ?? null, headers: init.headers, signal: AbortSignal.timeout(timeoutMs),
        timeoutMs, maxResponseBytes: 8_000_000,
      });
      answered = true;
      if (result.status === 403 && attempt < PROXY_EXITS - 1) { last = new Error('HTTP 403'); continue; }
      const headers = new Headers();
      for (const [name, value] of Object.entries(result.headers ?? {})) {
        // proxyFetch has already decoded the body, so its encoding and length no longer describe it.
        if (value == null || name === 'content-encoding' || name === 'content-length') continue;
        for (const item of [value].flat()) headers.append(name, String(item));
      }
      return new Response(NULL_BODY_STATUSES.has(result.status) ? null : result.buffer, { status: result.status, headers });
    } catch (error) {
      if (error?.code === 'RESPONSE_TOO_LARGE') throw error;
      if (error?.proxyConnect && error.status >= 400 && error.status < 500) {
        throw new Error(`food source proxy refused: ${redactProxyCredentials(error.message)}`);
      }
      last = error;
    }
  }
  if (!last) throw new Error('food source fetch budget exceeded');
  throw Object.assign(new Error(`food source proxy failed: ${redactProxyCredentials(last?.message || last)}`), { proxyUnreachable: !answered });
}

/**
 * IPv4 only, but every IPv4 address in turn. With `family: 4` Node connects to
 * the first resolved address alone, so a publisher with one dead A record
 * (www.da.gov.ph: one of two addresses never answers, and the resolver rotates
 * them) timed out on about half the runs. `autoSelectFamily` tries each address
 * the lookup returns, giving each a short attempt window; it is ignored when
 * `family` is set, so the lookup pins IPv4 instead.
 */
export function foodSourceConnectOptions(adapter, { dnsLookup = lookup } = {}) {
  return {
    lookup: (hostname, options, callback) => dnsLookup(hostname, { ...options, family: 4, all: true }, callback),
    autoSelectFamily: true,
    autoSelectFamilyAttemptTimeout: 2_500,
    timeout: 15_000,
    ...(adapter?.ca ? { ca: [...rootCertificates, ...adapter.ca] } : {}),
  };
}

export async function collectFoodSource(id, {
  now = new Date(), fetchFn = (...args) => globalThis.fetch(...args), pause = delay, budgetMs = 230_000,
  // Callers pass resolveProxyForConnect(); the default keeps the collector direct and hermetic.
  proxyAuth = '', proxyFetchFn = proxyFetch, firstProxyExit = randomInt(1_000_000),
} = {}) {
  const source = sources.find(source => source.id === id);
  if (!source) throw new Error('unknown food-price source');
  const adapter = FOOD_PRICE_ADAPTERS[id];
  const agent = new Agent({ connect: foodSourceConnectOptions(adapter) });
  const dispatcher = new Dispatcher1Wrapper(agent);
  const deadline = Date.now() + budgetMs;
  let requested = false;
  const hosts = new Set([new URL(source.url).hostname, ...(source.hosts ?? [])]);
  const protocols = source.allowHttp ? ['https:', 'http:'] : ['https:'];
  const cookies = new Map();
  const request = async (url, { binary = false, method = 'GET', body, headers = {} } = {}) => {
    if (requested) await pause(id === 'pihps' ? 500 : 250);
    requested = true;
    let target = new URL(url);
    for (let redirects = 0; redirects <= 4; redirects++) {
      if (!protocols.includes(target.protocol) || !hosts.has(target.hostname) || target.username || target.password) throw new Error('food source URL left its publisher');
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('food source fetch budget exceeded');
      const jar = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
      const timeoutMs = Math.min(id === 'twmoa' ? 60_000 : 20_000, remaining);
      const init = {
        method, body,
        headers: { 'User-Agent': CHROME_UA, Accept: '*/*', ...(jar ? { Cookie: jar } : {}), ...headers },
        dispatcher, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
      };
      let response;
      if (adapter?.proxy && proxyAuth) {
        // Proxy-first for publishers that refuse Railway egress on every run (FRED and fuel-prices precedent);
        // direct only when no exit reached the publisher at all.
        try {
          response = await fetchViaProxy(target.href, { ...init, timeoutMs }, { proxyAuth, proxyFetchFn, firstExit: firstProxyExit, deadline });
        } catch (error) {
          if (!error?.proxyUnreachable || deadline <= Date.now()) throw error;
          console.warn(`${id}: ${error.message}; trying direct`);
          response = await fetchFn(target.href, { ...init, signal: AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, deadline - Date.now()))) });
        }
      } else {
        response = await fetchFn(target.href, init);
      }
      for (const cookie of response.headers.getSetCookie?.() ?? []) {
        const [pair] = cookie.split(';');
        const at = pair.indexOf('=');
        if (at > 0) cookies.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = utf8Header(response.headers.get('location'));
        await response.body?.cancel();
        if (!location) throw new Error('food source redirect missing location');
        target = new URL(location, target);
        if (response.status === 303 || (method === 'POST' && response.status !== 307 && response.status !== 308)) { method = 'GET'; body = undefined; }
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
  const get = (url, binary = false) => request(url, { binary });
  try {
    let observations = [];
    let refreshedReports = [];
    let contexts = [];
    let reportUrl = source.url;
    if (adapter) {
      const result = await adapter.collect({
        get: (url, options = {}) => request(url, options), now, dated, pdfPages, readWorkbook, links, selectOptions,
        warn: message => console.warn(`${id}: ${message}`),
      });
      observations = result.observations ?? [];
      contexts = result.contexts ?? [];
      refreshedReports = result.refreshedReports ?? [];
      reportUrl = result.reportUrl ?? source.url;
    } else if (id === 'pihps') {
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
            rows = parsePbs(await readWorkbook(await get(annex.url, true)));
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
      if (!observations.length) throw new Error('ONAGRI report has no food prices');
      contexts = [{ countryCode: 'TN', country: 'Tunisia', referenceDate: latest.date, title: 'Bir El Kassaa monthly wholesale report', url: latest.url }];
    }
    if (!observations.length && !(source.contextOnly && contexts.some(context => context.referenceDate && !context.fetchFailed))) throw new Error(`${id} has no dated records`);
    if (observations.some(row => !isoDate(...row.date.split('-')) || row.date > dated(now, 0))) throw new Error('invalid or future food observation');
    if (contexts.some(context => context.referenceDate && (!isoDate(...context.referenceDate.split('-')) || context.referenceDate > dated(now, 0)))) throw new Error('invalid or future food context');
    return { observations, contexts, reportUrl, fetchedAt: now.toISOString(), ...(refreshedReports.length ? { refreshedReports } : {}) };
  } finally { await agent.close(); }
}
