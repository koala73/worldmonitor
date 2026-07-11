import { PANEL_CATEGORY_MAP, getVariantPanelCategories } from '@/config/panels';
import type { PanelConfig } from '@/types';

export interface OpenEyeTab {
  key: string;
  /** i18n key for category-derived tabs; resolved with t() at render time. */
  labelKey?: string;
  /** Fixed label for the synthetic WORLD / MORE tabs. */
  label?: string;
  panelKeys: string[];
}

/**
 * Tab model for the AALICE:OpenEYE desktop layout (fork-side, AMD-003).
 *
 * WORLD carries the map plus the `core` category; every other category of the
 * active variant with at least one enabled panel becomes a section tab; enabled
 * panels that belong to no applicable category (custom widgets, MCP panels)
 * are collected into MORE. Membership lists only contain enabled panels — the
 * tab bar's visibility filter composes with Panel.toggle()'s `.hidden`, same
 * contract as MobilePanelNav.
 */
export function buildOpenEyeTabs(
  panelSettings: Record<string, PanelConfig>,
  variant: string,
): OpenEyeTab[] {
  const enabled = (k: string): boolean => panelSettings[k]?.enabled === true;

  const core = PANEL_CATEGORY_MAP.core?.panelKeys ?? [];
  const world: OpenEyeTab = { key: 'world', label: 'WORLD', panelKeys: core.filter(enabled) };

  const sections = getVariantPanelCategories(panelSettings, variant)
    .filter((c) => c.key !== 'core')
    .map((c) => ({ key: c.key, labelKey: c.labelKey, panelKeys: c.panelKeys.filter(enabled) }));

  const categorized = new Set<string>(core);
  for (const def of Object.values(PANEL_CATEGORY_MAP)) {
    if (def.variants && !def.variants.includes(variant)) continue;
    for (const k of def.panelKeys) categorized.add(k);
  }
  const leftovers = Object.keys(panelSettings).filter((k) => enabled(k) && !categorized.has(k));

  const tabs = [world, ...sections];
  if (leftovers.length > 0) tabs.push({ key: 'more', label: 'MORE', panelKeys: leftovers });
  return tabs;
}
