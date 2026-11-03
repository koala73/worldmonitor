export type { MilitaryBaseType } from '@/types';

export function getMilitaryBaseColor(type: string, alpha: number): [number, number, number, number] {
  switch (type) {
    case 'us-nato': return [68, 136, 255, alpha];
    case 'russia':  return [255, 68, 68, alpha];
    case 'china':   return [255, 136, 68, alpha];
    case 'uk':      return [68, 170, 255, alpha];
    case 'france':  return [0, 85, 164, alpha];
    case 'india':   return [255, 153, 51, alpha];
    case 'japan':   return [188, 0, 45, alpha];
    case 'italy':   return [0, 146, 70, alpha];
    case 'uae':     return [0, 115, 94, alpha];
    case 'turkey':  return [227, 10, 23, alpha];
    default:        return [136, 136, 136, alpha];
  }
}
