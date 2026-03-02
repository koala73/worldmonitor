export const config = { runtime: 'edge' };

import type { AirportDelayAlert } from '../../src/generated/server/worldmonitor/aviation/v1/service_server';
import { MONITORED_AIRPORTS, FAA_AIRPORTS } from '../../src/config/airports';
import {
  FAA_URL,
  parseFaaXml,
  toProtoDelayType,
  toProtoSeverity,
  toProtoRegion,
  toProtoSource,
  determineSeverity,
  fetchAviationStackDelays,
  fetchNotamClosures,
} from '../../server/worldmonitor/aviation/v1/_shared';
import { setCachedJson } from '../../server/_shared/redis';
import { CHROME_UA } from '../../server/_shared/constants';

const FAA_CACHE_KEY = 'aviation:delays:faa:v1';
const INTL_CACHE_KEY = 'aviation:delays:intl:v3';
const NOTAM_CACHE_KEY = 'aviation:notam:closures:v1';
const CRON_TTL = 14400; // 4h — survives 1 missed cron run

async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const aBuf = encoder.encode(a);
  const bBuf = encoder.encode(b);
  if (aBuf.byteLength !== bBuf.byteLength) return false;
  const key = await crypto.subtle.importKey('raw', aBuf, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, bBuf);
  const expected = await crypto.subtle.sign('HMAC', key, aBuf);
  const sigArr = new Uint8Array(sig);
  const expArr = new Uint8Array(expected);
  if (sigArr.length !== expArr.length) return false;
  let diff = 0;
  for (let i = 0; i < sigArr.length; i++) diff |= sigArr[i]! ^ expArr[i]!;
  return diff === 0;
}

export default async function handler(req: Request): Promise<Response> {
  const t0 = Date.now();

  const auth = req.headers.get('authorization') || '';
  const secret = process.env.CRON_SECRET;
  if (!secret || !(await timingSafeEqual(auth, `Bearer ${secret}`))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const results: Record<string, { ok: boolean; count: number; error?: string }> = {};

  // 1. FAA (US airports)
  try {
    const alerts: AirportDelayAlert[] = [];
    const faaResp = await fetch(FAA_URL, {
      headers: { Accept: 'application/xml', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(15_000),
    });

    let faaDelays = new Map<string, { airport: string; reason: string; avgDelay: number; type: string }>();
    if (faaResp.ok) {
      faaDelays = parseFaaXml(await faaResp.text());
    }

    for (const iata of FAA_AIRPORTS) {
      const airport = MONITORED_AIRPORTS.find(a => a.iata === iata);
      if (!airport) continue;
      const d = faaDelays.get(iata);
      if (d) {
        alerts.push({
          id: `faa-${iata}`,
          iata,
          icao: airport.icao,
          name: airport.name,
          city: airport.city,
          country: airport.country,
          location: { latitude: airport.lat, longitude: airport.lon },
          region: toProtoRegion(airport.region),
          delayType: toProtoDelayType(d.type),
          severity: toProtoSeverity(determineSeverity(d.avgDelay)),
          avgDelayMinutes: d.avgDelay,
          delayedFlightsPct: 0,
          cancelledFlights: 0,
          totalFlights: 0,
          reason: d.reason,
          source: toProtoSource('faa'),
          updatedAt: Date.now(),
        });
      }
    }

    await setCachedJson(FAA_CACHE_KEY, { alerts }, CRON_TTL);
    results.faa = { ok: true, count: alerts.length };
    console.log(`[Cron/Aviation] FAA: ${alerts.length} alerts cached`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    results.faa = { ok: false, count: 0, error: msg };
    console.warn(`[Cron/Aviation] FAA failed: ${msg}`);
  }

  // 2. International (non-US airports via AviationStack)
  try {
    const nonUs = MONITORED_AIRPORTS.filter(a => a.country !== 'USA');
    const avResult = await fetchAviationStackDelays(nonUs);

    if (!avResult.healthy) {
      results.intl = { ok: false, count: 0, error: 'unhealthy response, preserving existing cache' };
      console.warn('[Cron/Aviation] Intl: unhealthy, skipping cache write');
    } else {
      await setCachedJson(INTL_CACHE_KEY, { alerts: avResult.alerts }, CRON_TTL);
      results.intl = { ok: true, count: avResult.alerts.length };
      console.log(`[Cron/Aviation] Intl: ${avResult.alerts.length} alerts cached`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    results.intl = { ok: false, count: 0, error: msg };
    console.warn(`[Cron/Aviation] Intl failed: ${msg}`);
  }

  // 3. NOTAM closures (MENA airports via ICAO API)
  try {
    const mena = MONITORED_AIRPORTS.filter(a => a.region === 'mena');
    const notamResult = await fetchNotamClosures(mena);
    const closedIcaos = [...notamResult.closedIcaoCodes];
    const reasons: Record<string, string> = {};
    for (const [icao, reason] of notamResult.notamsByIcao) reasons[icao] = reason;

    await setCachedJson(NOTAM_CACHE_KEY, { closedIcaos, reasons }, CRON_TTL);
    results.notam = { ok: true, count: closedIcaos.length };
    console.log(`[Cron/Aviation] NOTAM: ${closedIcaos.length} closures cached`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    results.notam = { ok: false, count: 0, error: msg };
    console.warn(`[Cron/Aviation] NOTAM failed: ${msg}`);
  }

  const elapsed = Date.now() - t0;
  console.log(`[Cron/Aviation] Done in ${elapsed}ms`, JSON.stringify(results));
  return Response.json({ ok: true, elapsed, results });
}
