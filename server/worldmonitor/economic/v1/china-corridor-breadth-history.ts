import type {
  ChinaCorridorControlTowerResponse,
  CorridorSourceSignal,
} from '../../../../shared/china-corridor-control-towers';
import {
  CHINA_CORRIDOR_SIGNAL_FAMILIES,
  type ChinaCorridorSignalFamily,
} from '../../../../shared/china-logistics-corridors';
import {
  CHINA_CORRIDOR_DIRECTIONAL_HISTORY_KEY as SHARED_HISTORY_KEY,
} from '../../../_shared/cache-keys';
import {
  prependCachedJsonList,
  readCachedJsonList,
  type CacheReadResult,
} from '../../../_shared/redis';

export const CHINA_CORRIDOR_DIRECTIONAL_HISTORY_KEY = SHARED_HISTORY_KEY;
export const CHINA_CORRIDOR_DIRECTIONAL_HISTORY_LIMIT = 16;
export const CHINA_CORRIDOR_DIRECTIONAL_HISTORY_TTL_SECONDS = 14 * 24 * 60 * 60;
/** Must match the corridor proxy's 72-hour freshness budget. */
export const CHINA_CORRIDOR_DIRECTIONAL_HISTORY_MAX_PRIOR_AGE_SECONDS = 72 * 60 * 60;

const CHINA_CORRIDOR_ACTIVITY_DIRECTIONS = [
  'strengthening',
  'weakening',
  'unchanged',
] as const;

type ChinaCorridorActivityDirection = (typeof CHINA_CORRIDOR_ACTIVITY_DIRECTIONS)[number];

export interface ChinaCorridorDirectionalSnapshot {
  schemaVersion: 3;
  generatedAt: string;
  corridorIds: string[];
  /** Canonical `<corridor-id>:<family>` membership used for comparability. */
  familyKeys: string[];
  /** Families with an explicit, fresh directional observation in this snapshot. */
  directionalFamilies: ChinaCorridorSignalFamily[];
  /** Stable `<corridor-id>:<family>:<selector-id>` coverage of directional inputs. */
  directionalSelectorKeys: string[];
  /** Families whose source-derived activity state is strengthening. */
  strengtheningFamilies: ChinaCorridorSignalFamily[];
  /** Families whose source-derived activity state is weakening. */
  weakeningFamilies: ChinaCorridorSignalFamily[];
}

export type ChinaCorridorBreadthExclusion =
  | 'comparable_prior_snapshot_not_available'
  | 'corridor_history_read_failed'
  | 'corridor_set_changed'
  | 'corridor_family_set_changed'
  | 'directional_family_set_changed'
  | 'directional_observation_set_changed'
  | 'directional_observations_not_available';

export interface ChinaCorridorBreadthComparison {
  value: number | null;
  priorValue: number | null;
  exclusion: ChinaCorridorBreadthExclusion | null;
}

export type ChinaCorridorDirectionalHistoryReader = (
  key: string,
  limit: number,
) => Promise<CacheReadResult>;

export type ChinaCorridorDirectionalHistoryWriter = (
  key: string,
  value: unknown,
  limit: number,
  ttlSeconds: number,
) => Promise<boolean>;

const validFamilies = new Set<string>(CHINA_CORRIDOR_SIGNAL_FAMILIES);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function canonicalTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const canonical = new Date(parsed).toISOString();
  return canonical === value ? canonical : null;
}

function canonicalStringSet(value: unknown, allowEmpty = false): string[] | null {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) return null;
  if (value.some((item) => typeof item !== 'string' || item.length === 0)) return null;
  const strings = value as string[];
  const canonical = [...new Set(strings)].sort();
  return canonical.length === strings.length
      && canonical.every((item, index) => item === strings[index])
    ? canonical
    : null;
}

function membershipForKey(
  key: string,
  corridorIds: readonly string[],
): { corridorId: string; family: string } | null {
  const corridorId = corridorIds.find((candidate) => key.startsWith(`${candidate}:`));
  if (corridorId === undefined) return null;
  const family = key.slice(corridorId.length + 1);
  return validFamilies.has(family) ? { corridorId, family } : null;
}

function directionalSelectorMembershipForKey(
  key: string,
  corridorIds: readonly string[],
): { corridorId: string; family: string } | null {
  const corridorId = corridorIds.find((candidate) => key.startsWith(`${candidate}:`));
  if (corridorId === undefined) return null;
  const remainder = key.slice(corridorId.length + 1);
  const family = CHINA_CORRIDOR_SIGNAL_FAMILIES.find((candidate) =>
    remainder.startsWith(`${candidate}:`));
  if (family === undefined || remainder.slice(family.length + 1).length === 0) return null;
  return { corridorId, family };
}

function parseSnapshot(value: unknown): ChinaCorridorDirectionalSnapshot | null {
  const candidate = record(value);
  if (candidate?.schemaVersion !== 3) return null;
  const generatedAt = canonicalTimestamp(candidate.generatedAt);
  const corridorIds = canonicalStringSet(candidate.corridorIds);
  const familyKeys = canonicalStringSet(candidate.familyKeys);
  const directionalFamilies = canonicalStringSet(candidate.directionalFamilies, true);
  const directionalSelectorKeys = canonicalStringSet(candidate.directionalSelectorKeys, true);
  const strengtheningFamilies = canonicalStringSet(candidate.strengtheningFamilies, true);
  const weakeningFamilies = canonicalStringSet(candidate.weakeningFamilies, true);
  if (
    generatedAt === null
    || corridorIds === null
    || familyKeys === null
    || directionalFamilies === null
    || directionalSelectorKeys === null
    || strengtheningFamilies === null
    || weakeningFamilies === null
  ) return null;

  const presentFamilies = new Set<string>();
  const corridorsWithFamilies = new Set<string>();
  for (const key of familyKeys) {
    const membership = membershipForKey(key, corridorIds);
    if (membership === null) return null;
    presentFamilies.add(membership.family);
    corridorsWithFamilies.add(membership.corridorId);
  }
  if (corridorsWithFamilies.size !== corridorIds.length) return null;
  if (directionalFamilies.some((family) => !presentFamilies.has(family))) return null;
  const directionalSet = new Set(directionalFamilies);
  const selectorFamilies = new Set<string>();
  for (const key of directionalSelectorKeys) {
    const membership = directionalSelectorMembershipForKey(key, corridorIds);
    if (membership === null || !directionalSet.has(membership.family)) return null;
    selectorFamilies.add(membership.family);
  }
  if (directionalFamilies.some((family) => !selectorFamilies.has(family))) return null;
  if (
    strengtheningFamilies.some((family) => !directionalSet.has(family))
    || weakeningFamilies.some((family) => !directionalSet.has(family))
    || weakeningFamilies.some((family) => strengtheningFamilies.includes(family))
  ) return null;

  return {
    schemaVersion: 3,
    generatedAt,
    corridorIds,
    familyKeys,
    directionalFamilies: directionalFamilies as ChinaCorridorSignalFamily[],
    directionalSelectorKeys,
    strengtheningFamilies: strengtheningFamilies as ChinaCorridorSignalFamily[],
    weakeningFamilies: weakeningFamilies as ChinaCorridorSignalFamily[],
  };
}

function finiteMetric(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

function nonEmptyMetric(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasDirectionalMetric(signal: CorridorSourceSignal): boolean {
  if (
    signal.availability !== 'available'
    || signal.transportFreshness !== 'fresh'
    || signal.contentFreshness !== 'current'
  ) return false;

  switch (signal.family) {
    case 'port':
      return finiteMetric(signal.metrics.trendDelta);
    case 'aviation':
      return signal.metrics.providerStatus === 'normal'
        || signal.metrics.providerStatus === 'disruption';
    case 'trade':
      return finiteMetric(signal.metrics.periodChangePct);
    case 'power_energy':
      return finiteMetric(signal.metrics.demandChangePercent)
        && nonEmptyMetric(signal.metrics.demandChangeBasis)
        && nonEmptyMetric(signal.metrics.demandChangeCurrentMonth)
        && canonicalTimestamp(signal.metrics.demandChangePeriodEnd) !== null;
    case 'hazard':
    case 'strategic_industry':
      return false;
  }
}

function activityDirection(value: number): ChinaCorridorActivityDirection {
  if (value > 0) return 'strengthening';
  if (value < 0) return 'weakening';
  return 'unchanged';
}

function averageMetric(
  signals: readonly CorridorSourceSignal[],
  metric: string,
): number | null {
  const values = signals
    .filter(hasDirectionalMetric)
    .map((signal) => signal.metrics[metric])
    .filter((value): value is number => finiteMetric(value));
  return values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function activityDirectionForFamily(
  family: ChinaCorridorSignalFamily,
  signals: readonly CorridorSourceSignal[],
): ChinaCorridorActivityDirection | null {
  const directionalSignals = signals.filter(hasDirectionalMetric);
  if (directionalSignals.length === 0) return null;

  switch (family) {
    case 'port': {
      const value = averageMetric(directionalSignals, 'trendDelta');
      return value === null ? null : activityDirection(value);
    }
    case 'aviation': {
      const normal = directionalSignals.filter((signal) =>
        signal.metrics.providerStatus === 'normal').length;
      const disruption = directionalSignals.filter((signal) =>
        signal.metrics.providerStatus === 'disruption').length;
      return activityDirection(normal - disruption);
    }
    case 'trade': {
      const value = averageMetric(directionalSignals, 'periodChangePct');
      return value === null ? null : activityDirection(value);
    }
    case 'power_energy': {
      const value = averageMetric(directionalSignals, 'demandChangePercent');
      return value === null ? null : activityDirection(value);
    }
    case 'hazard':
    case 'strategic_industry':
      return null;
  }
}

function signalsForFamily(
  response: ChinaCorridorControlTowerResponse,
  family: ChinaCorridorSignalFamily,
): CorridorSourceSignal[] {
  const byId = new Map<string, CorridorSourceSignal>();
  for (const corridor of response.corridors) {
    const condition = corridor.conditions.find((item) => item.family === family);
    for (const signal of condition?.sourceSignals ?? []) {
      if (!byId.has(signal.id)) byId.set(signal.id, signal);
    }
  }
  return [...byId.values()];
}

export function createChinaCorridorDirectionalSnapshot(
  response: ChinaCorridorControlTowerResponse,
): ChinaCorridorDirectionalSnapshot | null {
  const generatedAt = canonicalTimestamp(response.generatedAt);
  const corridorIds = [...new Set(response.corridors.map((corridor) => corridor.id))].sort();
  if (generatedAt === null || corridorIds.length === 0) return null;

  const familyKeys = [...new Set(response.corridors.flatMap((corridor) =>
    corridor.conditions.map((condition) => `${corridor.id}:${condition.family}`)))].sort();
  if (familyKeys.length === 0) return null;

  const directionalFamilies = CHINA_CORRIDOR_SIGNAL_FAMILIES
    .filter((family) => signalsForFamily(response, family).some(hasDirectionalMetric))
    .sort();
  const directionalSelectorKeys = [...new Set(response.corridors.flatMap((corridor) =>
    corridor.conditions.flatMap((condition) => condition.sourceSignals
      .filter(hasDirectionalMetric)
      .map((signal) => `${corridor.id}:${condition.family}:${signal.selectorId}`))))].sort();
  const strengtheningFamilies: ChinaCorridorSignalFamily[] = [];
  const weakeningFamilies: ChinaCorridorSignalFamily[] = [];
  for (const family of directionalFamilies) {
    const direction = activityDirectionForFamily(family, signalsForFamily(response, family));
    if (direction === 'strengthening') strengtheningFamilies.push(family);
    if (direction === 'weakening') weakeningFamilies.push(family);
  }

  return {
    schemaVersion: 3,
    generatedAt,
    corridorIds,
    familyKeys,
    directionalFamilies,
    directionalSelectorKeys,
    strengtheningFamilies,
    weakeningFamilies,
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function activityBreadthValue(snapshot: ChinaCorridorDirectionalSnapshot): number {
  return snapshot.strengtheningFamilies.length - snapshot.weakeningFamilies.length;
}

/**
 * Snapshots are comparable only when the prior is older, the reviewed corridor
 * and family membership is identical, and the stable directional observation
 * domain is identical. A missing or changed directional set is an exclusion,
 * never an implicit zero; no forward fill or interpolation is performed.
 */
export function compareChinaCorridorDirectionalSnapshots(
  current: ChinaCorridorDirectionalSnapshot,
  prior: ChinaCorridorDirectionalSnapshot | null,
): ChinaCorridorBreadthComparison {
  if (
    prior === null
    || Date.parse(prior.generatedAt) >= Date.parse(current.generatedAt)
  ) {
    return {
      value: null,
      priorValue: null,
      exclusion: 'comparable_prior_snapshot_not_available',
    };
  }
  if (!sameStrings(current.corridorIds, prior.corridorIds)) {
    return {
      value: null,
      priorValue: prior.directionalFamilies.length,
      exclusion: 'corridor_set_changed',
    };
  }
  if (!sameStrings(current.familyKeys, prior.familyKeys)) {
    return {
      value: null,
      priorValue: prior.directionalFamilies.length,
      exclusion: 'corridor_family_set_changed',
    };
  }
  if (
    current.directionalFamilies.length === 0
    || prior.directionalFamilies.length === 0
  ) {
    return {
      value: null,
      priorValue: prior.directionalFamilies.length,
      exclusion: 'directional_observations_not_available',
    };
  }
  if (!sameStrings(current.directionalFamilies, prior.directionalFamilies)) {
    return {
      value: null,
      priorValue: activityBreadthValue(prior),
      exclusion: 'directional_family_set_changed',
    };
  }
  if (!sameStrings(current.directionalSelectorKeys, prior.directionalSelectorKeys)) {
    return {
      value: null,
      priorValue: activityBreadthValue(prior),
      exclusion: 'directional_observation_set_changed',
    };
  }
  return {
    value: activityBreadthValue(current) - activityBreadthValue(prior),
    priorValue: activityBreadthValue(prior),
    exclusion: null,
  };
}

function normalizeHistory(value: unknown): ChinaCorridorDirectionalSnapshot[] {
  if (!Array.isArray(value)) return [];
  const byGeneratedAt = new Map<string, ChinaCorridorDirectionalSnapshot>();
  for (const item of value) {
    const parsed = parseSnapshot(item);
    if (parsed !== null && !byGeneratedAt.has(parsed.generatedAt)) {
      byGeneratedAt.set(parsed.generatedAt, parsed);
    }
  }
  return [...byGeneratedAt.values()]
    .sort((left, right) => Date.parse(right.generatedAt) - Date.parse(left.generatedAt))
    .slice(0, CHINA_CORRIDOR_DIRECTIONAL_HISTORY_LIMIT);
}

export function mergeChinaCorridorDirectionalHistory(
  current: ChinaCorridorDirectionalSnapshot,
  history: readonly ChinaCorridorDirectionalSnapshot[],
): ChinaCorridorDirectionalSnapshot[] {
  return normalizeHistory([current, ...history]);
}

export function selectPriorChinaCorridorDirectionalSnapshot(
  current: ChinaCorridorDirectionalSnapshot,
  history: readonly ChinaCorridorDirectionalSnapshot[],
): ChinaCorridorDirectionalSnapshot | null {
  const currentMs = Date.parse(current.generatedAt);
  if (!Number.isFinite(currentMs)) return null;
  const maxAgeMs = CHINA_CORRIDOR_DIRECTIONAL_HISTORY_MAX_PRIOR_AGE_SECONDS * 1000;
  return normalizeHistory(history).find((candidate) => {
    const candidateMs = Date.parse(candidate.generatedAt);
    return candidateMs < currentMs && currentMs - candidateMs <= maxAgeMs;
  }) ?? null;
}

export async function readChinaCorridorDirectionalHistory(
  read: ChinaCorridorDirectionalHistoryReader = readCachedJsonList,
): Promise<ChinaCorridorDirectionalSnapshot[]> {
  const result = await read(
    CHINA_CORRIDOR_DIRECTIONAL_HISTORY_KEY,
    CHINA_CORRIDOR_DIRECTIONAL_HISTORY_LIMIT,
  );
  if (result.status === 'error') throw result.error;
  return result.status === 'hit' ? normalizeHistory(result.value) : [];
}

export async function persistChinaCorridorDirectionalSnapshot(
  current: ChinaCorridorDirectionalSnapshot,
  write: ChinaCorridorDirectionalHistoryWriter = prependCachedJsonList,
): Promise<boolean> {
  try {
    return await write(
      CHINA_CORRIDOR_DIRECTIONAL_HISTORY_KEY,
      current,
      CHINA_CORRIDOR_DIRECTIONAL_HISTORY_LIMIT,
      CHINA_CORRIDOR_DIRECTIONAL_HISTORY_TTL_SECONDS,
    );
  } catch {
    return false;
  }
}
