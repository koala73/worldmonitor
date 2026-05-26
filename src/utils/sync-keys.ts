export const CLOUD_SYNC_KEYS = [
  'worldmonitor-panels',
  'worldmonitor-monitors',
  'worldmonitor-layers',
  'worldmonitor-disabled-feeds',
  'worldmonitor-panel-spans',
  'worldmonitor-panel-col-spans',
  'worldmonitor-panel-order',
  'worldmonitor-theme',
  'worldmonitor-variant',
  'worldmonitor-map-mode',
  'wm-breaking-alerts-v1',
  'wm-market-watchlist-v1',
  'aviation:watchlist:v1',
  'wm-pinned-webcams',
  'wm-map-provider',
  'wm-font-family',
  'wm-globe-visual-preset',
  'wm-stream-quality',
  'wm-ai-flow-cloud-llm',
  // Sister AI-flow toggles. Without these, the user's "Browser Local Model"
  // and "Headline Memory" prefs reset per variant and disagree with the
  // already-synced Cloud AI toggle — e.g. Headline Memory left on for the
  // full variant silently runs the local ML worker (HuggingFace model
  // downloads) on every page load, but switching to the tech variant shows
  // the toggle as off because tech-variant localStorage is fresh.
  'wm-ai-flow-browser-model',
  'wm-headline-memory',
  'wm-analysis-frameworks',
  'wm-panel-frameworks',
  // Provider-specific map themes (wm-map-theme:<provider>)
  'wm-map-theme:auto',
  'wm-map-theme:pmtiles',
  'wm-map-theme:openfreemap',
  'wm-map-theme:carto',
  // Live-stream mode
  'wm-live-streams-always-on',
] as const;

export type CloudSyncKey = (typeof CLOUD_SYNC_KEYS)[number];
