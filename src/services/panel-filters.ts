/**
 * A tab's per-panel filter choices (#10453, phase 2): the forecast region, the
 * webcam region, and any later panel choice an analyst makes. They are saved
 * with the tab and travel in a shared team dashboard's `panelFilters`.
 *
 * The bounds mirror convex/lib/teamDashboardLayout.ts (key shape, entry count,
 * value length) so capture never builds something `publish` would refuse. A
 * value is opaque here: the panel that owns the key decides what it means and
 * ignores one it does not recognise.
 */

export type PanelFilters = Record<string, string>;

export const PANEL_FILTER_MAX_ENTRIES = 40;
export const PANEL_FILTER_MAX_VALUE_LENGTH = 200;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$/;

function validEntry(key: string, value: unknown): value is string {
  return KEY_RE.test(key) && typeof value === 'string' && value.length <= PANEL_FILTER_MAX_VALUE_LENGTH;
}

/** The usable choices in a stored or decoded value; undefined when none. */
export function normalizePanelFilters(raw: unknown): PanelFilters | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: PanelFilters = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (!validEntry(key, value)) continue;
    if (count >= PANEL_FILTER_MAX_ENTRIES) break;
    out[key] = value;
    count++;
  }
  return count > 0 ? out : undefined;
}

/**
 * A copy of `filters` with one panel's choice set, or removed when `value` is
 * null. A key or value the server would refuse leaves the filters unchanged.
 */
export function setPanelFilter(
  filters: PanelFilters | undefined,
  key: string,
  value: string | null,
): PanelFilters | undefined {
  const next: PanelFilters = { ...(filters ?? {}) };
  if (value === null) {
    delete next[key];
  } else if (validEntry(key, value)) {
    next[key] = value;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/** The server's shape: sorted by key so two captures of one tab are equal. */
export function filtersToEntries(filters: PanelFilters | undefined): Array<{ key: string; value: string }> {
  return Object.entries(normalizePanelFilters(filters) ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => ({ key, value }));
}

export function filtersFromEntries(
  entries: ReadonlyArray<{ key: string; value: string }> | undefined,
): PanelFilters | undefined {
  if (!entries) return undefined;
  const raw: PanelFilters = {};
  for (const entry of entries) raw[entry.key] = entry.value;
  return normalizePanelFilters(raw);
}

export interface PanelFilterApplyPlan {
  /** Panels to hand a value (null resets the panel to its default). */
  updates: Array<{ key: string; value: string | null }>;
  /** The keys this tab has set; the next tab switch resets any it does not set. */
  applied: Set<string>;
}

/**
 * What to hand each mounted panel when a tab becomes active. A panel the tab
 * chose for gets that value. A panel the previous tab chose for and this tab
 * did not goes back to its default, so one tab's webcam region does not follow
 * the user into the next. A panel neither tab chose for is left alone, so a
 * region saved in this browser before tabs carried one is not wiped.
 */
export function planPanelFilterApply(
  mountedKeys: Iterable<string>,
  filters: PanelFilters | undefined,
  previouslyApplied: ReadonlySet<string>,
): PanelFilterApplyPlan {
  const updates: PanelFilterApplyPlan['updates'] = [];
  for (const key of mountedKeys) {
    const value = filters?.[key];
    if (value !== undefined) updates.push({ key, value });
    else if (previouslyApplied.has(key)) updates.push({ key, value: null });
  }
  return { updates, applied: new Set(Object.keys(filters ?? {})) };
}
