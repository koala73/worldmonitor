/**
 * Activity Tracker Service
 * Tracks new items in panels to show "new" badges and highlights.
 */

export interface ActivityState {
  /** IDs of items the user has "seen" (panel was visible or scrolled to) */
  seenIds: Set<string>;
  /** When items were first observed (for fading "NEW" tags) */
  firstSeenTime: Map<string, number>;
  /** Count of new items since last panel focus */
  newCount: number;
  /** Timestamp of last user interaction with this panel */
  lastInteraction: number;
}

/** Duration to show "NEW" tag on items (2 minutes) */
export const NEW_TAG_DURATION_MS = 2 * 60 * 1000;

/**
 * #4923: persisted read-state. Holds the timestamp of the user's previous
 * visit so a returning session can distinguish "new since you were last
 * here" from "new to this page load". Listed in CLOUD_SYNC_KEYS, so
 * signed-in users get it synced across devices via cloud-prefs-sync with
 * zero extra wiring here.
 */
export const READ_STATE_KEY = 'wm-read-state-v1';

/** Throttle for lastVisitAt writes — markAsSeen fires per scroll/click. */
const READ_STATE_PERSIST_INTERVAL_MS = 30 * 1000;

interface PersistedReadState {
  v: 1;
  lastVisitAt: number;
}

/**
 * #4926 external review: in sandboxed iframes / blocked-storage modes the
 * `localStorage` accessor ITSELF throws (SecurityError) — `typeof` does
 * not guard property-getter throws, only undeclared identifiers. All
 * storage access goes through this helper; null = session-only mode.
 */
function getSafeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Duration for highlight glow effect (30 seconds) */
export const HIGHLIGHT_DURATION_MS = 30 * 1000;

class ActivityTracker {
  private panels: Map<string, ActivityState> = new Map();
  private observers: Map<string, IntersectionObserver> = new Map();
  private onChangeCallbacks: Map<string, (newCount: number) => void> = new Map();
  /** lastVisitAt from the PREVIOUS session, read once at load (0 = none). */
  private previousVisitAt = 0;
  private lastPersistAt = 0;
  /**
   * #4926 external review (acknowledgement model): the persisted
   * timestamp advances ONLY on genuine user interaction (scroll/click/
   * visibility via markAsSeen) — never on the programmatic first-render
   * markItemsSeen. A session with zero interaction persists NOTHING, so
   * any number of reloads keeps away-stories NEW.
   */
  private lastInteractionAt: number | null = null;
  private lifecycleInstalled = false;

  constructor() {
    // Constructor stays side-effect-light (a single localStorage read);
    // window/document listeners install lazily on first register() —
    // mirrors the repo's explicit-install convention (cloud-prefs-sync
    // install()) without adding a bootstrap call site.
    this.loadReadState();
  }

  private installLifecycleListeners(): void {
    if (this.lifecycleInstalled || typeof window === 'undefined') return;
    this.lifecycleInstalled = true;
    // Flush on the way out so the next session's "previous visit" is
    // accurate even if the throttle window was open. visibilitychange is
    // the reliable signal on mobile Safari; beforeunload is the desktop
    // belt-and-braces.
    window.addEventListener('beforeunload', () => this.persistLastVisit(true));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.persistLastVisit(true);
    });
    // Cross-device continuity: when cloud prefs land AFTER module load
    // (sign-in mid-session, another device visited more recently), adopt
    // the newer previous-visit timestamp — otherwise the cloud value is
    // silently ignored until the next full reload.
    window.addEventListener('wm:cloud-prefs-applied', (event) => {
      const keys = (event as CustomEvent<{ keys?: string[] }>).detail?.keys;
      if (Array.isArray(keys) && keys.includes(READ_STATE_KEY)) {
        this.refreshPreviousVisitFromStorage();
      }
    });
  }

  /** Adopt a LATER previous-visit timestamp written by cloud sync. */
  private refreshPreviousVisitFromStorage(): void {
    const before = this.previousVisitAt;
    const current = this.previousVisitAt;
    this.previousVisitAt = 0;
    this.loadReadState();
    // Monotonic: another device's more recent visit advances the marker;
    // an older cloud value must not resurrect already-seen NEW state.
    if (this.previousVisitAt < current) this.previousVisitAt = current;
    if (this.previousVisitAt !== before) this.lastPersistAt = 0;
  }

  private loadReadState(): void {
    const storage = getSafeLocalStorage();
    if (!storage) return;
    try {
      const raw = storage.getItem(READ_STATE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<PersistedReadState>;
      if (parsed && typeof parsed.lastVisitAt === 'number' && Number.isFinite(parsed.lastVisitAt)) {
        // Clock-skew guard: a future timestamp (device clock jumped back
        // after writing, or a corrupt cloud value) would blank every NEW
        // tag for the whole session. Tolerate small skew, ignore beyond it.
        const maxPlausible = Date.now() + 10 * 60 * 1000;
        if (parsed.lastVisitAt <= maxPlausible) {
          this.previousVisitAt = parsed.lastVisitAt;
        }
      }
    } catch {
      // Corrupt state degrades to "no previous visit" — old behavior.
    }
  }

  /**
   * Timestamp of the previous session's last activity (0 when unknown).
   * Panels use this to keep items that arrived while the user was away
   * flagged NEW on the first render instead of blanket-marking everything
   * seen (#4923 — the "every visit is a stateless snapshot" bug).
   */
  getPreviousVisitTime(): number {
    return this.previousVisitAt;
  }

  private persistLastVisit(force = false): void {
    // Nothing to persist until the user actually interacted this session
    // — flushing "now" on unload/hide would mark away-stories seen after
    // a plain F5 with zero acknowledgement.
    if (this.lastInteractionAt === null) return;
    const storage = getSafeLocalStorage();
    if (!storage) return;
    const now = Date.now();
    if (!force && now - this.lastPersistAt < READ_STATE_PERSIST_INTERVAL_MS) return;
    this.lastPersistAt = now;
    try {
      const state: PersistedReadState = { v: 1, lastVisitAt: this.lastInteractionAt };
      storage.setItem(READ_STATE_KEY, JSON.stringify(state));
    } catch {
      // Quota/privacy-mode failures degrade to session-only behavior.
    }
  }

  /** Test hook: re-read persisted state after stubbing localStorage. */
  _reloadReadStateForTests(): void {
    this.previousVisitAt = 0;
    this.lastPersistAt = 0;
    this.lastInteractionAt = null;
    this.loadReadState();
  }

  /**
   * Initialize tracking for a panel
   */
  register(panelId: string): void {
    this.installLifecycleListeners();
    // Cloud prefs may have applied between module load and the first
    // panel registering — re-read (monotonic) so the first partition
    // sees a cross-device visit that landed in that window.
    this.refreshPreviousVisitFromStorage();
    if (!this.panels.has(panelId)) {
      this.panels.set(panelId, {
        seenIds: new Set(),
        firstSeenTime: new Map(),
        newCount: 0,
        lastInteraction: Date.now(),
      });
    }
  }

  /**
   * Update items for a panel and compute new item count
   * @returns Array of new item IDs (items not seen before)
   */
  updateItems(panelId: string, itemIds: string[]): string[] {
    this.register(panelId);
    const state = this.panels.get(panelId)!;
    const now = Date.now();
    const newItems: string[] = [];

    for (const id of itemIds) {
      // Track when we first saw this item
      if (!state.firstSeenTime.has(id)) {
        state.firstSeenTime.set(id, now);
      }

      // If not in seenIds, it's "new" to the user
      if (!state.seenIds.has(id)) {
        newItems.push(id);
      }
    }

    // Update new count (items present but not seen)
    state.newCount = newItems.length;

    // Notify listeners of change
    const callback = this.onChangeCallbacks.get(panelId);
    if (callback) {
      callback(state.newCount);
    }

    // Clean up old entries (items no longer present)
    const currentIds = new Set(itemIds);
    for (const id of state.firstSeenTime.keys()) {
      if (!currentIds.has(id)) {
        state.firstSeenTime.delete(id);
        state.seenIds.delete(id);
      }
    }

    return newItems;
  }

  /**
   * Mark all current items as "seen" (user interacted with panel)
   */
  markAsSeen(panelId: string): void {
    const state = this.panels.get(panelId);
    if (!state) return;

    // Add all currently tracked items to seen set
    for (const id of state.firstSeenTime.keys()) {
      state.seenIds.add(id);
    }

    state.newCount = 0;
    state.lastInteraction = Date.now();
    this.lastInteractionAt = Date.now();
    this.persistLastVisit();

    // Notify listeners
    const callback = this.onChangeCallbacks.get(panelId);
    if (callback) {
      callback(0);
    }
  }

  /**
   * Mark a SUBSET of items as seen (#4923). Used on a returning user's
   * first render: items older than the previous visit are seen, items
   * that arrived while away keep their NEW state.
   */
  markItemsSeen(panelId: string, itemIds: string[]): void {
    const state = this.panels.get(panelId);
    if (!state) return;

    for (const id of itemIds) {
      state.seenIds.add(id);
    }
    let unseen = 0;
    for (const id of state.firstSeenTime.keys()) {
      if (!state.seenIds.has(id)) unseen++;
    }
    state.newCount = unseen;
    state.lastInteraction = Date.now();
    // Deliberately NO persistence here: this is programmatic bootstrap
    // marking, not user acknowledgement (#4926 external review P1).

    const callback = this.onChangeCallbacks.get(panelId);
    if (callback) {
      callback(state.newCount);
    }
  }

  /**
   * Get new item count for a panel
   */
  getNewCount(panelId: string): number {
    return this.panels.get(panelId)?.newCount ?? 0;
  }

  /**
   * Check if an item should show the "NEW" tag (within NEW_TAG_DURATION_MS of first seen)
   */
  isNewItem(panelId: string, itemId: string): boolean {
    const state = this.panels.get(panelId);
    if (!state) return false;

    const firstSeen = state.firstSeenTime.get(itemId);
    if (!firstSeen) return false;

    return Date.now() - firstSeen < NEW_TAG_DURATION_MS;
  }

  /**
   * Check if an item should show highlight glow (within HIGHLIGHT_DURATION_MS)
   */
  shouldHighlight(panelId: string, itemId: string): boolean {
    const state = this.panels.get(panelId);
    if (!state) return false;

    // Only highlight if not yet seen by user
    if (state.seenIds.has(itemId)) return false;

    const firstSeen = state.firstSeenTime.get(itemId);
    if (!firstSeen) return false;

    return Date.now() - firstSeen < HIGHLIGHT_DURATION_MS;
  }

  /**
   * Get relative time string for when an item was first seen
   */
  getRelativeTime(panelId: string, itemId: string): string {
    const state = this.panels.get(panelId);
    if (!state) return '';

    const firstSeen = state.firstSeenTime.get(itemId);
    if (!firstSeen) return '';

    const elapsed = Date.now() - firstSeen;

    if (elapsed < 60000) {
      return 'just now';
    } else if (elapsed < 3600000) {
      const mins = Math.floor(elapsed / 60000);
      return `${mins}m ago`;
    } else {
      const hours = Math.floor(elapsed / 3600000);
      return `${hours}h ago`;
    }
  }

  /**
   * Register a callback for when new count changes
   */
  onChange(panelId: string, callback: (newCount: number) => void): void {
    this.onChangeCallbacks.set(panelId, callback);
  }

  /**
   * Set up IntersectionObserver to auto-mark panel as seen when visible
   */
  observePanel(panelId: string, element: HTMLElement): void {
    // Clean up existing observer
    this.observers.get(panelId)?.disconnect();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && entry.intersectionRatio > 0.5) {
            // Panel is more than 50% visible - mark as seen
            this.markAsSeen(panelId);
          }
        }
      },
      { threshold: 0.5 }
    );

    observer.observe(element);
    this.observers.set(panelId, observer);
  }

  /**
   * Stop observing a panel
   */
  unobservePanel(panelId: string): void {
    this.observers.get(panelId)?.disconnect();
    this.observers.delete(panelId);
  }

  /**
   * Unregister a panel completely (cleanup for component destruction)
   */
  unregister(panelId: string): void {
    this.unobservePanel(panelId);
    this.onChangeCallbacks.delete(panelId);
    this.panels.delete(panelId);
  }

  /**
   * Clear all tracking data
   */
  clear(): void {
    for (const observer of this.observers.values()) {
      observer.disconnect();
    }
    this.observers.clear();
    this.panels.clear();
    this.onChangeCallbacks.clear();
  }
}

// Singleton instance
export const activityTracker = new ActivityTracker();
