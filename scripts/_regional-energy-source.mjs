import feeds from './shared/regional-energy-feeds.json' with { type: 'json' };
import { readFileSync } from 'node:fs';
import { rootCertificates } from 'node:tls';
import { Agent, fetch as undiciFetch } from 'undici';
import { getOptionalUpstashCreds, upstashCommand } from './_upstash-rest.mjs';
import { assertZipExpansionWithin } from './_zip-expansion.mjs';
import {
  parsePgcb, parseNiso, parseCammesa, parseEskom, parseOns, parseAnpTrade,
  parseAnpPriceRows, parsePetrobangla, parseGse, pdfItems, pdfAllItems,
  discoverEskomCsv, discoverGsePdf, discoverPetrobanglaPdf, buildFeedSnapshot, inEffect, effectiveAt,
  discoverEvnPost, parseEvn,
  KOREM_FIXED_URLS, koremEnergySeriesUrl, koremLastDateUrl, koremCtUrls, parseKorem,
  COES_DEMAND_URL, coesDemandBody, parseCoes,
  ICCC_INDEX_URL, discoverPngFuelPosts, parsePngFuelPost,
  FCCC_INDEX_URL, discoverFijiFuelPdfs, parseFijiFuel,
} from './lib/regional-energy-feeds.mjs';

const USER_AGENT = 'WorldMonitor/1.0 (+https://www.worldmonitor.app)';
// The national price sheet uses about a dozen columns.
const ANP_SHEET_COLUMNS = 64;
const DOWNLOAD_HOSTS = new Set([
  'erp.powergrid.gov.bd', 'petrobangla.org.bd', 'www.niggrid.org',
  'www.eskom.co.za', 'api.cammesa.com', 'admin.gse.com.ge',
  'dados.ons.org.br', 'ons-aws-prod-opendata.s3.amazonaws.com',
  'www.gov.br', 'objectstorage.ap-dcc-gazipur-1.oraclecloud15.com',
  'evn.com.vn', 'portal.korem.kz', 'www.coes.org.pe',
  'iccc.gov.pg', 'fccc.gov.fj',
]);
export const regionalEnergyKey = id => `energy:regional:${id}:v1`;
export const regionalEnergyMetaKey = id => `seed-meta:energy:regional-${id}`;
const issuerAgents = new Map();
// @railway-runtime-dependency ./data/regional-energy/pgcb-issuer.pem
// @railway-runtime-dependency ./data/regional-energy/petrobangla-issuer.pem

function sourceFetch(url, options) {
  const issuer = {
    'erp.powergrid.gov.bd': 'pgcb',
    'petrobangla.org.bd': 'petrobangla',
  }[new URL(url).hostname];
  if (!issuer) return globalThis.fetch(url, options);
  if (!issuerAgents.has(issuer)) {
    // These servers omit their intermediates. Complete their chains using
    // the public Sectigo issuers, while retaining Node's roots and TLS checks.
    const intermediate = readFileSync(new URL(`./data/regional-energy/${issuer}-issuer.pem`, import.meta.url), 'utf8');
    issuerAgents.set(issuer, new Agent({ connect: { ca: [...rootCertificates, intermediate] } }));
  }
  return undiciFetch(url, { ...options, dispatcher: issuerAgents.get(issuer) });
}

export async function fetchRegionalEnergyFeed(id, { fetchFn = sourceFetch, nowMs = Date.now() } = {}) {
  const feed = feeds.find(f => f.id === id);
  if (!feed) throw new Error(`Unknown regional energy feed ${id}`);
  const downloaded = [];
  // `form` sends a urlencoded POST body; a redirect would drop it, so a POST must not redirect.
  const read = async (input, format = 'text', form = undefined) => {
    let url = new URL(input);
    for (let hop = 0; hop < 4; hop++) {
      if (url.protocol !== 'https:' || url.username || url.password || url.port || !DOWNLOAD_HOSTS.has(url.hostname)) throw new Error('Unapproved regional energy URL');
      const request = form === undefined
        ? { headers: { 'User-Agent': USER_AGENT } }
        : { method: 'POST', body: form, headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } };
      const response = await fetchFn(url.href, { ...request, signal: AbortSignal.timeout(25000), redirect: 'manual' });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (form !== undefined) throw new Error('Unexpected regional energy POST redirect');
        const location = response.headers.get('location');
        if (!location) throw new Error('Missing regional energy redirect location');
        url = new URL(location, url); continue;
      }
      if (!response.ok) throw new Error(`${id} provider HTTP ${response.status}`);
      const limit = 25_000_000;
      if (Number(response.headers.get('content-length')) > limit) throw new Error('Energy download exceeds size budget');
      const parts = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > limit) throw new Error('Energy download exceeds size budget');
        parts.push(chunk);
      }
      const bytes = Buffer.concat(parts);
      downloaded.push(url.href);
      if (format === 'bytes') return bytes;
      const body = bytes.toString('utf8');
      return format === 'json' ? JSON.parse(body) : body;
    }
    throw new Error('Too many regional energy redirects');
  };

  let points;
  if (id === 'pgcb') points = parsePgcb(await read(feed.sourceUrl));
  if (id === 'niso') points = parseNiso(await read(feed.sourceUrl));
  if (id === 'petrobangla') {
    const url = discoverPetrobanglaPdf(await read(`${feed.sourceUrl}?filters=${encodeURIComponent(JSON.stringify({ reports_type: '6922d2b181fc96cef9e99f16' }))}`));
    points = parsePetrobangla(await pdfItems(await read(url, 'bytes')));
  }
  if (id === 'cammesa') {
    const base = 'https://api.cammesa.com/demanda-svc';
    const demand = await read(`${base}/demanda/ObtieneDemandaYTemperaturaRegion?id_region=1002`, 'json');
    const generation = await read(`${base}/generacion/ObtieneGeneracioEnergiaPorRegion?id_region=1002`, 'json');
    points = parseCammesa(demand, generation);
  }
  if (id === 'eskom') {
    const datasets = ['System_hourly_actual_and_forecasted_demand', 'Weekly_unplanned_outages', 'Hourly_Generation'];
    const csvs = [];
    for (const title of datasets) {
      const media = await read(`https://www.eskom.co.za/dataportal/wp-json/wp/v2/media?search=${encodeURIComponent(title)}&per_page=20&orderby=date&order=desc`, 'json');
      csvs.push(await read(discoverEskomCsv(media, title)));
    }
    points = parseEskom(...csvs);
  }
  if (id === 'gse') {
    const url = discoverGsePdf(await read(feed.sourceUrl, 'json'));
    points = parseGse(await pdfItems(await read(url, 'bytes')));
  }
  if (id === 'ons') {
    const catalog = await read(feed.sourceUrl, 'json');
    if (catalog.success !== true) throw new Error('ONS catalog unavailable');
    const resources = (catalog.result?.resources ?? []).filter(r => r.format === 'CSV' && /BALANCO_ENERGIA_SUBSISTEMA_20\d{2}\.csv$/.test(r.url)).sort((a, b) => b.url.localeCompare(a.url));
    if (!resources.length) throw new Error('Missing ONS balance CSV');
    points = parseOns(await read(resources[0].url));
  }
  if (id === 'anp') {
    const tradePage = await read('https://www.gov.br/anp/pt-br/centrais-de-conteudo/dados-abertos/importacoes-e-exportacoes');
    const tradeUrl = [...tradePage.matchAll(/href="([^"]+)"/g)].find(m => /\/ie\/derivados\/importacoes-exportacoes-derivados-[^/]+\.csv$/.test(m[1]))?.[1];
    if (!tradeUrl) throw new Error('Missing ANP petroleum trade CSV');
    const trade = parseAnpTrade(await read(tradeUrl));
    const pricePage = await read('https://www.gov.br/anp/pt-br/assuntos/precos-e-defesa-da-concorrencia/precos/levantamento-de-precos-de-combustiveis-ultimas-semanas-pesquisadas');
    const priceUrl = [...pricePage.matchAll(/href="([^"]+)"/g)].find(m => /\/resumo[_-]semanal[_-]lpc[_-].+\.xlsx$/.test(m[1]))?.[1];
    if (!priceUrl) throw new Error('Missing ANP weekly price workbook');
    const bytes = await read(priceUrl, 'bytes');
    // ZIP headers are not trusted: inflate each entry with a bounded output
    // before ExcelJS inflates the same bytes without one.
    try {
      assertZipExpansionWithin(bytes, 50_000_000);
    } catch (err) {
      throw new Error(/expands past/.test(err.message) ? 'ANP workbook exceeds size budget' : `ANP workbook is ${err.message}`);
    }
    const { default: ExcelJS } = await import('exceljs');
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(bytes);
    const sheet = book.getWorksheet('BRASIL');
    if (!sheet) throw new Error('Missing national ANP price sheet');
    // ExcelJS indexes row values by column, so copying row.values would
    // allocate up to a far-right cell. Copy only cells within the price table.
    const sheetRows = [];
    sheet.eachRow(row => {
      const values = [];
      row.eachCell((cell, column) => { if (column <= ANP_SHEET_COLUMNS) values[column - 1] = cell.value; });
      sheetRows.push(Array.from(values));
    });
    points = [...trade, ...parseAnpPriceRows(sheetRows)];
  }
  if (id === 'evn') points = parseEvn(await read(discoverEvnPost(await read(feed.sourceUrl))));
  if (id === 'korem') {
    const summary = await read(KOREM_FIXED_URLS.summary, 'json');
    const maxConsumption = await read(KOREM_FIXED_URLS.maxConsumption, 'json');
    const torgNames = await read(KOREM_FIXED_URLS.torgNames, 'json');
    const zones = await read(KOREM_FIXED_URLS.zones, 'json');
    const series = await read(koremEnergySeriesUrl(summary), 'json');
    const ct = [];
    for (const plan of koremCtUrls(torgNames, zones, await read(koremLastDateUrl(torgNames), 'json'))) {
      ct.push({ zone: plan.zone, prices: await read(plan.prices, 'json'), volumes: await read(plan.volumes, 'json') });
    }
    points = parseKorem({ series, maxConsumption, ct });
  }
  if (id === 'coes') points = parseCoes(await read(COES_DEMAND_URL, 'json', coesDemandBody(nowMs)));
  if (id === 'iccc' || id === 'fccc') {
    // Releases are posted before they take effect. Use the newest release
    // already in effect, reading at most three.
    const candidates = id === 'iccc' ? discoverPngFuelPosts(await read(ICCC_INDEX_URL, 'json')) : discoverFijiFuelPdfs(await read(FCCC_INDEX_URL, 'json'));
    for (const url of candidates.slice(0, 3)) {
      const parsed = id === 'iccc' ? parsePngFuelPost(await read(url, 'json')) : parseFijiFuel(await pdfAllItems(await read(url, 'bytes')));
      points = inEffect(parsed, nowMs, feed.utcOffsetMin);
      if (points.length) break;
    }
    if (!points?.length) throw new Error(`No ${id} fuel price release in effect`);
  }
  if (feed.publishesAhead) points = inEffect(points, nowMs, feed.utcOffsetMin);
  const snapshot = buildFeedSnapshot(id, points, downloaded.at(-1), nowMs);
  return { ...snapshot, dataUrls: downloaded };
}

// Health reads a future newestItemAt as stale content. Date periods start at
// the provider's local midnight, and items published up to an hour ahead (COES
// schedules) count only once they have started.
export function regionalEnergyContentMeta(data, runStartedAtMs = Date.now()) {
  const offset = feeds.find(f => f.id === data.sourceId)?.utcOffsetMin;
  const times = data.observations.map(p => effectiveAt(p.period, offset)).filter(t => t <= runStartedAtMs);
  if (!times.length) return null;
  return { newestItemAt: Math.max(...times), oldestItemAt: Math.min(...times) };
}

export function regionalEnergySeedOptions(id) {
  const feed = feeds.find(f => f.id === id);
  if (!feed) throw new Error('Unknown regional energy feed');
  return {
    ttlSeconds: 14 * 86400,
    sourceVersion: `regional-energy-${id}-v1`,
    schemaVersion: 1,
    declareRecords: data => data.observations.length,
    recordCount: data => data.observations.length,
    validateFn: data => data.sourceId === id && data.observations.length > 0,
    emptyDataIsFailure: true,
    maxStaleMin: feed.intervalMin * 3,
    contentMeta: regionalEnergyContentMeta,
    maxContentAgeMin: feed.maxContentAgeMin,
    lockTtlMs: 300000,
    fetchPhaseTimeoutMs: 240000,
    afterFreshness: async () => {
      const creds = getOptionalUpstashCreds();
      if (!creds) throw new Error('Missing regional energy activation credentials');
      await upstashCommand(creds, ['SET', `seed-activated:energy:regional-${id}`, '1']);
    },
  };
}
