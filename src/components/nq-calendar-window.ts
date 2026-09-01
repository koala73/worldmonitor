import { addLocalDays, localYmd } from '@/utils/local-date';

export interface NqCalendarWindow {
  from: string;
  to: string;
}

export function nqCalendarWindow(now: Date, calendarDateCount: number): NqCalendarWindow {
  return {
    from: localYmd(now),
    to: localYmd(addLocalDays(now, calendarDateCount - 1)),
  };
}
