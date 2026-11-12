// Batch 3 regional fuel-price feeds (#10051): QatarEnergy (QA), Zambia ERB (ZM),
// Ghana NPA (GH), Burkina Faso SONABHY (BF), Zimbabwe ZERA (ZW), Philippines DOE
// (PH), Timor-Leste ANP (TL), Colombia CREG (CO) and Uruguay URSEA (UY).
// Parsers take a provider document and return observations; discovery helpers
// turn an index page into the document URLs to read, newest first.
import {
  cleanHtml, text, blocks, rows, number, observation, publicUrl,
  validDay, ymd, EN_MONTHS, EN_MONTH_RE, addUnique, decodeTitle,
} from './regional-energy-feeds.mjs';

const monthIndex = name => {
  const i = EN_MONTHS.findIndex(m => m.startsWith(name.slice(0, 3).toUpperCase()));
  if (name.length < 3 || i < 0) throw new Error(`Unknown month ${name}`);
  return i + 1;
};
const ES_MONTHS = ['ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO', 'JULIO', 'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE'];
const esMonthIndex = name => {
  const upper = name.toUpperCase().replace('SETIEMBRE', 'SEPTIEMBRE');
  const i = ES_MONTHS.indexOf(upper);
  if (i < 0) throw new Error(`Unknown month ${name}`);
  return i + 1;
};
// Named Latin-1 entities the CREG page uses for accented city names.
const ENTITIES = { amp: '&', quot: '"', apos: "'", nbsp: ' ', aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', uuml: 'ü' };
export const decodeEntities = s => String(s).replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[A-Za-z]{2,8});/g, (m, code) => {
  if (code[0] === '#') return String.fromCodePoint(Number(code[1] === 'x' ? `0${code.slice(1)}` : code.slice(1)));
  return Object.hasOwn(ENTITIES, code) ? ENTITIES[code] : m;
});
// Text runs on one line of one page, left to right.
const pageLine = (items, ref, tolerance = 2) => items.filter(i => i.page === ref.page && Math.abs(i.y - ref.y) <= tolerance).sort((a, b) => a.x - b.x);
const centre = i => i.x + i.width / 2;
const inBand = (i, x, halfWidth) => Math.abs(centre(i) - x) <= halfWidth;
const positive = (point, min, max, what) => {
  if (!(point.value >= min && point.value <= max)) throw new Error(`Implausible ${what}`);
  return point;
};

// ---- QatarEnergy: monthly fuel price history (PDF) ----

export const QATARENERGY_PDF_URL = 'https://www.qatarenergy.qa/en/Documents/Fuel%20Prices.pdf';
const QA_PRODUCTS = ['Gasoline Premium', 'Gasoline Super', 'Diesel'];

// Items come from pdfAllItems: the history table is on the second page. A
// month's price applies from its first day, so the period is that day.
export function parseQatarFuel(items) {
  if (!Array.isArray(items) || !items.length) throw new Error('Empty QatarEnergy PDF');
  const title = items.find(i => /^Fuel Price History/.test(i.text.trim()));
  if (!title) throw new Error('Unknown QatarEnergy document');
  const page = items.filter(i => i.page === title.page);
  const gasoline = page.filter(i => i.text.trim() === 'Gasoline').sort((a, b) => a.x - b.x);
  const premium = page.find(i => i.text.trim() === 'Premium'), superItem = page.find(i => i.text.trim() === 'Super'), diesel = page.find(i => i.text.trim() === 'Diesel');
  if (gasoline.length !== 2 || !premium || !superItem || !diesel || !(centre(premium) < centre(superItem) && centre(superItem) < centre(diesel))) throw new Error('Changed QatarEnergy price columns');
  const columns = [centre(gasoline[0]), centre(gasoline[1]), centre(diesel)];
  const step = columns[1] - columns[0];
  const points = new Map();
  for (const label of page) {
    const m = label.text.trim().match(/^([A-Za-z]{3,9})\.? (20\d{2})$/);
    if (!m || centre(label) >= columns[0] - step / 2) continue;
    const period = ymd(m[2], monthIndex(m[1]), 1);
    const line = pageLine(page, label).filter(i => i !== label);
    columns.forEach((x, c) => {
      // pdfjs splits "1.95" into runs; join the runs within the column band.
      const cell = line.filter(i => inBand(i, x, step / 2) && /^[\d.]+$/.test(i.text.trim())).map(i => i.text.trim()).join('');
      if (!cell) throw new Error(`Missing QatarEnergy ${QA_PRODUCTS[c]} price for ${period}`);
      addUnique(points, positive(observation('fuel.retail_price', period, cell, 'QAR/l', QA_PRODUCTS[c]), 0.5, 20, 'QatarEnergy price'));
    });
  }
  if (points.size < 3 * QA_PRODUCTS.length) throw new Error('Missing QatarEnergy price history');
  return [...points.values()];
}

// ---- Zambia ERB: monthly uniform pump price build-up (PDF) ----

const ERB_HOST = 'www.erb.org.zm';
// Category 24 is "Price build-up" (https://www.erb.org.zm/category/price-build-up/).
// A search, not the "Price build-up" category: the November 2026 release was
// posted outside that category, and the title pattern below filters the rest.
export const ERB_INDEX_URL = `https://${ERB_HOST}/wp-json/wp/v2/posts?search=${encodeURIComponent('Petroleum Pump Prices')}&orderby=date&order=desc&per_page=10&_fields=id,date,date_gmt,link,title,content`;
const ERB_TITLE = new RegExp(`^(${EN_MONTH_RE})\\s+(20\\d{2})\\s+Petroleum Pump Prices`, 'i');

// Newest first: the pump price build-up PDF of each monthly release and the
// day its prices take effect (the first of the month).
export function discoverErbBuildUps(index) {
  if (!Array.isArray(index)) throw new Error('Invalid ERB post index');
  const releases = [];
  for (const post of index) {
    const m = decodeTitle(post?.title?.rendered ?? '').match(ERB_TITLE);
    if (!m || typeof post.content?.rendered !== 'string' || typeof post.date_gmt !== 'string') continue;
    const period = ymd(m[2], monthIndex(m[1]), 1);
    const url = [...cleanHtml(post.content.rendered).matchAll(/href="(https:\/\/[^"<>\s]{1,300}\.pdf)"/gi)]
      .map(h => h[1]).find(u => /\/FuelPumpPrices\/[^/]*PUMP-PRICE-BUILD-UP\.pdf$/i.test(u) && !/WHOLESALE/i.test(u));
    if (!url) throw new Error(`Missing ERB pump price build-up for ${period}`);
    releases.push({ period, url: publicUrl(url, [ERB_HOST]), postedAt: post.date_gmt });
  }
  if (!releases.length) throw new Error('Missing ERB pump price post');
  return releases.sort((a, b) => b.period.localeCompare(a.period) || b.postedAt.localeCompare(a.postedAt));
}

const ERB_PRODUCTS = ['Petrol', 'Diesel', 'Kerosene'];
const ERB_ROWS = { 'Uniform Pump Price': 'fuel.retail_price', 'WHOLESALE PRICE TO OMC': 'fuel.wholesale_price' };

// The build-up prices every product per cubic metre; retail pumps price per
// litre, so the feed publishes ZMW per litre.
export function parseErbBuildUp(items, period) {
  if (!Array.isArray(items) || !items.length) throw new Error('Empty ERB PDF');
  validDay(period);
  const heading = items.find(i => new RegExp(`^(${EN_MONTH_RE}) (20\\d{2}) PUMP PRICE BUILD UP$`, 'i').test(i.text.trim()));
  const h = heading?.text.trim().match(/^([A-Za-z]+) (20\d{2})/);
  if (!h || ymd(h[2], monthIndex(h[1]), 1) !== period) throw new Error('ERB build-up month does not match its release');
  const headers = ERB_PRODUCTS.map(p => items.find(i => i.text.trim().toUpperCase() === p.toUpperCase()));
  if (headers.some(x => !x) || headers.some((x, i) => i && centre(x) <= centre(headers[i - 1]))) throw new Error('Changed ERB build-up columns');
  if (items.filter(i => /^ZMW\/\s*M$/.test(i.text.trim())).length !== 3) throw new Error('Changed ERB build-up unit');
  const step = centre(headers[1]) - centre(headers[0]);
  const points = new Map();
  for (const label of items) {
    const metric = ERB_ROWS[label.text.trim()];
    if (!metric) continue;
    const line = pageLine(items, label).filter(i => i !== label);
    headers.forEach((header, c) => {
      const cell = line.filter(i => inBand(i, centre(header), step / 2) && i.text.trim() !== '-').map(i => i.text.trim());
      if (cell.length !== 1) throw new Error(`Changed ERB ${label.text.trim()} row`);
      const perLitre = Number((number(cell[0]) / 1000).toFixed(5));
      addUnique(points, positive(observation(metric, period, perLitre, 'ZMW/l', ERB_PRODUCTS[c]), 1, 500, 'ERB price'));
    });
  }
  if (points.size !== Object.keys(ERB_ROWS).length * ERB_PRODUCTS.length) throw new Error('Missing ERB build-up rows');
  return [...points.values()];
}

// ---- Ghana NPA: ex-pump price listing and price indicators (XLSX via WP media) ----

const NPA_HOST = 'npa.gov.gh';
export const npaMediaUrl = title => `https://${NPA_HOST}/wp-json/wp/v2/media?search=${encodeURIComponent(title)}&per_page=10&orderby=date&order=desc&_fields=id,date,date_gmt,title,source_url,mime_type`;
const NPA_TITLES = {
  expump: new RegExp(`^Ex-Pump Prices of OMCs and LPGMCs as of (\\d{1,2})(?:st|nd|rd|th)? (${EN_MONTH_RE}),? (20\\d{2})`, 'i'),
  indicators: new RegExp(`^Petroleum Price Indicators \\(As of (\\d{1,2})(?:st|nd|rd|th)? (${EN_MONTH_RE}),? (20\\d{2})\\)`, 'i'),
};
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Re-uploads carry "(1)" or "Copy" suffixes; the newest "as of" day wins, then the newest upload.
export function discoverNpaWorkbook(media, kind) {
  if (!Array.isArray(media)) throw new Error('Invalid NPA media index');
  const pattern = NPA_TITLES[kind];
  if (!pattern) throw new Error('Unknown NPA workbook');
  const files = media.flatMap(item => {
    const m = decodeTitle(item?.title?.rendered ?? '').match(pattern);
    if (!m || item.mime_type !== XLSX_MIME || typeof item.source_url !== 'string' || typeof item.date_gmt !== 'string') return [];
    return [{ day: ymd(m[3], monthIndex(m[2]), m[1]), url: publicUrl(item.source_url, [NPA_HOST]), uploadedAt: item.date_gmt }];
  }).sort((a, b) => b.day.localeCompare(a.day) || b.uploadedAt.localeCompare(a.uploadedAt));
  if (!files.length) throw new Error(`Missing NPA ${kind} workbook`);
  return files[0];
}

const npaLabel = v => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : v);
const NPA_UNITS = { 'GHS/Lt': 'GHS/l', 'GHS/Kg': 'GHS/kg' };
const NPA_SUMMARY = { Max: 'fuel.retail_price.high', Min: 'fuel.retail_price.low', Average: 'fuel.retail_price' };

// Rows of the newest "Ex-Pump Prices" sheet: one company per row, then the
// Max, Min and Average rows the NPA prints under the listing. The average is
// the headline retail price; Max and Min bound the listing.
export function parseNpaExPumpRows(sheetRows) {
  const title = sheetRows.flat().map(npaLabel).find(v => typeof v === 'string' && /^EX-PUMP PRICES OF OMCs\/LPGMCs AS OF /i.test(v));
  const d = title?.match(/AS OF (\d{1,2})(?:st|nd|rd|th)? ([A-Za-z]+),? (20\d{2})$/i);
  if (!d) throw new Error('Unknown NPA ex-pump sheet');
  const period = ymd(d[3], monthIndex(d[2]), d[1]);
  const headerAt = sheetRows.findIndex(row => npaLabel(row[1]) === 'NO.' && npaLabel(row[2]) === 'COMPANY');
  if (headerAt < 0) throw new Error('Changed NPA ex-pump header');
  // Product headers run from the third column to the first blank cell; the
  // sheet carries a stray blank cell further right.
  const headerCells = sheetRows[headerAt].slice(3).map(npaLabel);
  const end = headerCells.findIndex(h => h == null || h === '');
  const products = headerCells.slice(0, end < 0 ? headerCells.length : end).map(h => {
    const m = typeof h === 'string' && h.match(/^(.+?) \((GHS\/(?:Lt|Kg))\)$/);
    if (!m || !NPA_UNITS[m[2]]) throw new Error('Changed NPA ex-pump header');
    return { name: m[1].replace(/\s*-\s*/g, ' ').replace(/\s+/g, ' '), unit: NPA_UNITS[m[2]] };
  });
  if (products.length < 3 || !products.some(p => /^DIESEL$/i.test(p.name))) throw new Error('Changed NPA ex-pump products');
  let companies = 0;
  const points = new Map();
  for (const row of sheetRows.slice(headerAt + 1)) {
    const label = npaLabel(row[2]);
    if (typeof label !== 'string') continue;
    const summary = label.match(/^(Max|Min|Average) \(GH[Sp]\/Lt\)$/);
    if (!summary) { if (Number.isInteger(row[1])) companies++; continue; }
    products.forEach((product, c) => {
      const raw = row[c + 3];
      if (raw == null || raw === '' || raw === '-') return;
      const area = summary[1] === 'Average' ? `${titleCase(product.name)}; average of OMCs` : `${titleCase(product.name)}; across OMCs`;
      addUnique(points, positive(observation(NPA_SUMMARY[summary[1]], period, Number(number(raw).toFixed(4)), product.unit, area), 1, 200, 'NPA price'));
    });
  }
  if (companies < 20) throw new Error('NPA ex-pump listing is incomplete');
  if (!points.size || !products.every(p => points.has(`fuel.retail_price|${titleCase(p.name)}; average of OMCs|${period}`))) throw new Error('Missing NPA price summary rows');
  return [...points.values()];
}
const titleCase = s => s.split(' ').map(w => (/^[A-Z]{2,}\d*$/.test(w) && !/^RON\d*$|^LPG$|^MGO$/.test(w) ? w[0] + w.slice(1).toLowerCase() : w)).join(' ');

const NPA_INDICATORS = {
  'Crude Oil (USD/BBL)': ['Crude Oil', 'USD/bbl'],
  'Petrol (USD/MT)': ['Petrol', 'USD/MT'],
  'Diesel (USD/MT)': ['Diesel', 'USD/MT'],
  'LPG (USD/MT)': ['LPG', 'USD/MT'],
  'Jet/Kerosene (USD/MT)': ['Jet/Kerosene', 'USD/MT'],
  'Fuel Oil (USD/MT)': ['Fuel Oil', 'USD/MT'],
};

// The "Media Publication" sheet: average FOB prices behind the price build-up
// (PBU) in effect, dated from the window's effective day. The estimated next
// window and the exchange-rate row are not read.
export function parseNpaIndicatorRows(sheetRows) {
  const header = sheetRows.find(row => row.some(v => typeof v === 'string' && /^Average FOB Prices for the PBU Effective /i.test(npaLabel(v))));
  if (!header) throw new Error('Changed NPA indicator header');
  const column = header.findIndex(v => typeof v === 'string' && /^Average FOB Prices for the PBU Effective /i.test(npaLabel(v)));
  const e = npaLabel(header[column]).match(/Effective (\d{1,2})(?:st|nd|rd|th)? ([A-Za-z]+),? (20\d{2})/);
  if (!e) throw new Error('Changed NPA indicator header');
  const period = ymd(e[3], monthIndex(e[2]), e[1]);
  const points = new Map();
  for (const row of sheetRows) {
    const known = NPA_INDICATORS[npaLabel(row[1])];
    if (!known) continue;
    const raw = row[column];
    if (raw == null || raw === '') throw new Error(`Missing NPA ${known[0]} indicator`);
    addUnique(points, positive(observation('fuel.fob_price', period, Number(number(raw).toFixed(4)), known[1], known[0]), 10, 10000, 'NPA indicator'));
  }
  if (points.size !== Object.keys(NPA_INDICATORS).length) throw new Error('Missing NPA indicator rows');
  return [...points.values()];
}

// ---- Burkina Faso SONABHY: official retail tariffs (Strapi JSON behind a Nuxt page) ----

const SONABHY_HOST = 'www.sonabhy.bf';
export const SONABHY_PAGE_URL = `https://${SONABHY_HOST}/tarif-hydrocarbures/`;
// The Strapi CMS the page named on 2026-11-02; a page that names another host fails the run.
export const SONABHY_CMS_URL = 'https://king-prawn-app-6bsvl.ondigitalocean.app/api';
export const SONABHY_API_HOSTS = [new URL(SONABHY_CMS_URL).hostname];

// The page's Nuxt state names the CMS the site reads; read that, so the
// prices served are the ones the official page shows.
export function discoverSonabhyState(html) {
  const m = cleanHtml(String(html)).match(/<script[^<>]*\ssrc="(\/_nuxt\/static\/\d{1,12}\/tarif-hydrocarbures\/state\.js)"/);
  if (!m) throw new Error('Missing SONABHY page state');
  return publicUrl(`https://${SONABHY_HOST}${m[1]}`, [SONABHY_HOST]);
}

export function discoverSonabhyApi(stateJs) {
  const m = String(stateJs).match(/strapi:\{url:"([^"]{1,300})"\}/);
  if (!m) throw new Error('Missing SONABHY CMS address');
  const base = m[1].replace(/\\u002F/g, '/').replace(/\/+$/, '');
  return publicUrl(`${base}/tarif-consommateurs`, SONABHY_API_HOSTS);
}

const BF_QUANTITIES = { '1 litre': 'XOF/l', '12,5 Kg': 'XOF/12.5kg', '6 Kg': 'XOF/6kg', '2,75 Kg': 'XOF/2.75kg' };

// Two joint orders are published: the price structure and the retail prices.
// Only the retail order is read, at its newest order date.
export function parseSonabhyTariffs(payload) {
  const entries = Array.isArray(payload?.data) ? payload.data : null;
  if (!entries) throw new Error('Invalid SONABHY tariff payload');
  const retail = entries
    .filter(e => /prix de vente/i.test(e?.attributes?.titre ?? '') && Array.isArray(e.attributes.liste_tarif?.data))
    .sort((a, b) => validDay(b.attributes.date_arrete).localeCompare(validDay(a.attributes.date_arrete)));
  if (!retail.length) throw new Error('Missing SONABHY retail tariff order');
  const { date_arrete: period, liste_tarif } = retail[0].attributes;
  const points = new Map();
  for (const city of liste_tarif.data) {
    if (typeof city?.ville !== 'string' || !city.ville || !Array.isArray(city.produits)) throw new Error('Changed SONABHY tariff list');
    for (const product of city.produits) {
      const unit = BF_QUANTITIES[product?.quantite];
      const m = String(product?.tarif ?? '').match(/^(\d{1,3}(?:[ .]\d{3})*|\d+) F CFA$/);
      if (!unit || !m || typeof product.nom !== 'string' || !product.nom) throw new Error(`Changed SONABHY tariff for ${city.ville}`);
      addUnique(points, positive(observation('fuel.retail_price', period, m[1].replace(/[ .]/g, ''), unit, `${product.nom}; ${city.ville}`), 100, 100000, 'SONABHY tariff'));
    }
  }
  if (![...points.keys()].some(k => /^fuel\.retail_price\|Super 91; Ouagadougou\|/.test(k))) throw new Error('Missing SONABHY Ouagadougou super price');
  return [...points.values()];
}

// ---- Zimbabwe ZERA: current energy prices widget (HTML) ----

export const ZERA_HOME_URL = 'https://www.zera.co.zw/';
const ZERA_HEADINGS = { 'Petrol Blend (E20)': 'fuel.retail_price', 'Diesel (D50)': 'fuel.retail_price', LPG: 'fuel.retail_price', Electricity: 'electricity.tariff' };
const ZERA_PERIODS = [
  [/^(USD|ZWG) Per Litre$/i, cur => [`${cur}/l`, '']],
  [/^(USD|ZWG) Per Kg$/i, cur => [`${cur}/kg`, '']],
  [/^(USD|ZWG) Per (?:first 50 Units|50 first Units)$/i, cur => [`${cur}/50kWh`, 'first 50 units']],
];

// The widget prints each product once with a USD price and a ZWG price; only
// the first price table of a product carries its heading. "As Of" is day-month-year.
export function parseZeraPrices(html) {
  const source = cleanHtml(String(html));
  const asOf = source.match(/As Of:\s*(\d{2})-(\d{2})-(20\d{2})/);
  if (!asOf) throw new Error('Missing ZERA price date');
  const period = ymd(asOf[3], asOf[2], asOf[1]);
  const tokens = [...source.matchAll(/bdt-price-table-(heading|integer-part|period)[^"<>]*"\s*>([^<]{0,80})</g)]
    .map(m => ({ kind: m[1], value: text(m[2]) }));
  const points = new Map();
  let product = null, price = null;
  for (const token of tokens) {
    if (token.kind === 'heading') {
      if (!Object.hasOwn(ZERA_HEADINGS, token.value)) throw new Error(`Unknown ZERA product ${token.value}`);
      product = token.value; price = null;
    } else if (token.kind === 'integer-part') {
      if (price !== null) throw new Error('Changed ZERA price table');
      price = token.value;
    } else {
      const rule = ZERA_PERIODS.find(([re]) => re.test(token.value));
      if (!product || price === null || !rule) throw new Error(`Changed ZERA price table: ${token.value}`);
      const currency = token.value.slice(0, 3).toUpperCase();
      const [unit, detail] = rule[1](currency);
      // The USD price is the headline; the ZWG price of the same product is its own series.
      const area = [product, detail, currency === 'ZWG' ? 'in ZWG' : ''].filter(Boolean).join('; ');
      addUnique(points, positive(observation(ZERA_HEADINGS[product], period, price, unit, area), 0.01, 10000, 'ZERA price'));
      price = null;
    }
  }
  for (const heading of ['Petrol Blend (E20)', 'Diesel (D50)']) {
    if (!points.has(`fuel.retail_price|${heading}|${period}`)) throw new Error(`Missing ZERA ${heading} price`);
  }
  return [...points.values()];
}

// ---- Philippines DOE: weekly NCR liquid fuel price monitoring (PDF) ----

export const DOE_HOST = 'doe.gov.ph';
// The site's media host; every weekly PDF link on the page starts with this.
export const DOE_MEDIA_BASE = 'https://d24qbtp4vooyzi.cloudfront.net/api/media/file/';
export const DOE_MEDIA_HOST = new URL(DOE_MEDIA_BASE).hostname;
export const DOE_NCR_PAGE_URL = `https://${DOE_HOST}/data-and-prices/liquid-fuels/retail-pump-prices/ncr-pump-prices`;
const DOE_LABEL = new RegExp(`^(${EN_MONTH_RE}) (\\d{1,2}) to (?:(${EN_MONTH_RE}) )?(\\d{1,2})$`, 'i');

// The page is server-rendered React; each weekly PDF link and its label sit in
// the serialized payload. Labels carry no year, so the year is the one that
// puts the week within the past year of `nowMs` (Manila time).
export function discoverDoeNcrPdfs(html, nowMs = Date.now()) {
  const source = String(html).replace(/\\"/g, '"').replace(/\\u0026/g, '&');
  const today = new Date(nowMs + 8 * 3600000).toISOString().slice(0, 10);
  const weeks = new Map();
  for (const m of source.matchAll(/"href":"(https:\/\/[^"<>\s]{1,300}\.pdf(?:\?[^"<>\s]{0,80})?)"[^\]]{0,400}?"children":\["([^"]{1,60})"/g)) {
    const label = m[2].trim().match(DOE_LABEL);
    if (!label || !m[1].startsWith(DOE_MEDIA_BASE)) continue;
    const url = publicUrl(m[1], [DOE_MEDIA_HOST]);
    const month = monthIndex(label[1]), day = Number(label[2]);
    const year = Number(today.slice(0, 4));
    // A week start after next week cannot be this year's; it is last year's.
    let weekStart = ymd(year, month, day);
    if (weekStart > validDay(new Date(Date.parse(`${today}T00:00:00Z`) + 7 * 86400000).toISOString().slice(0, 10))) weekStart = ymd(year - 1, month, day);
    if (!weeks.has(weekStart)) weeks.set(weekStart, url);
  }
  if (!weeks.size) throw new Error('Missing DOE NCR price monitoring PDF');
  return [...weeks].sort((a, b) => b[0].localeCompare(a[0])).map(([weekStart, url]) => ({ weekStart, url }));
}

const DOE_PRODUCTS = ['RON 100', 'RON 97', 'RON 95', 'RON 91', 'DIESEL', 'DIESEL PLUS', 'KEROSENE'];

// Each city block lists every product with brand prices, the overall range and
// the common price. Only the range and common price are read. The week start
// is the period: prices hold for the monitored week.
export function parseDoeNcrPrices(items) {
  if (!Array.isArray(items) || !items.length) throw new Error('Empty DOE PDF');
  const week = items.map(i => i.text.trim().match(new RegExp(`^\\(For the week of (${EN_MONTH_RE}) (\\d{1,2}) ?- ?(?:(${EN_MONTH_RE}) )?(\\d{1,2}), (20\\d{2})\\)$`, 'i'))).find(Boolean);
  if (!week || !items.some(i => /^Price Monitoring of Liquid Fuels$/i.test(i.text.trim())) || !items.some(i => i.text.trim() === 'NCR')) throw new Error('Unknown DOE price monitoring document');
  const startMonth = monthIndex(week[1]), endMonth = week[3] ? monthIndex(week[3]) : startMonth;
  const period = ymd(Number(week[5]) - (startMonth > endMonth ? 1 : 0), startMonth, week[2]);
  const pages = [...new Set(items.map(i => i.page))].sort((a, b) => a - b);
  const points = new Map();
  const assigned = new Set();
  let cities = 0;
  for (const page of pages) {
    const onPage = items.filter(i => i.page === page);
    const range = onPage.find(i => i.text.trim() === 'OVERALL RANGE'), common = onPage.find(i => i.text.trim() === 'COMMON'), area = onPage.find(i => i.text.trim() === 'AREA'), productHeader = onPage.find(i => i.text.trim() === 'PRODUCT');
    if (!range || !common || !area || !productHeader) throw new Error('Changed DOE price monitoring layout');
    const productLines = onPage
      .filter(i => DOE_PRODUCTS.includes(i.text.trim()) && Math.abs(i.x - productHeader.x) < 25)
      .sort((a, b) => b.y - a.y);
    const cityLabels = onPage.filter(i => i.x < productHeader.x - 10 && i.y < area.y - 5 && /^[A-ZÑ][\p{L}.'-]+(?: [A-ZÑ][\p{L}.'-]+)* City$/u.test(i.text.trim()));
    // A block runs from one RON 100 line to the next.
    const blocks = [];
    for (const line of productLines) {
      if (line.text.trim() === DOE_PRODUCTS[0] || !blocks.length) blocks.push([]);
      blocks.at(-1).push(line);
    }
    for (const block of blocks) {
      if (block.length < 4) throw new Error('Changed DOE price monitoring block');
      const top = block[0].y + 6, bottom = block.at(-1).y - 6;
      const labels = cityLabels.filter(i => i.y <= top && i.y >= bottom).map(i => i.text.trim());
      const city = [...new Set(labels.filter(l => !assigned.has(l)))];
      if (city.length !== 1) throw new Error('Ambiguous DOE city block');
      assigned.add(city[0]);
      cities++;
      for (const line of block) {
        const product = line.text.trim();
        const cells = pageLine(onPage, line, 3).filter(i => i !== line && i.x > range.x - 12);
        const low = cells.find(i => Math.abs(i.x - range.x) <= 12), high = cells.find(i => i.x >= range.x + 25 && i.x <= range.x + 50);
        const commonCell = cells.find(i => i.x >= common.x - 12 && i.x <= common.x + 20);
        if (low && high) {
          addUnique(points, positive(observation('fuel.retail_price.low', period, low.text.trim(), 'PHP/l', `${titleCase(product)}; ${city[0]}`), 10, 500, 'DOE price'));
          addUnique(points, positive(observation('fuel.retail_price.high', period, high.text.trim(), 'PHP/l', `${titleCase(product)}; ${city[0]}`), 10, 500, 'DOE price'));
        } else if (low || high) throw new Error(`Changed DOE ${product} range for ${city[0]}`);
        if (commonCell && commonCell.text.trim() !== '#N/A') {
          addUnique(points, positive(observation('fuel.retail_price', period, commonCell.text.trim(), 'PHP/l', `${titleCase(product)}; ${city[0]}; common price`), 10, 500, 'DOE price'));
        }
      }
    }
  }
  if (cities < 10 || !points.size) throw new Error('DOE price monitoring is incomplete');
  return [...points.values()];
}

// ---- Timor-Leste ANP: daily fuel prices at every filling station (PDF via WP posts) ----

const ANPTL_HOST = 'www.anp.tl';
// Category 65 is "Daily Fuel Price" (https://www.anp.tl/category/daily-fuel-price/).
export const ANPTL_INDEX_URL = `https://${ANPTL_HOST}/wp-json/wp/v2/posts?categories=65&per_page=10&_fields=id,date,date_gmt,link,title`;
const ANPTL_TITLE = new RegExp(`^Daily Fuel Price\\s*[–-]\\s*(\\d{1,2})(?:\\s*-\\s*(\\d{1,2}))?\\s+(${EN_MONTH_RE})\\s+(20\\d{2})$`, 'i');

// Newest first; the Tetum edition of each post is skipped. A post names the
// days its listing covers; prices hold from the first day.
export function discoverAnpTlPosts(index) {
  if (!Array.isArray(index)) throw new Error('Invalid ANP post index');
  const posts = index.flatMap(p => {
    const m = decodeTitle(p?.title?.rendered ?? '').match(ANPTL_TITLE);
    if (!m || !Number.isSafeInteger(p.id) || p.id <= 0 || typeof p.date_gmt !== 'string' || typeof p.link !== 'string') return [];
    const link = new URL(p.link);
    if (link.hostname !== ANPTL_HOST || link.pathname.startsWith('/tl/')) return [];
    const month = monthIndex(m[3]);
    const firstDay = ymd(m[4], month, m[1]);
    if (m[2] && ymd(m[4], month, m[2]) < firstDay) throw new Error('Invalid ANP price window');
    return [{ period: firstDay, postedAt: p.date_gmt, url: publicUrl(`https://${ANPTL_HOST}/wp-json/wp/v2/posts/${p.id}?_fields=id,date,date_gmt,link,title,content`, [ANPTL_HOST]) }];
  }).sort((a, b) => b.period.localeCompare(a.period) || b.postedAt.localeCompare(a.postedAt));
  if (!posts.length) throw new Error('Missing ANP daily fuel price post');
  return posts;
}

export function discoverAnpTlPdf(post) {
  const html = post?.content?.rendered;
  if (typeof html !== 'string') throw new Error('Invalid ANP post');
  const url = cleanHtml(html).match(/href="(https:\/\/www\.anp\.tl\/wp-content\/uploads\/[^"<>\s]{1,300}\.pdf)"/i)?.[1];
  if (!url) throw new Error('Missing ANP fuel price PDF');
  return publicUrl(url, [ANPTL_HOST]);
}

const TL_PRODUCTS = ['Petrol', 'Diesel'];
const tlPrice = s => {
  const m = String(s).trim().match(/^(\d{1,2}),(\d{2})$/);
  if (!m) throw new Error('Invalid ANP station price');
  return Number(`${m[1]}.${m[2]}`);
};

// Items come from pdfAllItems. Each station row is: number, municipality,
// station name, then "$" and a price for petrol and for diesel. Stations
// without prices are listed unpriced and skipped. The feed publishes the
// lowest and highest listed price per municipality and nationally.
export function parseAnpTlStations(items, period) {
  if (!Array.isArray(items) || !items.length) throw new Error('Empty ANP PDF');
  validDay(period);
  if (!items.some(i => /^DAILY FUEL PRICES FROM ALL FUEL FILLING STATIONS/i.test(i.text.trim()))) throw new Error('Unknown ANP fuel price document');
  const header = items.find(i => i.text.trim() === 'Municipality');
  const petrol = items.find(i => i.text.trim() === 'Petrol'), diesel = items.find(i => i.text.trim() === 'Diesel');
  if (!header || !petrol || !diesel || petrol.x >= diesel.x) throw new Error('Changed ANP station columns');
  const stations = [];
  for (const no of items) {
    if (!/^\d{1,3}$/.test(no.text.trim()) || no.x >= header.x) continue;
    const line = pageLine(items, no).filter(i => i !== no);
    const dollar = line.findIndex(i => i.text.trim() === '$');
    const [municipality, ...rest] = (dollar < 0 ? line : line.slice(0, dollar)).map(i => i.text.trim());
    if (!municipality || !rest.length) throw new Error('Changed ANP station row');
    if (dollar < 0) { stations.push({ municipality, name: rest.join(' ') }); continue; }
    const prices = line.slice(dollar).map(i => i.text.trim());
    if (prices.length !== 4 || prices[0] !== '$' || prices[2] !== '$') throw new Error(`Changed ANP price cells for ${rest.join(' ')}`);
    stations.push({ municipality, name: rest.join(' '), petrol: tlPrice(prices[1]), diesel: tlPrice(prices[3]) });
  }
  const priced = stations.filter(s => s.petrol != null);
  if (stations.length < 40 || priced.length < 30) throw new Error('ANP station listing is incomplete');
  const points = new Map();
  const publish = (area, values) => {
    addUnique(points, positive(observation('fuel.retail_price.low', period, Math.min(...values), 'USD/l', area), 0.3, 10, 'ANP price'));
    addUnique(points, positive(observation('fuel.retail_price.high', period, Math.max(...values), 'USD/l', area), 0.3, 10, 'ANP price'));
  };
  for (const product of TL_PRODUCTS) {
    const key = product.toLowerCase();
    publish(`${product}; all municipalities`, priced.map(s => s[key]));
    for (const municipality of [...new Set(priced.map(s => s.municipality))]) {
      publish(`${product}; ${municipality}`, priced.filter(s => s.municipality === municipality).map(s => s[key]));
    }
  }
  return [...points.values()];
}

// ---- Colombia CREG: regulated gasoline and diesel prices by city (HTML tables) ----

export const CREG_PAGE_URL = 'https://creg.gov.co/publicaciones/15565/precios-de-combustibles-liquidos/';
const CREG_CAPTION = /^Precios vigentes a partir del (\d{1,2}) de ([a-záé]+) del? (20\d{2})/i;
const CREG_HEADER = ['No.', 'Ciudad', 'Gasolina MC ($/gal)', 'ACPM ($/gal)'];
const CREG_PRODUCTS = ['Gasolina MC', 'ACPM'];
// Pesos print with a dot for thousands ("16.331") and, if ever, a decimal comma.
const copNumber = s => {
  const m = String(s).trim().match(/^(\d{1,3}(?:\.\d{3})*)(?:,(\d+))?$/);
  if (!m) throw new Error('Invalid CREG price');
  return Number(`${m[1].replace(/\./g, '')}${m[2] ? `.${m[2]}` : ''}`);
};

// Each table is one price change, captioned with its effective day. The
// three newest tables are read so a month-on-month change is available.
export function parseCregPrices(html) {
  const source = cleanHtml(String(html));
  const tables = blocks(source, 'table').map(table => {
    const caption = blocks(table.inner, 'caption')[0];
    const m = caption && decodeEntities(text(caption.inner)).match(CREG_CAPTION);
    return m ? { period: ymd(m[3], esMonthIndex(m[2]), m[1]), inner: table.inner } : null;
  }).filter(Boolean).sort((a, b) => b.period.localeCompare(a.period)).slice(0, 3);
  if (!tables.length) throw new Error('Missing CREG price tables');
  const points = new Map();
  for (const table of tables) {
    const [header, ...data] = rows(table.inner).map(row => row.map(decodeEntities));
    if (header?.join('|') !== CREG_HEADER.join('|')) throw new Error('Changed CREG price table');
    let citiesRead = 0;
    for (const row of data) {
      if (row.length !== 4) throw new Error('Changed CREG price row');
      const city = row[1];
      if (!city) throw new Error('Changed CREG price row');
      if (/^\d+$/.test(row[0])) citiesRead++;
      CREG_PRODUCTS.forEach((product, c) => addUnique(points, positive(observation('fuel.retail_price', table.period, copNumber(row[c + 2]), 'COP/gal', `${product}; ${city}`), 1000, 100000, 'CREG price')));
    }
    if (citiesRead < 10 || !points.has(`fuel.retail_price|Gasolina MC; Bogotá|${table.period}`)) throw new Error('CREG price table is incomplete');
  }
  return [...points.values()];
}

// ---- Uruguay URSEA: maximum retail prices, PMIT and reference prices (HTML) ----

const URSEA_HOST = 'www.gub.uy';
const URSEA_BASE = `https://${URSEA_HOST}/unidad-reguladora-servicios-energia-agua`;
export const URSEA_TOPIC_URL = `${URSEA_BASE}/tematica/hidrocarburos`;

// The topic page lists items newest first. Returns, newest first, the news
// items that announce the Executive's maximum retail prices and the
// reference-price publications.
export function discoverUrseaPages(html) {
  const source = cleanHtml(String(html));
  const links = kind => [...new Set([...source.matchAll(/(?:<article about|href)="(\/unidad-reguladora-servicios-energia-agua\/comunicacion\/[^"<>\s]{1,200})"/g)].map(m => m[1]))]
    .filter(path => kind.test(path)).map(path => publicUrl(`https://${URSEA_HOST}${path}`, [URSEA_HOST]));
  const result = {
    maximum: links(/\/noticias\/ursea-determino-valor-del-pmit-poder-ejecutivo-actualizo-pvp(?:-\d+)?$/),
    reference: links(/\/publicaciones\/precios-venta-publico-referencia-para-gasolinas-gasoil-50-s(?:-\d+)?$/),
  };
  if (!result.maximum.length || !result.reference.length) throw new Error('Missing URSEA price pages');
  return result;
}

const UY_RETAIL = { 'Gasolina Súper 95': 'UYU/l', 'Gasolina Premium 97': 'UYU/l', 'Gas Oil 50S': 'UYU/l', 'Gas Oil 10S': 'UYU/l', 'Supergás (GLP)': 'UYU/kg' };
const UY_PMIT = { 'Gasolina Premium 97': 'UYU/l', 'Gasolina Super 95': 'UYU/l', Queroseno: 'UYU/l', 'Gas Oil 50s': 'UYU/l', 'Gas Oil 10s': 'UYU/l', 'GLP Envasado': 'UYU/kg' };
const uyNumber = s => number(String(s).replace(/^\$\s*/, ''), true);
const uyEffectiveDay = (source, what) => {
  const m = text(source).match(/a partir de las 00:00 (?:horas |h )?del (\d{1,2})\.?[º°]? de ([a-záé]+) de (20\d{2})/i);
  if (!m) throw new Error(`Missing URSEA ${what} effective date`);
  return ymd(m[3], esMonthIndex(m[2]), m[1]);
};

// The news item lists the Executive's maximum pump prices and tabulates the
// PMIT, the maximum wholesale price to service stations, both effective the
// same day.
export function parseUrseaMaximumPrices(html) {
  const source = cleanHtml(String(html));
  const main = blocks(source, 'main')[0]?.inner ?? source;
  const period = uyEffectiveDay(main, 'maximum price');
  const points = new Map();
  for (const item of blocks(main, 'li').map(li => text(li.inner))) {
    const m = item.match(/^(.{3,40}?):\s*\$\s*(\d{1,3},\d{2})$/);
    if (!m || !Object.hasOwn(UY_RETAIL, m[1])) continue;
    addUnique(points, positive(observation('fuel.retail_price', period, uyNumber(m[2]), UY_RETAIL[m[1]], m[1]), 5, 500, 'URSEA price'));
  }
  for (const table of blocks(main, 'table')) {
    const data = rows(table.inner);
    if (!/^PMIT/.test(data[0]?.[1] ?? '')) continue;
    for (const row of data.slice(1)) {
      if (row.length !== 2 || !Object.hasOwn(UY_PMIT, row[0])) continue;
      addUnique(points, positive(observation('fuel.wholesale_price', period, uyNumber(row[1]), UY_PMIT[row[0]], `${row[0]}; PMIT`), 5, 500, 'URSEA price'));
    }
  }
  for (const product of ['Gasolina Súper 95', 'Gas Oil 50S']) {
    if (!points.has(`fuel.retail_price|${product}|${period}`)) throw new Error(`Missing URSEA ${product} maximum price`);
  }
  return [...points.values()];
}

const UY_REFERENCE_COLUMNS = { 'Super 95($/l)': 'Gasolina Súper 95', 'Premium 97 ($/l)': 'Gasolina Premium 97', 'Gasoil 50-S ($/l)': 'Gas Oil 50S' };

// The publication tabulates the reference retail price built from the newest
// import parity price (PPI), for the month the table names.
export function parseUrseaReferencePrices(html) {
  const source = cleanHtml(String(html));
  const table = blocks(source, 'table').map(t => rows(t.inner)).find(data => /^Precios vigentes per[ií]odo /i.test(data[0]?.[0] ?? ''));
  if (!table) throw new Error('Missing URSEA reference price table');
  const m = table[0][0].match(/^Precios vigentes per[ií]odo (\d{1,2})\/(\d{1,2}) al \d{1,2}\/\d{1,2} del (20\d{2})$/i);
  if (!m) throw new Error('Changed URSEA reference price period');
  const period = ymd(m[3], m[2], m[1]);
  const products = table[0].slice(1).map(h => UY_REFERENCE_COLUMNS[h.replace(/\s+/g, ' ')]);
  if (products.length !== 3 || products.some(p => !p)) throw new Error('Changed URSEA reference price columns');
  const parity = table.filter(row => /^PPI \d{1,2} /i.test(row[0] ?? '')).at(-1);
  const reference = table.find(row => /^Precio de venta al p[uú]blico \(de referencia\)$/i.test(row[0] ?? ''));
  if (!parity || !reference || parity.length !== 4 || reference.length !== 4) throw new Error('Changed URSEA reference price rows');
  const points = new Map();
  products.forEach((product, c) => {
    addUnique(points, positive(observation('fuel.import_parity_price', period, uyNumber(parity[c + 1]), 'UYU/l', `${product}; PPI, before taxes`), 5, 500, 'URSEA price'));
    addUnique(points, positive(observation('fuel.reference_price', period, uyNumber(reference[c + 1]), 'UYU/l', product), 5, 500, 'URSEA price'));
  });
  return [...points.values()];
}

