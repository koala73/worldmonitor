/** [knot threshold, rgba] — first match wins (highest threshold first) */
export const TC_WIND_COLORS: ReadonlyArray<[number, [number, number, number, number]]> = [
  [137, [255, 96, 96, 200]],    // Cat5
  [113, [255, 140, 0, 200]],    // Cat4
  [96,  [255, 140, 0, 200]],    // Cat3
  [83,  [255, 231, 117, 200]],  // Cat2
  [64,  [255, 231, 117, 200]],  // Cat1
  [34,  [94, 186, 255, 200]],   // TS
  [0,   [160, 160, 160, 160]],  // TD
];

export function getWindColor(kt: number): [number, number, number, number] {
  for (const [threshold, color] of TC_WIND_COLORS) {
    if (kt >= threshold) return color;
  }
  return [160, 160, 160, 160];
}
