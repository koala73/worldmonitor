// Client wrapper over the dependency-free surge core in
// `shared/analysis-military-surge.ts`. The algorithms, tables and thresholds all
// live there so Edge/esbuild server handlers can run them too; this module owns
// the single process-wide engine and wires the two client-only lookups the core
// takes as callbacks (focal-point news correlation, cached CII scores).

import type { MilitaryFlight } from '@/types';
import type { SignalType } from '@/utils/analysis-constants';
import {
  MilitarySurgeEngine,
  type ForeignPresenceAlert as CoreForeignPresenceAlert,
  type MilitarySurgeSignal,
  type SurgeAlert,
  type TheaterActivity,
  type TheaterPostureSummary,
  surgeAlertToSignal as surgeAlertToSignalCore,
} from '../../shared/analysis-military-surge';
import { focalPointDetector } from './focal-point-detector';
import { getCachedCountryScoreValue } from './cached-risk-scores';

export type { MilitaryTheater } from '../../shared/analysis-military-surge';
export type { SurgeAlert, TheaterActivity, TheaterPostureSummary };

export type ForeignPresenceAlert = CoreForeignPresenceAlert<MilitaryFlight>;

/** The core narrows `type` to its own literal; the app-facing signal keeps the full union. */
type MilitarySignal = Omit<MilitarySurgeSignal, 'type'> & { type: SignalType };

// Cached/server scores are the only CII source here — see
// tests/frontend-cii-source-of-truth.test.mts.
const ciiLookup = (code: string): number | null => {
  const cii = getCachedCountryScoreValue(code);
  return cii;
};

const engine = new MilitarySurgeEngine<MilitaryFlight>({
  newsContext: {
    getCorrelation: (countryCodes) => focalPointDetector.getNewsCorrelationContext(countryCodes),
    getFocalPoint: (countryCode) => focalPointDetector.getFocalPointForCountry(countryCode),
  },
  getCii: ciiLookup,
});

export function analyzeFlightsForSurge(flights: MilitaryFlight[]): SurgeAlert[] {
  return engine.analyzeFlightsForSurge(flights);
}

export function getActiveSurges(): SurgeAlert[] {
  return engine.getActiveSurges();
}

export function getTheaterActivity(theaterId: string): TheaterActivity[] {
  return engine.getTheaterActivity(theaterId);
}

export function detectForeignMilitaryPresence(flights: MilitaryFlight[]): ForeignPresenceAlert[] {
  return engine.detectForeignMilitaryPresence(flights);
}

export function foreignPresenceToSignal(alert: ForeignPresenceAlert): MilitarySignal {
  return engine.foreignPresenceToSignal(alert);
}

export function getActiveForeignPresence(): ForeignPresenceAlert[] {
  return engine.getActiveForeignPresence();
}

export function surgeAlertToSignal(surge: SurgeAlert): MilitarySignal {
  return surgeAlertToSignalCore(surge);
}

export function getTheaterPostureSummaries(flights: MilitaryFlight[]): TheaterPostureSummary[] {
  return engine.getTheaterPostureSummaries(flights);
}

/**
 * Recalculate posture level after vessels have been merged into summaries.
 * Uses "either triggers" logic: if aircraft OR vessels exceed thresholds, level escalates.
 * CII boost: theaters whose target nation has CII ≥ 70 get elevated, ≥ 85 get critical.
 */
export function recalcPostureWithVessels(postures: TheaterPostureSummary[]): void {
  engine.recalcPostureWithVessels(postures);
}

export function getCriticalPostures(flights: MilitaryFlight[]): TheaterPostureSummary[] {
  return engine.getCriticalPostures(flights);
}
