/**
 * Panel Loading Priority Configuration
 *
 * Defines staggered loading delays for panels to optimize
 * perceived performance and reduce initial load blocking.
 */

/**
 * Loading priority batches
 * - Batch 1 (0ms): High-priority panels loaded immediately
 * - Batch 2 (300ms): Medium-priority panels
 * - Batch 3 (600ms): Low-priority panels
 */
export const PANEL_LOAD_DELAYS: Record<string, number> = {
  // Batch 1: Core panels (immediate load)
  ieSemiconductors: 0,
  startups: 0,
  ai: 0,
  ieTech: 0,

  // Batch 2: Secondary panels (300ms delay)
  ieDeals: 300,
  ieJobs: 300,
  ieBusiness: 300,
  tech: 300,
  finance: 300,

  // Batch 3: Lower priority (600ms delay)
  ieAcademic: 600,
  ieSummits: 600,
  vcblogs: 600,
  thinktanks: 600,
};

/**
 * Get loading delay for a panel
 * @param panelId - Panel identifier
 * @returns Delay in milliseconds (0 for unknown panels)
 */
export function getPanelLoadDelay(panelId: string): number {
  return PANEL_LOAD_DELAYS[panelId] ?? 0;
}

/**
 * Check if a panel is high priority (batch 1)
 */
export function isHighPriorityPanel(panelId: string): boolean {
  const delay = PANEL_LOAD_DELAYS[panelId];
  return delay === 0 || delay === undefined;
}

/**
 * Group panels by their load batch
 */
export function groupPanelsByBatch(panelIds: string[]): {
  batch1: string[];
  batch2: string[];
  batch3: string[];
} {
  const batch1: string[] = [];
  const batch2: string[] = [];
  const batch3: string[] = [];

  for (const id of panelIds) {
    const delay = PANEL_LOAD_DELAYS[id] ?? 0;
    if (delay === 0) {
      batch1.push(id);
    } else if (delay <= 300) {
      batch2.push(id);
    } else {
      batch3.push(id);
    }
  }

  return { batch1, batch2, batch3 };
}

/**
 * Auto-retry configuration
 */
export const RETRY_CONFIG = {
  /** Maximum number of auto retries */
  maxRetries: 1,
  /** Delay before first retry (ms) */
  retryDelay: 3000,
  /** Random jitter range to prevent retry storms (ms) */
  jitterRange: 500,
};

/**
 * Get retry delay with jitter
 * Adds random delay to prevent multiple panels retrying simultaneously
 */
export function getRetryDelayWithJitter(): number {
  const jitter = Math.random() * RETRY_CONFIG.jitterRange;
  return RETRY_CONFIG.retryDelay + jitter;
}
