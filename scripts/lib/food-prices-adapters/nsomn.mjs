// Mongolia NSO weekly prices from the PXWeb API on data.1212.mn (www.1212.mn does not answer our hosts).
const API = 'https://data.1212.mn/api/v1/en/NSO/Economy,%20environment/Consumer%20Price%20Index/';
export const CAPITAL_TABLE = 'DT_NSO_0600_001V4.px';
export const AIMAG_TABLE = 'DT_NSO_0300_010V5.px';
const PRODUCT = 'Бүтээгдэхүүн';
const REGION = 'Бүс';
const TIME = 'Хугацаа';
const MAX_CELLS = 10_000;

const ITEMS = {
  'Flour, highest grade, prepacked, kg': ['Wheat flour (highest grade, packaged)', 'kg'],
  'Flour, grade 1, prepacked, kg': ['Wheat flour (grade 1, packaged)', 'kg'],
  'Flour, grade 2, prepacked, kg': ['Wheat flour (grade 2, packaged)', 'kg'],
  'Bread, piece': ['Bread', 'piece'],
  'Sliced bread, 600 gr, piece': ['Sliced bread (600 g)', 'piece'],
  'Bread, rye, piece': ['Rye bread', 'piece'],
  'Rice, prepacked, kg': ['Rice (packaged)', 'kg'],
  'Mutton, kg': ['Mutton', 'kg'],
  'Beef, kg': ['Beef', 'kg'],
  'Beef, without bones, kg': ['Beef (boneless)', 'kg'],
  'Horse meat, kg': ['Horse meat', 'kg'],
  'Goat meat, kg': ['Goat meat', 'kg'],
  'Milk, fresh, not pasteurised, l': ['Milk (fresh, unpasteurised)', 'litre'],
  'Milk, pasteurised, 500 g': ['Milk (pasteurised)', '500 g'],
  'Milk, pasteurised, l': ['Milk (pasteurised)', 'litre'],
  'Yoghurt, Tsutsgiitei, plain, 900 g': ['Yoghurt (Tsutsgiitei, plain)', '900 g'],
  'Butter cream, Sain zuuhii, 450 g': ['Butter cream (Sain zuuhii)', '450 g'],
  'Vegetable oil, l, imported': ['Vegetable oil (imported)', 'litre'],
  'Sugar, prepacked, kg, imported': ['Sugar (imported, packaged)', 'kg'],
  'Green tea, prepacked, 90 g': ['Green tea (packaged)', '90 g'],
  'Egg, piece, domestic': ['Eggs (domestic)', 'piece'],
  'Apple, kg, China': ['Apples', 'kg', 'China'],
  'Tomato, kg': ['Tomatoes', 'kg'],
  'Carrot, kg': ['Carrots', 'kg'],
  'Cabbage, kg': ['Cabbage', 'kg'],
  'Beet, kg': ['Beetroot', 'kg'],
  'Onion, kg': ['Onions', 'kg'],
};
// Fuel and livestock hay share these tables but are not food prices.
const NOT_FOOD = /petrol|diesel|gasoline|аи-\d|автобензин|hay bale/i;

const label = text => String(text ?? '').replace(/\s+/g, ' ').trim();

function categories(table, code, size) {
  const category = table.dimension?.[code]?.category;
  if (!category?.label || !category.index) throw new Error(`nsomn ${code} dimension format changed`);
  const positions = Array.isArray(category.index) ? Object.fromEntries(category.index.map((key, i) => [key, i])) : category.index;
  const entries = Object.entries(category.label);
  // Each code must own one declared position; repeated or extra codes would multiply the row loop
  // far beyond the declared cells (CWE-770).
  if (entries.length !== size) throw new Error(`nsomn ${code} dimension format changed`);
  const seen = new Set();
  return entries.map(([key, text]) => {
    const position = positions[key];
    if (!Number.isInteger(position) || position < 0 || position >= size || seen.has(position)) throw new Error(`nsomn ${code} dimension format changed`);
    seen.add(position);
    return { position, text: label(text) };
  });
}

export function parseNsoTable(table, { market } = {}) {
  const ids = market ? [PRODUCT, TIME] : [PRODUCT, REGION, TIME];
  if (!Array.isArray(table?.id) || table.id.join('|') !== ids.join('|') || !Array.isArray(table.size) || table.size.length !== ids.length
    || !Array.isArray(table.value) || table.value.length !== table.size.reduce((product, size) => product * size, 1)
    // The real tables hold 62 and 550 cells; a far larger cube would expand into millions of rows (CWE-770).
    || table.value.length > MAX_CELLS) {
    throw new Error('nsomn table shape format changed');
  }
  const strides = ids.map((_, i) => table.size.slice(i + 1).reduce((product, size) => product * size, 1));
  const catalogue = code => categories(table, code, table.size[ids.indexOf(code)]);
  const products = catalogue(PRODUCT);
  const regions = market ? [{ position: 0, text: market }] : catalogue(REGION).filter(region => !/ region$/i.test(region.text));
  const times = catalogue(TIME);
  if (times.some(time => !/^\d{4}-\d{2}-\d{2}$/.test(time.text) || Number.isNaN(Date.parse(`${time.text}T00:00:00Z`)))) {
    throw new Error('nsomn week label format changed');
  }
  const food = products.filter(product => !NOT_FOOD.test(product.text));
  const known = food.filter(product => ITEMS[product.text]);
  // A wholesale relabel would otherwise publish an empty or partial basket as if prices had vanished.
  if (known.length < Math.ceil(food.length * 0.8) || !known.length) throw new Error('nsomn product labels format changed');
  const result = [];
  for (const product of known) {
    const [item, unit, origin = ''] = ITEMS[product.text];
    for (const region of regions) {
      for (const time of times) {
        const offset = market ? product.position * strides[0] + time.position : product.position * strides[0] + region.position * strides[1] + time.position;
        const price = table.value[offset];
        if (typeof price === 'number' && Number.isFinite(price) && price > 0) {
          result.push({ item, market: region.text, marketType: 'retail', unit, currency: 'MNT', date: time.text, price, origin });
        }
      }
    }
  }
  return result;
}

const query = table => ({
  query: [
    { code: PRODUCT, selection: { filter: 'all', values: ['*'] } },
    ...(table === AIMAG_TABLE ? [{ code: REGION, selection: { filter: 'all', values: ['*'] } }] : []),
    { code: TIME, selection: { filter: 'top', values: ['2'] } },
  ],
  response: { format: 'json-stat2' },
});

export async function collect(ctx) {
  const tables = [];
  for (const [table, market] of [[CAPITAL_TABLE, 'Ulaanbaatar'], [AIMAG_TABLE, undefined]]) {
    const body = await ctx.get(`${API}${table}`, { method: 'POST', body: JSON.stringify(query(table)), headers: { 'Content-Type': 'application/json' } });
    tables.push(parseNsoTable(JSON.parse(body), { market }));
  }
  const [capital, aimags] = tables;
  const newest = rows => rows.map(row => row.date).sort().at(-1);
  const latest = newest(capital);
  if (!latest) throw new Error('nsomn capital table has no food prices');
  // The card shows only the newest week, so a table that lags would silently drop all of its markets.
  // Fail instead, which keeps the last complete snapshot until both tables carry the same week.
  if (newest(aimags) !== latest) throw new Error(`nsomn aimag table newest week ${newest(aimags) || 'missing'} does not match capital week ${latest}`);
  const rows = [...capital, ...aimags];
  if (latest > ctx.dated(ctx.now, 0)) throw new Error(`nsomn week ${latest} is in the future`);
  const prior = ctx.dated(new Date(`${latest}T00:00:00Z`), -7);
  const observations = rows.filter(row => row.date === latest || row.date === prior);
  if (observations.length < rows.length) ctx.warn(`dropped weeks other than ${latest} and ${prior}`);
  const refreshedReports = [latest, prior].filter(date => observations.some(row => row.date === date)).map(date => ({ date }));
  if (refreshedReports.length < 2) ctx.warn(`no week dated ${prior}`);
  return { observations, contexts: [], refreshedReports };
}
