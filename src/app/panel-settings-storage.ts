import type { PanelConfig } from '@/types';

export interface DynamicPanelSetting {
  id: string;
  name: string;
  priority?: number;
}

export interface PanelSettingsNormalizationOptions {
  allPanels: Record<string, PanelConfig>;
  variant: string;
  variantDefaults: Record<string, string[]>;
  getPanelConfig: (key: string, variant: string) => PanelConfig;
}

export function normalizeStoredPanelSettings(
  stored: Record<string, PanelConfig> | null | undefined,
  dynamicPanels: DynamicPanelSetting[] = [],
  options: PanelSettingsNormalizationOptions,
): Record<string, PanelConfig> {
  const settings: Record<string, PanelConfig> = {};
  for (const [key, config] of Object.entries(stored ?? {})) {
    settings[key] = { ...config };
  }

  const variantDefaults = new Set(options.variantDefaults[options.variant] ?? []);
  for (const key of Object.keys(options.allPanels)) {
    if (key in settings) continue;
    const config = options.getPanelConfig(key, options.variant);
    settings[key] = {
      ...config,
      enabled: variantDefaults.has(key) && config.enabled,
    };
  }

  for (const panel of dynamicPanels) {
    if (panel.id in settings) continue;
    settings[panel.id] = {
      name: panel.name,
      enabled: true,
      priority: panel.priority ?? 3,
    };
  }

  return settings;
}
