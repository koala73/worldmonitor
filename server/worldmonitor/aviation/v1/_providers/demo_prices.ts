/**
 * Demo price provider — distance-based indicative pricing.
 * No API keys required. Always sets isIndicative = true.
 */

import type { PriceQuote, CabinClass, Carrier } from '../../../../../src/generated/server/worldmonitor/aviation/v1/service_server';

// Haversine distance
const AIRPORT_COORDS: Record<string, [number, number]> = {
    IST: [41.275, 28.752], ESB: [40.128, 32.995], SAW: [40.898, 29.309],
    LHR: [51.477, -0.461], FRA: [50.033, 8.571], CDG: [49.009, 2.548],
    AMS: [52.308, 4.764], MAD: [40.472, -3.561], BCN: [41.297, 2.078],
    JFK: [40.639, -73.779], LAX: [33.942, -118.408], ORD: [41.979, -87.905],
    DXB: [25.252, 55.364], DOH: [25.261, 51.565], AUH: [24.433, 54.651],
    SIN: [1.355, 103.988], BKK: [13.681, 100.747], HKG: [22.308, 113.918],
    NRT: [35.764, 140.386], PEK: [40.079, 116.603], SYD: [-33.946, 151.177],
    TLV: [32.011, 34.886], CAI: [30.121, 31.406], ATH: [37.936, 23.944],
    VIE: [48.110, 16.570], FCO: [41.800, 12.239], ZRH: [47.464, 8.549],
};

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const CABIN_MULTIPLIERS: Record<string, number> = {
    CABIN_CLASS_ECONOMY: 1,
    CABIN_CLASS_PREMIUM_ECONOMY: 1.8,
    CABIN_CLASS_BUSINESS: 3.5,
    CABIN_CLASS_FIRST: 6,
};

// Advance-purchase curve: >60 days → 0.8x, <7 days → 1.4x
function advancePurchaseMultiplier(departureDate: string): number {
    const daysOut = Math.max(0, (new Date(departureDate).getTime() - Date.now()) / 86_400_000);
    if (daysOut > 60) return 0.8;
    if (daysOut > 30) return 0.9;
    if (daysOut > 14) return 1.0;
    if (daysOut > 7) return 1.15;
    return 1.4;
}

const DEMO_CARRIERS: Carrier[] = [
    { iataCode: 'TK', icaoCode: 'THY', name: 'Turkish Airlines' },
    { iataCode: 'LH', icaoCode: 'DLH', name: 'Lufthansa' },
    { iataCode: 'BA', icaoCode: 'BAW', name: 'British Airways' },
    { iataCode: 'AF', icaoCode: 'AFR', name: 'Air France' },
    { iataCode: 'EK', icaoCode: 'UAE', name: 'Emirates' },
];

export function generateDemoPrices(
    origin: string,
    destination: string,
    departureDate: string,
    adults: number,
    cabin: string,
    nonstopOnly: boolean,
    maxResults: number,
    currency: string,
): PriceQuote[] {
    const c1 = AIRPORT_COORDS[origin] ?? [0, 0];
    const c2 = AIRPORT_COORDS[destination] ?? [0, 0];
    const distKm = haversineKm(c1[0], c1[1], c2[0], c2[1]) || 2500;

    const baseFare = Math.max(60, distKm * 0.07);
    const cabinMul = CABIN_MULTIPLIERS[cabin] ?? 1;
    const advMul = advancePurchaseMultiplier(departureDate);
    const durationMin = Math.round((distKm / 850) * 60) + 30;
    const now = Date.now();
    const count = Math.min(maxResults, 5);
    const quotes: PriceQuote[] = [];

    for (let i = 0; i < count; i++) {
        const carrier = DEMO_CARRIERS[i % DEMO_CARRIERS.length]!;
        const jitter = 0.85 + Math.random() * 0.3;
        const price = Math.round(baseFare * cabinMul * advMul * jitter * adults);
        const stops = nonstopOnly ? 0 : (i === 0 ? 0 : i <= 2 ? 1 : 2);
        const extra = stops * (45 + Math.floor(Math.random() * 60));

        quotes.push({
            id: `demo-${origin}-${destination}-${i}`,
            origin,
            destination,
            departureDate,
            returnDate: '',
            carrier,
            priceAmount: price,
            currency: currency.toUpperCase() || 'USD',
            cabin: cabin as CabinClass,
            stops,
            durationMinutes: durationMin + extra,
            bookingUrl: '',
            checkoutRef: '',
            provider: 'demo',
            isIndicative: true,
            observedAt: now,
            expiresAt: 0,
        });
    }

    return quotes.sort((a, b) => a.priceAmount - b.priceAmount);
}
