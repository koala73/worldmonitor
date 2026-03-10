import type { GetEarningsCalendarResponse } from '@/generated/server/worldmonitor/market/v1/service_server';
import { SITE_VARIANT } from '@/config';
import { getCurrentLanguage } from './i18n';

export async function fetchEarningsReports(timeframe: 'upcoming' | 'recent'): Promise<GetEarningsCalendarResponse> {

    // For development/screenshot purposes, provide mock data if API fails or returns empty
    const useMock = import.meta.env.DEV;

    try {
        const res = await fetch(`/api/market/v1/get-earnings-calendar?timeframe=${encodeURIComponent(timeframe)}&variant=${SITE_VARIANT}&lang=${getCurrentLanguage()}`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
        });
        if (!res.ok) {
            throw new Error(`HTTP error ${res.status}`);
        }
        const data = await res.json() as GetEarningsCalendarResponse;

        if (useMock && (!data.reports || data.reports.length === 0)) {
            return getMockEarnings(timeframe);
        }

        return data;
    } catch (err) {
        console.error(`[Earnings API] Failed to fetch earnings for timeframe ${timeframe}:`, err);
        if (useMock) {
            return getMockEarnings(timeframe);
        }
        return { reports: [], finnhubSkipped: false, skipReason: String(err) };
    }
}

function getMockEarnings(timeframe: 'upcoming' | 'recent'): GetEarningsCalendarResponse {
    const mockReports: any[] = timeframe === 'upcoming' ? [
        {
            symbol: 'AAPL',
            title: 'Apple Inc.',
            epsEstimate: 2.10,
            reportDate: '2026-03-12',
            reportTime: 'AMC',
        },
        {
            symbol: 'NVDA',
            title: 'NVIDIA Corporation',
            epsEstimate: 0.75,
            reportDate: '2026-03-15',
            reportTime: 'AMC',
        },
        {
            symbol: 'TSLA',
            title: 'Tesla, Inc.',
            epsEstimate: 0.60,
            reportDate: '2026-03-18',
            reportTime: 'BMO',
        }
    ] : [
        {
            symbol: 'MSFT',
            title: 'Microsoft Corp.',
            epsEstimate: 2.80,
            epsActual: 2.93,
            epsSurprisePercent: 4.6,
            revenueEstimate: 61120000000,
            revenueActual: 62020000000,
            revenueSurprisePercent: 1.5,
            reportDate: '2026-03-08',
            reportTime: 'AMC',
        },
        {
            symbol: 'GOOGL',
            title: 'Alphabet Inc.',
            epsEstimate: 1.60,
            epsActual: 1.64,
            epsSurprisePercent: 2.5,
            revenueEstimate: 86320000000,
            revenueActual: 86600000000,
            revenueSurprisePercent: 0.3,
            reportDate: '2026-03-06',
            reportTime: 'AMC',
        }
    ];

    return {
        reports: mockReports,
        finnhubSkipped: false,
        skipReason: ''
    };
}
