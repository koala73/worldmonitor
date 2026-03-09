import type { GetEarningsCalendarResponse } from '@/generated/server/worldmonitor/market/v1/service_server';
import { SITE_VARIANT } from '@/config';
import { getCurrentLanguage } from './i18n';

export async function fetchEarningsReports(timeframe: 'upcoming' | 'recent'): Promise<GetEarningsCalendarResponse> {

    try {
        const res = await fetch(`/api/market/v1/get-earnings-calendar?timeframe=${encodeURIComponent(timeframe)}&variant=${SITE_VARIANT}&lang=${getCurrentLanguage()}`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
        });
        if (!res.ok) {
            throw new Error(`HTTP error ${res.status}`);
        }
        const data = await res.json() as GetEarningsCalendarResponse;
        return data;
    } catch (err) {
        console.error(`[Earnings API] Failed to fetch earnings for timeframe ${timeframe}:`, err);
        return { reports: [], finnhubSkipped: false, skipReason: String(err) };
    }
}
