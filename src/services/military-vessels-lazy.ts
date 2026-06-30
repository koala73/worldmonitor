export type MilitaryVesselsModule = Pick<
  typeof import('@/services/military-vessels'),
  | 'fetchMilitaryVessels'
  | 'disconnectMilitaryVesselStream'
  | 'initMilitaryVesselStream'
  | 'isMilitaryVesselTrackingConfigured'
  | 'startVesselHistoryCleanup'
  | 'stopVesselHistoryCleanup'
>;

let militaryVesselsModulePromise: Promise<MilitaryVesselsModule> | null = null;
let militaryVesselsModule: MilitaryVesselsModule | null = null;
let vesselHistoryCleanupWanted = false;

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

export async function getMilitaryVesselsModule(): Promise<MilitaryVesselsModule> {
  vesselHistoryCleanupWanted = true;
  const module = await loadMilitaryVesselsModule();
  if (!vesselHistoryCleanupWanted) {
    stopLoadedVesselRuntime(module);
    throw new Error('Military vessel runtime stopped before lazy module finished loading');
  }
  module.startVesselHistoryCleanup();
  return module;
}

function stopLoadedVesselRuntime(module: MilitaryVesselsModule): void {
  module.stopVesselHistoryCleanup();
  module.disconnectMilitaryVesselStream();
}

export function stopLoadedVesselHistoryCleanup(): void {
  vesselHistoryCleanupWanted = false;
  if (militaryVesselsModule) {
    stopLoadedVesselRuntime(militaryVesselsModule);
    return;
  }
  void militaryVesselsModulePromise?.then((module) => {
    if (!vesselHistoryCleanupWanted) stopLoadedVesselRuntime(module);
  }).catch(() => {});
}
