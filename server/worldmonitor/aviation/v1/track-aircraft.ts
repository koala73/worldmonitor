import type {
    ServerContext,
    TrackAircraftRequest,
    TrackAircraftResponse,
    PositionSample,
} from '../../../../src/generated/server/worldmonitor/aviation/v1/service_server';
import { getRelayBaseUrl, getRelayHeaders } from './_shared';
import { cachedFetchJson } from '../../../_shared/redis';
import { isOpenSkyProvider, requiresRedistributableProviders } from '../../../_shared/provider-redistribution';

// 120s. This TTL was originally sized for the anonymous OpenSky tier's ~10 req/min
// ceiling; that tier was removed in #6222, so the binding constraint is now the shared
// authenticated credit pool the relay draws on — a shorter TTL multiplies bbox misses
// straight into it. Revisit only alongside that budget, not on its own.
const CACHE_TTL = 120;
// Callsign searches hit the relay's in-memory index (5min TTL); cache positive hits 60s,
// negative hits 10s so a retry after panning into view returns fresh data quickly.
const CALLSIGN_CACHE_TTL = 60;
const CALLSIGN_NEGATIVE_TTL = 10;
const BBOX_RELAY_TIMEOUT_MS = 6_000;

function isDegenerateBbox(req: TrackAircraftRequest): boolean {
    return req.swLat === req.neLat && req.swLon === req.neLon;
}

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


// There is deliberately no anonymous OpenSky path here. The unauthenticated tier
// is 400 credits/day PER IP, and these handlers run on Vercel's shared egress —
// the quota is consumed by every other tenant on the same address, so the call
// essentially always 429s while still costing a full 6s timeout on the very
// request that was already failing over. Removing it also returns that 6s to
// the response budget below (#6222).

function buildCacheKey(req: TrackAircraftRequest): string {
    if (req.icao24) return `aviation:track:icao:${req.icao24}:v2`;
    if (req.callsign) return `aviation:track:callsign:${req.callsign.toUpperCase()}:v2`;
    if (!isDegenerateBbox(req)) {
        return `aviation:track:bbox:${Math.floor(req.swLat)}:${Math.floor(req.swLon)}:${Math.ceil(req.neLat)}:${Math.ceil(req.neLon)}:v1`;
    }
    return 'aviation:track:all:v2';
}

// Response-level source values (TrackAircraftResponse.source):
//   'opensky'           — data from OpenSky via relay
//   'wingbits'          — data from Wingbits via relay
//   'none'              — all real sources returned empty or failed; positions = []
export async function trackAircraft(
    ctx: ServerContext,
    req: TrackAircraftRequest,
): Promise<TrackAircraftResponse> {
    const redistributableOnly = requiresRedistributableProviders(ctx.request);
    const cacheKey = `${buildCacheKey(req)}${redistributableOnly ? ':redistributable' : ''}`;

    let result: { positions: PositionSample[]; source: string } | null = null;
    try {
        const positiveTtl = req.callsign ? CALLSIGN_CACHE_TTL : CACHE_TTL;
        const negativeTtl = req.callsign ? CALLSIGN_NEGATIVE_TTL : CACHE_TTL;
        result = await cachedFetchJson<{ positions: PositionSample[]; source: string }>(
            cacheKey, positiveTtl, async () => {
                const relayBase = getRelayBaseUrl();
                const isCallsignOnly = !!req.callsign && !req.icao24 && isDegenerateBbox(req);

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

                // Wingbits is the normal bbox source. A successful response — including an
                // empty one — is authoritative for that viewport, so do not also debit the
                // shared authenticated OpenSky account. OpenSky is recovery-only when the
                // Wingbits request itself fails.
                //
                // Skip a degenerate (zero-span) bbox. The generated GET decoder coerces
                // absent query params to 0 rather than leaving them null, so an icao24-only
                // request would otherwise issue a real authenticated bbox relay call for
                // `lamin=0&lomin=0&lamax=0&lomax=0` before reaching its own 8s tier.
                if (!isCallsignOnly && relayBase && !isDegenerateBbox(req)) {
                    const wbUrl = `${relayBase}/wingbits/track?lamin=${req.swLat}&lomin=${req.swLon}&lamax=${req.neLat}&lomax=${req.neLon}`;
                    try {
                        const wbResp = await fetch(wbUrl, {
                            headers: getRelayHeaders({}),
                            signal: AbortSignal.timeout(BBOX_RELAY_TIMEOUT_MS),
                        });
                        if (wbResp.ok) {
                            const wbData = await wbResp.json() as WingbitsRelayResponse;
                            return { positions: wbData.positions ?? [], source: 'wingbits' };
                        }
                    } catch (err) {
                        // sentry-coverage-ok: provider failure is expected here and the bounded OpenSky fallback owns recovery.
                        console.warn(`[Aviation] Wingbits bbox relay failed: ${err instanceof Error ? err.message : err}`);
                    }

                    if (!redistributableOnly) {
                        try {
                            const osUrl = `${relayBase}/opensky/states/all?lamin=${req.swLat}&lomin=${req.swLon}&lamax=${req.neLat}&lomax=${req.neLon}`;
                            const osResp = await fetch(osUrl, {
                                headers: getRelayHeaders({}),
                                signal: AbortSignal.timeout(BBOX_RELAY_TIMEOUT_MS),
                            });
                            if (osResp.ok) {
                                const osData = await osResp.json() as OpenSkyResponse;
                                const osPositions = parseOpenSkyStates(osData.states ?? []);
                                if (osPositions.length > 0) return { positions: osPositions, source: 'opensky' };
                            }
                        } catch (err) {
                            // sentry-coverage-ok: relay failure degrades to an empty viewport by design;
                            // there is no further provider tier that can succeed from shared egress.
                            console.warn(`[Aviation] OpenSky bbox relay failed: ${err instanceof Error ? err.message : err}`);
                        }
                    }

                    // Both relay paths exhausted. A bbox-only request now spends at most
                    // 6s + 6s here. An icao24-only request is also nondegenerate-bbox-gated
                    // so it skips this block entirely and goes straight to its own 8s tier.
                }

                // For icao24-only queries, try the OpenSky relay
                if (!redistributableOnly && !isCallsignOnly && relayBase && req.icao24) {
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
        let source = result.source;
        if (redistributableOnly) {
            positions = positions.filter((position) => position.source !== 'POSITION_SOURCE_OPENSKY');
            if (isOpenSkyProvider(source)) {
                positions = [];
                source = 'none';
            }
        }
        if (req.icao24) positions = positions.filter(p => p.icao24 === req.icao24);
        if (req.callsign) positions = positions.filter(p => p.callsign.includes(req.callsign.toUpperCase()));
        return { positions, source, updatedAt: Date.now() };
    }

    return { positions: [], source: 'none', updatedAt: Date.now() };
}
