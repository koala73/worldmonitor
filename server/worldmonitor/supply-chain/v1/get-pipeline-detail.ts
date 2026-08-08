import { getCachedJson } from '../../../_shared/redis';
import { PIPELINES_GAS_KEY, PIPELINES_OIL_KEY } from '../../../_shared/cache-keys';
import type {
  GetPipelineDetailRequest,
  GetPipelineDetailResponse,
  PipelineEntry,
} from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';
import { projectPipeline } from './list-pipelines';
import { pickNewerIsoTimestamp } from '../../../../src/shared/pipeline-evidence';

interface RawRegistry {
  updatedAt?: string;
  pipelines?: Record<string, unknown>;
}

/**
 * Returns one pipeline + its revision log, loaded lazily when the user opens
 * the asset-detail drawer. Revisions come from a separate Redis key (future
 * work — empty array for now until the auto-revision log is wired in Week 3).
 *
 * Falls back to a scan across BOTH registries because pipeline IDs are
 * globally unique (enforced by tests/pipelines-registry.test.mts).
 */
export async function getPipelineDetail(
  _ctx: unknown,
  req: GetPipelineDetailRequest,
): Promise<GetPipelineDetailResponse> {
  if (!req.pipelineId || req.pipelineId.length === 0) {
    return {
      pipeline: undefined,
      revisions: [],
      fetchedAt: new Date().toISOString(),
      unavailable: true,
    };
  }

  const [gasRaw, oilRaw] = await Promise.all([
    getCachedJson(PIPELINES_GAS_KEY) as Promise<RawRegistry | null>,
    getCachedJson(PIPELINES_OIL_KEY) as Promise<RawRegistry | null>,
  ]);

  const raw = gasRaw?.pipelines?.[req.pipelineId] ?? oilRaw?.pipelines?.[req.pipelineId];
  if (!raw) {
    return {
      pipeline: undefined,
      revisions: [],
      fetchedAt: new Date().toISOString(),
      unavailable: true,
    };
  }

  const pipeline: PipelineEntry | null = projectPipeline(raw);
  if (!pipeline) {
    return {
      pipeline: undefined,
      revisions: [],
      fetchedAt: new Date().toISOString(),
      unavailable: true,
    };
  }

  return {
    pipeline,
    // Revision log arrives in Week 3 alongside the disruption-event log;
    // see §13 of docs/internal/global-energy-flow-parity-and-surpass.md.
    revisions: [],
    // Gas and oil seeders cron independently; report the newer cycle's
    // timestamp rather than always preferring gas.
    fetchedAt: pickNewerIsoTimestamp(gasRaw?.updatedAt, oilRaw?.updatedAt) || new Date().toISOString(),
    unavailable: false,
  };
}
