import type { Fundamentals } from '@/generated/client/worldmonitor/market/v1/service_client';

export interface FundamentalDisplayCell {
  label: string;
  value: string;
  color?: string;
}

function formatFinancialValueCompact(value: number, currency: string): string {
  const candidateCurrency = currency.trim().toUpperCase();
  const normalizedCurrency = /^[A-Z]{3}$/.test(candidateCurrency) ? candidateCurrency : 'USD';
  const prefix = normalizedCurrency === 'USD' ? '$' : `${normalizedCurrency} `;
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${sign}${prefix}${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}${prefix}${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}${prefix}${(abs / 1e3).toFixed(0)}K`;
  return `${sign}${prefix}${abs.toFixed(0)}`;
}

export function buildFundamentalDisplayCells(
  fundamentals: Fundamentals | undefined,
  quoteCurrency = 'USD',
): FundamentalDisplayCell[] {
  if (!fundamentals) return [];

  const num = (value: number | undefined): value is number =>
    typeof value === 'number' && Number.isFinite(value);
  const signColor = (value: number): string => (value >= 0 ? '#16a34a' : '#dc2626');
  const cells: FundamentalDisplayCell[] = [];

  if (num(fundamentals.profitMargin)) cells.push({ label: 'Profit Margin', value: `${(fundamentals.profitMargin * 100).toFixed(1)}%`, color: signColor(fundamentals.profitMargin) });
  if (num(fundamentals.operatingMargin)) cells.push({ label: 'Oper. Margin', value: `${(fundamentals.operatingMargin * 100).toFixed(1)}%`, color: signColor(fundamentals.operatingMargin) });
  if (num(fundamentals.returnOnEquity)) cells.push({ label: 'ROE', value: `${(fundamentals.returnOnEquity * 100).toFixed(1)}%`, color: signColor(fundamentals.returnOnEquity) });
  if (num(fundamentals.revenueGrowth)) cells.push({ label: 'Rev. Growth', value: `${(fundamentals.revenueGrowth * 100).toFixed(1)}%`, color: signColor(fundamentals.revenueGrowth) });
  if (num(fundamentals.earningsGrowth)) cells.push({ label: 'EPS Growth', value: `${(fundamentals.earningsGrowth * 100).toFixed(1)}%`, color: signColor(fundamentals.earningsGrowth) });
  if (num(fundamentals.debtToEquity)) cells.push({ label: 'Debt/Equity', value: fundamentals.debtToEquity.toFixed(2) });
  if (num(fundamentals.freeCashflow)) {
    cells.push({
      label: 'Free Cash Flow',
      value: formatFinancialValueCompact(
        fundamentals.freeCashflow,
        fundamentals.financialCurrency || quoteCurrency,
      ),
      color: fundamentals.freeCashflow >= 0 ? undefined : '#dc2626',
    });
  }

  return cells;
}
