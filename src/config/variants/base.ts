// SalesIntel base configuration

// Refresh intervals for data sources
export const REFRESH_INTERVALS = {
  feeds: 15 * 60 * 1000,       // 15 min — RSS feed refresh
  signals: 10 * 60 * 1000,     // 10 min — Signal aggregation
  enrichment: 60 * 60 * 1000,  // 1 hour — Company enrichment
  health: 30 * 60 * 1000,      // 30 min — Account health recalc
};

// Signal category accent colors for UI
export const MONITOR_COLORS = [
  '#3b82f6', // blue - funding
  '#10b981', // green - hiring
  '#8b5cf6', // purple - expansion
  '#f59e0b', // amber - leadership
  '#06b6d4', // cyan - technology
  '#ef4444', // red - financial risk
  '#ec4899', // pink - competitive
  '#a855f7', // violet - partnership
  '#14b8a6', // teal - product
  '#6366f1', // indigo - general
];

// Storage keys
export const STORAGE_KEYS = {
  panels: 'salesintel-panels',
  monitors: 'salesintel-monitors',
  mapLayers: 'salesintel-layers',
  disabledFeeds: 'salesintel-disabled-feeds',
  targets: 'salesintel-targets',
  settings: 'salesintel-settings',
} as const;
