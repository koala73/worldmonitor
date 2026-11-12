import { normalizeScope, scopeEquals, type TabScope } from '../../shared/tab-scope';
import { resolveScope } from '../../shared/tab-scope-resolve';
import { hasTabFocusForAccount } from '@/services/entitlements';

/**
 * Dashboard focus (#10453): the ACTIVE tab's scope, held here as the single
 * runtime source. Panels, the focus bar and (later) the map read it from this
 * module; the tab object in `tab-store` is where it is persisted, and
 * `PanelLayoutManager` keeps the two in step on every tab switch, create,
 * delete and reload.
 *
 * Gate: setting a focus on your own tab is a CLIENT-SIDE presentation gate.
 * A personal tab's focus only narrows data the account's plan already
 * receives, so no data is protected by `canSetFocus()`; someone who edits it
 * out gains nothing they could not already see. The gate that does protect
 * something is server-side: `convex/teamDashboards.ts` refuses to publish a
 * focused team dashboard for a caller without the entitlement.
 */

export type { TabScope };

/** A scope with its neighbours expanded from shared/country-adjacency.ts. */
export interface ResolvedScope {
  scope: TabScope;
  /** The chosen countries, in the order the user chose them. */
  chosen: string[];
  /** Neighbours of the chosen countries, sorted; empty when switched off. */
  neighbours: string[];
}

export type ScopeListener = (resolved: ResolvedScope | null) => void;

let active: TabScope | null = null;
let resolved: ResolvedScope | null = null;
const listeners = new Set<ScopeListener>();

function copyScope(scope: TabScope): TabScope {
  return { ...scope, countries: [...scope.countries] };
}

function apply(next: TabScope | null): void {
  if (scopeEquals(active, next)) return;
  active = next;
  resolved = next ? { scope: copyScope(next), ...resolveScope(next) } : null;
  for (const listener of [...listeners]) {
    try {
      listener(resolved);
    } catch (err) {
      console.error('[tab-focus] listener failed', err);
    }
  }
}

/** The active tab's focus, or null when the tab shows the whole world. */
export function getActiveScope(): TabScope | null {
  return active ? copyScope(active) : null;
}

/** The active focus with neighbours resolved, or null without a focus. */
export function getResolvedScope(): ResolvedScope | null {
  return resolved;
}

/** Called with the new resolved scope (or null) whenever the active focus changes. */
export function subscribeScope(listener: ScopeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Whether this account may set a focus on its own tabs (Pro Business, API
 * Business, Enterprise). Client-side only; see the module comment.
 */
export function canSetFocus(): boolean {
  return hasTabFocusForAccount();
}

/**
 * A user's own change to the active tab's focus. Clearing (null) is always
 * allowed. Setting one is refused (false) without the entitlement, and for a
 * scope `normalizeScope` rejects. `entitled` defaults to the live gate; the
 * parameter exists so callers that already evaluated it, and tests, pass it.
 */
export function setActiveScope(scope: TabScope | null, entitled: boolean = scope === null || canSetFocus()): boolean {
  if (scope === null) {
    apply(null);
    return true;
  }
  if (!entitled) return false;
  const normalized = normalizeScope(scope);
  if (!normalized) return false;
  apply(normalized);
  return true;
}

/**
 * Make a stored scope the active one: the tab just switched to, the tab
 * restored on reload, or a team dashboard a teammate shared. Not gated: the
 * focus already exists and only narrows what the plan shows. Returns the
 * normalized scope, or null when there is none or it is invalid.
 */
export function restoreActiveScope(raw: unknown): TabScope | null {
  const normalized = raw == null ? null : normalizeScope(raw);
  apply(normalized);
  return normalized ? copyScope(normalized) : null;
}
