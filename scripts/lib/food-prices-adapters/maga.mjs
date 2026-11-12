import { htmlElements, isoDate, plainText } from '../food-prices.mjs';

export const MAGA_URL = 'https://precios.maga.gob.gt/diarios/diarios.html';
const MARKET = 'La Terminal';

const ITEMS = {
  'Aguacate criollo, mediano, de primera': 'Avocado (criollo, medium, 1st grade)',
  'Aguacate Hass, mediano, de primera': 'Avocado (Hass, medium, 1st grade)',
  'Aguacate Hass, mediano, de primera, importado': 'Avocado (Hass, medium, 1st grade, imported)',
  'Ajo blanco, mediano, de primera': 'Garlic (white, medium, 1st grade)',
  'Apio grande, de primera': 'Celery (large, 1st grade)',
  'Apio mediano, de primera': 'Celery (medium, 1st grade)',
  'Arroz oro, blanco de primera': 'Rice (milled white, 1st grade)',
  'Arroz oro, blanco de segunda': 'Rice (milled white, 2nd grade)',
  'Arveja china, revuelta, de primera': 'Snow peas (mixed, 1st grade)',
  'Arveja dulce en grano': 'Sweet peas (shelled)',
  'Bagre (Juilin), filete seco de primera': 'Catfish fillet (dried, 1st grade)',
  'Banano criollo, mediano, de primera': 'Banana (criollo, medium, 1st grade)',
  'Banano de exportación, mediano, de primera': 'Banana (export, medium, 1st grade)',
  'Bovino en canal, de primera': 'Beef carcass (1st grade)',
  'Brócoli mediano, de primera': 'Broccoli (medium, 1st grade)',
  'Caja de manzana Royal Gala importada mediana': 'Apple (Royal Gala, medium, imported)',
  'Caja de Manzana Verde importada mediana': 'Apple (green, medium, imported)',
  'Camarón grande, de primera con cabeza (estanque)': 'Shrimp (large, head-on, farmed, 1st grade)',
  'Camarón grande, de primera sin cabeza (estanque)': 'Shrimp (large, headless, farmed, 1st grade)',
  'Camarón mediano, de primera con cabeza (estanque)': 'Shrimp (medium, head-on, farmed, 1st grade)',
  'Camarón mediano, de primera sin cabeza (estanque)': 'Shrimp (medium, headless, farmed, 1st grade)',
  'Camarón pequeño, de primera con cabeza (estanque)': 'Shrimp (small, head-on, farmed, 1st grade)',
  'Camarón pequeño, de primera sin cabeza (estanque)': 'Shrimp (small, headless, farmed, 1st grade)',
  'Camote, de primera': 'Sweet potato (1st grade)',
  'Cebolla con tallo, blanca, mediana, de primera': 'Spring onion (white, medium, 1st grade)',
  'Cebolla seca, amarilla, mediana, de primera': 'Onion (dry yellow, medium, 1st grade)',
  'Cebolla seca, blanca, mediana, de primera': 'Onion (dry white, medium, 1st grade)',
  'Cebolla seca, blanca, mediana, de primera, importada': 'Onion (dry white, medium, 1st grade, imported)',
  'Cebolla seca, blanca, mediana, de segunda': 'Onion (dry white, medium, 2nd grade)',
  'Cebolla seca, blanca, mediana, de segunda, importada': 'Onion (dry white, medium, 2nd grade, imported)',
  'Cebolla seca, morada, mediana, de primera': 'Onion (dry red, medium, 1st grade)',
  'Cebolla seca, morada, mediana, de primera, importada': 'Onion (dry red, medium, 1st grade, imported)',
  'Cherna filete seco': 'Grouper fillet (dried)',
  'Cherna filete seco importado': 'Grouper fillet (dried, imported)',
  'Chile Jalapeño, grande, de primera': 'Jalapeño pepper (large, 1st grade)',
  'Chile Jalapeño, mediano, de primera': 'Jalapeño pepper (medium, 1st grade)',
  'Chile Pimiento, grande, de primera': 'Bell pepper (large, 1st grade)',
  'Chile Pimiento, mediano, de primera': 'Bell pepper (medium, 1st grade)',
  'Cilantro de primera': 'Coriander (1st grade)',
  'Coco verde, mediano, de primera': 'Green coconut (medium, 1st grade)',
  'Coliflor mediana, de primera': 'Cauliflower (medium, 1st grade)',
  'Crema pura': 'Cream',
  'Cuadril y Pierna de pollo, de primera': 'Chicken thigh and leg (1st grade)',
  'Ejote Chino': 'Green beans (Chinese)',
  'Ejote francés, de primera': 'Green beans (French, 1st grade)',
  'Filete de dorado, de primera': 'Mahi-mahi fillet (1st grade)',
  'Filete de róbalo, de primera': 'Snook fillet (1st grade)',
  'Filete de tiburón, de primera': 'Shark fillet (1st grade)',
  'Fresa mediana, de primera': 'Strawberry (medium, 1st grade)',
  'Frijol blanco, de primera': 'Beans (white, 1st grade)',
  'Frijol blanco, de segunda': 'Beans (white, 2nd grade)',
  'Frijol negro, de primera': 'Beans (black, 1st grade)',
  'Frijol negro, de primera, importado': 'Beans (black, 1st grade, imported)',
  'Frijol negro, de segunda': 'Beans (black, 2nd grade)',
  'Frijol rojo, de primera': 'Beans (red, 1st grade)',
  'Frijol rojo, de segunda': 'Beans (red, 2nd grade)',
  'Güicoy sazón, mediano, de primera': 'Squash (ripe güicoy, medium, 1st grade)',
  'Güisquil mediano, de primera': 'Chayote (medium, 1st grade)',
  'Hierba buena, de primera': 'Mint (1st grade)',
  'Huevo blanco, extra': 'Eggs (white, extra large)',
  'Huevo blanco, grande': 'Eggs (white, large)',
  'Huevo blanco, mediano': 'Eggs (white, medium)',
  'Huevo blanco, pequeño': 'Eggs (white, small)',
  'Jocote de Corona, grande, de primera': 'Jocote (Corona, large, 1st grade)',
  'Jocote de Corona, mediano, de primera': 'Jocote (Corona, medium, 1st grade)',
  'Lechuga repollada, mediana, de primera': 'Lettuce (iceberg, medium, 1st grade)',
  'Limón criollo, mediano, de primera': 'Lime (criollo, medium, 1st grade)',
  'Limón Persa, mediano, de primera': 'Lime (Persian, medium, 1st grade)',
  'Loroco de primera': 'Loroco (1st grade)',
  'Maíz amarillo, de primera': 'Maize (yellow, 1st grade)',
  'Maíz amarillo, de primera,otros orígenes': 'Maize (yellow, 1st grade, other origins)',
  'Maíz amarillo, de segunda': 'Maize (yellow, 2nd grade)',
  'Maíz blanco, de primera': 'Maize (white, 1st grade)',
  'Maíz blanco, de primera, otros orígenes': 'Maize (white, 1st grade, other origins)',
  'Maíz blanco, de segunda': 'Maize (white, 2nd grade)',
  'Malanga de primera': 'Malanga (1st grade)',
  'Mandarina criolla, mediana, de primera': 'Mandarin (criollo, medium, 1st grade)',
  'Manzana Estrella, mediana, de primera': 'Apple (Estrella, medium, 1st grade)',
  'Melón Harper,mediano de primera': 'Melon (Harper, medium, 1st grade)',
  'Miltomate verde, con cascara de primera': 'Tomatillo (green, husked, 1st grade)',
  'Mora mediana, de primera': 'Blackberry (medium, 1st grade)',
  'Naranja Piña (Azucarona), mediana, de primera': 'Orange (Piña, medium, 1st grade)',
  'Naranja Valencia, mediana, de primera': 'Orange (Valencia, medium, 1st grade)',
  'Papa Loman, lavada, grande, de primera': 'Potato (Loman, washed, large, 1st grade)',
  'Papa Loman, lavada, mediana, de primera': 'Potato (Loman, washed, medium, 1st grade)',
  'Papa Loman, lavada, pequeña, de primera': 'Potato (Loman, washed, small, 1st grade)',
  'Papa redonda, lavada, grande, de primera': 'Potato (round, washed, large, 1st grade)',
  'Papa redonda, sin lavar, grande, de primera': 'Potato (round, unwashed, large, 1st grade)',
  'Papaya Tainung, mediana, de primera': 'Papaya (Tainung, medium, 1st grade)',
  'Pargo entero, revuelto, de primera': 'Snapper (whole, mixed sizes, 1st grade)',
  'Pargo mediano, de primera': 'Snapper (medium, 1st grade)',
  'Pechuga de pollo, con ala, de primera': 'Chicken breast (with wing, 1st grade)',
  'Pechuga de pollo, de primera': 'Chicken breast (1st grade)',
  'Pepino mediano, de primera': 'Cucumber (medium, 1st grade)',
  'Perulero blanco, mediano, de primera': 'Perulero squash (white, medium, 1st grade)',
  'Piña mediana, de primera': 'Pineapple (medium, 1st grade)',
  'Plátano grande, de primera': 'Plantain (large, 1st grade)',
  'Plátano mediano, de primera': 'Plantain (medium, 1st grade)',
  'Pollo entero, sin menudos, de primera': 'Chicken (whole, without giblets, 1st grade)',
  'Pollo importado (piezas)': 'Chicken pieces (imported)',
  'Porcino en canal': 'Pork carcass',
  'Queso fresco': 'Fresh cheese',
  'Rábano mediano, de primera': 'Radish (medium, 1st grade)',
  'Rambután mediano, de primera': 'Rambutan (medium, 1st grade)',
  'Remolacha, mediana, de primera': 'Beetroot (medium, 1st grade)',
  'Repollo blanco, mediano': 'Cabbage (white, medium)',
  'Róbalo entero, revuelto': 'Snook (whole, mixed sizes)',
  'Róbalo filete seco': 'Snook fillet (dried)',
  'Sandia redonda, mediana, de primera': 'Watermelon (round, medium, 1st grade)',
  'Sorgo blanco, de primera': 'Sorghum (white, 1st grade)',
  'Tiburón entero, revuelto, de primera': 'Shark (whole, mixed sizes, 1st grade)',
  'Tiburón gris (Bacalao), filete seco de primera': 'Grey shark fillet (dried, 1st grade)',
  'Tilapia grande, de primera': 'Tilapia (large, 1st grade)',
  'Tilapia mediana, de primera': 'Tilapia (medium, 1st grade)',
  'Tilapia pequeña, de primera': 'Tilapia (small, 1st grade)',
  'Tomate de cocina, grande, de primera': 'Tomato (cooking, large, 1st grade)',
  'Tomate de cocina, mediano, de primera': 'Tomato (cooking, medium, 1st grade)',
  'Tomate Manzano, mediano, de primera': 'Tomato (Manzano, medium, 1st grade)',
  'Uva roja, importada, de primera': 'Grapes (red, imported, 1st grade)',
  'Yuca entera, mediana, de primera': 'Cassava (whole, medium, 1st grade)',
  'Zanahoria mediana, de primera': 'Carrot (medium, 1st grade)',
  'Zanahoria mediana, de primera, sin hojas': 'Carrot (medium, 1st grade, without leaves)',
  'Zapote mediano, de primera': 'Sapote (medium, 1st grade)',
};
export const magaItem = name => ITEMS[name] ?? name;

export function parseMaga(html) {
  // Bounded openers and one indexOf for the table end keep hostile markup linear (CWE-1333).
  const open = /<div\b[^<>]*\bid=["']precios_diarios["'][^<>]*>/i.exec(html);
  const end = open ? html.toLowerCase().indexOf('</table>', open.index + open[0].length) : -1;
  const block = end === -1 ? '' : html.slice(open.index + open[0].length, end);
  if (!/al mayorista en quetzales/i.test(plainText(htmlElements(block, ['h4'])[0]?.[1] ?? ''))) throw new Error('maga daily wholesale table format changed');
  const day = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(plainText(htmlElements(block, ['h5'])[0]?.[1] ?? ''));
  const date = day ? isoDate(day[3], day[2], day[1]) : '';
  if (!date) throw new Error('maga report date format changed');
  const rows = [...block.matchAll(/<tr\b[^<>]*>([\s\S]*?)(?=<tr\b|<\/tbody>|<\/thead>|$)/gi)].map(match =>
    htmlElements(match[1], ['td', 'th']).map(([, cell]) => plainText(cell)));
  if (rows[0]?.join('|') !== 'Producto|Mercado|Medida|Precio') throw new Error('maga table header format changed');
  const seen = new Map();
  for (const [name, market, unit, value, ...rest] of rows.slice(1)) {
    if (rest.length || unit === undefined) throw new Error('maga table row format changed');
    if (market !== MARKET || !name || !unit) continue;
    const text = String(value).replace(/,/g, '');
    if (!/^\d+(?:\.\d+)?$/.test(text) || Number(text) <= 0) continue;
    const row = { item: magaItem(name), market: MARKET, marketType: 'wholesale', unit, currency: 'GTQ', date, price: Number(text), origin: '' };
    const key = `${row.item}|${unit}`;
    seen.set(key, seen.has(key) && seen.get(key)?.price !== row.price ? null : row);
  }
  const observations = [...seen.values()].filter(Boolean);
  if (!observations.length) throw new Error('maga has no La Terminal prices');
  return { date, observations };
}

export async function collect(ctx) {
  const { date, observations } = parseMaga(await ctx.get(MAGA_URL));
  if (date > ctx.dated(ctx.now, 0)) throw new Error('maga report date is in the future');
  return { observations, contexts: [], refreshedReports: [{ date }], reportUrl: MAGA_URL };
}
