/**
 * FR #203: API Request Prioritization
 * Defines load priority tiers for staged data loading
 */

/**
 * Load priority levels for data fetching
 * Lower number = higher priority = loaded earlier
 */
export enum LoadPriority {
  /** Critical: Above-fold content, visible immediately (e.g., Breaking News) */
  CRITICAL = 0,
  /** High: Main content panels and map data */
  HIGH = 1,
  /** Normal: Secondary panels and features */
  NORMAL = 2,
  /** Low: Analytics, telemetry, non-essential features */
  LOW = 3,
}

/**
 * Default priority for data sources not explicitly configured
 */
export const DEFAULT_PRIORITY = LoadPriority.NORMAL;

/**
 * Priority configuration for each data loader task
 * Tasks are grouped and loaded in phases based on priority
 */
export const TASK_PRIORITIES: Record<string, LoadPriority> = {
  // CRITICAL: Above-fold, must render first
  news: LoadPriority.CRITICAL,

  // HIGH: Main panels and map layers
  markets: LoadPriority.HIGH,
  predictions: LoadPriority.HIGH,
  cables: LoadPriority.HIGH,
  cableHealth: LoadPriority.HIGH,
  intelligence: LoadPriority.HIGH,

  // NORMAL: Secondary panels
  stockAnalysis: LoadPriority.NORMAL,
  stockBacktest: LoadPriority.NORMAL,
  forecasts: LoadPriority.NORMAL,
  pizzint: LoadPriority.NORMAL,
  fred: LoadPriority.NORMAL,
  spending: LoadPriority.NORMAL,
  bis: LoadPriority.NORMAL,
  oil: LoadPriority.NORMAL,
  tradePolicy: LoadPriority.NORMAL,
  supplyChain: LoadPriority.NORMAL,
  firms: LoadPriority.NORMAL,
  natural: LoadPriority.NORMAL,
  weather: LoadPriority.NORMAL,
  flights: LoadPriority.NORMAL,
  cyberThreats: LoadPriority.NORMAL,
  iranAttacks: LoadPriority.NORMAL,
  techEvents: LoadPriority.NORMAL,
  webcams: LoadPriority.NORMAL,
  thermalEscalation: LoadPriority.NORMAL,
  ais: LoadPriority.NORMAL,

  // LOW: Non-essential, load after user interaction or delay
  satellites: LoadPriority.LOW,
  sanctions: LoadPriority.LOW,
  radiation: LoadPriority.LOW,
  techReadiness: LoadPriority.LOW,
  progress: LoadPriority.LOW,
  species: LoadPriority.LOW,
  renewable: LoadPriority.LOW,
  happinessMap: LoadPriority.LOW,
  renewableMap: LoadPriority.LOW,
  giving: LoadPriority.LOW,
};

/**
 * Delay in milliseconds before loading each priority tier
 * CRITICAL: immediate, HIGH: 100ms, NORMAL: requestIdleCallback or 3s, LOW: 5s
 */
export const PRIORITY_DELAYS: Record<LoadPriority, number> = {
  [LoadPriority.CRITICAL]: 0,
  [LoadPriority.HIGH]: 100,
  [LoadPriority.NORMAL]: 3000, // fallback if requestIdleCallback not available
  [LoadPriority.LOW]: 5000,
};

/**
 * Get priority for a task, defaulting to NORMAL if not configured
 */
export function getTaskPriority(taskName: string): LoadPriority {
  return TASK_PRIORITIES[taskName] ?? DEFAULT_PRIORITY;
}

/**
 * Group tasks by priority level
 */
export function groupTasksByPriority<T extends { name: string }>(
  tasks: T[]
): Map<LoadPriority, T[]> {
  const groups = new Map<LoadPriority, T[]>();

  for (const priority of [
    LoadPriority.CRITICAL,
    LoadPriority.HIGH,
    LoadPriority.NORMAL,
    LoadPriority.LOW,
  ]) {
    groups.set(priority, []);
  }

  for (const task of tasks) {
    const priority = getTaskPriority(task.name);
    groups.get(priority)!.push(task);
  }

  return groups;
}
