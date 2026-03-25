import type {
    ServerContext,
    SearchFlightPricesRequest,
    SearchFlightPricesResponse,
} from '../../../../src/generated/server/worldmonitor/aviation/v1/service_server';
import { generateDemoPrices } from './_providers/demo_prices';
import { searchPricesTravelpayouts } from './_providers/travelpayouts_data';

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
                    isIndicative: true,
                    updatedAt: now,
                };
            }
            // Fall through to demo if TP returned nothing
        } catch (err) {
            console.warn(`[Aviation] Travelpayouts failed, using demo: ${err instanceof Error ? err.message : err}`);
        }
    }

    // Demo fallback
    const quotes = generateDemoPrices(origin, destination, depDate, adults, cabin, nonstopOnly, maxResults, currency);
    return {
        quotes,
        provider: 'demo',
        isDemoMode: true,
        isIndicative: true,
        updatedAt: now,
    };
}
