import { PANEL_CATEGORY_MAP } from '@/config/panels';
import type { PanelConfig } from '@/types';

export interface OpenEyeTab {
  key: string;
  /** i18n key for category-derived tabs; resolved with t() at render time. */
  labelKey?: string;
  /** Fixed label for the synthetic MAP / LIVE / MORE tabs. */
  label?: string;
  panelKeys: string[];
}

/**
 * The map's settings key. It is not a grid panel — `applyPanelSettings`
 * routes it to `#mapSection` — so a tab carrying it shows the map section
 * and no grid panels at all, which is exactly what the MAP tab wants.
 */
export const MAP_PANEL_KEY = 'map';

/**
 * Continuous video and news feeds.
 *
 * These are the three panels that never stop moving: rolling news video,
 * webcam mosaics, weather cams. Mixed into a reading surface they dominate
 * it, so they get a section of their own.
 */
export const LIVE_PANEL_KEYS = ['live-news', 'live-webcams', 'windy-webcams'] as const;

/**
 * Where the remaining `core` panels live now that there is no HOME tab.
 *
 * `core` is a settings-and-mobile-nav grouping, not a subject: it means
 * "on by default in every variant", which is why the map, three video feeds
 * and four analysis panels share it. Once the map has its own tab and the
 * feeds have theirs, what is left is four analysis panels with nothing in
 * common except that flag — a tab built from them would be a leftovers
 * drawer with a nice name.
 *
 * So they are adopted by the category they actually belong to. A panel whose
 * category does not apply to the active variant (`intelligence` is
 * full-only) falls through to MORE, which exists for exactly that case.
 */
export const CORE_PANEL_HOMES: Readonly<Record<string, string>> = {
  insights: 'intelligence',
  'strategic-posture': 'intelligence',
  'latest-brief': 'intelligence',
  'bloc-alignment': 'intelligence',
};

/**
 * Tab model for the AALICE:OpenEYE desktop layout (fork-side, AMD-003).
 *
 * MAP is first and is where the app opens. It is the product: a
 * photorealistic globe carrying every tracker, and the thing a mission
 * console is for. Everything else is a section you go to.
 *
 * Structure is decided here rather than in PANEL_CATEGORY_MAP because that
 * map also drives the settings panel list and MobilePanelNav's categories,
 * and neither should be reorganised to suit a desktop-only tab bar.
 *
 * Membership lists only contain enabled panels — the tab bar's visibility
 * filter composes with Panel.toggle()'s `.hidden`, same contract as
 * MobilePanelNav.
 */
export function buildOpenEyeTabs(
  panelSettings: Record<string, PanelConfig>,
  variant: string,
): OpenEyeTab[] {
  const enabled = (k: string): boolean => panelSettings[k]?.enabled === true;

  const core = PANEL_CATEGORY_MAP.core?.panelKeys ?? [];
  const live = new Set<string>(LIVE_PANEL_KEYS);

  const tabs: OpenEyeTab[] = [];

  // The map opens the app. It disappears only if the map itself is switched
  // off in settings — a tab onto nothing is worse than one fewer tab.
  if (enabled(MAP_PANEL_KEY)) {
    tabs.push({ key: 'map', label: 'MAP', panelKeys: [MAP_PANEL_KEY] });
  }

  const liveKeys = core.filter((k) => live.has(k)).filter(enabled);
  if (liveKeys.length > 0) {
    tabs.push({ key: 'live', label: 'LIVE', panelKeys: liveKeys });
  }

  // Categories that apply to this variant, populated or not: an adopted core
  // panel is allowed to be the reason a category tab appears at all.
  const applicable = Object.entries(PANEL_CATEGORY_MAP)
    .filter(([key, def]) => key !== 'core'
      && (!def.variants || def.variants.includes(variant)));
  const applicableKeys = new Set(applicable.map(([key]) => key));

  const adopted = new Map<string, string[]>();
  const homeless: string[] = [];
  for (const key of core) {
    if (key === MAP_PANEL_KEY || live.has(key) || !enabled(key)) continue;
    const home = CORE_PANEL_HOMES[key];
    if (home && applicableKeys.has(home)) {
      const bucket = adopted.get(home);
      if (bucket) bucket.push(key);
      else adopted.set(home, [key]);
    } else {
      homeless.push(key);
    }
  }

  for (const [key, def] of applicable) {
    // Adopted panels lead: they were the app's front page a moment ago, and
    // burying them under a long category list would be a demotion nobody
    // asked for.
    const panelKeys = [...(adopted.get(key) ?? []), ...def.panelKeys.filter(enabled)];
    if (panelKeys.length > 0) tabs.push({ key, labelKey: def.labelKey, panelKeys });
  }

  // Enabled panels that belong to no applicable category — custom widgets,
  // MCP panels, and any core panel whose category this variant lacks.
  const categorized = new Set<string>(core);
  for (const def of Object.values(PANEL_CATEGORY_MAP)) {
    if (def.variants && !def.variants.includes(variant)) continue;
    for (const k of def.panelKeys) categorized.add(k);
  }
  const leftovers = [
    ...homeless,
    ...Object.keys(panelSettings).filter((k) => enabled(k) && !categorized.has(k)),
  ];
  if (leftovers.length > 0) tabs.push({ key: 'more', label: 'MORE', panelKeys: leftovers });

  return tabs;
}
