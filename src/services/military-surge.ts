// Client wrapper over the dependency-free surge core in
// `shared/analysis-military-surge.ts`. The algorithms, tables and thresholds all
// live there so Edge/esbuild server handlers can run them too; this module owns
// the single process-wide engine and wires the client-only news lookup the core
// takes as a callback (focal-point news correlation).

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

export type { MilitaryTheater } from '../../shared/analysis-military-surge';
export { POSTURE_TARGET_NATION_CODES } from '../../shared/analysis-military-surge';
export type { SurgeAlert, TheaterActivity, TheaterPostureSummary };

export type ForeignPresenceAlert = CoreForeignPresenceAlert<MilitaryFlight>;

/** The core narrows `type` to its own literal; the app-facing signal keeps the full union. */
type MilitarySignal = Omit<MilitarySurgeSignal, 'type'> & { type: SignalType };

const engine = new MilitarySurgeEngine<MilitaryFlight>({
  newsContext: {
    getCorrelation: (countryCodes) => focalPointDetector.getNewsCorrelationContext(countryCodes),
    getFocalPoint: (countryCode) => focalPointDetector.getFocalPointForCountry(countryCode),
  },
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
