import type { MarineHazard } from './marine-hazards';
import type { NWSAlert } from './nws-alerts';
import type { BuoyObservation, HurricaneReconFix } from './noaa-buoys';
import { haversineKm } from './proximity-filter';
import type { SavedPlace } from './saved-places';
import type { ConvectiveOutlook, SpcSummary, StormReport } from './spc-outlook';
import type { TropicalCyclone } from './tropical-cyclones';
import type { WeatherAlert } from './weather';
import type { ExcessiveRainfallOutlook } from './wpc-excessive-rainfall';
import type { WinterWeatherOutlook } from './wpc-winter-weather';

export type StormPreparednessSeverity = 'critical' | 'high' | 'medium' | 'low';
export type StormScenario = 'hurricane' | 'tornado' | 'winter' | 'flood' | 'marine' | 'severe-storm';
export type StormPosture = 'monitor' | 'prepare-today' | 'act-now' | 'shelter-now';

export interface StormPreparednessItem {
  label: string;
  value: string;
  severity: StormPreparednessSeverity;
  scenario: StormScenario;
  posture: StormPosture;
  source: string;
}

export interface PlaceStormPreparedness {
  headline: string;
  detail: string;
  scenario: StormScenario;
  posture: StormPosture;
  severity: StormPreparednessSeverity;
  guidance: string[];
  items: StormPreparednessItem[];
  updatedAt: Date;
}

export interface StormPreparednessContext {
  weatherAlerts: WeatherAlert[];
  nwsAlerts: NWSAlert[];
  tropicalCyclones: TropicalCyclone[];
  spcSummary: SpcSummary | null;
  excessiveRainfallOutlooks: ExcessiveRainfallOutlook[];
  winterWeatherOutlooks: WinterWeatherOutlook[];
  marineHazards: MarineHazard[];
  buoyAlerts: BuoyObservation[];
  reconFixes: HurricaneReconFix[];
  updatedAt: number;
}

export interface StormPreparednessSummary {
  posture: StormPosture;
  criticalCount: number;
  highCount: number;
  majorSystemCount: number;
  stormFamilies: StormScenario[];
  updatedAt: number;
}

interface PreparednessCandidate {
  headline: string;
  detail: string;
  scenario: StormScenario;
  posture: StormPosture;
  severity: StormPreparednessSeverity;
  actions: string[];
  source: string;
}

const STORM_EVENT = 'wm:storm-data-updated';
const EMPTY_CONTEXT: StormPreparednessContext = {
  weatherAlerts: [],
  nwsAlerts: [],
  tropicalCyclones: [],
  spcSummary: null,
  excessiveRainfallOutlooks: [],
  winterWeatherOutlooks: [],
  marineHazards: [],
  buoyAlerts: [],
  reconFixes: [],
  updatedAt: 0,
};

const SEVERITY_RANK: Record<StormPreparednessSeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

const POSTURE_RANK: Record<StormPosture, number> = {
  monitor: 0,
  'prepare-today': 1,
  'act-now': 2,
  'shelter-now': 3,
};

let stormContext: StormPreparednessContext = { ...EMPTY_CONTEXT };

function isFiniteDate(value: Date | string | null | undefined): value is Date | string {
  if (!value) return false;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime());
}

function normalizeContext(
  context: Partial<Omit<StormPreparednessContext, 'updatedAt'>> = {},
  updatedAt = Date.now(),
): StormPreparednessContext {
  return {
    weatherAlerts: context.weatherAlerts ?? stormContext.weatherAlerts ?? [],
    nwsAlerts: context.nwsAlerts ?? stormContext.nwsAlerts ?? [],
    tropicalCyclones: context.tropicalCyclones ?? stormContext.tropicalCyclones ?? [],
    spcSummary: context.spcSummary ?? stormContext.spcSummary ?? null,
    excessiveRainfallOutlooks: context.excessiveRainfallOutlooks ?? stormContext.excessiveRainfallOutlooks ?? [],
    winterWeatherOutlooks: context.winterWeatherOutlooks ?? stormContext.winterWeatherOutlooks ?? [],
    marineHazards: context.marineHazards ?? stormContext.marineHazards ?? [],
    buoyAlerts: context.buoyAlerts ?? stormContext.buoyAlerts ?? [],
    reconFixes: context.reconFixes ?? stormContext.reconFixes ?? [],
    updatedAt,
  };
}

function pointNearPlace(place: SavedPlace, lat: number, lon: number, extraKm = 0): boolean {
  return haversineKm(place.lat, place.lon, lat, lon) <= place.radiusKm + extraKm;
}

function polygonHasPlace(place: SavedPlace, polygon: [number, number][]): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  const x = place.lon;
  const y = place.lat;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i] ?? [0, 0];
    const [xj, yj] = polygon[j] ?? [0, 0];
    const intersects = ((yi > y) !== (yj > y))
      && (x < ((xj - xi) * (y - yi)) / ((yj - yi) || Number.EPSILON) + xi);
    if (intersects) inside = !inside;
  }

  return inside;
}

function geometryNearPlace(
  place: SavedPlace,
  coordinates: [number, number][],
  centroid?: [number, number],
  extraKm = 50,
): boolean {
  if (coordinates.length > 0 && polygonHasPlace(place, coordinates)) return true;
  if (coordinates.some(([lon, lat]) => pointNearPlace(place, lat, lon, extraKm))) return true;
  if (centroid && pointNearPlace(place, centroid[1], centroid[0], extraKm)) return true;
  return false;
}

function mapWeatherSeverity(severity: WeatherAlert['severity'] | NWSAlert['severity']): StormPreparednessSeverity {
  switch (severity) {
    case 'Extreme':
      return 'critical';
    case 'Severe':
      return 'high';
    case 'Moderate':
      return 'medium';
    default:
      return 'low';
  }
}

function classifyScenario(event: string): StormScenario | null {
  const normalized = event.toLowerCase();
  if (normalized.includes('tornado') || normalized.includes('waterspout')) return 'tornado';
  if (
    normalized.includes('hurricane')
    || normalized.includes('typhoon')
    || normalized.includes('tropical storm')
    || normalized.includes('storm surge')
  ) {
    return 'hurricane';
  }
  if (
    normalized.includes('blizzard')
    || normalized.includes('winter storm')
    || normalized.includes('ice storm')
    || normalized.includes('snow squall')
    || normalized.includes('freezing rain')
    || normalized.includes('lake effect snow')
  ) {
    return 'winter';
  }
  if (normalized.includes('flash flood') || normalized.includes('flood')) return 'flood';
  if (
    normalized.includes('marine')
    || normalized.includes('gale')
    || normalized.includes('high surf')
    || normalized.includes('rip current')
    || normalized.includes('dangerous surf')
    || normalized.includes('hurricane force wind')
  ) {
    return 'marine';
  }
  if (
    normalized.includes('severe thunderstorm')
    || normalized.includes('thunderstorm')
    || normalized.includes('convective')
  ) {
    return 'severe-storm';
  }
  return null;
}

function formatScenarioLabel(scenario: StormScenario): string {
  switch (scenario) {
    case 'hurricane':
      return 'Hurricane';
    case 'tornado':
      return 'Tornado';
    case 'winter':
      return 'Winter';
    case 'flood':
      return 'Flood';
    case 'marine':
      return 'Coastal';
    case 'severe-storm':
      return 'Severe Storm';
  }
}

function formatPostureLabel(posture: StormPosture): string {
  switch (posture) {
    case 'prepare-today':
      return 'Prepare Today';
    case 'act-now':
      return 'Act Now';
    case 'shelter-now':
      return 'Shelter Now';
    default:
      return 'Monitor';
  }
}

function leadTimeText(rawDate: Date | string | null | undefined, updatedAt: number): string {
  if (!isFiniteDate(rawDate)) return 'Active now';
  const eventTime = rawDate instanceof Date ? rawDate.getTime() : new Date(rawDate).getTime();
  const deltaMs = eventTime - updatedAt;
  if (deltaMs <= 0) return 'Active now';
  const deltaMinutes = Math.round(deltaMs / 60000);
  if (deltaMinutes < 60) return `${deltaMinutes} min lead`;
  const deltaHours = Math.round(deltaMinutes / 60);
  return `${deltaHours} hr lead`;
}

function compareCandidates(left: PreparednessCandidate, right: PreparednessCandidate): number {
  const postureDiff = POSTURE_RANK[right.posture] - POSTURE_RANK[left.posture];
  if (postureDiff !== 0) return postureDiff;
  const severityDiff = SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity];
  if (severityDiff !== 0) return severityDiff;
  return left.headline.localeCompare(right.headline);
}

function maxPosture(a: StormPosture, b: StormPosture): StormPosture {
  return POSTURE_RANK[a] >= POSTURE_RANK[b] ? a : b;
}

function postureFromAlert(event: string, severity: StormPreparednessSeverity): StormPosture {
  const normalized = event.toLowerCase();
  const scenario = classifyScenario(event);

  if (scenario === 'tornado') {
    if (normalized.includes('warning') || normalized.includes('emergency')) return 'shelter-now';
    if (normalized.includes('watch')) return 'prepare-today';
  }

  if (scenario === 'flood') {
    if (normalized.includes('emergency')) return 'shelter-now';
    if (normalized.includes('warning')) return 'act-now';
    if (normalized.includes('watch')) return 'prepare-today';
  }

  if (scenario === 'winter') {
    if (normalized.includes('blizzard warning') || normalized.includes('ice storm warning')) return 'act-now';
    if (normalized.includes('watch') || normalized.includes('winter storm warning')) return 'prepare-today';
  }

  if (scenario === 'hurricane') {
    if (normalized.includes('warning') || normalized.includes('storm surge')) return 'act-now';
    if (normalized.includes('watch')) return 'prepare-today';
  }

  if (scenario === 'marine') {
    if (normalized.includes('warning')) return 'prepare-today';
  }

  if (scenario === 'severe-storm') {
    if (normalized.includes('warning')) return 'act-now';
    if (normalized.includes('watch')) return 'prepare-today';
  }

  if (severity === 'critical') return 'act-now';
  if (severity === 'high') return 'prepare-today';
  return 'monitor';
}

function scenarioActions(scenario: StormScenario, posture: StormPosture): string[] {
  switch (scenario) {
    case 'tornado':
      return posture === 'shelter-now'
        ? ['Move to the lowest interior room now.', 'Stay away from windows and exterior walls.', 'Keep shoes, phones, and helmets close.']
        : ['Review your shelter room today.', 'Charge phones and weather radios.', 'Secure outdoor items before storms arrive.'];
    case 'hurricane':
      return posture === 'act-now' || posture === 'shelter-now'
        ? ['Top off fuel, water, and medications.', 'Charge batteries and stage go-bags.', 'Be ready to leave low-lying or surge-prone areas.']
        : ['Restock storm supplies today.', 'Review evacuation routes and contacts.', 'Move important documents into waterproof storage.'];
    case 'winter':
      return posture === 'act-now'
        ? ['Avoid unnecessary travel before roads deteriorate.', 'Protect pipes, pets, and backup heat.', 'Stage food, meds, and blankets for 48 hours.']
        : ['Check cold-weather gear and batteries.', 'Bring vehicles above half a tank.', 'Prepare for outages and slick roads.'];
    case 'flood':
      return posture === 'shelter-now'
        ? ['Move immediately to higher ground.', 'Never drive into flood water.', 'Keep devices and documents above floor level.']
        : ['Clear drains and move vehicles out of low spots.', 'Plan alternate routes around flood-prone roads.', 'Prepare to relocate valuables upstairs.'];
    case 'marine':
      return ['Avoid surf, piers, and exposed shoreline.', 'Secure boats and loose coastal gear.', 'Review surge and inundation routes.'];
    case 'severe-storm':
      return ['Bring in loose outdoor items.', 'Charge power banks and radios.', 'Expect fast warning upgrades and stay close to shelter.'];
  }
}

function cycloneCategoryLabel(storm: TropicalCyclone): string {
  switch (storm.category) {
    case 'tropical_depression':
      return 'TD';
    case 'tropical_storm':
      return 'TS';
    case 'category_1':
      return 'Cat 1';
    case 'category_2':
      return 'Cat 2';
    case 'category_3':
      return 'Cat 3';
    case 'category_4':
      return 'Cat 4';
    case 'category_5':
      return 'Cat 5';
    default:
      return 'TC';
  }
}

function convectiveRiskLabel(risk: ConvectiveOutlook['risk']): string {
  switch (risk) {
    case 'HIGH':
      return 'High';
    case 'MDT':
      return 'Moderate';
    case 'ENH':
      return 'Enhanced';
    case 'SLGT':
      return 'Slight';
    case 'MRGL':
      return 'Marginal';
    default:
      return 'Thunderstorm';
  }
}

function outlookPosture(risk: ConvectiveOutlook['risk']): StormPosture {
  switch (risk) {
    case 'HIGH':
    case 'MDT':
      return 'act-now';
    case 'ENH':
      return 'prepare-today';
    default:
      return 'monitor';
  }
}

function isMajorStormEvent(event: string, severity: StormPreparednessSeverity): boolean {
  if (severity === 'low' || severity === 'medium') return false;
  const normalized = event.toLowerCase();
  return [
    'hurricane warning',
    'storm surge warning',
    'blizzard warning',
    'ice storm warning',
    'tornado emergency',
    'flash flood emergency',
    'extreme wind warning',
  ].some((needle) => normalized.includes(needle));
}

function isMajorCyclone(storm: TropicalCyclone): boolean {
  return storm.category === 'category_3' || storm.category === 'category_4' || storm.category === 'category_5';
}

function isMajorReconFix(fix: HurricaneReconFix): boolean {
  return (fix.minPressureMb ?? Number.POSITIVE_INFINITY) <= 960 || (fix.surfaceWindKts ?? 0) >= 100;
}

function pickGuidance(candidates: PreparednessCandidate[]): string[] {
  const merged = candidates.flatMap((candidate) => candidate.actions);
  return [...new Set(merged)].slice(0, 3);
}

function candidateFromWeatherAlert(
  place: SavedPlace,
  alert: WeatherAlert,
  updatedAt: number,
): PreparednessCandidate | null {
  const scenario = classifyScenario(alert.event);
  if (!scenario) return null;
  if (!geometryNearPlace(place, alert.coordinates, alert.centroid, 75)) return null;

  const severity = mapWeatherSeverity(alert.severity);
  const posture = postureFromAlert(alert.event, severity);
  return {
    headline: alert.headline || alert.event,
    detail: `${formatPostureLabel(posture)} · ${leadTimeText(alert.onset, updatedAt)}`,
    scenario,
    posture,
    severity,
    actions: scenarioActions(scenario, posture),
    source: 'Weather alert',
  };
}

function candidateFromSpcOutlook(
  place: SavedPlace,
  outlook: ConvectiveOutlook,
): PreparednessCandidate | null {
  const rings = outlook.coordinates;
  const intersects = rings.some((ring) => geometryNearPlace(place, ring, outlook.centroid, 150));
  if (!intersects) return null;

  const scenario: StormScenario = outlook.risk === 'HIGH' || outlook.risk === 'MDT' ? 'tornado' : 'severe-storm';
  const posture = outlookPosture(outlook.risk);
  return {
    headline: `${convectiveRiskLabel(outlook.risk)} convective risk near ${place.name}`,
    detail: `SPC Day ${outlook.day} outlook`,
    scenario,
    posture,
    severity: outlook.severity,
    actions: scenarioActions(scenario, posture),
    source: 'SPC outlook',
  };
}

function candidateFromExcessiveRainfallOutlook(
  place: SavedPlace,
  outlook: ExcessiveRainfallOutlook,
): PreparednessCandidate | null {
  const intersects = outlook.coordinates.some((ring) => geometryNearPlace(place, ring, outlook.centroid, 100));
  if (!intersects) return null;

  let posture: StormPosture = 'monitor';
  switch (outlook.riskLevel) {
    case 'high':
      posture = 'act-now';
      break;
    case 'moderate':
      posture = outlook.day === 1 ? 'act-now' : 'prepare-today';
      break;
    case 'slight':
      posture = 'prepare-today';
      break;
    default:
      posture = 'monitor';
      break;
  }

  return {
    headline: `WPC ${outlook.riskText} excessive rainfall risk near ${place.name}`,
    detail: `Day ${outlook.day} flash-flood outlook`,
    scenario: 'flood',
    posture,
    severity: outlook.severity,
    actions: scenarioActions('flood', posture),
    source: 'WPC rainfall outlook',
  };
}

function winterOutlookPosture(outlook: WinterWeatherOutlook): StormPosture {
  if (outlook.day === 1 && outlook.severity === 'critical') return 'act-now';
  if (outlook.day <= 2 && (outlook.severity === 'critical' || outlook.severity === 'high')) return 'prepare-today';
  if (outlook.day === 1 && outlook.severity === 'medium') return 'prepare-today';
  return 'monitor';
}

function winterThresholdLabel(outlook: WinterWeatherOutlook): string {
  if (outlook.hazardType === 'ice') return '0.25 inch ice';
  return `${outlook.threshold.replace('in', '')} inches snow`;
}

function candidateFromWinterWeatherOutlook(
  place: SavedPlace,
  outlook: WinterWeatherOutlook,
): PreparednessCandidate | null {
  const intersects = outlook.coordinates.some((ring) => geometryNearPlace(place, ring, outlook.centroid, 100));
  if (!intersects) return null;

  const posture = winterOutlookPosture(outlook);
  return {
    headline: `WPC Day ${outlook.day} winter weather risk near ${place.name}`,
    detail: `${winterThresholdLabel(outlook)} · ${outlook.probabilityPercent}% probability`,
    scenario: 'winter',
    posture,
    severity: outlook.severity,
    actions: scenarioActions('winter', posture),
    source: 'WPC winter outlook',
  };
}

function candidateFromStormReport(
  place: SavedPlace,
  report: StormReport,
): PreparednessCandidate | null {
  if (!pointNearPlace(place, report.lat, report.lon, 60)) return null;

  const scenario: StormScenario = report.type === 'tornado'
    ? 'tornado'
    : report.type === 'flooding'
      ? 'flood'
      : 'severe-storm';
  const closeRange = haversineKm(place.lat, place.lon, report.lat, report.lon) <= 25;
  const posture: StormPosture = report.type === 'tornado' && closeRange
    ? 'shelter-now'
    : report.type === 'tornado' || report.type === 'flooding'
      ? 'act-now'
      : 'prepare-today';

  return {
    headline: `Recent ${report.type} report near ${place.name}`,
    detail: [report.location, report.state].filter(Boolean).join(', ') || 'Local storm report',
    scenario,
    posture,
    severity: report.severity,
    actions: scenarioActions(scenario, posture),
    source: 'Storm report',
  };
}

function candidateFromCyclone(
  place: SavedPlace,
  storm: TropicalCyclone,
): PreparednessCandidate | null {
  const distanceKm = haversineKm(place.lat, place.lon, storm.lat, storm.lon);
  if (distanceKm > 1200) return null;

  let posture: StormPosture = 'monitor';
  if (distanceKm <= 150 && storm.severity === 'critical') posture = 'shelter-now';
  else if (distanceKm <= 350 && (storm.severity === 'critical' || storm.severity === 'high')) posture = 'act-now';
  else if (distanceKm <= 700 && storm.severity !== 'low') posture = 'prepare-today';

  return {
    headline: `${storm.name} may impact ${place.name}`,
    detail: `${cycloneCategoryLabel(storm)} · ${Math.round(distanceKm)} km away`,
    scenario: 'hurricane',
    posture,
    severity: storm.severity,
    actions: scenarioActions('hurricane', posture),
    source: 'Tropical cyclone',
  };
}

function candidateFromBuoy(
  place: SavedPlace,
  observation: BuoyObservation,
): PreparednessCandidate | null {
  if (!pointNearPlace(place, observation.lat, observation.lon, 900)) return null;
  if (!observation.isAlertCondition) return null;

  const posture: StormPosture = observation.severity === 'critical' ? 'act-now' : 'prepare-today';
  return {
    headline: `Offshore conditions worsening near ${place.name}`,
    detail: observation.alertReason || observation.stationId,
    scenario: 'marine',
    posture,
    severity: observation.severity === 'normal' ? 'low' : observation.severity,
    actions: scenarioActions('marine', posture),
    source: 'NOAA buoy',
  };
}

function candidateFromRecon(
  place: SavedPlace,
  fix: HurricaneReconFix,
): PreparednessCandidate | null {
  if (!pointNearPlace(place, fix.lat, fix.lon, 1200)) return null;

  const severeFix = isMajorReconFix(fix);
  const posture: StormPosture = severeFix ? 'act-now' : 'prepare-today';
  return {
    headline: `Recon confirms strengthening hurricane conditions`,
    detail: `${fix.stormName} · ${fix.surfaceWindKts ?? fix.flightLevelWindKts ?? 0} kt`,
    scenario: 'hurricane',
    posture,
    severity: severeFix ? 'critical' : 'high',
    actions: scenarioActions('hurricane', posture),
    source: 'Hurricane recon',
  };
}

function countsFromSeverity(
  severity: StormPreparednessSeverity,
  counts: Pick<StormPreparednessSummary, 'criticalCount' | 'highCount'>,
): void {
  if (severity === 'critical') counts.criticalCount += 1;
  else if (severity === 'high') counts.highCount += 1;
}

export function getStormDataUpdatedEventName(): string {
  return STORM_EVENT;
}

export function resetStormPreparednessContext(): void {
  stormContext = { ...EMPTY_CONTEXT };
}

export function getStormPreparednessContext(): StormPreparednessContext {
  return stormContext;
}

export function updateStormPreparednessContext(
  context: Partial<Omit<StormPreparednessContext, 'updatedAt'>>,
): StormPreparednessContext {
  stormContext = normalizeContext(context);

  if (typeof document !== 'undefined' && typeof CustomEvent !== 'undefined') {
    document.dispatchEvent(new CustomEvent(STORM_EVENT, {
      detail: getStormPreparednessSummary(stormContext),
    }));
  }

  return stormContext;
}

export function getStormPreparednessSummary(
  context: StormPreparednessContext = stormContext,
): StormPreparednessSummary {
  const summary: StormPreparednessSummary = {
    posture: 'monitor',
    criticalCount: 0,
    highCount: 0,
    majorSystemCount: 0,
    stormFamilies: [],
    updatedAt: context.updatedAt || Date.now(),
  };
  const families = new Set<StormScenario>();

  for (const alert of context.weatherAlerts ?? []) {
    const scenario = classifyScenario(alert.event);
    if (!scenario) continue;
    families.add(scenario);
    const severity = mapWeatherSeverity(alert.severity);
    const posture = postureFromAlert(alert.event, severity);
    summary.posture = maxPosture(summary.posture, posture);
    countsFromSeverity(severity, summary);
    if (isMajorStormEvent(alert.event, severity)) summary.majorSystemCount += 1;
  }

  for (const alert of context.nwsAlerts ?? []) {
    const scenario = classifyScenario(alert.event);
    if (!scenario) continue;
    families.add(scenario);
    const severity = mapWeatherSeverity(alert.severity);
    const posture = postureFromAlert(alert.event, severity);
    summary.posture = maxPosture(summary.posture, posture);
    countsFromSeverity(severity, summary);
    if (isMajorStormEvent(alert.event, severity)) summary.majorSystemCount += 1;
  }

  for (const storm of context.tropicalCyclones ?? []) {
    families.add('hurricane');
    summary.posture = maxPosture(summary.posture, storm.severity === 'critical' ? 'act-now' : 'prepare-today');
    countsFromSeverity(storm.severity, summary);
    if (isMajorCyclone(storm)) summary.majorSystemCount += 1;
  }

  if (context.spcSummary?.maxRisk) {
    families.add(context.spcSummary.maxRisk === 'HIGH' || context.spcSummary.maxRisk === 'MDT' ? 'tornado' : 'severe-storm');
    const severity: StormPreparednessSeverity = context.spcSummary.maxRisk === 'HIGH' || context.spcSummary.maxRisk === 'MDT'
      ? 'high'
      : context.spcSummary.maxRisk === 'ENH'
        ? 'medium'
        : 'low';
    const posture = outlookPosture(context.spcSummary.maxRisk);
    summary.posture = maxPosture(summary.posture, posture);
    countsFromSeverity(severity, summary);
    if (context.spcSummary.maxRisk === 'HIGH' || context.spcSummary.maxRisk === 'MDT') {
      summary.majorSystemCount += 1;
    }
  }

  for (const outlook of context.excessiveRainfallOutlooks ?? []) {
    families.add('flood');
    const posture: StormPosture = outlook.riskLevel === 'high' || (outlook.riskLevel === 'moderate' && outlook.day === 1)
      ? 'act-now'
      : outlook.riskLevel === 'slight' || outlook.riskLevel === 'moderate'
        ? 'prepare-today'
        : 'monitor';
    summary.posture = maxPosture(summary.posture, posture);
    countsFromSeverity(outlook.severity, summary);
    if (outlook.riskLevel === 'moderate' || outlook.riskLevel === 'high') {
      summary.majorSystemCount += 1;
    }
  }

  for (const outlook of context.winterWeatherOutlooks ?? []) {
    families.add('winter');
    const posture = winterOutlookPosture(outlook);
    summary.posture = maxPosture(summary.posture, posture);
    countsFromSeverity(outlook.severity, summary);
    if (
      (outlook.hazardType === 'ice' && outlook.probabilityPercent >= 40)
      || (outlook.threshold === '12in' && outlook.probabilityPercent >= 40)
      || (outlook.day === 1 && outlook.severity === 'critical')
    ) {
      summary.majorSystemCount += 1;
    }
  }

  for (const hazard of context.marineHazards ?? []) {
    const scenario = hazard.hazardType === 'storm-surge' || hazard.hazardType === 'hurricane-wind' ? 'hurricane' : 'marine';
    families.add(scenario);
    const posture: StormPosture = hazard.severity === 'critical' ? 'act-now' : hazard.severity === 'high' ? 'prepare-today' : 'monitor';
    summary.posture = maxPosture(summary.posture, posture);
    countsFromSeverity(hazard.severity, summary);
    if (hazard.hazardType === 'storm-surge' || hazard.hazardType === 'hurricane-wind') {
      summary.majorSystemCount += 1;
    }
  }

  for (const buoy of context.buoyAlerts ?? []) {
    families.add('marine');
    const severity = buoy.severity === 'normal' ? 'low' : buoy.severity;
    const posture: StormPosture = severity === 'critical' ? 'act-now' : severity === 'high' ? 'prepare-today' : 'monitor';
    summary.posture = maxPosture(summary.posture, posture);
    countsFromSeverity(severity, summary);
    if (severity === 'critical') summary.majorSystemCount += 1;
  }

  for (const fix of context.reconFixes ?? []) {
    families.add('hurricane');
    const severity: StormPreparednessSeverity = isMajorReconFix(fix) ? 'critical' : 'high';
    const posture: StormPosture = severity === 'critical' ? 'act-now' : 'prepare-today';
    summary.posture = maxPosture(summary.posture, posture);
    countsFromSeverity(severity, summary);
    if (isMajorReconFix(fix)) summary.majorSystemCount += 1;
  }

  summary.stormFamilies = [...families];
  return summary;
}

export function getStormPreparednessForPlace(
  place: SavedPlace,
  context: StormPreparednessContext = stormContext,
): PlaceStormPreparedness | null {
  const candidates: PreparednessCandidate[] = [];
  const updatedAt = context.updatedAt || Date.now();

  for (const alert of context.weatherAlerts ?? []) {
    const candidate = candidateFromWeatherAlert(place, alert, updatedAt);
    if (candidate) candidates.push(candidate);
  }

  if (context.spcSummary) {
    for (const outlook of context.spcSummary.outlooks) {
      const candidate = candidateFromSpcOutlook(place, outlook);
      if (candidate) candidates.push(candidate);
    }
    for (const report of context.spcSummary.reports) {
      const candidate = candidateFromStormReport(place, report);
      if (candidate) candidates.push(candidate);
    }
  }

  for (const outlook of context.excessiveRainfallOutlooks ?? []) {
    const candidate = candidateFromExcessiveRainfallOutlook(place, outlook);
    if (candidate) candidates.push(candidate);
  }

  for (const outlook of context.winterWeatherOutlooks ?? []) {
    const candidate = candidateFromWinterWeatherOutlook(place, outlook);
    if (candidate) candidates.push(candidate);
  }

  for (const storm of context.tropicalCyclones ?? []) {
    const candidate = candidateFromCyclone(place, storm);
    if (candidate) candidates.push(candidate);
  }

  for (const buoy of context.buoyAlerts ?? []) {
    const candidate = candidateFromBuoy(place, buoy);
    if (candidate) candidates.push(candidate);
  }

  for (const fix of context.reconFixes ?? []) {
    const candidate = candidateFromRecon(place, fix);
    if (candidate) candidates.push(candidate);
  }

  candidates.sort(compareCandidates);
  const topCandidates = candidates.slice(0, 3);
  const lead = topCandidates[0];
  if (!lead) return null;

  return {
    headline: lead.headline,
    detail: lead.detail,
    scenario: lead.scenario,
    posture: lead.posture,
    severity: lead.severity,
    guidance: pickGuidance(topCandidates),
    items: topCandidates.map((candidate) => ({
      label: candidate.headline,
      value: candidate.detail,
      severity: candidate.severity,
      scenario: candidate.scenario,
      posture: candidate.posture,
      source: candidate.source,
    })),
    updatedAt: new Date(updatedAt),
  };
}

export function summarizeStormPreparedness(preparedness: PlaceStormPreparedness | null): string | null {
  if (!preparedness) return null;
  return [
    formatScenarioLabel(preparedness.scenario),
    formatPostureLabel(preparedness.posture),
    preparedness.detail,
  ].filter(Boolean).join(' · ');
}
