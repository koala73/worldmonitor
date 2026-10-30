/// <reference lib="es2022.intl" />

import type { PriceQuote, CabinClass, Carrier } from '../../../../../src/generated/server/worldmonitor/aviation/v1/service_server';
import { ValidationError } from '../../../../../src/generated/server/worldmonitor/aviation/v1/service_server';
import { cachedFetchJson } from '../../../../_shared/redis';
import { CHROME_UA } from '../../../../_shared/constants';
import { normalizeCountryToIso2 } from '../../../../_shared/country-normalize';
import { IATA_RE } from '../_shared';

const BASE_V2 = 'https://api.travelpayouts.com/v2/prices';
const BASE_V3 = 'https://api.travelpayouts.com/v3';

const SNAPSHOT_PREFIX = 'aviation:price-snapshot';

// Premium economy has no code, so the request asks for economy.
const CABIN_CLASS_MAP: Record<string, number> = {
    CABIN_CLASS_ECONOMY: 0,
    CABIN_CLASS_PREMIUM_ECONOMY: 0,
    CABIN_CLASS_BUSINESS: 1,
    CABIN_CLASS_FIRST: 2,
};

const TRIP_CLASS_CABIN: Partial<Record<number, CabinClass>> = {
    0: 'CABIN_CLASS_ECONOMY',
    1: 'CABIN_CLASS_BUSINESS',
    2: 'CABIN_CLASS_FIRST',
};

const CURRENCIES = new Set(Intl.supportedValuesOf('currency').map(code => code.toLowerCase()));

function validDate(value: string): boolean {
    if (value === '') return true;
    if (!/^\d{4}-\d{2}(?:-\d{2})?$/.test(value)) return false;
    const date = value.length === 7 ? `${value}-01` : value;
    const parsed = new Date(`${date}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

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
    expires_at?: string;
    trip_class?: number;
}

interface TpMonthMatrixTicket {
    origin?: string;
    destination?: string;
    depart_date?: string;
    return_date?: string;
    number_of_changes?: number;
    value?: number;
    price?: number;
    trip_class?: number;
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

function expiresMs(isoStr?: string): number {
    if (!isoStr) return 0;
    try { return new Date(isoStr).getTime(); } catch { return 0; }
}

function parseCarrier(iata?: string): Carrier {
    return { iataCode: iata ?? '', icaoCode: '', name: iata ?? '' };
}

function cabinFromTripClass(code: unknown): CabinClass {
    if (typeof code !== 'number' || !Number.isInteger(code)) return 'CABIN_CLASS_UNSPECIFIED';
    return TRIP_CLASS_CABIN[code] ?? 'CABIN_CLASS_UNSPECIFIED';
}

function fareAmount(value: unknown, legacyPrice: unknown): number | null {
    const amount = value ?? legacyPrice;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) return null;
    return amount;
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
        cabin: cabinFromTripClass(t.trip_class),
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

function fromMonthMatrix(t: TpMonthMatrixTicket, origin: string, destination: string, currency: string, now: number): PriceQuote | null {
    const priceAmount = fareAmount(t.value, t.price);
    if (priceAmount === null) return null;
    return {
        id: `tp-month-${t.origin ?? origin}-${t.destination ?? destination}-${t.depart_date ?? ''}`,
        origin: t.origin ?? origin,
        destination: t.destination ?? destination,
        departureDate: t.depart_date ?? '',
        returnDate: t.return_date ?? '',
        carrier: parseCarrier(t.airline),
        priceAmount,
        currency: currency.toUpperCase(),
        cabin: cabinFromTripClass(t.trip_class),
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
        // v2 sets success. v3 returns data without that flag.
        if ('success' in json && !json.success) return null;
        return (json.data ?? json) as T;
    } catch (err) {
        console.warn(`[Travelpayouts] fetch error: ${err instanceof Error ? err.message : err}`);
        return null;
    }
}

export interface TravelpayoutsResult {
    quotes: PriceQuote[];
    isDemoMode: false;
    // True when the underlying HTTP/network call failed (fetchTp returned
    // null) — distinct from a successful upstream call that returned an
    // empty `data` array (genuine no-results for this route). The
    // search-flight-prices handler uses this to surface error:'upstream_error'
    // vs error:'no_results'. See issue #3756 and the #3795 review-2 follow-up.
    upstreamFailed: boolean;
}

export async function searchPricesTravelpayouts(opts: {
    origin: string;
    destination: string;
    departureDate: string;
    returnDate: string;
    cabin: string;
    nonstopOnly: boolean;
    maxResults: number;
    currency: string;
    market: string;
    token: string;
}): Promise<TravelpayoutsResult> {
    const { departureDate, returnDate, nonstopOnly, maxResults, token } = opts;
    const origin = opts.origin.trim().toUpperCase();
    const destination = opts.destination.trim().toUpperCase();
    const cabin = !opts.cabin || opts.cabin === 'CABIN_CLASS_UNSPECIFIED' ? 'CABIN_CLASS_ECONOMY' : opts.cabin;
    const currency_ = (opts.currency || 'usd').trim().toLowerCase();
    const market_ = (opts.market || inferMarket(origin)).trim().toLowerCase();
    // Validate before cache keys. An unknown cabin would otherwise store an economy query under its own key.
    const invalidField = [
        ['origin', IATA_RE.test(origin), 'Expected a three-letter airport code'],
        ['destination', IATA_RE.test(destination), 'Expected a three-letter airport code'],
        ['departure_date', validDate(departureDate), 'Expected a YYYY-MM-DD date'],
        ['return_date', validDate(returnDate), 'Expected a YYYY-MM-DD date'],
        ['cabin', Object.prototype.hasOwnProperty.call(CABIN_CLASS_MAP, cabin), 'Unsupported cabin class'],
        ['currency', CURRENCIES.has(currency_), 'Unsupported currency'],
        ['market', /^[a-z]{2}$/.test(market_) && Boolean(normalizeCountryToIso2(market_)), 'Expected a two-letter market country code'],
    ].find(([, valid]) => !valid) as [string, boolean, string] | undefined;
    if (invalidField) throw new ValidationError([{ field: invalidField[0], description: invalidField[2] }]);
    const now = Date.now();
    const tripClass = CABIN_CLASS_MAP[cabin]!;

    const isDayPrecision = /^\d{4}-\d{2}-\d{2}$/.test(departureDate);
    const isMonthPrecision = /^\d{4}-\d{2}$/.test(departureDate);

    let quotes: PriceQuote[] = [];
    let upstreamFailed = false;

    if (isDayPrecision) {
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

        const cacheKey = `tp:v3:${origin}:${destination}:${departureDate}:${returnDate}:${cabin}:${currency_}:${market_}:${nonstopOnly}:${Math.min(maxResults, 30)}:v2`;
        const data = await cachedFetchJson<TpV3Ticket[]>(cacheKey, 3600, () =>
            fetchTp<TpV3Ticket[]>(`${BASE_V3}/prices_for_dates?${params}`, token)
        );

        if (data === null) upstreamFailed = true;
        else quotes = data.slice(0, maxResults).map(t => fromV3(t, origin, destination, currency_, cabin, now));
    } else if (isMonthPrecision) {
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
        );

        if (data === null) {
            upstreamFailed = true;
        } else {
            const rows = nonstopOnly ? data.filter(r => (r.number_of_changes ?? 0) === 0) : data;
            const priced = rows.flatMap(row => {
                const quote = fromMonthMatrix(row, origin, destination, currency_, now);
                return quote ? [quote] : [];
            });
            quotes = priced.slice(0, maxResults);
        }
    } else {
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

        const cacheKey = `tp:latest:${origin}:${destination}:${cabin}:${currency_}:${returnDate ? 'roundtrip' : 'oneway'}:${Math.min(maxResults, 30)}:v2`;
        const data = await cachedFetchJson<TpLatestTicket[]>(cacheKey, 3600, () =>
            fetchTp<TpLatestTicket[]>(`${BASE_V2}/latest?${params}`, token)
        );

        if (data === null) {
            upstreamFailed = true;
        } else {
            const rows = nonstopOnly ? data.filter(r => (r.number_of_changes ?? 0) === 0) : data;
            quotes = rows.slice(0, maxResults).map(t => fromLatest(t, origin, destination, currency_, now));
        }
    }

    try {
        const snapshotKey = `${SNAPSHOT_PREFIX}:${origin}-${destination}:${departureDate.slice(0, 7)}:${cabin}:v1`;
        await cachedFetchJson(snapshotKey, 7 * 24 * 3600, async () => ({
            quotes: quotes.map(q => ({ price: q.priceAmount, carrier: q.carrier?.iataCode })),
            savedAt: now,
        }));
    } catch { /* snapshot failure must not fail the search */ }

    return { quotes, isDemoMode: false, upstreamFailed };
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
