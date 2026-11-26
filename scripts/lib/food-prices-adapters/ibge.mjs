import { monthDate } from './monthly.mjs';

// IBGE SIDRA table 7060, the IPCA consumer price index by group: national monthly and 12-month changes.
const TABLE = 7060;
// 63 is the monthly change, 2265 the change over 12 months.
const MONTHLY = '63';
const TWELVE_MONTHS = '2265';
// 7170 food and drink, 7171 food at home, 7432 food away from home.
export const GROUPS = { food: '7170', home: '7171', away: '7432' };
export const DATA_URL = `https://apisidra.ibge.gov.br/values/t/${TABLE}/n1/all/v/${MONTHLY},${TWELVE_MONTHS}/p/last%201/c315/${Object.values(GROUPS).join(',')}?formato=json`;
export const TABLE_URL = `https://sidra.ibge.gov.br/tabela/${TABLE}`;
const LABELS = { [GROUPS.food]: /^1\.Alimentação e bebidas$/, [GROUPS.home]: /^11\.Alimentação no domicílio$/, [GROUPS.away]: /^12\.Alimentação fora do domicílio$/ };
const CHANGE = /^-?\d{1,3}\.\d{2}$/;

const text = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const signed = value => `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;

/** Describe the newest month's food and drink IPCA changes as context, not shelf prices. */
export function parseIbge(payload) {
  if (!Array.isArray(payload) || payload.length < 2) throw new Error('IBGE SIDRA response format changed');
  const [header, ...rows] = payload;
  if (header.D2C !== 'Variável (Código)' || header.D3C !== 'Mês (Código)' || !/^Geral, grupo/.test(text(header.D4N)) || header.D1N !== 'Brasil') {
    throw new Error('IBGE SIDRA columns format changed');
  }
  const months = new Set(rows.map(row => text(row.D3C)));
  const [month] = months;
  const date = months.size === 1 ? monthDate(month) : '';
  if (!date) throw new Error('IBGE SIDRA month format changed');
  const value = (variable, group) => {
    const row = rows.find(row => row.D2C === variable && row.D4C === group);
    if (!row || row.MN !== '%' || !LABELS[group].test(text(row.D4N)) || !CHANGE.test(text(row.V))) throw new Error(`IBGE IPCA ${group} change format changed`);
    return Number(row.V);
  };
  const monthly = Object.fromEntries(Object.entries(GROUPS).map(([name, group]) => [name, value(MONTHLY, group)]));
  const yearly = value(TWELVE_MONTHS, GROUPS.food);
  return { country: 'Brazil', countryCode: 'BR', referenceDate: date, url: TABLE_URL,
    title: `Food and drink IPCA: ${signed(monthly.food)} month-on-month (food at home ${signed(monthly.home)}, away from home ${signed(monthly.away)}); ${signed(yearly)} over 12 months (index changes, not prices)` };
}

/** Collect the national IPCA food context and reject a future month. */
export async function collect(ctx) {
  const context = parseIbge(JSON.parse(await ctx.get(DATA_URL)));
  if (context.referenceDate > ctx.dated(ctx.now, 0)) throw new Error('IBGE future month');
  return { observations: [], contexts: [context], reportUrl: TABLE_URL };
}
