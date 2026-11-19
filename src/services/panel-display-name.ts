import { VARIANT_PANEL_OVERRIDES } from '@/config/panels';
import { SITE_VARIANT } from '@/config/variant';
import { t } from '@/services/i18n';

function translated(lookup: string): string | null {
  const value = t(lookup);
  return value === lookup ? null : value;
}

/**
 * The name a panel shows in its header, the Settings panel list and the
 * search command deck. A variant rename in VARIANT_PANEL_OVERRIDES wins over
 * the generic `panels.<key>` string, so all three surfaces agree.
 */
export function getPanelDisplayName(panelKey: string, fallback: string = panelKey, variant: string = SITE_VARIANT): string {
  if (panelKey === 'runtime-config') return t('modals.runtimeConfig.title');
  const camelKey = panelKey.replace(/-([a-z])/g, (_match, group: string) => group.toUpperCase());
  const overrideName = VARIANT_PANEL_OVERRIDES[variant]?.[panelKey]?.name;
  if (overrideName) return translated(`panelVariants.${variant}.${camelKey}`) ?? overrideName;
  return translated(`panels.${camelKey}`) ?? fallback;
}
