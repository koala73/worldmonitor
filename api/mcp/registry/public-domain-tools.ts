import type { GetGoldIntelligenceResponse } from '../../../src/generated/server/worldmonitor/market/v1/service_server';
import { buildAuthHeaders } from '../auth';
import { assertToolFetchOk } from '../billing-denial';
import { fetchMcpDownstream } from '../downstream';
import type { ToolDef } from '../types';

const number = { type: 'number' };
const num = (description: string) => ({ type: 'number', description });
const str = (description: string) => ({ type: 'string', description });
const cotCategory = (description: string) => ({ type: 'object', description, properties: {
  longPositions: str('Long contracts held, as a decimal string.'),
  shortPositions: str('Short contracts held, as a decimal string.'),
  wowNetDelta: str('Week-over-week change in net (long minus short) contracts, as a decimal string; 0 when the prior week is unknown.'),
  netPct: num('Net positioning as a percentage of the group\'s gross (long plus short) contracts; positive means net long.'),
  oiSharePct: num('The group\'s gross contracts as a percentage of total open interest; 0 when unknown.'),
} });
const mover = { type: 'object', properties: { iso3: str('ISO alpha-3 country code.'), name: str('Country name.'), deltaTonnes12m: num('Change in gold holdings over 12 months, tonnes.') } };


export const PUBLIC_DOMAIN_TOOLS: ToolDef[] = [{
  name: 'get_gold_intelligence',
  title: 'Gold market intelligence',
  description: 'Return seeded gold intelligence: metal futures quotes, cross-currency gold prices, CFTC positioning, session returns/ranges, drivers, ETF holdings and central-bank reserves. Prices are USD/troy ounce unless a currency row states otherwise; changes/returns are percentages; COT counts are decimal strings; ETF holdings are tonnes, AUM is USD. Reserves include IMF indicator and valueIsOunces: only true means tonnes/totalTonnes are measured, including genuine zero. False or missing means legacy zero placeholders, not measured quantities; physical movers are unavailable. Reserve percentages can remain available on the USD fallback. unavailable:true or missing blocks mark absent data; zero prices are placeholders. Each block has its own observation date; updatedAt does not guarantee source freshness. No arguments. Paid plan; one downstream seeded fetch, weight 2 on API plans. Read-only; no trade or research snapshot is created.',
  _outputBudgetBytes: 131072,
  inputSchema: { type: 'object', properties: {}, required: [] },
  outputSchema: { type: 'object', required: ['unavailable'], properties: {
    goldPrice: num('Gold futures (GC=F) price, USD per troy ounce; 0 is a placeholder.'),
    goldChangePct: num('Gold futures change on the session, percent.'),
    goldSparkline: { type: 'array', items: number, description: 'Recent gold futures prices, oldest first, USD per troy ounce.' },
    silverPrice: num('Silver futures (SI=F) price, USD per troy ounce; 0 is a placeholder.'),
    platinumPrice: num('Platinum futures (PL=F) price, USD per troy ounce; 0 is a placeholder.'),
    palladiumPrice: num('Palladium futures (PA=F) price, USD per troy ounce; 0 is a placeholder.'),
    goldSilverRatio: num('Gold price divided by silver price; absent when either price is missing.'),
    goldPlatinumPremiumPct: num('Gold premium over platinum, percent of the platinum price; absent when either price is missing.'),
    crossCurrencyPrices: { type: 'array', description: 'Gold price per troy ounce converted into other currencies.', items: { type: 'object', properties: { currency: str('Currency code, such as EUR or JPY.'), flag: str('Flag emoji for the currency.'), price: num('Gold price per troy ounce in that currency.') } } },
    cot: { type: 'object', description: 'CFTC Commitments of Traders positioning in COMEX gold futures.', properties: { reportDate: str('Report date of the CFTC release.'), nextReleaseDate: str('Expected date of the next release; empty when unknown.'), openInterest: str('Total open interest in contracts, as a decimal string.'),
      managedMoney: cotCategory('Managed-money (speculative fund) positions.'), producerSwap: cotCategory('Producer/merchant and swap-dealer positions.') } },
    updatedAt: str('Timestamp of the session, returns and drivers data; empty when that data is missing. Other blocks carry their own dates.'),
    unavailable: { type: 'boolean', description: 'True when no gold quote could be read; every other field is then a placeholder.' },
    session: { type: 'object', description: 'Current gold futures session, USD per troy ounce.', properties: { dayHigh: num('Session high.'), dayLow: num('Session low.'), prevClose: num('Previous session close.') } },
    returns: { type: 'object', description: 'Gold futures price returns, percent.', properties: { w1: num('Over 1 week (5 trading days).'), m1: num('Over 1 month.'), ytd: num('Since the first trading day of the year.'), y1: num('Over 1 year.') } },
    range52w: { type: 'object', description: '52-week gold futures range, USD per troy ounce.', properties: { hi: num('52-week high.'), lo: num('52-week low.'), positionPct: num('Current price position within the range: 0 at the low, 100 at the high.') } },
    drivers: { type: 'array', description: 'Market series that move gold.', items: { type: 'object', properties: {
      symbol: str('Market symbol of the series.'), label: str('Display name.'), value: num('Latest value.'), changePct: num('Change from the previous close, percent.'), correlation30d: num('Pearson correlation of its daily returns with gold over the last 30 trading days, -1 to 1.'),
    } } },
    etfFlows: { type: 'object', description: 'SPDR Gold Shares (GLD) holdings; absent when unavailable.', properties: {
      asOfDate: str('Date of the holdings figure.'), tonnes: num('Gold held, tonnes.'), aumUsd: num('Assets under management, USD.'), nav: num('Net asset value per share, USD.'),
      changeW1Tonnes: num('Change in holdings over 1 week, tonnes.'), changeM1Tonnes: num('Change in holdings over 1 month, tonnes.'), changeY1Tonnes: num('Change in holdings over 1 year, tonnes.'),
      changeW1Pct: num('Change in holdings over 1 week, percent.'), changeM1Pct: num('Change in holdings over 1 month, percent.'), changeY1Pct: num('Change in holdings over 1 year, percent.'),
      sparkline90d: { type: 'array', items: number, description: 'Daily holdings over the last 90 days, tonnes, oldest first.' },
    } },
    cbReserves: { type: 'object', description: 'Central-bank gold reserves from IMF data; absent when fewer than five holders are available.', properties: { asOfMonth: str('Month of the reserve data.'), totalTonnes: num('Summed gold reserves of all reporting central banks, tonnes; 0 unless valueIsOunces is true.'),
      indicator: str('IMF indicator the figures come from.'), valueIsOunces: { type: 'boolean', description: 'True only when the source measured ounces, so tonne fields are real quantities.' },
      topHolders: { type: 'array', description: 'Largest holders.', items: { type: 'object', properties: { iso3: str('ISO alpha-3 country code.'), name: str('Country name.'), tonnes: num('Gold held, tonnes; 0 unless valueIsOunces is true.'), pctOfReserves: num('Gold share of the country\'s total reserves, percent.') } } },
      topBuyers12m: { type: 'array', description: 'Largest 12-month buyers; empty unless valueIsOunces is true.', items: mover },
      topSellers12m: { type: 'array', description: 'Largest 12-month sellers; empty unless valueIsOunces is true.', items: mover },
    } },
  } },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _execute: async (_params, base, context, execution) => {
    const url = `${base}/api/market/v1/get-gold-intelligence`;
    const auth = await buildAuthHeaders(context, 'GET', url, null);
    const response = await fetchMcpDownstream(url, {
      headers: { ...auth, 'User-Agent': 'worldmonitor-mcp-edge/1.0' }, signal: AbortSignal.timeout(25_000),
    }, execution);
    await assertToolFetchOk(response, 'get_gold_intelligence', { preserveBackoff: true });
    return await response.json() as GetGoldIntelligenceResponse;
  },
  _apiPaths: ['GET /api/market/v1/get-gold-intelligence'],
}];
