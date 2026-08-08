import type { MilitaryBase } from '@/types';

let militaryBasesCache: MilitaryBase[] | null = null;
let militaryBasesPromise: Promise<MilitaryBase[]> | null = null;

export function getCachedMilitaryBases(): MilitaryBase[] {
  return militaryBasesCache ?? [];
}

export function preloadMilitaryBases(): Promise<MilitaryBase[]> {
  if (militaryBasesCache !== null) return Promise.resolve(militaryBasesCache);
  if (!militaryBasesPromise) {
    militaryBasesPromise = import('@/config/military-bases')
      .then(({ MILITARY_BASES }) => {
        militaryBasesCache = MILITARY_BASES;
        return MILITARY_BASES;
      })
      .catch((error) => {
        militaryBasesPromise = null;
        throw error;
      });
  }
  return militaryBasesPromise;
}
