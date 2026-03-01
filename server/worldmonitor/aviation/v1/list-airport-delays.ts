import type {
  ServerContext,
  ListAirportDelaysRequest,
  ListAirportDelaysResponse,
  AirportDelayAlert,
} from '../../../../src/generated/server/worldmonitor/aviation/v1/service_server';
import {
  MONITORED_AIRPORTS,
  FAA_AIRPORTS,
} from '../../../../src/config/airports';
import {
  FAA_URL,
  parseFaaXml,
  toProtoDelayType,
  toProtoSeverity,
  toProtoRegion,
  toProtoSource,
  determineSeverity,
  generateSimulatedDelay,
  fetchAviationStackDelays,
  fetchNotamClosures,
  buildNotamAlert,
} from './_shared';
import { CHROME_UA } from '../../../_shared/constants';
import { cachedFetchJson, getCachedJson, setCachedJson } from '../../../_shared/redis';

const FAA_CACHE_KEY = 'aviation:delays:faa:v1';
const INTL_CACHE_KEY = 'aviation:delays:intl:v2';
const NOTAM_CACHE_KEY = 'aviation:notam:closures:v1';
const CACHE_TTL = 7200;      // 2h for FAA, intl (real), and NOTAM
const SIM_CACHE_TTL = 300;   // 5 min for simulation fallback — retry sooner

export async function listAirportDelays(
  _ctx: ServerContext,
  _req: ListAirportDelaysRequest,
): Promise<ListAirportDelaysResponse> {
  const t0 = Date.now();
  // 1. FAA (US) — independent try-catch
  let faaAlerts: AirportDelayAlert[] = [];
  try {
    const result = await cachedFetchJson<{ alerts: AirportDelayAlert[] }>(
      FAA_CACHE_KEY, CACHE_TTL, async () => {
        const alerts: AirportDelayAlert[] = [];
        const faaResponse = await fetch(FAA_URL, {
          headers: { Accept: 'application/xml', 'User-Agent': CHROME_UA },
          signal: AbortSignal.timeout(15_000),
        });

        let faaDelays = new Map<string, { airport: string; reason: string; avgDelay: number; type: string }>();
        if (faaResponse.ok) {
          const xml = await faaResponse.text();
          faaDelays = parseFaaXml(xml);
        }

        for (const iata of FAA_AIRPORTS) {
          const airport = MONITORED_AIRPORTS.find((a) => a.iata === iata);
          if (!airport) continue;
          const faaDelay = faaDelays.get(iata);
          if (faaDelay) {
            alerts.push({
              id: `faa-${iata}`,
              iata,
              icao: airport.icao,
              name: airport.name,
              city: airport.city,
              country: airport.country,
              location: { latitude: airport.lat, longitude: airport.lon },
              region: toProtoRegion(airport.region),
              delayType: toProtoDelayType(faaDelay.type),
              severity: toProtoSeverity(determineSeverity(faaDelay.avgDelay)),
              avgDelayMinutes: faaDelay.avgDelay,
              delayedFlightsPct: 0,
              cancelledFlights: 0,
              totalFlights: 0,
              reason: faaDelay.reason,
              source: toProtoSource('faa'),
              updatedAt: Date.now(),
            });
          }
        }

        return { alerts };
      }
    );
    faaAlerts = result?.alerts ?? [];
    console.log(`[Aviation] FAA: ${faaAlerts.length} alerts`);
  } catch (err) {
    console.warn(`[Aviation] FAA fetch failed: ${err instanceof Error ? err.message : 'unknown'}`);
  }

  // 2. International — check cache first, then fetch with conditional TTL
  let intlAlerts: AirportDelayAlert[] = [];
  try {
    const cached = await getCachedJson(INTL_CACHE_KEY);
    if (cached && typeof cached === 'object' && 'alerts' in (cached as Record<string, unknown>)) {
      intlAlerts = (cached as { alerts: AirportDelayAlert[] }).alerts;
      const simCount = intlAlerts.filter(a => a.id.startsWith('sim-')).length;
      const realCount = intlAlerts.length - simCount;
      console.log(`[Aviation] Intl cache HIT: ${intlAlerts.length} alerts (${realCount} real, ${simCount} simulated)`);
    } else {
      const nonUs = MONITORED_AIRPORTS.filter(a => a.country !== 'USA');
      const apiKey = process.env.AVIATIONSTACK_API;

      if (!apiKey) {
        console.log('[Aviation] No AVIATIONSTACK_API key — using simulation');
        intlAlerts = nonUs.map(a => generateSimulatedDelay(a)).filter(Boolean) as AirportDelayAlert[];
        await setCachedJson(INTL_CACHE_KEY, { alerts: intlAlerts }, SIM_CACHE_TTL);
      } else {
        const avResult = await fetchAviationStackDelays(nonUs);
        if (!avResult.healthy) {
          console.warn('[Aviation] AviationStack unhealthy — falling back to simulation');
          intlAlerts = nonUs.map(a => generateSimulatedDelay(a)).filter(Boolean) as AirportDelayAlert[];
          await setCachedJson(INTL_CACHE_KEY, { alerts: intlAlerts }, SIM_CACHE_TTL);
        } else {
          console.log(`[Aviation] AviationStack OK: ${avResult.alerts.length} real alerts`);
          intlAlerts = avResult.alerts;
          await setCachedJson(INTL_CACHE_KEY, { alerts: intlAlerts }, CACHE_TTL);
        }
      }
    }
    console.log(`[Aviation] Intl: ${intlAlerts.length} alerts`);
  } catch (err) {
    console.warn(`[Aviation] Intl fetch failed: ${err instanceof Error ? err.message : 'unknown'}`);
  }

  // 3. NOTAM closures (ICAO API) — overlay on existing alerts
  let allAlerts = [...faaAlerts, ...intlAlerts];
  if (process.env.ICAO_API_KEY) {
    try {
      const notamResult = await cachedFetchJson<{ closedIcaos: string[]; reasons: Record<string, string> }>(
        NOTAM_CACHE_KEY, CACHE_TTL, async () => {
          const mena = MONITORED_AIRPORTS.filter(a => a.region === 'mena');
          const result = await fetchNotamClosures(mena);
          const closedIcaos = [...result.closedIcaoCodes];
          const reasons: Record<string, string> = {};
          for (const [icao, reason] of result.notamsByIcao) reasons[icao] = reason;
          return { closedIcaos, reasons };
        }
      );
      if (notamResult && notamResult.closedIcaos.length > 0) {
        const existingIatas = new Set(allAlerts.map(a => a.iata));
        for (const icao of notamResult.closedIcaos) {
          const airport = MONITORED_AIRPORTS.find(a => a.icao === icao);
          if (!airport) continue;
          const reason = notamResult.reasons[icao] || 'Airport closure (NOTAM)';
          if (existingIatas.has(airport.iata)) {
            const idx = allAlerts.findIndex(a => a.iata === airport.iata);
            if (idx >= 0) {
              allAlerts[idx] = buildNotamAlert(airport, reason);
            }
          } else {
            allAlerts.push(buildNotamAlert(airport, reason));
          }
        }
        console.log(`[Aviation] NOTAM: ${notamResult.closedIcaos.length} closures applied`);
      }
    } catch (err) {
      console.warn(`[Aviation] NOTAM fetch failed: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }

  // 4. Fill in ALL monitored airports with no alerts as "normal operations"
  //    so they always appear on the map (gray dots)
  const alertedIatas = new Set(allAlerts.map(a => a.iata));
  let normalCount = 0;
  for (const airport of MONITORED_AIRPORTS) {
    if (!alertedIatas.has(airport.iata)) {
      normalCount++;
      allAlerts.push({
        id: `status-${airport.iata}`,
        iata: airport.iata,
        icao: airport.icao,
        name: airport.name,
        city: airport.city,
        country: airport.country,
        location: { latitude: airport.lat, longitude: airport.lon },
        region: toProtoRegion(airport.region),
        delayType: toProtoDelayType('general'),
        severity: toProtoSeverity('normal'),
        avgDelayMinutes: 0,
        delayedFlightsPct: 0,
        cancelledFlights: 0,
        totalFlights: 0,
        reason: 'Normal operations',
        source: toProtoSource('computed'),
        updatedAt: Date.now(),
      });
    }
  }

  console.log(`[Aviation] Total: ${allAlerts.length} alerts (${normalCount} normal) in ${Date.now() - t0}ms`);
  return { alerts: allAlerts };
}

