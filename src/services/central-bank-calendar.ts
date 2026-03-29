/**
 * Central Bank Decision Calendar — 2026 meeting schedule
 *
 * Hardcoded 2026 decision dates for the five major central banks.
 * Returns sorted upcoming meetings with days-until countdown.
 * No API key required.
 */

export interface CbMeeting {
  bank: string;
  shortName: string;
  currency: string;
  date: Date;
  daysUntil: number;
  /** true = multi-day meeting, date is the decision/announcement day */
  isMultiDay: boolean;
}

// 2026 official meeting calendars
// Sources: Fed (federalreserve.gov), ECB, BoJ, BoE, BoC published schedules
const MEETINGS_2026: Array<{ bank: string; shortName: string; currency: string; iso: string; multi: boolean }> = [
  // Federal Reserve FOMC — decision day (Wed of 2-day meeting)
  { bank: 'Federal Reserve', shortName: 'Fed', currency: 'USD', iso: '2026-01-28', multi: true },
  { bank: 'Federal Reserve', shortName: 'Fed', currency: 'USD', iso: '2026-03-18', multi: true },
  { bank: 'Federal Reserve', shortName: 'Fed', currency: 'USD', iso: '2026-04-29', multi: true },
  { bank: 'Federal Reserve', shortName: 'Fed', currency: 'USD', iso: '2026-06-10', multi: true },
  { bank: 'Federal Reserve', shortName: 'Fed', currency: 'USD', iso: '2026-07-29', multi: true },
  { bank: 'Federal Reserve', shortName: 'Fed', currency: 'USD', iso: '2026-09-16', multi: true },
  { bank: 'Federal Reserve', shortName: 'Fed', currency: 'USD', iso: '2026-10-28', multi: true },
  { bank: 'Federal Reserve', shortName: 'Fed', currency: 'USD', iso: '2026-12-09', multi: true },

  // ECB Governing Council — monetary policy decision day
  { bank: 'European Central Bank', shortName: 'ECB', currency: 'EUR', iso: '2026-01-22', multi: false },
  { bank: 'European Central Bank', shortName: 'ECB', currency: 'EUR', iso: '2026-03-05', multi: false },
  { bank: 'European Central Bank', shortName: 'ECB', currency: 'EUR', iso: '2026-04-16', multi: false },
  { bank: 'European Central Bank', shortName: 'ECB', currency: 'EUR', iso: '2026-05-28', multi: false },
  { bank: 'European Central Bank', shortName: 'ECB', currency: 'EUR', iso: '2026-07-09', multi: false },
  { bank: 'European Central Bank', shortName: 'ECB', currency: 'EUR', iso: '2026-09-10', multi: false },
  { bank: 'European Central Bank', shortName: 'ECB', currency: 'EUR', iso: '2026-10-22', multi: false },
  { bank: 'European Central Bank', shortName: 'ECB', currency: 'EUR', iso: '2026-12-10', multi: false },

  // Bank of Japan Policy Board — decision day
  { bank: 'Bank of Japan', shortName: 'BoJ', currency: 'JPY', iso: '2026-01-24', multi: true },
  { bank: 'Bank of Japan', shortName: 'BoJ', currency: 'JPY', iso: '2026-03-19', multi: true },
  { bank: 'Bank of Japan', shortName: 'BoJ', currency: 'JPY', iso: '2026-05-01', multi: true },
  { bank: 'Bank of Japan', shortName: 'BoJ', currency: 'JPY', iso: '2026-06-17', multi: true },
  { bank: 'Bank of Japan', shortName: 'BoJ', currency: 'JPY', iso: '2026-07-30', multi: true },
  { bank: 'Bank of Japan', shortName: 'BoJ', currency: 'JPY', iso: '2026-09-18', multi: true },
  { bank: 'Bank of Japan', shortName: 'BoJ', currency: 'JPY', iso: '2026-10-29', multi: true },
  { bank: 'Bank of Japan', shortName: 'BoJ', currency: 'JPY', iso: '2026-12-19', multi: true },

  // Bank of England MPC — decision day
  { bank: 'Bank of England', shortName: 'BoE', currency: 'GBP', iso: '2026-02-05', multi: false },
  { bank: 'Bank of England', shortName: 'BoE', currency: 'GBP', iso: '2026-03-19', multi: false },
  { bank: 'Bank of England', shortName: 'BoE', currency: 'GBP', iso: '2026-05-07', multi: false },
  { bank: 'Bank of England', shortName: 'BoE', currency: 'GBP', iso: '2026-06-18', multi: false },
  { bank: 'Bank of England', shortName: 'BoE', currency: 'GBP', iso: '2026-08-06', multi: false },
  { bank: 'Bank of England', shortName: 'BoE', currency: 'GBP', iso: '2026-09-17', multi: false },
  { bank: 'Bank of England', shortName: 'BoE', currency: 'GBP', iso: '2026-11-05', multi: false },
  { bank: 'Bank of England', shortName: 'BoE', currency: 'GBP', iso: '2026-12-17', multi: false },

  // Bank of Canada — decision day
  { bank: 'Bank of Canada', shortName: 'BoC', currency: 'CAD', iso: '2026-01-22', multi: false },
  { bank: 'Bank of Canada', shortName: 'BoC', currency: 'CAD', iso: '2026-03-12', multi: false },
  { bank: 'Bank of Canada', shortName: 'BoC', currency: 'CAD', iso: '2026-04-16', multi: false },
  { bank: 'Bank of Canada', shortName: 'BoC', currency: 'CAD', iso: '2026-06-04', multi: false },
  { bank: 'Bank of Canada', shortName: 'BoC', currency: 'CAD', iso: '2026-07-15', multi: false },
  { bank: 'Bank of Canada', shortName: 'BoC', currency: 'CAD', iso: '2026-09-10', multi: false },
  { bank: 'Bank of Canada', shortName: 'BoC', currency: 'CAD', iso: '2026-10-22', multi: false },
  { bank: 'Bank of Canada', shortName: 'BoC', currency: 'CAD', iso: '2026-12-10', multi: false },
];

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

/**
 * Returns upcoming central bank meetings, sorted by date.
 * Meetings in the past (>= 1 day ago) are excluded.
 * @param limit max number of results (default 10)
 */
export function getUpcomingMeetings(limit = 10): CbMeeting[] {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  return MEETINGS_2026
    .map(m => {
      const date = new Date(m.iso + 'T00:00:00');
      return {
        bank: m.bank,
        shortName: m.shortName,
        currency: m.currency,
        date,
        daysUntil: daysBetween(todayStart, date),
        isMultiDay: m.multi,
      };
    })
    .filter(m => m.daysUntil >= 0)
    .sort((a, b) => a.daysUntil - b.daysUntil)
    .slice(0, limit);
}

/** Returns the single next meeting across all tracked banks. */
export function getNextMeeting(): CbMeeting | null {
  const upcoming = getUpcomingMeetings(1);
  return upcoming[0] ?? null;
}
