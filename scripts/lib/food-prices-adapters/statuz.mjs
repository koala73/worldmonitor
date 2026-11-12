import { isoDate } from '../food-prices.mjs';

const PAGE_URL = 'https://stat.uz/ru/ofitsialnaya-statistika/prices-and-indexes';
const DATA_URL = 'https://api.siat.stat.uz/media/uploads/sdmx/sdmx_data_1308.json';
const INDICATOR = '1.11.03.0001';
const ITEMS = {
  'Рис': 'Rice', 'Ячмень': 'Barley', 'Пшеница': 'Wheat', 'Кукуруза': 'Maize', 'Отруби': 'Bran', 'Шрот': 'Oilseed meal',
  'Шелуха': 'Husk', 'Комбикорм': 'Compound feed', 'Мука пшеничная высшего сорта': 'Wheat flour (premium grade)',
  'Мука пшеничная первого сорта': 'Wheat flour (first grade)', 'Хлеб пшеничный из муки 1-го сорта': 'Wheat bread (first-grade flour)',
  'Говядина': 'Beef', 'Баранина': 'Mutton', 'Мясо птицы': 'Poultry', 'Рыба всякая': 'Fish (all kinds)', 'Молоко свежее': 'Milk (fresh)',
  'Яйца': 'Eggs', 'Масло хлопковое': 'Cottonseed oil', 'Масло подсолнечное': 'Sunflower oil', 'Масло сливочное': 'Butter',
  'Лимоны': 'Lemons', 'Яблоки': 'Apples', 'Груши': 'Pears', 'Виноград': 'Grapes', 'Арбуз': 'Watermelon', 'Дыня': 'Melon',
  'Кишмиш': 'Raisins (kishmish)', 'Капуста': 'Cabbage', 'Огурцы': 'Cucumbers', 'Помидоры': 'Tomatoes', 'Баклажаны': 'Eggplant',
  'Перец болгарский': 'Bell pepper', 'Тыква': 'Pumpkin', 'Морковь': 'Carrots', 'Чеснок': 'Garlic', 'Лук репчатый': 'Onion',
  'Картофель': 'Potatoes', 'Фасоль': 'Beans', 'Горох': 'Peas', 'Маш': 'Mung beans (mash)', 'Сахар песок': 'Sugar (granulated)',
};
const ANIMAL_FEED = new Set(['Отруби', 'Шрот', 'Шелуха', 'Комбикорм']);
const UNITS = { '1 литр': 'litre', '10 штук': '10 pieces' };

export function parseStatuz(payload) {
  const dataset = Array.isArray(payload) && payload.length === 1 ? payload[0] : null;
  const meta = (name, valid) => {
    const values = (dataset?.metadata ?? []).filter(entry => entry.name_en === name).map(entry => String(entry.value_en ?? ''));
    return values.length > 0 && values.every(valid);
  };
  const rows = dataset?.data;
  if (!meta('Indicator identification number (code)', value => value === INDICATOR) || !meta('Periodicity', value => value === 'monthly')
    || !meta('Unit of measurement', value => /^In soums for kilogram$/i.test(value)) || !Array.isArray(rows) || rows.length < 30 || rows.length > 60) {
    throw new Error('statuz average-price dataset format changed');
  }
  const months = new Map();
  for (const key of Object.keys(rows[0])) {
    const match = /^(\d{4})-[MМ](\d{2})$/.exec(key);
    if (match) months.set(key, isoDate(match[1], match[2], 1));
  }
  const filled = [...months].filter(([key, date]) => date && rows.some(row => Number(row[key]) > 0));
  if (!filled.length) throw new Error('statuz dataset has no monthly prices');
  const [key, date] = filled.reduce((latest, entry) => entry[1] > latest[1] ? entry : latest);
  return rows.flatMap(row => {
    const name = /^(.+?)\s*(?:\(([^)]*)\))?$/.exec(String(row.Klassifikator_ru ?? '').trim());
    if (!name || !row.Klassifikator_en) throw new Error('statuz product columns format changed');
    const qualifier = name[2]?.trim();
    const unit = qualifier ? UNITS[qualifier] : 'kg';
    if (!unit) throw new Error(`statuz unit format changed: ${qualifier}`);
    const value = typeof row[key] === 'number' ? row[key] : Number(String(row[key] ?? '').trim() || NaN);
    if (!Number.isFinite(value) || value <= 0 || ANIMAL_FEED.has(name[1])) return [];
    const item = ITEMS[name[1]] ?? String(row.Klassifikator_en).replace(/\s*\([^)]*\)\s*$/, '').trim();
    return [{ item, market: 'National average', marketType: 'retail', unit, currency: 'UZS', date, price: value, origin: '' }];
  });
}

export async function collect(ctx) {
  const observations = parseStatuz(JSON.parse(await ctx.get(DATA_URL)));
  const referenceDate = observations[0].date;
  return {
    observations,
    contexts: [{ countryCode: 'UZ', country: 'Uzbekistan', referenceDate, title: 'Average prices of selected goods in markets and stores', url: PAGE_URL }],
    refreshedReports: [{ date: referenceDate }],
    reportUrl: PAGE_URL,
  };
}
