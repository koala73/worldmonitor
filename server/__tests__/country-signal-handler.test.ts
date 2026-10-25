import { beforeEach, describe, expect, it, vi } from 'vitest';
const cache = vi.hoisted(() => ({ rows: new Map<string, unknown>(), reads: vi.fn() }));
vi.mock('../_shared/redis', () => ({
  getCachedJson: async (key: string) => { cache.reads(key); return cache.rows.get(key) ?? null; },
  readCachedJson: async (key: string) => { cache.reads(key); return cache.rows.has(key) ? { status: 'hit', value: cache.rows.get(key) } : { status: 'miss' }; },
  getRawJson: async () => null, setCachedJson: async () => true, setCachedJsonIfAbsent: async () => true,
  cachedFetchJson: async () => { throw new Error('Provider fetch forbidden'); },
}));
vi.mock('../_shared/required-seed', () => ({ readRequiredSeed: async (key: string, decode: (value: unknown) => unknown) => { cache.reads(key); const value = decode(cache.rows.get(key)); if (!value) throw new Error('Missing seed'); return value; } }));
import { getCountrySignalObservations } from '../worldmonitor/intelligence/v1/get-country-signal-observations';
import { readMilitaryFlights } from '../worldmonitor/military/v1/list-military-flights';
import { getTheaterPosture } from '../worldmonitor/military/v1/get-theater-posture';
import { drainResponseHeaders } from '../_shared/response-headers';
import { countrySignalOutcomeSchema } from '../../shared/country-signal-observations';
import type { GetCountrySignalObservationsRequest } from '../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { createIntelligenceServiceRoutes, ValidationError, type IntelligenceServiceHandler } from '../../src/generated/server/worldmonitor/intelligence/v1/service_server';

const context = (signal?: AbortSignal) => ({ request: new Request('https://example.com/api/intelligence/v1/get-country-signal-observations', { signal }), headers: {}, pathParams: {} });
const req = (family: GetCountrySignalObservationsRequest['family']): GetCountrySignalObservationsRequest => ({ countryCode: 'FR', family, windowIndex: 0, cursor: '' });
it.each([false, true])('preserves qualified live empty posture with stale positive present=%s', async stale => {
  cache.rows.clear(); cache.reads.mockClear();
  cache.rows.set('theater-posture:sebuf:v1', { provider: 'adsb.lol', fetchedAt: 1792324800000, theaters: [] });
  if (stale) cache.rows.set('theater_posture:sebuf:stale:v1', { provider: 'adsb.lol', fetchedAt: 1792238400000, theaters: [{ theater: 'iran-theater', postureLevel: 'critical', activeFlights: 3 }] });
  const result = await getCountrySignalObservations(context(), { ...req('COUNTRY_SIGNAL_FAMILY_POSTURE'), countryCode: 'IR' });
  expect(countrySignalOutcomeSchema.parse(JSON.parse(result.outcomeJson))).toMatchObject({ state: 'observed', snapshotAt: '2026-10-18T12:00:00.000Z', observations: [] });
  expect(cache.reads.mock.calls.map(call => call[0])).toEqual(['theater-posture:sebuf:v1']);
  const legacy = await getTheaterPosture(context(), {});
  expect(legacy.theaters).toHaveLength(stale ? 1 : 0);
});
describe('bounded country family handler', () => {
  beforeEach(() => { cache.rows.clear(); cache.reads.mockClear(); });
  it('returns HTTP400 field violations for invalid country profiles before source IO', async () => {
    const route = createIntelligenceServiceRoutes({ getCountrySignalObservations } as IntelligenceServiceHandler)
      .find(value => value.path === '/api/intelligence/v1/get-country-signal-observations')!;
    for (const query of ['country_code=AA&family=COUNTRY_SIGNAL_FAMILY_OUTAGES', 'country_code=IR&family=COUNTRY_SIGNAL_FAMILY_UNSPECIFIED', 'country_code=IR&family=COUNTRY_SIGNAL_FAMILY_FLIGHT_PAGE&window_index=2']) {
      const response = await route.handler(new Request(`https://example.com${route.path}?${query}`));
      expect(response.status).toBe(400);
      expect((await response.json()).violations[0]).toMatchObject({ field: expect.any(String), description: expect.any(String) });
    }
    expect(cache.reads).not.toHaveBeenCalled();
  });
  it('rejects country/variant/window before source IO', async () => {
    for (const request of [
      ...['', 'XX', 'AA', 'EU', 'IRN', 'fr'].map(countryCode => ({ ...req('COUNTRY_SIGNAL_FAMILY_OUTAGES'), countryCode })),
      req('COUNTRY_SIGNAL_FAMILY_UNSPECIFIED'),
      { ...req('COUNTRY_SIGNAL_FAMILY_OUTAGES'), cursor: 'unexpected' },
      { ...req('COUNTRY_SIGNAL_FAMILY_FLIGHT_PAGE'), windowIndex: 2 },
      { ...req('COUNTRY_SIGNAL_FAMILY_FLIGHT_PAGE'), cursor: 'w1:100' },
    ]) await expect(getCountrySignalObservations(context(), request)).rejects.toBeInstanceOf(ValidationError);
    expect(cache.reads).not.toHaveBeenCalled();
  });
  it('does not misread the sanctions zero-clock fallback as observed empty', async () => {
    const ctx = context();
    const response = await getCountrySignalObservations(ctx, req('COUNTRY_SIGNAL_FAMILY_SANCTIONS'));
    expect(countrySignalOutcomeSchema.parse(JSON.parse(response.outcomeJson)).state).toBe('unavailable');
    expect(cache.reads.mock.calls.map(call => call[0])).toEqual(['sanctions:pressure:v1']);
    expect(drainResponseHeaders(ctx.request)?.['Cache-Control']).toBe('no-store');
  });
  it('selects exactly normalized ISO country without substring prefiltering', async () => {
    cache.rows.set('infra:outages:v1', { outages: [{ id: 'fr', country: 'FR', title: 'French outage', detectedAt: 1792324800000 }, { id: 'us', country: 'US', title: 'US outage', detectedAt: 1792324800000 }] });
    const response = await getCountrySignalObservations(context(), req('COUNTRY_SIGNAL_FAMILY_OUTAGES'));
    const outcome = countrySignalOutcomeSchema.parse(JSON.parse(response.outcomeJson));
    expect(outcome.observations.map(row => row.id)).toEqual(['fr']);
    expect(outcome.observations[0]?.eventAt).toBe('2026-10-18T12:00:00.000Z');
    expect(cache.reads.mock.calls.every(call => String(call[0]).includes('outages'))).toBe(true);
  });
  it('keeps global radiation sampling and valid source empty distinct', async () => {
    cache.rows.set('radiation:observations:v1', { observations: [], fetchedAt: 1792324800000 });
    const response = await getCountrySignalObservations(context(), req('COUNTRY_SIGNAL_FAMILY_RADIATION'));
    const outcome = countrySignalOutcomeSchema.parse(JSON.parse(response.outcomeJson));
    expect(outcome).toMatchObject({ state: 'observed', partial: true, sampleBeforeCountryFilter: true, observations: [] });
  });
  it('bounds the complete escaped UTF-8 envelope and discloses omitted rows', async () => {
    cache.rows.set('infra:outages:v1', { outages: Array.from({ length: 100 }, (_, i) => ({ id: String(i), country: 'FR', title: '\\'.repeat(512), source: '💥'.repeat(250), severity: 'OUTAGE_SEVERITY_TOTAL' })) });
    const response = await getCountrySignalObservations(context(), req('COUNTRY_SIGNAL_FAMILY_OUTAGES'));
    expect(new TextEncoder().encode(JSON.stringify(response)).length).toBeLessThanOrEqual(131072);
    const outcome = countrySignalOutcomeSchema.parse(JSON.parse(response.outcomeJson));
    expect(outcome.state).toBe('observed');
    expect(outcome.partial).toBe(true);
    expect(outcome.omittedRows).toBeGreaterThan(0);
    expect(outcome.sampledRows! + outcome.omittedRows!).toBe(100);
  });
  it('leaves a disabled conflict source unavailable before cache IO', async () => {
    const response = await getCountrySignalObservations(context(), req('COUNTRY_SIGNAL_FAMILY_CONFLICT'));
    expect(countrySignalOutcomeSchema.parse(JSON.parse(response.outcomeJson)).state).toBe('unavailable');
    expect(cache.reads).not.toHaveBeenCalled();
  });
  it('keeps posture fallback status, provider and assessment clocks without accepting empty live data', async () => {
    cache.rows.set('theater-posture:sebuf:v1', { theaters: [], provider: 'adsb.lol' });
    cache.rows.set('theater_posture:sebuf:stale:v1', { provider: 'adsb.lol', theaters: [{ theater: 'iran-theater', postureLevel: 'elevated', activeFlights: 3, trackedVessels: 0, assessedAt: 1792324800000 }] });
    const response = await getCountrySignalObservations(context(), { ...req('COUNTRY_SIGNAL_FAMILY_POSTURE'), countryCode: 'IR' });
    const outcome = countrySignalOutcomeSchema.parse(JSON.parse(response.outcomeJson));
    expect(outcome).toMatchObject({ state: 'observed', partial: true, attribution: 'adsb.lol', snapshotAt: null });
    expect(outcome.scope).toContain('stale');
    expect(outcome.observations).toMatchObject([{ type: 'military_flight', snapshotAt: '2026-10-18T12:00:00.000Z', timeBasis: 'snapshot' }]);
  });
  it('fails closed for posture providers without redistribution attribution', async () => {
    cache.rows.set('theater-posture:sebuf:v1', { provider: 'opensky', theaters: [{ theater: 'iran-theater', postureLevel: 'critical', activeFlights: 10 }] });
    const response = await getCountrySignalObservations(context(), { ...req('COUNTRY_SIGNAL_FAMILY_POSTURE'), countryCode: 'IR' });
    expect(countrySignalOutcomeSchema.parse(JSON.parse(response.outcomeJson))).toMatchObject({ state: 'locked', observations: [] });
    expect(cache.reads).toHaveBeenCalledTimes(3);
  });
  it('filters the same eligible cohort before pages for browser and MCP contexts', async () => {
    const flights = Array.from({ length: 240 }, (_, i) => ({ id: String(i), source: i % 2 === 0 ? 'opensky' : 'adsb.lol', location: { latitude: 48, longitude: 2 } }));
    cache.rows.set('military:flights:stable-live:v1', { flights, coverage: 'global' });
    cache.rows.set('military:flights:v1', { coverage: 'global', flights: flights.map(row => ({ id: row.id, lat: 48, lon: 2, sourceMeta: { source: row.source } })) });
    const request = { neLat: 52, neLon: 10, swLat: 40, swLon: -6, pageSize: 100, cursor: '', operator: 'MILITARY_OPERATOR_UNSPECIFIED' as const, aircraftType: 'MILITARY_AIRCRAFT_TYPE_UNSPECIFIED' as const };
    const a = await readMilitaryFlights(context(), request, { redistributableOnly: true, allowProviderFetch: false });
    const b = await readMilitaryFlights(context(), request, { redistributableOnly: true, allowProviderFetch: false });
    expect(a.flights).toEqual(b.flights);
    expect(a.flights).toHaveLength(100);
    expect(a.flights.every(row => row.source === 'adsb.lol')).toBe(true);
    expect(new Set(a.flights.map(row => row.id)).size).toBe(100);
    const first = await getCountrySignalObservations(context(), req('COUNTRY_SIGNAL_FAMILY_FLIGHT_PAGE'));
    expect(first.flightPage?.pagination?.nextCursor).toBe('FR:w0:100');
    const second = await getCountrySignalObservations(context(), { ...req('COUNTRY_SIGNAL_FAMILY_FLIGHT_PAGE'), cursor: first.flightPage!.pagination!.nextCursor });
    expect(second.flightPage?.flights).toHaveLength(20);
    expect(new Set([...first.flightPage!.flights, ...second.flightPage!.flights].map(row => row.id)).size).toBe(120);
    const count = cache.reads.mock.calls.length;
    await expect(getCountrySignalObservations(context(), { ...req('COUNTRY_SIGNAL_FAMILY_FLIGHT_PAGE'), cursor: 'US:w0:100' })).rejects.toMatchObject({ name: 'ValidationError', violations: [{ field: 'cursor', description: 'Invalid country flight window or cursor.' }] });
    expect(cache.reads).toHaveBeenCalledTimes(count);
  });
  it('suppresses canceled source work without provider calls', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(getCountrySignalObservations(context(controller.signal), req('COUNTRY_SIGNAL_FAMILY_OUTAGES'))).rejects.toThrow();
    expect(cache.reads).not.toHaveBeenCalled();
  });
  it('ends a stalled source read on the single deadline without publishing a fallback', async () => {
    const deadline = new AbortController();
    const timer = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    cache.rows.set('infra:outages:v1', { outages: [] });
    cache.rows.set('seed-meta:infra:outages', new Promise(() => {}));
    try {
      const pending = getCountrySignalObservations(context(), req('COUNTRY_SIGNAL_FAMILY_OUTAGES'));
      deadline.abort(new DOMException('Source deadline expired', 'TimeoutError'));
      await expect(pending).rejects.toThrow('Source deadline expired');
      expect(timer).toHaveBeenCalledWith(15_000);
      expect(cache.reads.mock.calls.map(call => call[0])).toEqual(['infra:outages:v1', 'seed-meta:infra:outages']);
    } finally { timer.mockRestore(); }
  });
});
