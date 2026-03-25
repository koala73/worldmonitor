/**
 * Travelpayouts Cached Data API provider
 * Auth: X-Access-Token header
 * All results are indicative (cached), bookingUrl/checkoutRef left empty.
 *
 * Endpoints:
 *   v2/prices/latest           — cheapest tickets found recently for a route
 *   v2/prices/month-matrix     — cheapest by day for a month
 *   v3/prices_for_dates        — specific date range (day-precision, one-way/return)
 */

import type { PriceQuote, CabinClass, Carrier } from '../../../../../src/generated/server/worldmonitor/aviation/v1/service_server';
import { cachedFetchJson } from '../../../../_shared/redis';
import { CHROME_UA } from '../../../../_shared/constants';

const BASE_V2 = 'https://api.travelpayouts.com/v2/prices';
const BASE_V3 = 'https://api.travelpayouts.com/v3';

// Cache key for 7-day price snapshots
const SNAPSHOT_PREFIX = 'aviation:price-snapshot';

// Travelpayouts trip_class codes
const CABIN_CLASS_MAP: Record<string, number> = {
    CABIN_CLASS_ECONOMY: 0,
    CABIN_CLASS_PREMIUM_ECONOMY: 1,
    CABIN_CLASS_BUSINESS: 2,
    CABIN_CLASS_FIRST: 2,  // treat as business — most caches lack separate FIRST
};

// ---- Internal response shapes ----

interface TpLatestTicket {
    origin?: string;
    destination?: string;
    depart_date?: string;
    return_date?: string;
    number_of_changes?: number;
    value?: number;
    currency?: string;
    duration?: number;
    distance?: number;
    gate?: string;
    airline?: string;
    expires_at?: string;    // ISO-8601
    class?: number;
}

interface TpMonthMatrixTicket {
    origin?: string;
    destination?: string;
    depart_date?: string;
    return_date?: string;
    number_of_changes?: number;
    price?: number;
    airline?: string;
    duration?: number;
    expires_at?: string;
}

interface TpV3Ticket {
    origin?: string;
    destination?: string;
    departure_at?: string;
    return_at?: string;
    transfers?: number;
    price?: number;
    airline?: string;
    flight_number?: number;
    duration_to?: number;
    duration_back?: number | null;
    expires_at?: string;
}

// ---- Normalisers ----

function expiresMs(isoStr?: string): number {
    if (!isoStr) return 0;
    try { return new Date(isoStr).getTime(); } catch { return 0; }
}

function parseCarrier(iata?: string): Carrier {
    return { iataCode: iata ?? '', icaoCode: '', name: iata ?? '' };
}

function fromLatest(t: TpLatestTicket, origin: string, destination: string, currency: string, now: number): PriceQuote {
    return {
        id: `tp-latest-${t.origin ?? origin}-${t.destination ?? destination}-${t.depart_date ?? ''}`,
        origin: t.origin ?? origin,
        destination: t.destination ?? destination,
        departureDate: t.depart_date ?? '',
        returnDate: t.return_date ?? '',
        carrier: parseCarrier(t.airline),
        priceAmount: t.value ?? 0,
        currency: (t.currency ?? currency).toUpperCase(),
        cabin: 'CABIN_CLASS_ECONOMY',
        stops: t.number_of_changes ?? 0,
        durationMinutes: t.duration ?? 0,
        bookingUrl: '',
        checkoutRef: '',
        provider: 'travelpayouts_data',
        isIndicative: true,
        observedAt: now,
        expiresAt: expiresMs(t.expires_at),
    };
}

function fromMonthMatrix(t: TpMonthMatrixTicket, origin: string, destination: string, currency: string, now: number): PriceQuote {
    return {
        id: `tp-month-${t.origin ?? origin}-${t.destination ?? destination}-${t.depart_date ?? ''}`,
        origin: t.origin ?? origin,
        destination: t.destination ?? destination,
        departureDate: t.depart_date ?? '',
        returnDate: t.return_date ?? '',
        carrier: parseCarrier(t.airline),
        priceAmount: t.price ?? 0,
        currency: currency.toUpperCase(),
        cabin: 'CABIN_CLASS_ECONOMY',
        stops: t.number_of_changes ?? 0,
        durationMinutes: t.duration ?? 0,
        bookingUrl: '',
        checkoutRef: '',
        provider: 'travelpayouts_data',
        isIndicative: true,
        observedAt: now,
        expiresAt: expiresMs(t.expires_at),
    };
}

function fromV3(t: TpV3Ticket, origin: string, destination: string, currency: string, cabin: string, now: number): PriceQuote {
    const dur = (t.duration_to ?? 0) + (t.duration_back ?? 0);
    return {
        id: `tp-v3-${t.origin ?? origin}-${t.destination ?? destination}-${t.departure_at?.slice(0, 10) ?? ''}`,
        origin: t.origin ?? origin,
        destination: t.destination ?? destination,
        departureDate: t.departure_at?.slice(0, 10) ?? '',
        returnDate: t.return_at?.slice(0, 10) ?? '',
        carrier: parseCarrier(t.airline),
        priceAmount: t.price ?? 0,
        currency: currency.toUpperCase(),
        cabin: cabin as CabinClass,
        stops: t.transfers ?? 0,
        durationMinutes: dur,
        bookingUrl: '',
        checkoutRef: '',
        provider: 'travelpayouts_data',
        isIndicative: true,
        observedAt: now,
        expiresAt: expiresMs(t.expires_at),
    };
}

// ---- Fetch helpers ----

function makeHeaders(token: string): Record<string, string> {
    return {
        'X-Access-Token': token,
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        'User-Agent': CHROME_UA,
    };
}

async function fetchTp<T>(url: string, token: string): Promise<T | null> {
    try {
        const resp = await fetch(url, {
            headers: makeHeaders(token),
            signal: AbortSignal.timeout(15_000),
        });
        if (!resp.ok) {
            console.warn(`[Travelpayouts] ${resp.status} for ${url}`);
            return null;
        }
        const json = await resp.json() as { data?: T; success?: boolean };
        // v2 wraps in { success, data }, v3 wraps in { data }
        if ('success' in json && !json.success) return null;
        return (json.data ?? json) as T;
    } catch (err) {
        console.warn(`[Travelpayouts] fetch error: ${err instanceof Error ? err.message : err}`);
        return null;
    }
}

// ---- Main search function ----

export interface TravelpayoutsResult {
    quotes: PriceQuote[];
    isDemoMode: false;
}

export async function searchPricesTravelpayouts(opts: {
    origin: string;
    destination: string;
    departureDate: string;
    returnDate: string;
    adults: number;
    cabin: string;
    nonstopOnly: boolean;
    maxResults: number;
    currency: string;
    market: string;
    token: string;
}): Promise<TravelpayoutsResult> {
    const { origin, destination, departureDate, returnDate, adults: _adults, cabin, nonstopOnly, maxResults, currency, market, token } = opts;
    const now = Date.now();
    const tripClass = CABIN_CLASS_MAP[cabin] ?? 0;
    const currency_ = currency || 'usd';
    const market_ = market || inferMarket(origin);

    // Determine query style:
    // - Day-precision date given → v3 prices_for_dates (most precise)
    // - Month-precision (YYYY-MM) → v2 month-matrix
    // - No date / fuzzy → v2 latest
    const isDayPrecision = /^\d{4}-\d{2}-\d{2}$/.test(departureDate);
    const isMonthPrecision = /^\d{4}-\d{2}$/.test(departureDate);

    let quotes: PriceQuote[] = [];

    if (isDayPrecision) {
        // v3: prices_for_dates
        const params = new URLSearchParams({
            origin,
            destination,
            departure_at: departureDate,
            currency: currency_,
            trip_class: String(tripClass),
            one_way: returnDate ? 'false' : 'true',
            sorting: 'price',
            limit: String(Math.min(maxResults, 30)),
        });
        if (returnDate) params.set('return_at', returnDate);
        if (nonstopOnly) params.set('direct', 'true');
        if (market_) params.set('market', market_);

        const cacheKey = `tp:v3:${origin}:${destination}:${departureDate}:${returnDate}:${cabin}:${currency_}:v1`;
        const data = await cachedFetchJson<TpV3Ticket[]>(cacheKey, 3600, () =>
            fetchTp<TpV3Ticket[]>(`${BASE_V3}/prices_for_dates?${params}`, token)
                .then(d => d ?? [])
        );

        quotes = (data ?? []).slice(0, maxResults).map(t => fromV3(t, origin, destination, currency_, cabin, now));
    } else if (isMonthPrecision) {
        // v2: month-matrix
        const params = new URLSearchParams({
            currency: currency_,
            origin,
            destination,
            show_to_affiliates: 'true',
            month: departureDate + '-01',
            trip_class: String(tripClass),
        });

        const cacheKey = `tp:month:${origin}:${destination}:${departureDate}:${cabin}:${currency_}:v1`;
        const data = await cachedFetchJson<TpMonthMatrixTicket[]>(cacheKey, 7200, () =>
            fetchTp<TpMonthMatrixTicket[]>(`${BASE_V2}/month-matrix?${params}`, token)
                .then(d => d ?? [])
        );

        let rows = data ?? [];
        if (nonstopOnly) rows = rows.filter(r => (r.number_of_changes ?? 0) === 0);
        quotes = rows.slice(0, maxResults).map(t => fromMonthMatrix(t, origin, destination, currency_, now));
    } else {
        // v2: latest
        const params = new URLSearchParams({
            currency: currency_,
            origin,
            destination,
            period_type: 'year',
            one_way: returnDate ? 'false' : 'true',
            trip_class: String(tripClass),
            limit: String(Math.min(maxResults, 30)),
            sorting: 'price',
            show_to_affiliates: 'true',
        });

        const cacheKey = `tp:latest:${origin}:${destination}:${cabin}:${currency_}:v1`;
        const data = await cachedFetchJson<TpLatestTicket[]>(cacheKey, 3600, () =>
            fetchTp<TpLatestTicket[]>(`${BASE_V2}/latest?${params}`, token)
                .then(d => d ?? [])
        );

        let rows = data ?? [];
        if (nonstopOnly) rows = rows.filter(r => (r.number_of_changes ?? 0) === 0);
        quotes = rows.slice(0, maxResults).map(t => fromLatest(t, origin, destination, currency_, now));
    }

    // Save 7-day price snapshot for diff display
    try {
        const snapshotKey = `${SNAPSHOT_PREFIX}:${origin}-${destination}:${departureDate.slice(0, 7)}:${cabin}:v1`;
        await cachedFetchJson(snapshotKey, 7 * 24 * 3600, async () => ({
            quotes: quotes.map(q => ({ price: q.priceAmount, carrier: q.carrier?.iataCode })),
            savedAt: now,
        }));
    } catch { /* non-critical */ }

    return { quotes, isDemoMode: false };
}

function inferMarket(originIata: string): string {
    const EU = new Set(['LHR', 'FRA', 'CDG', 'AMS', 'MAD', 'BCN', 'FCO', 'VIE', 'ZRH', 'ATH', 'BRU', 'LIS', 'ARN', 'CPH', 'HEL']);
    const TR = new Set(['IST', 'ESB', 'SAW', 'ADB', 'AYT', 'BJV']);
    const AE = new Set(['DXB', 'AUH', 'SHJ']);
    if (TR.has(originIata)) return 'tr';
    if (EU.has(originIata)) return 'gb';
    if (AE.has(originIata)) return 'ae';
    return 'us';
}
