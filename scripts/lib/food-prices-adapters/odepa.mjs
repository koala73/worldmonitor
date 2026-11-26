// Chile ODEPA weekly consumer prices from the CKAN datastore on datos.odepa.gob.cl (the datos.gob.cl mirror returns 404).
// Each calendar year is a separate resource of one dataset, so the newest week and the week before it can sit in
// different resources at the turn of the year.
const API = 'https://datos.odepa.gob.cl/api/3/action/';
export const DATASET_ID = 'd4646b7f-0d2e-4567-b6fa-932b1a6bb3f3';
const MAX_ROWS = 5_000;

// A staple basket whose labels ODEPA uses all year. Fruit and onion labels carry cultivar and season, so only
// year-round cultivars are listed; the onion season labels are separate series and never compared with each other.
export const BASKET = {
  'Marraqueta': 'Marraqueta bread',
  'Hallulla corriente': 'Hallulla bread',
  'Arroz grano ancho grado 2': 'Rice (long grain, grade 2)',
  'Azúcar': 'Sugar',
  'Aceite vegetal': 'Vegetable oil',
  'Harina sin polvos de hornear': 'Wheat flour (plain)',
  'Spaghetti N°5': 'Spaghetti',
  'Lentejas 6 mm': 'Lentils (6 mm)',
  'Leche Fluida Entera': 'Whole milk',
  'Huevo blanco grande (primera)': 'Eggs (white, large)',
  'Pollo Entero': 'Whole chicken',
  'Chuleta (centro)': 'Pork chop (centre cut)',
  'Posta Negra': 'Beef (posta negra)',
  'Papa|Asterix|Primera': 'Potatoes (Asterix, first grade)',
  'Tomate|Larga vida|Primera': 'Tomatoes (long-life, first grade)',
  'Zanahoria|Sin especificar|Primera': 'Carrots (first grade)',
  'Lechuga|Escarola|Primera': 'Lettuce (escarole, first grade)',
  'Manzana|Granny Smith|Primera': 'Apples (Granny Smith, first grade)',
  'Plátano|Sin especificar|Primera': 'Bananas (first grade)',
};
const ONIONS = {
  'Cebolla|Sin especificar|1a nueva(o)': 'Onions (new season, first grade)',
  'Cebolla|Sin especificar|1a (guarda)': 'Onions (stored, first grade)',
  'Cebolla|Sin especificar|1a (cosecha)': 'Onions (harvest, first grade)',
};
const PRODUCTS = { ...BASKET, ...ONIONS };

const UNITS = {
  '$/kilo': 'kg',
  '$/unidad': 'piece',
  '$/botella 900 ml': '900 ml bottle',
  '$/envase 400 gramos': '400 g pack',
  '$/Caja de 1 Litro': '1 litre carton',
  '$/bandeja 12 unidades': 'tray of 12',
  '$/bandeja 30 unidades': 'tray of 30',
};
const OUTLETS = {
  'Supermercado': ['supermarket', 'retail'],
  'Supermercado en Línea': ['online supermarket', 'retail'],
  'Feria libre': ['street market', 'retail'],
  'Mercado Minorista': ['retail market', 'retail'],
  'Carnicería': ['butcher', 'retail'],
  'Panadería': ['bakery', 'retail'],
  'Mercado Mayorista': ['wholesale market', 'wholesale'],
};
const REQUIRED = ['Fecha inicio', 'Region', 'Sector', 'Tipo de punto monitoreo', 'Producto', 'Unidad', 'Precio minimo', 'Precio maximo', 'Precio promedio'];
// Published prices are whole pesos or a comma decimal ("2067,000000").
const PRICE = /^\d{1,9}(?:,\d{1,8})?$/;

const text = value => String(value ?? '').replace(/\s+/g, ' ').trim();
// "Región de Los Lagos" -> "Los Lagos", "Región del Maule" -> "Maule", "Región Metropolitana de Santiago" -> "Metropolitana".
const region = value => text(value).replace(/^Región (?:del |de )?/i, '').replace(/ de Santiago$/i, '');
const price = value => {
  const raw = text(value);
  if (!PRICE.test(raw)) throw new Error('odepa price format changed');
  return Number(raw.replace(',', '.'));
};

/** Read a datastore page. A partial week would silently drop markets, so only the one-row probe may be partial. */
function records(payload, { partial = false } = {}) {
  const result = payload?.success === true ? payload.result : undefined;
  if (!Array.isArray(result?.records) || !Number.isInteger(result.total)) throw new Error('odepa datastore response format changed');
  if (!partial && result.total !== result.records.length) throw new Error(`odepa returned ${result.records.length} of ${result.total} rows`);
  return result.records;
}

/** Turn one week of datastore rows into basket observations dated by the week's Monday. */
export function parseOdepaWeek(rows, date) {
  if (!rows.length) return [];
  if (rows.some(row => REQUIRED.some(field => !(field in row)))) throw new Error('odepa columns format changed');
  const seen = new Set();
  const result = [];
  for (const row of rows) {
    const product = text(row.Producto);
    const item = PRODUCTS[product];
    const unit = UNITS[text(row.Unidad)];
    const outlet = OUTLETS[text(row['Tipo de punto monitoreo'])];
    if (!item || !unit) continue;
    if (!outlet) throw new Error(`odepa outlet type ${text(row['Tipo de punto monitoreo'])} format changed`);
    if (text(row['Fecha inicio']) !== date) throw new Error('odepa week date mismatch');
    const [low, high, mean] = [row['Precio minimo'], row['Precio maximo'], row['Precio promedio']].map(price);
    // A mean outside its own range means the columns moved.
    if (!(mean > 0) || low > mean || mean > high) throw new Error(`odepa ${product} mean outside its range`);
    const market = `${region(row.Region)} · ${text(row.Sector)}`;
    // Means carry six decimals of a peso, which has no subunit in use; publish whole pesos.
    const observation = { item: `${item} · ${outlet[0]}`, market, marketType: outlet[1], unit, currency: 'CLP', date, price: Math.round(mean), origin: '' };
    const key = JSON.stringify([market, outlet[1], observation.item, unit]);
    if (seen.has(key)) throw new Error(`odepa duplicate series ${key}`);
    seen.add(key);
    result.push(observation);
  }
  return result;
}

const monday = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).getUTCDay() === 1
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

export async function collect(ctx) {
  const search = async (resource, params, options) => {
    const query = new URLSearchParams({ resource_id: resource.id, ...params });
    return records(JSON.parse(await ctx.get(`${API}datastore_search?${query}`)), options);
  };
  const dataset = JSON.parse(await ctx.get(`${API}package_show?id=${DATASET_ID}`));
  if (dataset?.success !== true || !Array.isArray(dataset.result?.resources)) throw new Error('odepa dataset format changed');
  const years = dataset.result.resources
    .map(resource => ({ id: text(resource.id), year: Number(/año (\d{4})$/i.exec(text(resource.name))?.[1]), active: resource.datastore_active === true }))
    .filter(resource => resource.active && /^[0-9a-f-]{36}$/.test(resource.id) && resource.year >= 2008)
    .sort((a, b) => b.year - a.year)
    .slice(0, 2);
  if (!years.length) throw new Error('odepa yearly resources missing');

  // A new year's resource can exist before its first week is loaded; the previous year then holds the newest week.
  let latest = '';
  let at = -1;
  for (const [index, resource] of years.entries()) {
    const [row] = await search(resource, { sort: 'Fecha inicio desc', limit: '1', fields: 'Fecha inicio' }, { partial: true });
    if (row) { latest = text(row['Fecha inicio']); at = index; break; }
  }
  if (!latest) throw new Error('odepa has no weekly prices');
  if (!monday(latest)) throw new Error(`odepa week start ${latest} is not a Monday`);
  if (latest > ctx.dated(ctx.now, 0)) throw new Error(`odepa week ${latest} is in the future`);
  const prior = ctx.dated(new Date(`${latest}T00:00:00Z`), -7);

  const week = async (resource, date) => parseOdepaWeek(await search(resource, {
    filters: JSON.stringify({ 'Fecha inicio': date, Producto: Object.keys(PRODUCTS) }), limit: String(MAX_ROWS),
  }), date);
  const current = await week(years[at], latest);
  const present = new Set(current.map(row => row.item.replace(/ · [^·]+$/, '')));
  // The server-side product filter returns nothing for a renamed label, so a relabel would quietly shrink the basket.
  const basket = Object.values(BASKET).filter(item => present.has(item)).length;
  if (basket < Math.ceil(Object.keys(BASKET).length * 0.8)) throw new Error(`odepa basket labels format changed (${basket} of ${Object.keys(BASKET).length})`);

  let previous = await week(years[at], prior);
  if (!previous.length && years[at + 1]) previous = await week(years[at + 1], prior);
  const observations = [...current, ...previous];
  const refreshedReports = [latest, prior].filter(date => observations.some(row => row.date === date)).map(date => ({ date }));
  if (refreshedReports.length < 2) ctx.warn(`no week dated ${prior}`);
  return { observations, contexts: [], refreshedReports };
}
