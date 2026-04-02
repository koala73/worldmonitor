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
// Callsign searches hit the relay's in-memory index (5min TTL); cache positive hits 60s,
// negative hits 10s so a retry after panning into view returns fresh data quickly.
const CALLSIGN_CACHE_TTL = 60;
const CALLSIGN_NEGATIVE_TTL = 10;

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
        return `aviation:track:bbox:${Math.floor(req.swLat)}:${Math.floor(req.swLon)}:${Math.ceil(req.neLat)}:${Math.ceil(req.neLon)}:v1`;
    }
    if (req.callsign) return `aviation:track:callsign:${req.callsign.toUpperCase()}:v1`;
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
        const positiveTtl = req.callsign ? CALLSIGN_CACHE_TTL : CACHE_TTL;
        const negativeTtl = req.callsign ? CALLSIGN_NEGATIVE_TTL : CACHE_TTL;
        result = await cachedFetchJson<{ positions: PositionSample[]; source: string }>(
            cacheKey, positiveTtl, async () => {
                const relayBase = getRelayBaseUrl();
                const isCallsignOnly = !!req.callsign && req.swLat == null && req.icao24 == null;

                // For callsign-only searches, try Wingbits first — commercial flights like UAE20
                // are Wingbits-exclusive and not visible in OpenSky. Trying OpenSky first wastes
                // time and may return an early hit with no callsign match.
                if (isCallsignOnly && relayBase) {
                    try {
                        const wbUrl = `${relayBase}/wingbits/track?callsign=${encodeURIComponent(req.callsign)}`;
                        const wbResp = await fetch(wbUrl, {
                            headers: getRelayHeaders({}),
                            signal: AbortSignal.timeout(20_000),
                        });
                        if (wbResp.ok) {
                            const wbData = await wbResp.json() as WingbitsRelayResponse;
                            if (wbData.positions && wbData.positions.length > 0) {
                                return { positions: wbData.positions, source: 'wingbits' };
                            }
                        }
                    } catch (err) {
                        console.warn(`[Aviation] Wingbits callsign relay failed: ${err instanceof Error ? err.message : err}`);
                    }
                }

                // For bbox queries: run OpenSky relay and Wingbits relay in parallel.
                // Sequential was 10s + 6s + 15s = 31s worst-case, exceeding Vercel's 25s limit.
                // Parallel caps at 10s and gives merged coverage from both sources.
                if (!isCallsignOnly && relayBase && req.swLat != null && req.neLat != null) {
                    const osUrl = `${relayBase}/opensky/states/all?lamin=${req.swLat}&lomin=${req.swLon}&lamax=${req.neLat}&lomax=${req.neLon}`;
                    const wbUrl = `${relayBase}/wingbits/track?lamin=${req.swLat}&lomin=${req.swLon}&lamax=${req.neLat}&lomax=${req.neLon}`;

                    const [osResult, wbResult] = await Promise.allSettled([
                        fetch(osUrl, { headers: getRelayHeaders({}), signal: AbortSignal.timeout(10_000) })
                            .then(r => r.ok ? r.json() as Promise<OpenSkyResponse> : Promise.resolve(null))
                            .then(d => d ? parseOpenSkyStates(d.states ?? []) : [])
                            .catch(() => [] as PositionSample[]),
                        fetch(wbUrl, { headers: getRelayHeaders({}), signal: AbortSignal.timeout(10_000) })
                            .then(r => r.ok ? r.json() as Promise<WingbitsRelayResponse> : Promise.resolve(null))
                            .then(d => d?.positions ?? [])
                            .catch(() => [] as PositionSample[]),
                    ]);

                    const osPositions = osResult.status === 'fulfilled' ? osResult.value : [];
                    const wbPositions = wbResult.status === 'fulfilled' ? wbResult.value : [];

                    // Merge: Wingbits preferred for duplicates (more accurate for commercial flights).
                    const seenIcao = new Set(wbPositions.map(p => p.icao24));
                    const merged = [...wbPositions, ...osPositions.filter(p => !seenIcao.has(p.icao24))];
                    if (merged.length > 0) {
                        const source = wbPositions.length > 0 && osPositions.length > 0 ? 'wingbits'
                            : wbPositions.length > 0 ? 'wingbits' : 'opensky';
                        return { positions: merged, source };
                    }

                    // Both relay sources empty — try OpenSky anonymous as last resort
                    try {
                        const directPositions = await fetchOpenSkyAnonymous(req);
                        if (directPositions.length > 0) {
                            return { positions: directPositions, source: 'opensky-anonymous' };
                        }
                    } catch (err) {
                        console.warn(`[Aviation] OpenSky anonymous failed: ${err instanceof Error ? err.message : err}`);
                    }
                }

                // For icao24-only queries, try OpenSky relay then Wingbits
                if (!isCallsignOnly && relayBase && req.icao24) {
                    try {
                        const osUrl = `${relayBase}/opensky/states/all?icao24=${req.icao24}`;
                        const resp = await fetch(osUrl, { headers: getRelayHeaders({}), signal: AbortSignal.timeout(8_000) });
                        if (resp.ok) {
                            const data = await resp.json() as OpenSkyResponse;
                            const positions = parseOpenSkyStates(data.states ?? []);
                            if (positions.length > 0) return { positions, source: 'opensky' };
                        }
                    } catch (err) {
                        console.warn(`[Aviation] Relay icao24 failed: ${err instanceof Error ? err.message : err}`);
                    }
                }

                return null; // negative-cached briefly
            }, negativeTtl,
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
