export type MilitaryBaseType = 'us-nato' | 'russia' | 'china' | 'uk' | 'france' | 'india' | 'japan';

export function getMilitaryBaseColor(type: string, alpha: number): [number, number, number, number] {
  switch (type) {
    case 'us-nato': return [68, 136, 255, alpha];
    case 'russia':  return [255, 68, 68, alpha];
    case 'china':   return [255, 136, 68, alpha];
    case 'uk':      return [68, 170, 255, alpha];
    case 'france':  return [0, 85, 164, alpha];
    case 'india':   return [255, 153, 51, alpha];
    case 'japan':   return [188, 0, 45, alpha];
    default:        return [136, 136, 136, alpha];
  }
}
