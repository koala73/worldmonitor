import { priceReport } from './monthly.mjs';

// Statistics Canada table 18-10-0245-01, monthly average retail prices, through the Web Data Service.
// Since 2026-11-17 StatCan's Cloudflare edge refuses Railway's egress with 403 (scripts/lib/statcan-wds.mjs).
export const proxy = true;
const WDS = 'https://www150.statcan.gc.ca/t1/wds/rest/';
export const PRODUCT_ID = 18100245;
export const TABLE_URL = 'https://www150.statcan.gc.ca/t1/tbl1/en/tv.action?pid=1810024501';
// The WDS refuses more than 300 coordinates in one request.
const BATCH = 300;
const ATTEMPTS = 3;
// Personal-care and household products share the table with food.
const NON_FOOD = new Set(['Deodorant', 'Toothpaste', 'Shampoo', 'Laundry detergent']);

const text = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const UNITS = [
  [/^per kilogram$/, () => 'kg'],
  [/^unit$/, () => 'piece'],
  [/^1 dozen$/, () => 'dozen'],
  [/^(\d+(?:\.\d+)?) grams$/, n => `${n} g`],
  [/^(\d+(?:\.\d+)?) kilograms?$/, n => `${n} kg`],
  [/^(\d+(?:\.\d+)?) litres?$/, n => `${n} L`],
  [/^(\d+(?:\.\d+)?) millilitres$/, n => `${n} ml`],
  [/^\((\d+) bags\)$/, n => `${n} bags`],
];

/** Split a StatCan product label ("Bacon, 500 grams", "Tea (20 bags)") into the item and its published unit. */
export function splitProduct(label) {
  const name = text(label);
  const match = /^(.+?)(?:, | )((?:per kilogram|unit|1 dozen|\d+(?:\.\d+)? (?:grams|kilograms?|litres?|millilitres))|\(\d+ bags\))$/.exec(name);
  if (!match) throw new Error(`StatCan product unit format changed: ${name}`);
  for (const [pattern, unit] of UNITS) {
    const found = pattern.exec(match[2]);
    if (found) return { item: match[1], unit: unit(found[1]) };
  }
  throw new Error(`StatCan product unit format changed: ${name}`);
}

/** Read the cube's geography and food product members; fail when the table's shape moves. */
export function parseStatcanMetadata(payload) {
  const cube = Array.isArray(payload) && payload[0]?.status === 'SUCCESS' ? payload[0].object : undefined;
  const [geography, products] = cube?.dimension ?? [];
  if (Number(cube?.productId) !== PRODUCT_ID || cube.dimension.length !== 2 || Number(cube.frequencyCode) !== 6
    || text(geography?.dimensionNameEn) !== 'Geography' || text(products?.dimensionNameEn) !== 'Products'
    || !Array.isArray(geography.member) || !Array.isArray(products.member)) throw new Error('StatCan table metadata format changed');
  const members = list => list.filter(member => Number.isInteger(member.memberId) && member.memberId > 0 && !member.terminated)
    .map(member => ({ id: member.memberId, name: text(member.memberNameEn) }));
  const geographies = members(geography.member);
  // Non-food products are dropped by name before their unit is read, so a new household pack size cannot fail the run.
  const foods = members(products.member).filter(product => !NON_FOOD.has(product.name.split(/,| \(/)[0]))
    .map(product => ({ ...product, ...splitProduct(product.name) }));
  if (!geographies.some(geo => geo.name === 'Canada') || geographies.length < 10 || foods.length < 50) throw new Error('StatCan table members format changed');
  return { geographies, foods };
}

/** Turn WDS data points into the newest month's prices; older months of discontinued series are left out. */
export function parseStatcanPrices(responses, { geographies, foods }) {
  const geo = new Map(geographies.map(member => [member.id, member.name]));
  const food = new Map(foods.map(member => [member.id, member]));
  const points = [];
  for (const response of responses) {
    const object = response?.object;
    // A geography that does not collect a product has no series: FAILED, response code 2, vector 0, no points.
    // Any other failure is an outage and must not publish a report with that geography's prices missing.
    if (response?.status === 'FAILED' && Number(object?.responseStatusCode) === 2 && Number(object.vectorId) === 0 && !object.vectorDataPoint?.length) continue;
    if (response?.status !== 'SUCCESS' || Number(object?.responseStatusCode) !== 0) throw new Error(`StatCan series ${text(object?.coordinate) || 'unknown'} failed (${text(object?.responseStatusCode) || response?.status})`);
    const [geoId, productId, ...rest] = text(object?.coordinate).split('.').map(Number);
    if (Number(object?.productId) !== PRODUCT_ID || !geo.has(geoId) || !food.has(productId) || rest.some(Boolean)) throw new Error('StatCan coordinate format changed');
    const [point] = object.vectorDataPoint ?? [];
    // Suppressed and unreleased cells carry value null or a status code; neither is a price.
    if (!point || point.value === null || Number(point.statusCode) !== 0 || Number(point.scalarFactorCode) !== 0) continue;
    if (!/^\d{4}-\d{2}-01$/.test(point.refPer) || !(Number(point.value) > 0)) throw new Error('StatCan data point format changed');
    points.push({ market: geo.get(geoId), product: food.get(productId), date: point.refPer, price: Number(point.value) });
  }
  const latest = points.map(point => point.date).sort().at(-1);
  const rows = points.filter(point => point.date === latest);
  // A national table thinner than half the basket means the release or the coordinates changed.
  if (rows.filter(row => row.market === 'Canada').length < foods.length / 2) throw new Error('StatCan national prices missing');
  return rows.map(({ market, product, date, price }) => ({ item: product.item, market, marketType: 'retail', unit: product.unit, currency: 'CAD', date, price, origin: '' }));
}

/** Collect the newest month of Canadian retail food prices for every geography in the table. */
export async function collect(ctx) {
  // StatCan's edge intermittently answers 406 or a 200 "website is currently unavailable" HTML page
  // (scripts/lib/statcan-wds.mjs); a repeat request usually gets JSON. Other failures end the run.
  const post = async (method, body) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return JSON.parse(await ctx.get(`${WDS}${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
      } catch (error) {
        if (attempt >= ATTEMPTS || !(error instanceof SyntaxError || /\bHTTP 406$/.test(error?.message))) throw error;
        ctx.warn(`StatCan ${method} attempt ${attempt}: ${error instanceof SyntaxError ? 'not JSON' : error.message}; retrying`);
      }
    }
  };
  const members = parseStatcanMetadata(await post('getCubeMetadata', [{ productId: PRODUCT_ID }]));
  const coordinates = members.geographies.flatMap(geo => members.foods.map(food => ({ productId: PRODUCT_ID, coordinate: `${geo.id}.${food.id}.0.0.0.0.0.0.0.0`, latestN: 1 })));
  const responses = [];
  for (let at = 0; at < coordinates.length; at += BATCH) {
    const batch = coordinates.slice(at, at + BATCH);
    const page = await post('getDataFromCubePidCoordAndLatestNPeriods', batch);
    if (!Array.isArray(page) || page.length !== batch.length) throw new Error(`StatCan returned ${Array.isArray(page) ? page.length : 0} of ${batch.length} series`);
    responses.push(...page);
  }
  const rows = parseStatcanPrices(responses, members);
  const missing = members.geographies.filter(geo => !rows.some(row => row.market === geo.name)).map(geo => geo.name);
  if (missing.length) ctx.warn(`StatCan ${rows[0].date} has no prices for ${missing.join('; ')}`);
  return priceReport(rows, TABLE_URL, ctx.now);
}
