import { getCachedJson } from '../../../_shared/redis';
import { SCORECARD_INPUT_REGISTRY_VERSION } from './_input-registry';
import { SCORECARD_METHODOLOGY_VERSION } from './_methodology';
import { FIVE_FACTOR_SCORECARD_KEY } from './_snapshot';
import { SCORECARD_SNAPSHOT_SCHEMA_VERSION, type FiveFactorSnapshotV1 } from './_types';

export type ScorecardSnapshotReader = () => Promise<unknown>;

export async function readFiveFactorSnapshot(): Promise<unknown> {
  return getCachedJson(FIVE_FACTOR_SCORECARD_KEY, true);
}

export function asFiveFactorSnapshot(value: unknown): FiveFactorSnapshotV1 | null {
  const snapshot = value as Partial<FiveFactorSnapshotV1> | null;
  if (
    !snapshot
    || snapshot.schemaVersion !== SCORECARD_SNAPSHOT_SCHEMA_VERSION
    || snapshot.methodologyVersion !== SCORECARD_METHODOLOGY_VERSION
    || snapshot.inputRegistryVersion !== SCORECARD_INPUT_REGISTRY_VERSION
    || typeof snapshot.computedAt !== 'string'
    || !snapshot.countries
    || typeof snapshot.countries !== 'object'
  ) return null;
  return snapshot as FiveFactorSnapshotV1;
}
