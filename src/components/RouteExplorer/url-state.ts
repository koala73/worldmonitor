/**
 * URL state serialization for the Route Explorer modal.
 *
 * Format: `?explorer=from:CN,to:DE,hs:85,cargo:container,tab:1`
 *
 * Invalid values fall back to defaults silently — never throw — so the modal
 * always opens to a usable state regardless of where the URL came from.
 */

export type ExplorerCargo = 'container' | 'tanker' | 'bulk' | 'roro';
export type ExplorerTab = 1 | 2 | 3 | 4;

export interface ExplorerUrlState {
  fromIso2: string | null;
  toIso2: string | null;
  hs2: string | null;
  cargo: ExplorerCargo | null;
  tab: ExplorerTab;
}

export const DEFAULT_EXPLORER_STATE: ExplorerUrlState = {
  fromIso2: null,
  toIso2: null,
  hs2: null,
  cargo: null,
  tab: 1,
};

const EXPLORER_QUERY_KEY = 'explorer';
const VALID_CARGO: ReadonlySet<ExplorerCargo> = new Set([
  'container',
  'tanker',
  'bulk',
  'roro',
]);
const VALID_TABS: ReadonlySet<ExplorerTab> = new Set([1, 2, 3, 4]);
const ISO2_RE = /^[A-Z]{2}$/;
const HS2_RE = /^\d{1,2}$/;

/**
 * Parse the `explorer=...` query parameter into a typed state object.
 * Unknown or malformed fields fall back to defaults silently.
 */
export function parseExplorerUrl(search: string): ExplorerUrlState {
  let raw: string | null;
  try {
    raw = new URLSearchParams(search).get(EXPLORER_QUERY_KEY);
  } catch {
    return { ...DEFAULT_EXPLORER_STATE };
  }
  if (!raw) return { ...DEFAULT_EXPLORER_STATE };

  const out: ExplorerUrlState = { ...DEFAULT_EXPLORER_STATE };
  const parts = raw.split(',');
  for (const part of parts) {
    const [key, value] = part.split(':');
    if (!key || value === undefined) continue;
    switch (key.trim().toLowerCase()) {
      case 'from': {
        const v = value.trim().toUpperCase();
        if (ISO2_RE.test(v)) out.fromIso2 = v;
        break;
      }
      case 'to': {
        const v = value.trim().toUpperCase();
        if (ISO2_RE.test(v)) out.toIso2 = v;
        break;
      }
      case 'hs': {
        const v = value.trim();
        if (HS2_RE.test(v)) out.hs2 = v;
        break;
      }
      case 'cargo': {
        const v = value.trim().toLowerCase() as ExplorerCargo;
        if (VALID_CARGO.has(v)) out.cargo = v;
        break;
      }
      case 'tab': {
        const n = Number.parseInt(value.trim(), 10) as ExplorerTab;
        if (VALID_TABS.has(n)) out.tab = n;
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/**
 * Serialize a state object into the `explorer=...` query value. Returns
 * `null` when no field is set so callers can remove the param entirely.
 */
export function serializeExplorerUrl(state: ExplorerUrlState): string | null {
  const parts: string[] = [];
  if (state.fromIso2 && ISO2_RE.test(state.fromIso2)) parts.push(`from:${state.fromIso2}`);
  if (state.toIso2 && ISO2_RE.test(state.toIso2)) parts.push(`to:${state.toIso2}`);
  if (state.hs2 && HS2_RE.test(state.hs2)) parts.push(`hs:${state.hs2}`);
  if (state.cargo && VALID_CARGO.has(state.cargo)) parts.push(`cargo:${state.cargo}`);
  if (state.tab !== 1 && VALID_TABS.has(state.tab)) parts.push(`tab:${state.tab}`);
  if (parts.length === 0) return null;
  return parts.join(',');
}

/**
 * Apply a state update to `window.location` without triggering a navigation.
 * No-op when running in a non-browser context (test runners, sidecar).
 */
export function writeExplorerUrl(state: ExplorerUrlState): void {
  if (typeof window === 'undefined' || !window.history?.replaceState) return;
  const url = new URL(window.location.href);
  const serialized = serializeExplorerUrl(state);
  if (serialized) {
    url.searchParams.set(EXPLORER_QUERY_KEY, serialized);
  } else {
    url.searchParams.delete(EXPLORER_QUERY_KEY);
  }
  window.history.replaceState(window.history.state, '', url.toString());
}

/**
 * Read state from the current `window.location`. Returns defaults when
 * running in a non-browser context.
 */
export function readExplorerUrl(): ExplorerUrlState {
  if (typeof window === 'undefined') return { ...DEFAULT_EXPLORER_STATE };
  return parseExplorerUrl(window.location.search);
}
