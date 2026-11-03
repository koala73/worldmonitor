import { describe, expect, it } from 'vitest';
import { COUNTRY_SIGNAL_FAMILIES, projectCountrySignalFamily, projectQualifiedCountrySignals, projectQualifiedCountrySignalContext, unavailableCountrySignal, boundCountrySignalFamily, sourceClock, type CountrySignalOutcome } from '../../shared/country-signal-observations';

describe('qualified country Signals', () => {
  it.each([['elevated', 1, 'medium'], ['elevated', 5, 'high'], ['critical', 1, 'medium'], ['critical', 5, 'high']] as const)('keeps vessel count thresholds for %s posture with %i vessels', (postureLevel, trackedVessels, severity) => {
    const outcome = projectCountrySignalFamily('IR', 'posture', { state: 'observed', status: 'live', provider: 'adsb.lol', theaters: [{ theater: 'iran-theater', postureLevel, activeFlights: 1, trackedVessels }] });
    expect(outcome.observations.find(row => row.type === 'military_vessel')?.severity).toBe(severity);
    expect(outcome.observations.find(row => row.type === 'military_flight')?.severity).toBe(postureLevel === 'critical' ? 'high' : 'medium');
  });
  const observed = (family: CountrySignalOutcome['family']): CountrySignalOutcome => ({ ...unavailableCountrySignal('FR', family, ''), state: 'observed', partial: false, reason: null });
  it('distinguishes observed empty, missing and locked without invented zero totals', () => {
    expect(projectQualifiedCountrySignals('FR', [unavailableCountrySignal('FR', 'fires', 'missing')]).details).toBeNull();
    expect(projectQualifiedCountrySignals('FR', [observed('fires')]).details).toMatchObject({ critical: 0, high: 0, medium: 0, low: 0 });
    expect(() => projectQualifiedCountrySignals('US', [observed('fires')])).toThrow('identity');
  });
  it('counts available evidence and preserves unknown clocks with stable recent items', () => {
    const outcome = observed('military');
    outcome.observations = ['critical', 'high', 'high', 'high', 'high', 'medium', 'medium', 'medium', 'low'].map((severity, i) => ({ id: String(i), family: 'military', type: 'military_flight', severity: severity as 'high', title: `Eligible ${i}`, source: 'Licensed provider', eventAt: null, snapshotAt: null, timeBasis: 'unknown' }));
    const value = projectQualifiedCountrySignals('FR', [outcome, unavailableCountrySignal('FR', 'fires', 'missing')]);
    expect(value.details).toMatchObject({ critical: 1, high: 4, medium: 3, low: 1 });
    expect(value.details?.recentHigh.map(row => row.description)).toEqual(['Eligible 0', 'Eligible 1', 'Eligible 2']);
    expect(value.details?.recentHigh.every(row => row.timestamp === null)).toBe(true);
    expect(boundCountrySignalFamily(outcome).observations).toHaveLength(9);
  });
  it.each([[4, 'low'], [5, 'medium'], [9, 'medium'], [10, 'high']])('summarizes %i deduplicated country unrest rows with source time unknown', (count, severity) => {
    const events = Array.from({ length: count as number }, (_, i) => ({ id: String(i), country: 'FR', occurredAt: 1792324800000 }));
    const outcome = projectCountrySignalFamily('FR', 'unrest', { events: [...events, ...events] });
    expect(outcome.observations).toHaveLength(1);
    expect(outcome.observations[0]).toMatchObject({ severity, eventAt: null, snapshotAt: null, timeBasis: 'unknown' });
  });
  it.each([[1, 'low'], [2, 'medium'], [4, 'medium'], [5, 'critical']])('preserves the conflict summary threshold at %i high rows', (count, severity) => {
    const events = Array.from({ length: count as number }, (_, i) => ({ id: String(i), country: 'FR', severity: 'high', timestamp: 1792324800 }));
    const outcome = projectCountrySignalFamily('FR', 'conflict', { events, scrapedAt: '1792324800000' });
    expect(outcome.observations[0]).toMatchObject({ severity, eventAt: '2026-10-18T12:00:00.000Z', timeBasis: 'event' });
    expect(projectCountrySignalFamily('FR', 'conflict', { events: [], scrapedAt: '0' }).state).toBe('unavailable');
  });
  it.each([[19, 0, null], [20, 0, 'medium'], [49, 0, 'medium'], [50, 0, 'high'], [1, 1, 'medium'], [1, 5, 'high']])('uses sanctions stock %i and delta %i without an invented event date', (entryCount, newEntryCount, severity) => {
    const outcome = projectCountrySignalFamily('FR', 'sanctions', { countries: [{ countryCode: 'FR', entryCount, newEntryCount }], fetchedAt: '1792324800000' });
    expect(outcome.observations[0]?.severity ?? null).toBe(severity);
    expect(outcome.observations.every(row => row.eventAt === null && row.timeBasis === 'snapshot')).toBe(true);
  });
  it('filters country before the local bound and rejects malformed radiation severity', () => {
    const outages = [...Array.from({ length: 1001 }, (_, i) => ({ id: `us-${i}`, country: 'US' })), { id: 'fr', country: 'France', severity: 'OUTAGE_SEVERITY_TOTAL' }];
    expect(projectCountrySignalFamily('FR', 'outages', { outages }).observations).toMatchObject([{ id: 'fr', severity: 'high' }]);
    const radiation = projectCountrySignalFamily('FR', 'radiation', { observations: [{ id: 'bad', country: 'FR', severity: 'garbage' }] });
    expect(radiation).toMatchObject({ state: 'unavailable', observations: [], partial: true });
    for (const value of [null, undefined, 0, -1, '0', 'invalid', Number.POSITIVE_INFINITY]) expect(sourceClock(value)).toBeNull();
  });
  it('replaces only a posture type with positive eligible evidence', () => {
    const military = observed('military');
    military.countryCode = 'IR';
    military.observations = ['military_flight', 'military_vessel', 'ais_disruption'].map(type => ({ id: type, family: 'military', type, severity: 'high', title: type, source: 'adsb.lol / AIS', eventAt: null, snapshotAt: null, timeBasis: 'unknown' }));
    const posture = projectCountrySignalFamily('IR', 'posture', { state: 'observed', status: 'live', provider: 'adsb.lol', theaters: [{ theater: 'iran-theater', postureLevel: 'elevated', activeFlights: 2, trackedVessels: 0 }] });
    const rows = projectQualifiedCountrySignals('IR', [military, posture]).observations;
    expect(rows.map(row => `${row.family}:${row.type}`)).toEqual(['military:military_vessel', 'military:ais_disruption', 'posture:military_flight']);
  });
  it('keeps dense model context bounded while preserving totals and each top-three clock', () => {
    const families = [...COUNTRY_SIGNAL_FAMILIES, 'military' as const].map(family => ({
      ...observed(family), scope: '💥'.repeat(250), attribution: '\\'.repeat(500), reason: '💥'.repeat(250),
      observations: [{ id: family, family, type: family, severity: 'high' as const, title: '\\'.repeat(512), source: '💥'.repeat(250), eventAt: null, snapshotAt: '2026-10-18T12:00:00.000Z', timeBasis: 'snapshot' as const }],
    }));
    const model = projectQualifiedCountrySignals('FR', families);
    const context = projectQualifiedCountrySignalContext(model);
    expect(context.details?.high).toBe(model.details?.high);
    expect(context.details?.recentHigh.map(row => row.timestamp)).toEqual(model.details?.recentHigh.map(row => row.timestamp));
    expect(context.details?.recentHigh.every(row => row.description.truncated)).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify({ content: [{ text: JSON.stringify(context) }] })).length).toBeLessThan(16384);
  });
});
