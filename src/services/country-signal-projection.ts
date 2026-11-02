import { COUNTRY_SIGNAL_FAMILIES, projectQualifiedCountrySignals, unavailableCountrySignal, type CountrySignalOutcome, type QualifiedCountrySignals } from '../../shared/country-signal-observations';
import type { CountryBriefSource } from './country-brief-source';
import { CountrySectionError } from './country-brief-error';
import type { loadHostCountryMilitaryActivity } from './country-military-activity';

export async function loadQualifiedCountrySignals(source: CountryBriefSource, code: string, signal: AbortSignal, military: ReturnType<typeof loadHostCountryMilitaryActivity>, previous?: QualifiedCountrySignals | null): Promise<QualifiedCountrySignals> {
  const militaryOutcome = await military.then(value => value.qualified, error => unavailableCountrySignal(code, 'military', 'Military observations unavailable.', error instanceof CountrySectionError && error.state === 'locked' ? 'locked' : 'unavailable'));
  signal.throwIfAborted();
  await source.settleMandatoryReads(signal);
  signal.throwIfAborted();
  const families: CountrySignalOutcome[] = await Promise.all(COUNTRY_SIGNAL_FAMILIES.map(async family => {
    if (family === 'posture' && !['IR', 'TW', 'KP', 'PS', 'YE'].includes(code)) return unavailableCountrySignal(code, family, 'No existing posture target applies to this country.');
    try { return await source.countrySignals(code, family, signal); }
    catch (error) { return unavailableCountrySignal(code, family, error instanceof Error && error.message.includes('budget') ? 'Deferred: the country read budget is reserved for existing sections.' : 'Source observations unavailable.', error instanceof CountrySectionError && error.state === 'locked' ? 'locked' : 'unavailable'); }
  }));
  signal.throwIfAborted();
  families.push(militaryOutcome);
  const retained = families.map(outcome => {
    const prior = previous?.countryCode === code ? previous.families.find(value => value.family === outcome.family) : undefined;
    return outcome.state === 'unavailable' && prior?.state === 'observed' ? { ...prior, partial: true, reason: `${outcome.reason ?? 'Refresh failed.'} Retained source observations keep their original clocks.`.slice(0, 500) } : outcome;
  });
  return projectQualifiedCountrySignals(code, retained);
}
