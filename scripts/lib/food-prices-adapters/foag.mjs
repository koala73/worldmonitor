import { monthDate, positive, priceReport } from './monthly.mjs';

export const ENDPOINT = 'https://lindas.cz-aws.net/query';
const BASE = 'https://agriculture.ld.admin.ch/foag/';
const DIMENSIONS = ['date', 'product', 'unit', 'currency', 'production-system', 'product-origin', 'sales-region', 'data-method', 'product-properties', 'value-chain-detail', 'data-source', 'key-indicator-type', 'usage', 'cost-component', 'foreign-trade'];
export const FOAG_CUBES = { foagfruit: 'FruitsVegetablesPotatoes', foagegg: 'Eggs', foagmilk: 'MilkDairyProducts' };

/** Build a bounded consumer-price query for a known cube and validated starting month. */
export function observationQuery(cube, since) {
  if (!Object.values(FOAG_CUBES).includes(cube) || !/^\d{4}-\d{2}$/.test(since)) throw new Error('unknown FOAG cube or month');
  return `PREFIX d: <${BASE}dimension/> SELECT ?price ${DIMENSIONS.map((_, i) => `?v${i}`).join(' ')} WHERE {
    <${BASE}cube/${cube}/Consumption_Price_Month/observation/> <https://cube.link/observation> ?obs .
    ?obs <${BASE}measure/price> ?price; ${DIMENSIONS.map((dimension, i) => `d:${dimension} ?v${i}`).join('; ')} .
    FILTER(STR(?v0) >= "https://ld.admin.ch/time/month/${since}")
  } LIMIT 5001`;
}

/** Normalize latest Swiss consumer prices, preserving all series dimensions and converting centimes. */
export function parseFoag(bindings, labels) {
  if (!Array.isArray(bindings) || bindings.length > 5000) throw new Error('FOAG observation limit exceeded');
  const text = uri => { const label = labels.get(uri); if (!label) throw new Error(`FOAG dimension label missing: ${uri}`); return label; };
  const result = bindings.flatMap(row => {
    if (!positive(row.price?.value)) return [];
    const dims = DIMENSIONS.map((_, i) => row[`v${i}`]?.value);
    if (dims.some((uri, i) => typeof uri !== 'string' || !uri.startsWith(i === 0 ? 'https://ld.admin.ch/time/month/' : BASE))) throw new Error('FOAG dimension identifiers changed');
    const date = monthDate(dims[0].split('/').at(-1));
    if (!date) throw new Error('FOAG month format changed');
    if (dims[11] !== `${BASE}key-indicator-type/1` || dims[9] !== `${BASE}value-chain-detail/18`) throw new Error('FOAG cube is no longer consumer prices');
    const currency = dims[3].slice(dims[3].lastIndexOf('/') + 1);
    if (!['CHF', '1'].includes(currency)) throw new Error('FOAG price currency changed');
    const unit = text(dims[2]);
    // All remaining dimensions qualify the series, including method and source; they must never be collapsed.
    const qualifiers = [4, 7, 8, 10, 12, 13, 14].map(i => text(dims[i])).filter(value => !/^(?:NA|not applicable|nicht anwendbar)$/i.test(value));
    return [{ item: [text(dims[1]), ...qualifiers].join(' · '), market: text(dims[6]), marketType: 'retail', unit,
      currency: 'CHF', date, price: Number(row.price.value) * (currency === '1' ? 0.01 : 1), origin: text(dims[5]) }];
  });
  const latest = result.map(row => row.date).sort().at(-1);
  const selected = result.filter(row => row.date === latest);
  const keys = new Set(selected.map(row => JSON.stringify([row.item, row.market, row.unit, row.origin])));
  if (keys.size !== selected.length) throw new Error('FOAG duplicate series dimensions');
  return selected;
}

const query = async (ctx, sparql) => JSON.parse(await ctx.get(ENDPOINT, { method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/sparql-results+json' },
  body: new URLSearchParams({ query: sparql, format: 'json' }).toString() }));

/** Collect one consumer-price cube and resolve validated vocabulary labels in bounded batches. */
export const foagAdapter = cube => ({ collect: async ctx => {
  const since = new Date(Date.UTC(ctx.now.getUTCFullYear(), ctx.now.getUTCMonth() - 3, 1)).toISOString().slice(0, 7);
  const payload = await query(ctx, observationQuery(cube, since));
  const rows = payload.results?.bindings;
  if (!Array.isArray(rows) || rows.length > 5000) throw new Error('FOAG result shape changed');
  const uris = [...new Set(rows.flatMap(row => [1, 2, 4, 5, 6, 7, 8, 10, 12, 13, 14].map(i => row[`v${i}`]?.value)))];
  if (uris.some(uri => typeof uri !== 'string' || !new RegExp(`^https://agriculture\\.ld\\.admin\\.ch/foag/[a-z-]+/[A-Za-z0-9-]+$`).test(uri))) throw new Error('FOAG vocabulary identifiers changed');
  const labels = new Map();
  for (let at = 0; at < uris.length; at += 100) {
    const response = await query(ctx, `SELECT ?uri ?label WHERE { VALUES ?uri { ${uris.slice(at, at + 100).map(uri => `<${uri}>`).join(' ')} }
      ?uri <http://schema.org/name> ?label . FILTER(LANG(?label) IN ("en", "de", "")) } LIMIT 1001`);
    const bindings = response.results?.bindings;
    if (!Array.isArray(bindings) || bindings.length > 1000) throw new Error('FOAG vocabulary result changed');
    for (const row of bindings) {
      if (!labels.has(row.uri.value) || row.label['xml:lang'] === 'en') labels.set(row.uri.value, row.label.value);
    }
  }
  return priceReport(parseFoag(rows, labels), 'https://www.agrarmarktdaten.ch', ctx.now);
} });
