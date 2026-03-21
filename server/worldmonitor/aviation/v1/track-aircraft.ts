import type {
    ServerContext,
    TrackAircraftRequest,
    TrackAircraftResponse,
    PositionSample,
} from '../../../../src/generated/server/worldmonitor/aviation/v1/service_server';
import { getRelayBaseUrl, getRelayHeaders } from './_shared';
import { cachedFetchJson } from '../../../_shared/redis';
import { CHROME_UA } from '../../../_shared/constants';

// 120s for anonymous OpenSky tier (~10 req/min limit); TODO: reduce to 10s on commercial tier
const CACHE_TTL = 120;

interface OpenSkyResponse {
    states?: unknown[][];
}

interface WingbitsRelayResponse {
    positions?: PositionSample[];
    source?: string;
}

function parseOpenSkyStates(states: unknown[][]): PositionSample[] {
    const now = Date.now();
    return states
        .filter(s => Array.isArray(s) && s[5] != null && s[6] != null)
        .map((s): PositionSample => ({
            icao24: String(s[0] ?? ''),
            callsign: String(s[1] ?? '').trim(),
            lat: Number(s[6]),
            lon: Number(s[5]),
            altitudeM: Number(s[7] ?? 0),
            groundSpeedKts: Number(s[9] ?? 0) * 1.944,
            trackDeg: Number(s[10] ?? 0),
            verticalRate: Number(s[11] ?? 0),
            onGround: Boolean(s[8]),
            source: 'POSITION_SOURCE_OPENSKY',
            observedAt: Number(s[4] ?? (now / 1000)) * 1000,
        }));
}


const OPENSKY_PUBLIC_BASE = 'https://opensky-network.org/api';

async function fetchOpenSkyAnonymous(req: TrackAircraftRequest): Promise<PositionSample[]> {
    let url: string;
    if (req.swLat != null && req.neLat != null) {
        url = `${OPENSKY_PUBLIC_BASE}/states/all?lamin=${req.swLat}&lomin=${req.swLon}&lamax=${req.neLat}&lomax=${req.neLon}`;
    } else if (req.icao24) {
        url = `${OPENSKY_PUBLIC_BASE}/states/all?icao24=${req.icao24}`;
    } else {
        url = `${OPENSKY_PUBLIC_BASE}/states/all`;
    }

    const resp = await fetch(url, {
        signal: AbortSignal.timeout(6_000),
        headers: { 'Accept': 'application/json', 'User-Agent': CHROME_UA },
    });
    if (!resp.ok) throw new Error(`OpenSky anonymous HTTP ${resp.status}`);
    const data = await resp.json() as OpenSkyResponse;
    return parseOpenSkyStates(data.states ?? []);
}

function buildCacheKey(req: TrackAircraftRequest): string {
    if (req.icao24) return `aviation:track:icao:${req.icao24}:v1`;
    if (req.swLat != null && req.neLat != null) {
        return `aviation:track:${Math.floor(req.swLat)}:${Math.floor(req.swLon)}:${Math.ceil(req.neLat)}:${Math.ceil(req.neLon)}:v1`;
    }
    return 'aviation:track:all:v1';
}

// Response-level source values (TrackAircraftResponse.source):
//   'opensky'           — data from OpenSky via relay
//   'opensky-anonymous' — data from OpenSky public API (no auth, rate-limited)
//   'wingbits'          — data from Wingbits via relay
//   'none'              — all real sources returned empty or failed; positions = []
export async function trackAircraft(
    _ctx: ServerContext,
    req: TrackAircraftRequest,
): Promise<TrackAircraftResponse> {
    const cacheKey = buildCacheKey(req);

    let result: { positions: PositionSample[]; source: string } | null = null;
    try {
        result = await cachedFetchJson<{ positions: PositionSample[]; source: string }>(
            cacheKey, CACHE_TTL, async () => {
                const relayBase = getRelayBaseUrl();

                // Try relay first if configured
                if (relayBase) {
                    try {
                        let osUrl: string;
                        if (req.swLat != null && req.neLat != null) {
                            osUrl = `${relayBase}/opensky/states/all?lamin=${req.swLat}&lomin=${req.swLon}&lamax=${req.neLat}&lomax=${req.neLon}`;
                        } else if (req.icao24) {
                            osUrl = `${relayBase}/opensky/states/all?icao24=${req.icao24}`;
                        } else {
                            osUrl = `${relayBase}/opensky/states/all`;
                        }

                        const resp = await fetch(osUrl, {
                            headers: getRelayHeaders({}),
                            signal: AbortSignal.timeout(10_000),
                        });

                        if (resp.ok) {
                            const data = await resp.json() as OpenSkyResponse;
                            const positions = parseOpenSkyStates(data.states ?? []);
                            if (positions.length > 0) return { positions, source: 'opensky' };
                        }
                    } catch (err) {
                        console.warn(`[Aviation] Relay failed: ${err instanceof Error ? err.message : err}`);
                    }
                }

                // Try direct OpenSky anonymous API (no auth needed, ~10 req/min limit)
                try {
                    const directPositions = await fetchOpenSkyAnonymous(req);
                    if (directPositions.length > 0) {
                        return { positions: directPositions, source: 'opensky-anonymous' };
                    }
                } catch (err) {
                    console.warn(`[Aviation] Direct OpenSky anonymous failed: ${err instanceof Error ? err.message : err}`);
                }

                // Try Wingbits relay. Supports bbox queries and, for callsign-only searches,
                // a global bbox so we can find the aircraft regardless of position.
                if (relayBase) {
                    try {
                        let wbUrl: string;
                        if (req.swLat != null && req.neLat != null) {
                            wbUrl = `${relayBase}/wingbits/track?lamin=${req.swLat}&lomin=${req.swLon}&lamax=${req.neLat}&lomax=${req.neLon}`;
                        } else if (req.callsign) {
                            // Global search — relay uses a worldwide box and filters by callsign.
                            wbUrl = `${relayBase}/wingbits/track?callsign=${encodeURIComponent(req.callsign)}`;
                        } else {
                            wbUrl = '';
                        }
                        if (wbUrl) {
                            const wbResp = await fetch(wbUrl, {
                                headers: getRelayHeaders({}),
                                signal: AbortSignal.timeout(15_000),
                            });
                            if (wbResp.ok) {
                                const wbData = await wbResp.json() as WingbitsRelayResponse;
                                if (wbData.positions && wbData.positions.length > 0) {
                                    return { positions: wbData.positions, source: 'wingbits' };
                                }
                            }
                        }
                    } catch (err) {
                        console.warn(`[Aviation] Wingbits relay failed: ${err instanceof Error ? err.message : err}`);
                    }
                }

                return null; // negative-cached briefly
            }, CACHE_TTL, // negative TTL same as positive — retry quickly
        );
    } catch {
        /* Redis unavailable — fall through to simulated */
    }

    if (result) {
        let positions = result.positions;
        if (req.icao24) positions = positions.filter(p => p.icao24 === req.icao24);
        if (req.callsign) positions = positions.filter(p => p.callsign.includes(req.callsign.toUpperCase()));
        return { positions, source: result.source, updatedAt: Date.now() };
    }

    return { positions: [], source: 'none', updatedAt: Date.now() };
}
