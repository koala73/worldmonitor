import type { EarningsFetchResult, EarningsReport } from '@/services/earnings';

function toLocalIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function offsetDate(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return toLocalIsoDate(date);
}

export function getMockEarnings(timeframe: 'upcoming' | 'recent'): EarningsFetchResult {
  const reports: EarningsReport[] = timeframe === 'upcoming'
    ? [
      {
        symbol: 'AAPL',
        company: 'Apple',
        date: offsetDate(1),
        hour: 'amc',
        epsEstimate: 2.18,
        revenueEstimate: 91400000000,
        epsActual: null,
        revenueActual: null,
        hasActuals: false,
        surpriseDirection: '',
      },
      {
        symbol: 'NVDA',
        company: 'NVIDIA',
        date: offsetDate(3),
        hour: 'amc',
        epsEstimate: 0.74,
        revenueEstimate: 38600000000,
        epsActual: null,
        revenueActual: null,
        hasActuals: false,
        surpriseDirection: '',
      },
      {
        symbol: 'TSLA',
        company: 'Tesla',
        date: offsetDate(5),
        hour: 'bmo',
        epsEstimate: 0.62,
        revenueEstimate: 25500000000,
        epsActual: null,
        revenueActual: null,
        hasActuals: false,
        surpriseDirection: '',
      },
    ]
    : [
      {
        symbol: 'MSFT',
        company: 'Microsoft',
        date: offsetDate(-1),
        hour: 'amc',
        epsEstimate: 2.81,
        revenueEstimate: 61100000000,
        epsActual: 2.93,
        revenueActual: 62000000000,
        hasActuals: true,
        surpriseDirection: 'beat',
      },
      {
        symbol: 'GOOGL',
        company: 'Alphabet',
        date: offsetDate(-2),
        hour: 'amc',
        epsEstimate: 1.62,
        revenueEstimate: 86400000000,
        epsActual: 1.58,
        revenueActual: 85900000000,
        hasActuals: true,
        surpriseDirection: 'miss',
      },
    ];

  return { reports };
}
