import type {
    ServerContext,
    GetEarningsCalendarRequest,
    GetEarningsCalendarResponse,
    EarningsReport,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { cachedFetchJson } from '../../../_shared/redis';

const REDIS_CACHE_KEY = 'market:earnings:v1';
const REDIS_CACHE_TTL = 3600 * 6; // 6 hours, earnings schedules change slowly

function formatDate(date: Date): string {
    // Returns YYYY-MM-DD
    return date.toISOString().split('T')[0]!;
}

export async function getEarningsCalendar(
    _ctx: ServerContext,
    req: GetEarningsCalendarRequest,
): Promise<GetEarningsCalendarResponse> {
    const apiKey = process.env.FINNHUB_API_KEY;
    if (!apiKey) {
        return { reports: [], finnhubSkipped: true, skipReason: 'FINNHUB_API_KEY not configured' };
    }

    const isUpcoming = req.timeframe === 'UPCOMING';
    const now = new Date();

    // Calculate date window (Recent = past 7 days, Upcoming = next 14 days)
    let fromDate = new Date(now);
    let toDate = new Date(now);

    if (isUpcoming) {
        toDate.setDate(now.getDate() + 14);
    } else {
        fromDate.setDate(now.getDate() - 7);
    }

    const fromStr = formatDate(fromDate);
    const toStr = formatDate(toDate);

    // Target top mega-cap liquidity proxies manually, or fetch all then filter
    const MEGA_CAPS = new Set([
        'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'JPM', 'V', 'JNJ', 'WMT',
        'PG', 'MA', 'ORCL', 'AVGO', 'HD', 'CVX', 'MRK', 'KO', 'PEP', 'BAC', 'MCD', 'DIS',
        'NFLX', 'AMD', 'CRM', 'INTC', 'CSCO', 'QCOM', 'IBM'
    ]);

    const redisKey = `${REDIS_CACHE_KEY}:${req.timeframe}:${fromStr}:${toStr}`;

    try {
        const result = await cachedFetchJson<GetEarningsCalendarResponse>(redisKey, REDIS_CACHE_TTL, async () => {
            const url = `https://finnhub.io/api/v1/calendar/earnings?from=${fromStr}&to=${toStr}`;

            const resp = await fetch(url, {
                headers: { Accept: 'application/json', 'User-Agent': 'WorldMonitor/1.0', 'X-Finnhub-Token': apiKey },
                signal: AbortSignal.timeout(10000),
            });

            if (!resp.ok) {
                console.warn(`[Finnhub] Earnings Fetch Failed HTTP ${resp.status}`);
                return null; // Return null to avoid negative caching
            }

            const data = await resp.json() as { earningsCalendar: Array<{ date: string; epsActual: number; epsEstimate: number; epsSurprise: number; quarter: number; revenueActual: number; revenueEstimate: number; revenueSurprise: number; symbol: string; year: number }> };

            if (!data || !data.earningsCalendar) {
                return { reports: [], finnhubSkipped: false, skipReason: '' };
            }

            // Filter to only MegaCaps to avoid noise (we can expand this later)
            const reports: EarningsReport[] = data.earningsCalendar
                .filter(item => MEGA_CAPS.has(item.symbol))
                .map(item => ({
                    symbol: item.symbol,
                    title: item.symbol, // Finnhub calendar does not return company name, fallback to symbol
                    epsEstimate: item.epsEstimate,
                    epsActual: item.epsActual,
                    epsSurprisePercent: item.epsSurprise, // Finnhub returns surprise as raw value or percent depending on endpoint, usually EPS difference or percent
                    revenueEstimate: item.revenueEstimate,
                    revenueActual: item.revenueActual,
                    revenueSurprisePercent: item.revenueSurprise,
                    reportDate: item.date,
                    reportTime: '', // Finnhub free tier doesn't specify pre/post market reliably in this endpoint
                }));

            // Sort: Upcoming (nearest first), Recent (newest first)
            reports.sort((a, b) => {
                const da = new Date(a.reportDate!).getTime();
                const db = new Date(b.reportDate!).getTime();
                return isUpcoming ? da - db : db - da;
            });

            return { reports, finnhubSkipped: false, skipReason: '' };
        });

        return result || { reports: [], finnhubSkipped: false, skipReason: '' };
    } catch (err) {
        console.warn(`[Finnhub] Earnings Fetch Error`, String(err));
        return { reports: [], finnhubSkipped: false, skipReason: '' };
    }
}
