import {
  ALL_PANELS,
  PANEL_CATEGORY_MAP,
  VARIANT_DEFAULTS,
  getEffectivePanelConfig,
} from '@/config/panels';
import { SITE_VARIANTS, isSiteVariant, type SiteVariant } from '@/config/variant';
import type { PanelConfig } from '@/types';
import { DASHBOARD_PANEL_ACTION_ID_PATTERN } from '../../shared/agent-bus-contract';

export const DASHBOARD_PANEL_CATALOG_DEFAULT_LIMIT = 6;
export const DASHBOARD_PANEL_CATALOG_MAX_LIMIT = 8;
export const DASHBOARD_PANEL_CATALOG_OUTPUT_TARGET_CHARS = 1_400;
export const DASHBOARD_PANEL_ID_MAX_CHARS = 96;
export const DASHBOARD_PANEL_LABEL_MAX_CHARS = 80;
export const DASHBOARD_PANEL_CATEGORY_MAX_CHARS = 64;
export const DASHBOARD_PANEL_ID_PATTERN = DASHBOARD_PANEL_ACTION_ID_PATTERN;

const PANEL_ID_RE = new RegExp(DASHBOARD_PANEL_ID_PATTERN);
const CATEGORY_KEY_RE = /^[a-z][a-zA-Z0-9]*$/;
const CANONICAL_PANEL_IDS = Object.freeze(
  Object.keys(ALL_PANELS)
    .filter((panelId) => !panelId.startsWith('cw-') && !panelId.startsWith('mcp-'))
    .sort((left, right) => left.localeCompare(right, 'en')),
);
const CANONICAL_PANEL_ID_SET = new Set(CANONICAL_PANEL_IDS);
const PANEL_CATEGORY_KEYS = Object.freeze(Object.keys(PANEL_CATEGORY_MAP));
const PANEL_CATEGORY_KEY_SET = new Set<string>([...PANEL_CATEGORY_KEYS, 'other']);
const VARIANT_PANEL_IDS = Object.freeze(
  Object.fromEntries(
    SITE_VARIANTS.map((variant) => [
      variant,
      Object.freeze(
        [...(VARIANT_DEFAULTS[variant] ?? [])]
          .filter((panelId) => CANONICAL_PANEL_ID_SET.has(panelId))
          .sort((left, right) => left.localeCompare(right, 'en')),
      ),
    ]),
  ),
) as Readonly<Record<SiteVariant, readonly string[]>>;
const VARIANT_PANEL_ID_SETS: Readonly<Record<SiteVariant, ReadonlySet<string>>> = Object.freeze(
  Object.fromEntries(
    SITE_VARIANTS.map((variant) => [variant, new Set(VARIANT_PANEL_IDS[variant])]),
  ) as Record<SiteVariant, Set<string>>,
);
const PANEL_VARIANT_AVAILABILITY = Object.freeze(
  Object.fromEntries(
    CANONICAL_PANEL_IDS.map((panelId) => [
      panelId,
      Object.freeze(
        SITE_VARIANTS.filter((variant) => VARIANT_PANEL_ID_SETS[variant].has(panelId)),
      ),
    ]),
  ),
) as Readonly<Record<string, readonly SiteVariant[]>>;

export const DASHBOARD_PANEL_CATALOG_CATEGORY_KEYS = Object.freeze(
  [...PANEL_CATEGORY_KEYS, 'other'],
);

export type DashboardPanelUnavailableReason =
  | 'panel_not_entitled'
  | 'panel_disabled'
  | 'panel_not_live';

export type DashboardPanelCatalogErrorReason =
  | 'malformed_arguments'
  | 'invalid_variant'
  | 'invalid_category'
  | 'invalid_cursor'
  | 'invalid_limit';

export interface DashboardPanelCatalogItem {
  id: string;
  label: string;
  category: string;
  variants: readonly string[];
  enabled: boolean;
  mounted: boolean;
  entitled: boolean;
  available: boolean;
  unavailableReason?: DashboardPanelUnavailableReason;
}

export interface DashboardPanelCatalogQuery {
  variant?: string;
  category?: string;
  enabled?: boolean;
  available?: boolean;
  cursor?: string;
  limit?: number;
}

export interface DashboardPanelCatalogPage {
  variant: string;
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
  panels: DashboardPanelCatalogItem[];
}

export interface DashboardPanelCatalogLiveState {
  currentVariant: string;
  panelSettings: Record<string, PanelConfig>;
  mountedIds: ReadonlySet<string>;
  isPanelAllowed: (panelId: string, config: PanelConfig) => boolean;
}

export class DashboardPanelCatalogError extends Error {
  public constructor(
    public readonly reason: DashboardPanelCatalogErrorReason,
    message: string,
  ) {
    super(message);
    this.name = 'DashboardPanelCatalogError';
  }
}

export function getCanonicalDashboardPanelIds(variant?: string): readonly string[] {
  if (variant === undefined) return CANONICAL_PANEL_IDS;
  if (!isSiteVariant(variant)) return [];
  return VARIANT_PANEL_IDS[variant];
}

export function getDashboardPanelCategoryKey(panelId: string, variant: string): string {
  for (const [key, definition] of Object.entries(PANEL_CATEGORY_MAP)) {
    if (definition.variants && !definition.variants.includes(variant)) continue;
    if (definition.panelKeys.includes(panelId)) return key;
  }
  for (const [key, definition] of Object.entries(PANEL_CATEGORY_MAP)) {
    if (definition.panelKeys.includes(panelId)) return key;
  }
  return 'other';
}

export function listDashboardPanelCatalog(
  live: DashboardPanelCatalogLiveState,
  query: DashboardPanelCatalogQuery = {},
): DashboardPanelCatalogPage {
  const currentVariant = live.currentVariant;
  if (!isSiteVariant(currentVariant)) {
    throw new DashboardPanelCatalogError(
      'invalid_variant',
      'variant must be one of: full, tech, finance, commodity, energy, happy.',
    );
  }

  const variantFilter = query.variant;
  if (variantFilter !== undefined) {
    if (typeof variantFilter !== 'string' || !isSiteVariant(variantFilter)) {
      throw new DashboardPanelCatalogError(
        'invalid_variant',
        'variant must be one of: full, tech, finance, commodity, energy, happy.',
      );
    }
  }

  const categoryFilter = query.category;
  if (categoryFilter !== undefined) {
    if (
      typeof categoryFilter !== 'string'
      || !CATEGORY_KEY_RE.test(categoryFilter)
      || !PANEL_CATEGORY_KEY_SET.has(categoryFilter)
    ) {
      throw new DashboardPanelCatalogError(
        'invalid_category',
        'category must be a known panel category key.',
      );
    }
  }

  if (query.enabled !== undefined && typeof query.enabled !== 'boolean') {
    throw new DashboardPanelCatalogError(
      'malformed_arguments',
      'enabled must be a boolean.',
    );
  }
  if (query.available !== undefined && typeof query.available !== 'boolean') {
    throw new DashboardPanelCatalogError(
      'malformed_arguments',
      'available must be a boolean.',
    );
  }

  const cursor = query.cursor;
  if (cursor !== undefined) {
    if (
      typeof cursor !== 'string'
      || cursor.length > DASHBOARD_PANEL_ID_MAX_CHARS
      || !PANEL_ID_RE.test(cursor)
      || !CANONICAL_PANEL_ID_SET.has(cursor)
    ) {
      throw new DashboardPanelCatalogError(
        'invalid_cursor',
        'cursor is not a valid catalog cursor.',
      );
    }
  }

  const limit = query.limit ?? DASHBOARD_PANEL_CATALOG_DEFAULT_LIMIT;
  if (
    !Number.isInteger(limit)
    || limit < 1
    || limit > DASHBOARD_PANEL_CATALOG_MAX_LIMIT
  ) {
    throw new DashboardPanelCatalogError(
      'invalid_limit',
      `limit must be an integer from 1 to ${DASHBOARD_PANEL_CATALOG_MAX_LIMIT}.`,
    );
  }

  const catalogVariant = variantFilter ?? currentVariant;
  const registryIds = getCanonicalDashboardPanelIds(variantFilter);
  const items: DashboardPanelCatalogItem[] = [];
  for (const panelId of registryIds) {
    const item = describePanel(panelId, live, catalogVariant);
    if (categoryFilter !== undefined && item.category !== categoryFilter) continue;
    if (query.enabled !== undefined && item.enabled !== query.enabled) continue;
    if (query.available !== undefined && item.available !== query.available) continue;
    items.push(item);
  }

  const startIndex = cursor === undefined
    ? 0
    : items.findIndex((item) => item.id.localeCompare(cursor, 'en') > 0);
  const remaining = startIndex === -1 ? [] : items.slice(startIndex);
  return packCatalogPage(currentVariant, items.length, remaining, limit);
}

function describePanel(
  panelId: string,
  live: DashboardPanelCatalogLiveState,
  catalogVariant: string,
): DashboardPanelCatalogItem {
  const saved = live.panelSettings[panelId];
  const liveConfig = getEffectivePanelConfig(panelId, live.currentVariant);
  const catalogConfig = catalogVariant === live.currentVariant
    ? liveConfig
    : getEffectivePanelConfig(panelId, catalogVariant);
  const enabled = saved?.enabled === true;
  const mounted = live.mountedIds.has(panelId);
  const entitled = live.isPanelAllowed(panelId, liveConfig);
  const available = enabled && mounted && entitled;
  const item: DashboardPanelCatalogItem = {
    id: panelId,
    label: catalogConfig.name.slice(0, DASHBOARD_PANEL_LABEL_MAX_CHARS),
    category: getDashboardPanelCategoryKey(panelId, catalogVariant),
    variants: PANEL_VARIANT_AVAILABILITY[panelId] ?? [],
    enabled,
    mounted,
    entitled,
    available,
  };
  if (!available) {
    item.unavailableReason = !entitled
      ? 'panel_not_entitled'
      : !enabled
        ? 'panel_disabled'
        : 'panel_not_live';
  }
  return item;
}

function packCatalogPage(
  variant: string,
  total: number,
  remaining: DashboardPanelCatalogItem[],
  limit: number,
): DashboardPanelCatalogPage {
  const candidates = remaining.slice(0, limit);
  const accepted: DashboardPanelCatalogItem[] = [];
  for (const item of candidates) {
    const next = [...accepted, item];
    const projectedHasMore = remaining.length > next.length;
    const projected = serializeCatalogPage(
      variant,
      total,
      next,
      projectedHasMore,
      projectedHasMore ? next[next.length - 1]?.id ?? null : null,
    );
    if (
      accepted.length > 0
      && JSON.stringify(projected).length > DASHBOARD_PANEL_CATALOG_OUTPUT_TARGET_CHARS
    ) {
      break;
    }
    accepted.push(item);
  }

  const hasMore = remaining.length > accepted.length;
  return serializeCatalogPage(
    variant,
    total,
    accepted,
    hasMore,
    hasMore ? accepted[accepted.length - 1]?.id ?? null : null,
  );
}

function serializeCatalogPage(
  variant: string,
  total: number,
  panels: DashboardPanelCatalogItem[],
  hasMore: boolean,
  nextCursor: string | null,
): DashboardPanelCatalogPage {
  return {
    variant,
    total,
    hasMore,
    nextCursor,
    panels: panels.map(serializeCatalogItem),
  };
}

function serializeCatalogItem(item: DashboardPanelCatalogItem): DashboardPanelCatalogItem {
  const serialized: DashboardPanelCatalogItem = {
    id: item.id.slice(0, DASHBOARD_PANEL_ID_MAX_CHARS),
    label: item.label.slice(0, DASHBOARD_PANEL_LABEL_MAX_CHARS),
    category: item.category.slice(0, DASHBOARD_PANEL_CATEGORY_MAX_CHARS),
    variants: [...item.variants],
    enabled: item.enabled === true,
    mounted: item.mounted === true,
    entitled: item.entitled === true,
    available: item.available === true,
  };
  if (!serialized.available && item.unavailableReason) {
    serialized.unavailableReason = item.unavailableReason;
  }
  return serialized;
}
