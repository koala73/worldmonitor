export type CiiComponentKey = 'unrest' | 'conflict' | 'security' | 'information';

export interface CiiComponentEntry {
  key: CiiComponentKey;
  value: number;
}

const CII_COMPONENT_ORDER: readonly CiiComponentKey[] = ['unrest', 'conflict', 'security', 'information'];

/**
 * The CII components a surface may show, in display order. Every surface reads
 * components through this function.
 *
 * CII v15 scores no Security input, so the Security component is always 0. A 0
 * there would read as "no military activity" for a country at war, so it is left
 * out rather than shown. The wire field stays, and a positive value (a payload
 * scored by an older formula) still displays.
 */
export function displayedCiiComponents(components: Record<CiiComponentKey, number>): CiiComponentEntry[] {
  return CII_COMPONENT_ORDER
    .filter((key) => key !== 'security' || components.security > 0)
    .map((key) => ({ key, value: components[key] }));
}
