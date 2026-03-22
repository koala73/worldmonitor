/**
 * Marker Tier System
 *
 * Calculates visual tier (1/2/3) for map markers based on facility size/importance.
 * Tier 1 = largest/most important, Tier 3 = smallest/emerging
 */

export type MarkerTier = 1 | 2 | 3;

/**
 * Tier configuration for marker radius
 * Returns [baseRadius, minPixels, maxPixels]
 */
export function getTierRadius(tier: MarkerTier): [number, number, number] {
  switch (tier) {
    case 1:
      return [28000, 12, 24]; // Large
    case 2:
      return [20000, 9, 18]; // Medium
    case 3:
      return [14000, 6, 12]; // Small
  }
}

/**
 * Calculate tier for semiconductor hub based on employees
 */
export function getSemiconductorTier(employees: number): MarkerTier {
  if (employees >= 2000) return 1;
  if (employees >= 500) return 2;
  return 3;
}

/**
 * Calculate tier for data center based on operator
 */
export function getDataCenterTier(operator: string): MarkerTier {
  // Tier 1: Hyperscale cloud providers
  if (['Google Cloud', 'Meta (Facebook)', 'Amazon Web Services'].some((p) => operator.includes(p) || p.includes(operator))) {
    return 1;
  }
  // Tier 2: Enterprise cloud providers
  if (['Microsoft', 'Equinix'].some((p) => operator.includes(p))) {
    return 2;
  }
  // Tier 3: Others
  return 3;
}

/**
 * Calculate tier for tech HQ based on employees
 */
export function getTechHQTier(employees: number | undefined): MarkerTier {
  if (!employees) return 3;
  if (employees >= 3000) return 1;
  if (employees >= 1000) return 2;
  return 3;
}

/**
 * Calculate tier for Irish unicorn based on category
 */
export function getUnicornTier(category: 'unicorn' | 'high-growth' | 'emerging'): MarkerTier {
  switch (category) {
    case 'unicorn':
      return 1;
    case 'high-growth':
      return 2;
    case 'emerging':
      return 3;
  }
}

/**
 * Adjust color brightness based on tier
 * Returns RGBA array for deck.gl
 */
export function getTierColor(baseColor: [number, number, number], tier: MarkerTier): [number, number, number, number] {
  const alphas: Record<MarkerTier, number> = {
    1: 255,
    2: 220,
    3: 180,
  };

  // For tier 2/3, lighten the color slightly
  const lightenFactor: Record<MarkerTier, number> = {
    1: 0,
    2: 20,
    3: 40,
  };

  const lighten = lightenFactor[tier];
  return [
    Math.min(255, baseColor[0] + lighten),
    Math.min(255, baseColor[1] + lighten),
    Math.min(255, baseColor[2] + lighten),
    alphas[tier],
  ];
}
