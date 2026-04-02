export function getMineralColor(mineral: string): [number, number, number, number] {
  switch (mineral) {
    case 'Gold':        return [255, 215, 0, 210];
    case 'Silver':      return [192, 192, 192, 200];
    case 'Copper':      return [184, 115, 51, 210];
    case 'Lithium':     return [0, 200, 255, 200];
    case 'Cobalt':      return [100, 100, 255, 200];
    case 'Rare Earths': return [255, 100, 200, 200];
    case 'Nickel':      return [100, 220, 100, 200];
    case 'Platinum':    return [210, 210, 255, 200];
    case 'Palladium':   return [180, 220, 180, 200];
    case 'Iron Ore':    return [139, 69, 19, 210];
    case 'Uranium':     return [50, 255, 80, 200];
    case 'Coal':        return [80, 80, 80, 200];
    default:            return [200, 200, 200, 200];
  }
}
