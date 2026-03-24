import type {
  ForecastServiceHandler,
  ServerContext,
  GetSimulationPackageRequest,
  GetSimulationPackageResponse,
} from '../../../../src/generated/server/worldmonitor/forecast/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';

const SIMULATION_PACKAGE_LATEST_KEY = 'forecast:simulation-package:latest';

const NOT_FOUND: GetSimulationPackageResponse = {
  found: false, runId: '', pkgKey: '', schemaVersion: '', theaterCount: 0, generatedAt: 0, note: '', error: '',
};

export const getSimulationPackage: ForecastServiceHandler['getSimulationPackage'] = async (
  _ctx: ServerContext,
  req: GetSimulationPackageRequest,
): Promise<GetSimulationPackageResponse> => {
  try {
    const pointer = await getCachedJson(SIMULATION_PACKAGE_LATEST_KEY) as {
      runId: string; pkgKey: string; schemaVersion: string; theaterCount: number; generatedAt: number;
    } | null;
    if (!pointer?.pkgKey) return NOT_FOUND;
    const note = req.runId && req.runId !== pointer.runId
      ? 'runId filter not yet active; returned package may differ from requested run'
      : '';
    return { found: true, runId: pointer.runId, pkgKey: pointer.pkgKey, schemaVersion: pointer.schemaVersion, theaterCount: pointer.theaterCount, generatedAt: pointer.generatedAt, note, error: '' };
  } catch (err) {
    console.warn('[getSimulationPackage] Redis error:', err instanceof Error ? err.message : String(err));
    return { ...NOT_FOUND, error: 'redis_unavailable' };
  }
};
