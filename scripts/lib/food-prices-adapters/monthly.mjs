import Papa from 'papaparse';
import { isoDate } from '../food-prices.mjs';

/** Parse a bounded CSV with the required publisher columns; reject schema changes. */
export function csvRows(text, columns) {
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
  if (parsed.errors.length || !columns.every(column => parsed.meta.fields?.includes(column)) || parsed.data.length > 100_000) {
    throw new Error('food CSV format changed');
  }
  return parsed.data;
}

/** Return the first day of a valid publisher month, or an empty string. */
export const monthDate = value => {
  const match = /^(\d{4})[-M]?(\d{2})$/.exec(String(value));
  return match ? isoDate(match[1], match[2], 1) : '';
};
/** Accept finite positive publisher values while excluding missing cells. */
export const positive = value => value !== null && value !== '' && Number.isFinite(Number(value)) && Number(value) > 0;

// A whole refreshed report replaces withdrawn quotes, while unrequested dates remain in history.
/** Build a replacement report for observed dates; reject empty or future reports. */
export function priceReport(observations, reportUrl, now) {
  if (!observations.length || observations.some(row => !row.date || row.date > now.toISOString().slice(0, 10))) throw new Error('food report has no prices or a future date');
  return { observations, contexts: [], reportUrl, refreshedReports: [...new Set(observations.map(row => row.date))].map(date => ({ date })) };
}

// PxWeb json-stat2 cells follow category.index, which can differ from the metadata order.
/** Decode bounded json-stat2 cells using category indices, rejecting dimension drift. */
export function cubeCells(table, expectedIds) {
  if (!Array.isArray(table?.id) || table.id.length !== expectedIds.length || !expectedIds.every(id => table.id.includes(id))
    || !Array.isArray(table.size) || table.size.length !== table.id.length) throw new Error('food cube dimensions changed');
  const count = table.size.reduce((a, b) => Number.isInteger(b) && b > 0 ? a * b : NaN, 1);
  if (!Number.isSafeInteger(count) || count > 50_000 || !Array.isArray(table.value) || table.value.length !== count) throw new Error('food cube size changed');
  const dimensions = table.id.map((id, i) => {
    const category = table.dimension?.[id]?.category;
    const entries = Object.entries(category?.index ?? {});
    if (entries.length !== table.size[i] || new Set(entries.map(([, n]) => n)).size !== entries.length
      || entries.some(([code, n]) => !Number.isInteger(n) || n < 0 || n >= entries.length || typeof category.label?.[code] !== 'string')) throw new Error('food cube index changed');
    return entries.sort((a, b) => a[1] - b[1]).map(([code]) => ({ code, label: category.label[code] }));
  });
  return table.value.map((value, index) => {
    const cell = { value };
    for (let i = table.id.length - 1; i >= 0; i--) {
      cell[table.id[i]] = dimensions[i][index % table.size[i]];
      index = Math.floor(index / table.size[i]);
    }
    return cell;
  });
}
