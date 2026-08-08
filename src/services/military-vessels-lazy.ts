export type MilitaryVesselsModule = Pick<
  typeof import('@/services/military-vessels'),
  | 'fetchMilitaryVessels'
  | 'disconnectMilitaryVesselStream'
  | 'initMilitaryVesselStream'
  | 'isMilitaryVesselTrackingConfigured'
  | 'startVesselHistoryCleanup'
  | 'stopVesselHistoryCleanup'
>;

/**
 * Raised by getMilitaryVesselsModule() when the lazy vessel runtime is torn
 * down (App.destroy) while the module load is in flight, or when a vessel call
 * lands after teardown. This is a deliberate cancellation — not a real fetch
 * failure — so callers should treat it as benign and skip error logging /
 * freshness error recording.
 */
export class VesselRuntimeStoppedError extends Error {
  constructor() {
    super('Military vessel runtime stopped before lazy module finished loading');
    this.name = 'VesselRuntimeStoppedError';
  }
}

export function isVesselRuntimeStoppedError(error: unknown): error is VesselRuntimeStoppedError {
  return error instanceof VesselRuntimeStoppedError;
}

let militaryVesselsModulePromise: Promise<MilitaryVesselsModule> | null = null;
let militaryVesselsModule: MilitaryVesselsModule | null = null;
// The vessel runtime is gated on the App lifecycle: App.boot() arms it via
// enableVesselRuntime() and App.destroy() disarms it via
// stopLoadedVesselHistoryCleanup(). Defaults to enabled so any non-App caller
// still works out of the box.
let vesselRuntimeEnabled = true;
// Bumped on every teardown. A load initiated in an earlier generation captures
// the epoch at call time and rejects after its await if the generation moved
// on, so a destroy (or destroy + re-init) that straddles an in-flight import
// cannot arm a runtime owned by a disposed App.
let vesselRuntimeEpoch = 0;

function loadMilitaryVesselsModule(): Promise<MilitaryVesselsModule> {
  militaryVesselsModulePromise ??= import('@/services/military-vessels')
    .then((module) => {
      militaryVesselsModule = module;
      return module;
    })
    .catch((err) => {
      militaryVesselsModulePromise = null;
      throw err;
    });
  return militaryVesselsModulePromise;
}

export function enableVesselRuntime(): void {
  vesselRuntimeEnabled = true;
}

export async function getMilitaryVesselsModule(): Promise<MilitaryVesselsModule> {
  const epoch = vesselRuntimeEpoch;
  const module = await loadMilitaryVesselsModule();
  // Teardown during the import (epoch moved) or after it (runtime disabled)
  // means this load is orphaned. Stop anything the module's eval-time
  // self-start may have armed and surface a typed cancellation instead of
  // arming a runtime no App owns.
  if (!vesselRuntimeEnabled || epoch !== vesselRuntimeEpoch) {
    stopLoadedVesselRuntime(module);
    throw new VesselRuntimeStoppedError();
  }
  module.startVesselHistoryCleanup();
  return module;
}

function stopLoadedVesselRuntime(module: MilitaryVesselsModule): void {
  module.stopVesselHistoryCleanup();
  module.disconnectMilitaryVesselStream();
}

export function stopLoadedVesselHistoryCleanup(): void {
  vesselRuntimeEnabled = false;
  vesselRuntimeEpoch++;
  // Any in-flight getMilitaryVesselsModule() awaits the same module promise and
  // will observe the disabled flag / bumped epoch once it resolves, tearing
  // itself down. We only need to stop the runtime here when the module has
  // already finished loading.
  if (militaryVesselsModule) {
    stopLoadedVesselRuntime(militaryVesselsModule);
  }
}
