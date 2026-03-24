import type {
  ForecastServiceHandler,
  ServerContext,
  GetSimulationPackageRequest,
  GetSimulationPackageResponse,
} from '../../../../src/generated/server/worldmonitor/forecast/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';

const SIMULATION_PACKAGE_LATEST_KEY = 'forecast:simulation-package:latest';

interface SimulationPackagePointer {
  runId: string;
  pkgKey: string;
  schemaVersion: string;
  theaterCount: number;
  generatedAt: number;
}

export const getSimulationPackage: ForecastServiceHandler['getSimulationPackage'] = async (
  _ctx: ServerContext,
  _req: GetSimulationPackageRequest,
): Promise<GetSimulationPackageResponse> => {
  try {
    const pointer = await getCachedJson(SIMULATION_PACKAGE_LATEST_KEY) as SimulationPackagePointer | null;
    if (!pointer?.pkgKey) {
      return { found: false, runId: '', pkgKey: '', schemaVersion: '', theaterCount: 0, generatedAt: 0 };
    }
    return {
      found: true,
      runId: pointer.runId || '',
      pkgKey: pointer.pkgKey,
      schemaVersion: pointer.schemaVersion || '',
      theaterCount: pointer.theaterCount || 0,
      generatedAt: pointer.generatedAt || 0,
    };
  } catch {
    return { found: false, runId: '', pkgKey: '', schemaVersion: '', theaterCount: 0, generatedAt: 0 };
  }
};
