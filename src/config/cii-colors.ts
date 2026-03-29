export type CiiLevel = 'low' | 'normal' | 'elevated' | 'high' | 'critical';

export const CII_LEVEL_COLORS: Record<CiiLevel, [number, number, number, number]> = {
  low:      [40, 180, 60, 130],
  normal:   [220, 200, 50, 135],
  elevated: [240, 140, 30, 145],
  high:     [220, 50, 20, 155],
  critical: [140, 10, 0, 170],
};
