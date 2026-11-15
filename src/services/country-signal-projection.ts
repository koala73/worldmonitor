import { COUNTRY_SIGNAL_FAMILIES, projectQualifiedCountrySignals, unavailableCountrySignal, type CountrySignalOutcome, type QualifiedCountrySignals } from '../../shared/country-signal-observations';
import type { CountrySignalFamily } from '../../shared/country-signal-contract';
import { ORBITAL_WATCH_ENABLED } from '@/config/orbital-watch-flag';
import type { CountryBriefSource } from './country-brief-source';
import { CountrySectionError } from './country-brief-error';
import type { loadHostCountryMilitaryActivity } from './country-military-activity';

/**
 * Families past the 64-read opening budget are deferred in dispatch order. With Orbital Watch on,
 * imagery goes first: the countries with the most watched sites are the ones that exhaust the budget.
 * While it is dark, imagery has nothing to show and goes last, behind every existing source.
 */
export function signalDispatchOrder(orbitalWatch: boolean): CountrySignalFamily[] {
  const others = COUNTRY_SIGNAL_FAMILIES.filter(family => family !== 'imagery');
  return orbitalWatch ? ['imagery', ...others] : [...others, 'imagery'];
}

export async function loadQualifiedCountrySignals(source: CountryBriefSource, code: string, signal: AbortSignal, military: ReturnType<typeof loadHostCountryMilitaryActivity>, previous?: QualifiedCountrySignals | null): Promise<QualifiedCountrySignals> {
  const militaryOutcome = await military.then(value => value.qualified, error => unavailableCountrySignal(code, 'military', 'Military observations unavailable.', error instanceof CountrySectionError && error.state === 'locked' ? 'locked' : 'unavailable'));
  signal.throwIfAborted();
  await source.settleMandatoryReads(signal);
  signal.throwIfAborted();
  const order = signalDispatchOrder(ORBITAL_WATCH_ENABLED);
  const outcomes = await Promise.all(order.map(async (family): Promise<CountrySignalOutcome> => {
    if (family === 'posture' && !['IR', 'TW', 'KP', 'PS', 'YE'].includes(code)) return unavailableCountrySignal(code, family, 'No existing posture target applies to this country.');
    try { return await source.countrySignals(code, family, signal); }
    catch (error) { return unavailableCountrySignal(code, family, error instanceof Error && error.message.includes('budget') ? 'Deferred: the country read budget is reserved for existing sections.' : 'Source observations unavailable.', error instanceof CountrySectionError && error.state === 'locked' ? 'locked' : 'unavailable'); }
  }));
  signal.throwIfAborted();
  const families = COUNTRY_SIGNAL_FAMILIES.map(family => outcomes[order.indexOf(family)]!);
  families.push(militaryOutcome);
  const retained = families.map(outcome => {
    const prior = previous?.countryCode === code ? previous.families.find(value => value.family === outcome.family) : undefined;
    return outcome.state === 'unavailable' && prior?.state === 'observed' ? { ...prior, partial: true, reason: `${outcome.reason ?? 'Refresh failed.'} Retained source observations keep their original clocks.`.slice(0, 500) } : outcome;
  });
  return projectQualifiedCountrySignals(code, retained);
}
