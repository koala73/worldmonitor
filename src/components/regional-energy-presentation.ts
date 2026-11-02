import type { RegionalEnergyFeed } from '@/generated/client/worldmonitor/intelligence/v1/service_client';

// Plain-language presentation for the national energy feeds in the country deep-dive.
// Source data keeps the provider's own codes and language; this module translates them for readers.

const FEED_TITLES: Record<string, string> = {
  pgcb: 'Power Grid Company of Bangladesh',
  petrobangla: 'Petrobangla, Bangladesh gas supply',
  niso: 'Nigerian Independent System Operator',
  eskom: 'Eskom, South Africa',
  cammesa: 'CAMMESA, Argentina grid operator',
  gse: 'Georgian State Electrosystem',
  ons: 'ONS, Brazil grid operator',
  anp: 'ANP, Brazil petroleum agency',
  evn: 'Vietnam Electricity (EVN)',
  korem: 'KOREM, Kazakhstan electricity market',
  coes: 'COES, Peru grid operator',
  iccc: 'ICCC, Papua New Guinea fuel prices',
  fccc: 'FCCC, Fiji fuel prices',
  mem: 'Ministry of Energy and Mines, Guatemala',
};

const METRIC_LABELS: Record<string, string> = {
  demand: 'Demand',
  'demand.scheduled': 'Scheduled demand',
  'demand.scheduled_weekly': 'Scheduled demand, weekly plan',
  'demand.peak': 'Peak demand',
  generation: 'Generation',
  'generation.peak': 'Peak generation',
  'generation.imports': 'Imports',
  'energy.consumed': 'Consumption',
  'energy.generated': 'Generation',
  'energy.sent_out': 'Energy sent out',
  'energy.generated_and_imported': 'Generated and imported',
  'energy.imports': 'Imports',
  'energy.exchange.net': 'Net exchange',
  'exchange.net': 'Net exchange',
  imports: 'Imports',
  'supply.total': 'Total supply',
  'outages.unplanned.average': 'Unplanned outages, average',
  'fuel.retail_price': 'Retail price',
  'fuel.retail_price.unsubsidized': 'Price without subsidy',
  'fuel.subsidy': 'Subsidy',
  'fuel.price': 'Price',
  'fuel.exports': 'Exports',
  'fuel.imports': 'Imports',
  'gas.supply': 'Gas supply',
  'gas.lng_supply': 'LNG supply',
  'gas.lng_share_of_supply': 'LNG share of gas supply',
  'price.day_ahead': 'Day-ahead price',
  'trade.day_ahead.volume': 'Day-ahead traded volume',
  'frequency.at_peak': 'Grid frequency at peak',
};

const SOURCE_LABELS: Record<string, string> = {
  hydro: 'Hydro', nuclear: 'Nuclear', renewable: 'Renewable', thermal: 'Thermal', coal: 'Coal',
  gas: 'Gas', gas_turbine: 'Gas turbine', oil: 'Oil', wind: 'Wind', solar: 'Solar', solar_pv: 'Solar PV',
  solar_csp: 'Concentrated solar', solar_farm: 'Solar farm', solar_rooftop: 'Rooftop solar', other: 'Other',
  other_renewable: 'Other renewable', liquid_fuel: 'Liquid fuel',
};

// Grid-area codes name the whole national system, so they add nothing for readers.
const DROPPED_AREAS = new Set(['SADI', 'SEIN', 'SIN', 'Eskom']);

const AREA_LABELS: Record<string, string> = {
  // ANP (Portuguese product names)
  ASFALTO: 'Asphalt',
  'COMBUSTÍVEIS PARA AERONAVES': 'Aviation fuels',
  'COMBUSTÍVEIS PARA NAVIOS': 'Marine fuels',
  COQUE: 'Petroleum coke',
  'ETANOL HIDRATADO': 'Hydrous ethanol',
  'GASOLINA A': 'Gasoline before blending',
  'GASOLINA ADITIVADA': 'Premium gasoline',
  'GASOLINA COMUM': 'Regular gasoline',
  'GASOLINA DE AVIAÇÃO': 'Aviation gasoline',
  GNV: 'Natural gas for vehicles',
  LUBRIFICANTE: 'Lubricants',
  NAFTA: 'Naphtha',
  'OLEO DIESEL': 'Diesel',
  'ÓLEO DIESEL': 'Diesel',
  'OLEO DIESEL S10': 'Diesel S10',
  'ÓLEO COMBUSTÍVEL': 'Fuel oil',
  'OUTROS NÃO ENERGÉTICOS': 'Other non-energy products',
  PARAFINA: 'Paraffin',
  'QUEROSENE DE AVIAÇÃO': 'Jet fuel',
  'QUEROSENE ILUMINANTE': 'Lighting kerosene',
  SOLVENTE: 'Solvents',
  // MEM (Spanish product names); ANP also uses GLP for LPG
  GLP: 'LPG',
  'GLP 25 lb cylinder': 'LPG 25 lb cylinder',
  'Gasolina Regular': 'Regular gasoline',
  'Gasolina Superior': 'Premium gasoline',
  'Diésel': 'Diesel',
  AvGas: 'Aviation gasoline',
  Bunker: 'Bunker fuel',
  'Jet A-1': 'Jet fuel',
  // FCCC
  'Motor Spirit': 'Petrol',
  'LPG 12 Kg Cylinder': 'LPG 12 kg cylinder',
  'LPG 4.5 Kg Cylinder': 'LPG 4.5 kg cylinder',
  'LPG Bulk': 'LPG bulk',
  'LPG Autogas': 'LPG autogas',
  // KOREM (Russian zone names)
  'Запад': 'West zone',
  'Север - Юг': 'North–South zone',
  // Eskom
  'RSA contracted demand': 'Contracted demand',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function capitalise(text: string): string {
  return text ? text[0]!.toUpperCase() + text.slice(1) : text;
}

function humanise(code: string): string {
  return capitalise(code.replace(/[._]+/g, ' ').trim());
}

export function regionalFeedTitle(feed: Pick<RegionalEnergyFeed, 'sourceId' | 'name'>): string {
  return FEED_TITLES[feed.sourceId] ?? feed.name;
}

export function regionalMetricLabel(metric: string): string {
  const exact = METRIC_LABELS[metric];
  if (exact) return exact;
  const [head, ...rest] = metric.split('.');
  const tail = rest.join('.');
  if (tail && !tail.includes('.')) {
    const source = SOURCE_LABELS[tail] ?? humanise(tail);
    if (head === 'generation') return `${source} generation`;
    if (head === 'energy') return `${source} output`;
    if (head === 'imports') return `Imports from ${humanise(tail)}`;
  }
  return humanise(metric);
}

function areaParts(area: string): string[] {
  return area.split(';')
    .map(part => part.trim())
    .filter(part => part && !DROPPED_AREAS.has(part))
    .map(part => {
      const zone = /^(?:LPG )?Schedule (\d+)$/.exec(part);
      if (zone) return `Price zone ${zone[1]}`;
      return capitalise(AREA_LABELS[part] ?? part);
    });
}

export function regionalAreaLabel(area: string): string {
  return areaParts(area).join(', ');
}

function unitLabel(unit: string): { text: string; currency: boolean } {
  const currency = /^([A-Z]{3})\/(.+)$/.exec(unit);
  if (currency) {
    const denominator = currency[2]!;
    const per = denominator === 'l' ? 'litre'
      : denominator === 'gal' ? 'gallon'
        : denominator.replace(/^(\d+(?:\.\d+)?)([a-zA-Z³]+)$/, '$1 $2');
    return { text: `${currency[1]} per ${per}`, currency: true };
  }
  if (unit === 'mln kWh') return { text: 'million kWh', currency: false };
  if (unit === 'm3') return { text: 'm³', currency: false };
  if (unit === 'MMcfd') return { text: 'million cubic feet per day', currency: false };
  return { text: unit, currency: false };
}

export function formatRegionalValue(value: number, unit: string, signed = false): string {
  const { text, currency } = unitLabel(unit);
  const number = value.toLocaleString('en-US', {
    minimumFractionDigits: currency ? 2 : 0,
    // Large grid figures read better whole; prices keep cents.
    maximumFractionDigits: currency ? 2 : Math.abs(value) >= 1000 ? 0 : Math.abs(value) >= 100 ? 1 : 2,
  });
  const sign = signed && value > 0 ? '+' : '';
  return text === '%' ? `${sign}${number}%` : `${sign}${number} ${text}`;
}

function periodTime(period: string): number {
  if (/^\d{4}-\d{2}$/.test(period)) return Date.parse(`${period}-01T00:00:00Z`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(period)) return Date.parse(`${period}T00:00:00Z`);
  return Date.parse(period);
}

export function formatRegionalPeriod(period: string): string {
  const time = periodTime(period);
  if (!Number.isFinite(time)) return period;
  const date = new Date(time);
  const month = MONTHS[date.getUTCMonth()]!;
  if (/^\d{4}-\d{2}$/.test(period)) return `${month} ${date.getUTCFullYear()}`;
  const day = `${date.getUTCDate()} ${month} ${date.getUTCFullYear()}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(period)) return day;
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  return `${day}, ${hh}:${mm} UTC`;
}

export interface RegionalSeriesRow {
  label: string;
  detail: string;
  latest: string;
  change: string;
  changeTitle: string;
  direction: 'up' | 'down' | 'flat' | 'none';
  period: string;
  stale: boolean;
}

function formatChange(latest: number, previous: number, unit: string): string {
  if (latest === previous) return 'No change';
  // A percentage is only meaningful when both readings share a sign and the base is non-zero.
  if (previous !== 0 && Math.sign(latest) === Math.sign(previous)) {
    const pct = ((latest - previous) / Math.abs(previous)) * 100;
    if (Math.abs(pct) < 0.05) return pct > 0 ? '+<0.1%' : '-<0.1%';
    return `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`;
  }
  return formatRegionalValue(latest - previous, unit, true);
}

function seriesLabel(metric: string, area: string): { label: string; detail: string } {
  const parts = areaParts(area);
  const metricLabel = regionalMetricLabel(metric);
  // Fuel feeds repeat one metric across many products, so the product is what tells rows apart.
  if (metric.startsWith('fuel.') && parts.length) return { label: parts[0]!, detail: [metricLabel, ...parts.slice(1)].join(', ') };
  return { label: metricLabel, detail: parts.join(', ') };
}

export function regionalSeriesRows(feed: Pick<RegionalEnergyFeed, 'observations'>): RegionalSeriesRow[] {
  const series = new Map<string, RegionalEnergyFeed['observations']>();
  for (const point of feed.observations) {
    const key = `${point.metric}|${point.area}`;
    const list = series.get(key);
    if (list) list.push(point);
    else series.set(key, [point]);
  }
  return [...series.values()].map(points => {
    const sorted = [...points].sort((a, b) => periodTime(b.period) - periodTime(a.period));
    const latest = sorted[0]!;
    const previous = sorted.find(point => point.period !== latest.period && point.unit === latest.unit);
    const delta = previous ? latest.value - previous.value : 0;
    return {
      ...seriesLabel(latest.metric, latest.area),
      latest: formatRegionalValue(latest.value, latest.unit),
      change: previous ? formatChange(latest.value, previous.value, latest.unit) : '—',
      changeTitle: previous ? `Compared with ${formatRegionalPeriod(previous.period)}` : '',
      direction: !previous ? 'none' : delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat',
      period: formatRegionalPeriod(latest.period),
      stale: latest.stale,
    };
  });
}

export function regionalLatestPeriod(feed: Pick<RegionalEnergyFeed, 'observations'>): string {
  let best: { time: number; period: string } | null = null;
  for (const point of feed.observations) {
    const time = periodTime(point.period);
    if (Number.isFinite(time) && (!best || time > best.time)) best = { time, period: point.period };
  }
  return best ? formatRegionalPeriod(best.period) : '';
}

export function regionalFeedStatusNote(status: string): string {
  if (status === 'stale') return 'Not updated recently';
  if (status === 'partial') return 'Some series not updated recently';
  if (status === 'error') return 'Latest reading could not be loaded';
  return '';
}
