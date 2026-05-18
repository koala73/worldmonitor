import type {
    ServerContext,
    SearchFlightPricesRequest,
    SearchFlightPricesResponse,
} from '../../../../src/generated/server/worldmonitor/aviation/v1/service_server';
import { generateDemoPrices } from './_providers/demo_prices';
import { searchPricesTravelpayouts } from './_providers/travelpayouts_data';

type DegradedError = 'missing_credentials' | 'upstream_error' | 'no_results';
type DegradedProvider = 'none' | 'travelpayouts_data';

/**
 * Returns a fail-closed empty response with a `degraded: true` discriminator
 * so the UI can render a meaningful per-state message. Mirrors the shape
 * sibling `searchGoogleFlights` already uses. See issue #3756.
 */
function emptyDegraded(
    now: number,
    error: DegradedError,
    provider: DegradedProvider,
): SearchFlightPricesResponse {
    return {
        quotes: [],
        provider,
        isDemoMode: false,
        updatedAt: now,
        isIndicative: false,
        degraded: true,
        error,
    };
}

export async function searchFlightPrices(
    _ctx: ServerContext,
    req: SearchFlightPricesRequest,
): Promise<SearchFlightPricesResponse> {
    const origin = (req.origin || 'IST').toUpperCase();
    const destination = (req.destination || 'LHR').toUpperCase();
    const depDate = req.departureDate || new Date().toISOString().slice(0, 10);
    const returnDate = req.returnDate || '';
    const adults = Math.max(1, Math.min(req.adults ?? 1, 9));
    const cabin = req.cabin || 'CABIN_CLASS_ECONOMY';
    const nonstopOnly = req.nonstopOnly ?? false;
    const maxResults = Math.max(1, Math.min(req.maxResults ?? 10, 30));
    const currency = (req.currency || 'usd').toLowerCase();
    const market = (req.market || '').toLowerCase();

    const token = process.env.TRAVELPAYOUTS_API_TOKEN ?? '';
    // Demo mode is OPT-IN. The handler used to fall through to synthetic
    // quotes for missing-credentials / upstream-error / no-results in any
    // self-host run, with only a tiny "Indicative prices" UI footnote.
    // Issue #3756 — demo data now requires an explicit AVIATION_DEMO_PRICES=1
    // env var so production / self-host setups fail closed by default.
    const demoOptIn = process.env.AVIATION_DEMO_PRICES === '1';
    const now = Date.now();

    if (token) {
        try {
            const result = await searchPricesTravelpayouts({
                origin, destination, departureDate: depDate, returnDate,
                adults, cabin, nonstopOnly, maxResults, currency, market, token,
            });

            if (result.quotes.length > 0) {
                return {
                    quotes: result.quotes,
                    provider: 'travelpayouts_data',
                    isDemoMode: false,
                    updatedAt: now,
                    isIndicative: true,
                    degraded: false,
                    error: '',
                };
            }
            // Provider call succeeded but had no quotes for this route.
            // Note: with the current Travelpayouts provider, fetch errors
            // are caught internally and surfaced as empty data — so this
            // path also covers upstream failures. The proto's
            // `upstream_error` value is reserved for synchronous handler
            // failures (validation crashes, schema mismatches) that bubble
            // up out of searchPricesTravelpayouts itself.
            // TODO(#3756 follow-up): teach travelpayouts_data.ts to
            // distinguish fetch-error vs empty-result and surface that
            // through a TravelpayoutsResult.upstreamFailed flag, then the
            // handler can return `upstream_error` for real network/HTTP
            // failures instead of collapsing them into `no_results`.
            if (demoOptIn) {
                const quotes = generateDemoPrices(origin, destination, depDate, adults, cabin, nonstopOnly, maxResults, currency);
                return {
                    quotes,
                    provider: 'demo',
                    isDemoMode: true,
                    updatedAt: now,
                    isIndicative: true,
                    degraded: true,
                    error: 'no_results',
                };
            }
            return emptyDegraded(now, 'no_results', 'travelpayouts_data');
        } catch (err) {
            console.warn(`[Aviation] Travelpayouts upstream error: ${err instanceof Error ? err.message : err}`);
            if (demoOptIn) {
                const quotes = generateDemoPrices(origin, destination, depDate, adults, cabin, nonstopOnly, maxResults, currency);
                return {
                    quotes,
                    provider: 'demo',
                    isDemoMode: true,
                    updatedAt: now,
                    isIndicative: true,
                    degraded: true,
                    error: 'upstream_error',
                };
            }
            return emptyDegraded(now, 'upstream_error', 'travelpayouts_data');
        }
    }

    // No token configured.
    if (demoOptIn) {
        const quotes = generateDemoPrices(origin, destination, depDate, adults, cabin, nonstopOnly, maxResults, currency);
        return {
            quotes,
            provider: 'demo',
            isDemoMode: true,
            updatedAt: now,
            isIndicative: true,
            degraded: true,
            error: 'missing_credentials',
        };
    }
    return emptyDegraded(now, 'missing_credentials', 'none');
}
