import { isEmergencySquawk, isFresh, OBSERVATION_MAX_AGE_MS, type EmergencySnapshot } from '../../../../shared/aircraft-emergencies';

const text = (value: unknown): string => typeof value === 'string' ? value.trim().slice(0, 160) : '';
const numeric = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export function parseEmergencyResponse(data: unknown, requestedCode: string, fetchedAt: number): EmergencySnapshot {
  if (!data || typeof data !== 'object') throw new Error('Invalid aircraft response');
  const body = data as Record<string, unknown>;
  if (!Array.isArray(body.ac) || !numeric(body.now) || body.now <= 0) throw new Error('Missing aircraft array or provider clock');
  const responseAt = body.now < 1_000_000_000_000 ? body.now * 1000 : body.now;
  if (responseAt > fetchedAt) throw new Error('Provider clock is in the future');
  const observations: EmergencySnapshot['observations'] = [];
  for (const row of body.ac) {
    if (!row || typeof row !== 'object') throw new Error('Invalid aircraft row');
    const a = row as Record<string, unknown>;
    const address = text(a.hex).toLowerCase();
    if (!/^~?[0-9a-f]{6}$/.test(address)) throw new Error('Invalid aircraft address');
    if (!isEmergencySquawk(a.squawk)) continue;
    const observedAt = numeric(a.seen) && a.seen >= 0 ? responseAt - a.seen * 1000 : 0;
    const positionAt = numeric(a.seen_pos) && a.seen_pos >= 0 ? responseAt - a.seen_pos * 1000 : 0;
    const position = numeric(a.lat) && Math.abs(a.lat) <= 90 && numeric(a.lon) && Math.abs(a.lon) <= 180
      ? { lat: a.lat, lon: a.lon, observedAt: Math.max(0, positionAt) } : undefined;
    observations.push({
      address, squawk: a.squawk, source: 'adsb.lol', observedAt: Math.max(0, observedAt), position,
      callsign: text(a.flight), registration: text(a.r), aircraftType: text(a.t), description: text(a.desc),
      militaryFlag: Number.isInteger(a.dbFlags) ? ((Number(a.dbFlags) & 1) === 1 ? 'set' : 'not_set') : 'unknown',
      altitudeFt: numeric(a.alt_baro) ? a.alt_baro : undefined,
      groundSpeedKts: numeric(a.gs) && a.gs >= 0 ? a.gs : undefined,
    });
  }
  const fresh = isFresh(responseAt, fetchedAt, OBSERVATION_MAX_AGE_MS);
  return { observations, feeds: [{ source: 'adsb.lol', squawk: requestedCode, status: fresh ? 'available' : 'stale', fetchedAt, message: fresh ? '' : 'Provider snapshot is stale' }] };
}
