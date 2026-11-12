/**
 * Which caller asked for a `loadAllData()` pass.
 *
 * - `full`: re-run every gated loader for the panels in range. User actions
 *   (sources changed, playback exit, settings) and resize use this.
 * - `viewport`: a panel scrolled or mounted into range. Only panels that no
 *   earlier pass has loaded need data; refreshing loaded panels belongs to the
 *   refresh scheduler.
 */
export type LoadAllDataTrigger = 'full' | 'viewport';

export interface ViewportHydrationLedgerOptions {
  rehydrateAfterMs?: number;
  now?: () => number;
}

export const VIEWPORT_REHYDRATE_AFTER_MS = 60_000;

/**
 * Remembers which panel instances a `loadAllData()` pass has already loaded.
 *
 * Scrolling the panel grid fires a viewport pass on every animation frame.
 * Without this ledger each pass re-ran every in-range loader and re-fetched
 * data the panels already showed, for example 10 PizzINT and 10 temporal
 * anomaly requests in one scroll down and back.
 *
 * Entries are panel instances, not ids, so a remounted or newly enabled panel
 * counts as unloaded and its loader still runs on the next pass. A change in
 * the pass context (premium access) clears the ledger, because some loader
 * gates depend on it.
 *
 * Entries expire after `rehydrateAfterMs`. Loaders swallow their own failures,
 * so a pass cannot tell an empty panel from a loaded one; expiry lets a failed
 * first load retry on a later scroll, while one burst of scrolling still loads
 * each panel once.
 */
export class ViewportHydrationLedger<P extends object = object> {
  private served = new WeakMap<P, number>();
  private claimed = new Set<string>();
  private context: unknown;
  private hasContext = false;
  private readonly rehydrateAfterMs: number;
  private readonly now: () => number;

  constructor(options: ViewportHydrationLedgerOptions = {}) {
    this.rehydrateAfterMs = options.rehydrateAfterMs ?? VIEWPORT_REHYDRATE_AFTER_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /** Call at the start of every pass. A changed context forgets all entries. */
  beginPass(context: unknown): void {
    if (this.hasContext && Object.is(context, this.context)) return;
    this.served = new WeakMap<P, number>();
    this.claimed.clear();
    this.context = context;
    this.hasContext = true;
  }

  /** Ids of in-range panels no pass has loaded within the re-hydration window. */
  collectUnserved(
    panels: Readonly<Record<string, P | undefined>>,
    isNear: (id: string) => boolean,
  ): Set<string> {
    const unserved = new Set<string>();
    const now = this.now();
    for (const [id, panel] of Object.entries(panels)) {
      if (!panel) continue;
      const servedAt = this.served.get(panel);
      if (servedAt !== undefined && now - servedAt < this.rehydrateAfterMs) continue;
      if (isNear(id)) unserved.add(id);
    }
    return unserved;
  }

  markServed(panels: Readonly<Record<string, P | undefined>>, ids: Iterable<string>): void {
    const now = this.now();
    for (const id of ids) {
      const panel = panels[id];
      if (panel) this.served.set(panel, now);
    }
  }

  /** True the first time a key is claimed, false afterwards. */
  claim(key: string): boolean {
    if (this.claimed.has(key)) return false;
    this.claimed.add(key);
    return true;
  }
}
