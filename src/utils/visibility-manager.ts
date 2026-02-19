/**
 * PERF-036: Background tab throttling / visibility management.
 * When the tab is hidden:
 * - Pauses CSS animations (via class toggle)
 * - Reduces refresh intervals (4x slower)
 * - Notifies listeners so they can skip expensive work
 *
 * PERF-013: IntersectionObserver for off-screen panels.
 * Panels not visible in the viewport skip DOM updates to reduce work.
 */

type VisibilityListener = (isVisible: boolean) => void;
const listeners: VisibilityListener[] = [];
let isPageVisible = !document.hidden;

// Panels currently visible in the viewport (PERF-013)
const visiblePanels = new Set<string>();
let panelObserver: IntersectionObserver | null = null;

/**
 * Subscribe to page visibility changes.
 */
export function onVisibilityChange(fn: VisibilityListener): () => void {
    listeners.push(fn);
    return () => {
        const idx = listeners.indexOf(fn);
        if (idx >= 0) listeners.splice(idx, 1);
    };
}

/**
 * Get whether the page is currently visible (foreground tab).
 */
export function isTabVisible(): boolean {
    return isPageVisible;
}

/**
 * Get the refresh interval multiplier.
 * Returns 1 when tab is visible, 4 when hidden (to reduce background load).
 */
export function getRefreshMultiplier(): number {
    return isPageVisible ? 1 : 4;
}

/**
 * Scale a refresh interval based on tab visibility.
 */
export function scaleInterval(baseMs: number): number {
    return baseMs * getRefreshMultiplier();
}

/**
 * PERF-013: Check if a panel is currently visible in the viewport.
 * Panels not visible skip DOM updates to avoid unnecessary reflows.
 */
export function isPanelVisible(panelId: string): boolean {
    // If observer isn't set up yet, assume all panels are visible
    if (!panelObserver) return true;
    return visiblePanels.has(panelId);
}

/**
 * PERF-013: Start observing panel elements for viewport intersection.
 * Call after panels are added to the DOM.
 */
export function observePanels(container: HTMLElement): void {
    if (panelObserver) panelObserver.disconnect();

    panelObserver = new IntersectionObserver(
        (entries) => {
            for (const entry of entries) {
                const panelId = (entry.target as HTMLElement).dataset.panel;
                if (!panelId) continue;
                if (entry.isIntersecting) {
                    visiblePanels.add(panelId);
                } else {
                    visiblePanels.delete(panelId);
                }
            }
        },
        { rootMargin: '100px', threshold: 0 }
    );

    // Observe all current panels
    const panels = container.querySelectorAll<HTMLElement>('.panel[data-panel]');
    panels.forEach(panel => panelObserver!.observe(panel));
}

/**
 * PERF-013: Observe a single new panel element.
 */
export function observePanel(element: HTMLElement): void {
    if (panelObserver && element.dataset.panel) {
        panelObserver.observe(element);
    }
}

/**
 * Clean up observer.
 */
export function disconnectPanelObserver(): void {
    panelObserver?.disconnect();
    panelObserver = null;
    visiblePanels.clear();
}

// Initialize visibility change listener
function initVisibilityManager(): void {
    document.addEventListener('visibilitychange', () => {
        isPageVisible = !document.hidden;

        // PERF-036: Toggle CSS animation pausing
        document.body.classList.toggle('animations-paused', !isPageVisible);

        // Notify all listeners
        for (const fn of listeners) {
            try {
                fn(isPageVisible);
            } catch (e) {
                console.error('[PERF] Visibility listener error:', e);
            }
        }

        if (isPageVisible) {
            console.log('[PERF] Tab visible — resuming full refresh rate');
        } else {
            console.log('[PERF] Tab hidden — throttling to 4x intervals');
        }
    });
}

// Auto-initialize
initVisibilityManager();
