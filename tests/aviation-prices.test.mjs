import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function src(relPath) {
    return readFileSync(resolve(root, relPath), 'utf-8');
}

// ---------------------------------------------------------------------------
// 1. Service wrappers — fetchGoogleFlights + fetchGoogleDates
// ---------------------------------------------------------------------------
describe('aviation service — Google Flights wrappers', () => {
    const aviation = src('src/services/aviation/index.ts');

    it('fetchGoogleFlights is exported and uses circuit breaker with empty fallback', () => {
        assert.ok(
            aviation.includes('export async function fetchGoogleFlights'),
            'fetchGoogleFlights must be exported',
        );
        assert.ok(
            aviation.includes('breakerGoogleFlights.execute'),
            'fetchGoogleFlights must use breakerGoogleFlights circuit breaker',
        );
        assert.ok(
            aviation.includes('{ flights: [], degraded: true'),
            'fetchGoogleFlights must return empty fallback with degraded:true on failure',
        );
    });

    it('fetchGoogleFlights circuit breaker has cacheTtlMs: 0 (no client-side caching)', () => {
        const breakerMatch = aviation.match(/breakerGoogleFlights\s*=\s*createCircuitBreaker[^)]+\)/s);
        assert.ok(breakerMatch, 'breakerGoogleFlights definition not found');
        assert.ok(
            breakerMatch[0].includes('cacheTtlMs: 0'),
            'Google Flights breaker must have cacheTtlMs: 0 (prices change rapidly)',
        );
    });

    it('fetchGoogleDates is exported and uses circuit breaker with empty fallback', () => {
        assert.ok(
            aviation.includes('export async function fetchGoogleDates'),
            'fetchGoogleDates must be exported',
        );
        assert.ok(
            aviation.includes('breakerGoogleDates.execute'),
            'fetchGoogleDates must use breakerGoogleDates circuit breaker',
        );
        assert.ok(
            aviation.includes('{ dates: [], degraded: true'),
            'fetchGoogleDates must return empty fallback with degraded:true on failure',
        );
    });

    it('fetchGoogleDates circuit breaker has 5-min client cache', () => {
        const breakerMatch = aviation.match(/breakerGoogleDates\s*=\s*createCircuitBreaker[^)]+\)/s);
        assert.ok(breakerMatch, 'breakerGoogleDates definition not found');
        assert.ok(
            breakerMatch[0].includes('cacheTtlMs: 5 * 60 * 1000') ||
            breakerMatch[0].includes('cacheTtlMs: 300000'),
            'Google Dates breaker must have 5-minute client cache',
        );
    });

    it('toDisplayGoogleFlight normalizer maps all leg fields from proto', () => {
        assert.ok(
            aviation.includes('function toDisplayGoogleFlight'),
            'toDisplayGoogleFlight normalizer must exist',
        );
        const normIdx = aviation.indexOf('function toDisplayGoogleFlight');
        const normSection = aviation.slice(normIdx, normIdx + 600);
        for (const field of ['airlineCode', 'flightNumber', 'departureAirport', 'arrivalAirport', 'departureDatetime', 'arrivalDatetime', 'durationMinutes']) {
            assert.ok(normSection.includes(field), `toDisplayGoogleFlight must map field: ${field}`);
        }
    });

    it('toDisplayDatePrice normalizer maps date, returnDate, price', () => {
        assert.ok(
            aviation.includes('function toDisplayDatePrice'),
            'toDisplayDatePrice normalizer must exist',
        );
        const normIdx = aviation.indexOf('function toDisplayDatePrice');
        const normSection = aviation.slice(normIdx, normIdx + 300);
        for (const field of ['date', 'returnDate', 'price']) {
            assert.ok(normSection.includes(field), `toDisplayDatePrice must map field: ${field}`);
        }
    });

    it('fetchGoogleDates passes isRoundTrip and tripDuration to the request', () => {
        const fnIdx = aviation.indexOf('export async function fetchGoogleDates');
        const fnSection = aviation.slice(fnIdx, fnIdx + 800);
        assert.ok(
            fnSection.includes('isRoundTrip') || fnSection.includes('is_round_trip'),
            'fetchGoogleDates must pass isRoundTrip param',
        );
        assert.ok(
            fnSection.includes('tripDuration') || fnSection.includes('trip_duration'),
            'fetchGoogleDates must pass tripDuration param',
        );
    });

    it('fetchFlightPrices and isPriceExpired are still exported (used by AviationCommandBar)', () => {
        assert.ok(
            aviation.includes('export async function fetchFlightPrices'),
            'fetchFlightPrices must remain exported — AviationCommandBar still uses it',
        );
        assert.ok(
            aviation.includes('export function isPriceExpired'),
            'isPriceExpired must remain exported — AviationCommandBar still uses it',
        );
    });
});

// ---------------------------------------------------------------------------
// 2. AirlineIntelPanel — no auto-fetch on prices tab switch
// ---------------------------------------------------------------------------
describe('AirlineIntelPanel — prices tab never auto-fetches', () => {
    const panel = src('src/components/AirlineIntelPanel.ts');

    it('switchTab auto-load block does not include prices', () => {
        const switchFn = panel.match(/private switchTab[^}]+\}/s);
        assert.ok(switchFn, 'switchTab method not found');
        const body = switchFn[0];
        assert.ok(
            !body.includes("tab === 'prices'"),
            "switchTab must NOT auto-load prices tab — prices only fetches on explicit search button click",
        );
    });

    it('refresh() skips loading the prices tab', () => {
        const refreshFn = panel.match(/private async refresh[^}]+\}/s);
        assert.ok(refreshFn, 'refresh() method not found');
        const body = refreshFn[0];
        assert.ok(
            body.includes("'prices'"),
            "refresh() must guard against loading the prices tab",
        );
        assert.ok(
            body.includes("!== 'prices'"),
            "refresh() must skip prices tab with !== 'prices' guard",
        );
    });

    it('prices tab state uses googleFlightsData and datesData, not pricesData', () => {
        assert.ok(
            panel.includes('googleFlightsData'),
            'AirlineIntelPanel must use googleFlightsData state field',
        );
        assert.ok(
            panel.includes('datesData'),
            'AirlineIntelPanel must use datesData state field',
        );
        assert.ok(
            !panel.includes('pricesData'),
            'AirlineIntelPanel must NOT use old pricesData field',
        );
    });

    it('loadTab prices branches on pricesMode', () => {
        const loadTabFn = panel.match(/private async loadTab[^}]+switch[^}]+\}/s);
        assert.ok(loadTabFn, 'loadTab method not found');
        assert.ok(
            panel.includes("pricesMode === 'dates'") || panel.includes("this.pricesMode === 'dates'"),
            "loadTab prices case must branch on pricesMode",
        );
    });

    it('pricesOrigin pre-filled from watchlist routes, not hardcoded IST/LHR', () => {
        assert.ok(
            panel.includes("wl.routes") && panel.includes("split('-')"),
            'pricesOrigin must be pre-filled from wl.routes split',
        );
        assert.ok(
            panel.includes('airports[0]') && panel.includes("?? 'IST'"),
            'IST must only appear as final fallback, not hardcoded default',
        );
    });

    it('mode toggle renders [data-price-mode] buttons', () => {
        assert.ok(
            panel.includes('data-price-mode="search"'),
            'renderPrices must include data-price-mode="search" toggle button',
        );
        assert.ok(
            panel.includes('data-price-mode="dates"'),
            'renderPrices must include data-price-mode="dates" toggle button',
        );
    });

    it('all server-derived strings pass through escapeHtml', () => {
        assert.ok(
            panel.includes('escapeHtml(this.pricesError)'),
            'pricesError must be passed through escapeHtml',
        );
        assert.ok(
            panel.includes('escapeHtml(leg.airlineCode)') && panel.includes('escapeHtml(leg.flightNumber)'),
            'leg fields must be passed through escapeHtml',
        );
        assert.ok(
            panel.includes('escapeHtml(d.date)') && panel.includes('escapeHtml(d.returnDate)'),
            'date fields must be passed through escapeHtml',
        );
    });
});
