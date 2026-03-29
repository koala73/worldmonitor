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

/** Duration for highlight glow effect (30 seconds) */
export const HIGHLIGHT_DURATION_MS = 30 * 1000;

class ActivityTracker {
  private panels = new Map<string, ActivityState>();
  private observers = new Map<string, IntersectionObserver>();
  private onChangeCallbacks = new Map<string, (newCount: number) => void>();

  /**
   * Initialize tracking for a panel
   */
  register(panelId: string): void {
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

    // Notify listeners
    const callback = this.onChangeCallbacks.get(panelId);
    if (callback) {
      callback(0);
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

    if (elapsed < 60_000) {
      return 'just now';
    } else if (elapsed < 3_600_000) {
      const mins = Math.floor(elapsed / 60_000);
      return `${mins}m ago`;
    } else {
      const hours = Math.floor(elapsed / 3_600_000);
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
