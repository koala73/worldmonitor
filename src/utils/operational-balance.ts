import type { OperationalBalance, OperationalDelivery, OperationalInput, OperationalSnapshot } from '@/types/operational-balance';

export const MAX_OPERATIONAL_DAYS = 90;
export const MAX_OPERATIONAL_DELIVERIES = 30;
export const MAX_OPERATIONAL_JSON_BYTES = 65_536;
const DAY_MS = 86_400_000;
const round = (value: number) => Math.round(value * 1e6) / 1e6;
const dateAt = (start: string, offset: number) => new Date(Date.parse(start) + offset * DAY_MS).toISOString().slice(0, 10);

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a worksheet object.');
  return value as Record<string, unknown>;
}
function quantity(value: unknown, label: string): number {
  if (value === '' || value === null || value === undefined) throw new Error(`${label} is required.`);
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e6 || round(value) !== value) {
    throw new Error(`${label} must be between 0 and 1 million with at most 6 decimal places.`);
  }
  return value;
}
function date(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value || value < '1900-01-01' || value > '9998-12-31') {
    throw new Error('Use a valid date from 1900 through 9998.');
  }
  return value;
}

export function parseOperationalInput(value: unknown): OperationalInput {
  const input = record(value);
  if (typeof input.operation !== 'string' || !input.operation.trim() || input.operation.length > 100) throw new Error('Enter an operation name of 1-100 characters.');
  if (typeof input.unit !== 'string' || !/^[\p{L}\p{N} %./-]{1,24}$/u.test(input.unit) || !input.unit.trim()) throw new Error('Enter one quantity unit of 1-24 characters.');
  const unit = input.unit.trim();
  const startDate = date(input.startDate);
  if (!Number.isInteger(input.horizonDays) || (input.horizonDays as number) < 1 || (input.horizonDays as number) > MAX_OPERATIONAL_DAYS) throw new Error('Horizon must be 1-90 whole days.');
  const horizonDays = input.horizonDays as number;
  if (input.basis !== 'example' && input.basis !== 'user') throw new Error('Input basis must be example or user.');
  const deliveries = (value: unknown): OperationalDelivery[] => {
    if (!Array.isArray(value) || value.length > MAX_OPERATIONAL_DELIVERIES) throw new Error('Use at most 30 deliveries per list.');
    return value.map(value => {
      const row = record(value);
      const deliveryDate = date(row.date);
      if (deliveryDate < startDate || deliveryDate > dateAt(startDate, horizonDays - 1)) throw new Error('Delivery dates must be inside the selected horizon.');
      if (row.unit !== unit) throw new Error(`Every delivery must use ${unit}; mixed units are not converted.`);
      return { date: deliveryDate, unit, quantity: quantity(row.quantity, 'Delivery quantity'), costUsd: row.costUsd === null || row.costUsd === undefined ? null : quantity(row.costUsd, 'Delivery cost') };
    });
  };
  return { operation: input.operation.trim(), basis: input.basis, unit, startDate, horizonDays,
    startingStock: quantity(input.startingStock, 'Starting stock'), dailyDemand: quantity(input.dailyDemand, 'Daily demand'),
    deliveries: deliveries(input.deliveries), alternativeDeliveries: deliveries(input.alternativeDeliveries),
    alternativeDailyDemand: input.alternativeDailyDemand === null ? null : quantity(input.alternativeDailyDemand, 'Alternative daily demand') };
}

export function calculateOperationalBalance(value: unknown): OperationalSnapshot {
  const input = parseOperationalInput(value);
  const balance = (deliveries: OperationalDelivery[], demand: number): OperationalBalance => {
    let stock = input.startingStock;
    const days = Array.from({ length: input.horizonDays }, (_, index) => {
      const date = dateAt(input.startDate, index);
      const arrivals = round(deliveries.filter(row => row.date === date).reduce((sum, row) => sum + row.quantity, 0));
      const available = round(stock + arrivals);
      const unmetDemand = round(Math.max(0, demand - available));
      stock = round(Math.max(0, available - demand));
      return { day: index + 1, date, arrivals, demand, closingStock: stock, unmetDemand };
    });
    return { days, firstGapDay: days.find(day => day.unmetDemand > 0)?.day ?? null, totalUnmetDemand: round(days.reduce((sum, day) => sum + day.unmetDemand, 0)) };
  };
  const baseline = balance(input.deliveries, input.dailyDemand);
  const alternative = balance([...input.deliveries, ...input.alternativeDeliveries], input.alternativeDailyDemand ?? input.dailyDemand);
  const costsKnown = [...input.deliveries, ...input.alternativeDeliveries].every(row => row.costUsd !== null);
  return { schema: 'worldmonitor-operational-worksheet/v1', input, baseline, alternative,
    avoidedUnmetDemand: round(baseline.totalUnmetDemand - alternative.totalUnmetDemand),
    additionalDeliveryCostUsd: costsKnown ? round(input.alternativeDeliveries.reduce((sum, row) => sum + row.costUsd!, 0)) : null };
}

export function importOperationalWorksheet(text: string): OperationalSnapshot {
  if (new TextEncoder().encode(text).length > MAX_OPERATIONAL_JSON_BYTES) throw new Error('Worksheet JSON must be no larger than 64 KiB.');
  const value = record(JSON.parse(text));
  if (value.schema !== 'worldmonitor-operational-worksheet/v1') throw new Error('Unsupported worksheet format.');
  return calculateOperationalBalance(value.input);
}

export function operationalExample(): OperationalInput {
  return { operation: 'Example operation', basis: 'example', unit: 'units', startDate: '2026-09-10', horizonDays: 10, startingStock: 100, dailyDemand: 20,
    deliveries: [{ date: '2026-09-13', quantity: 40, unit: 'units', costUsd: null }], alternativeDeliveries: [], alternativeDailyDemand: null };
}
