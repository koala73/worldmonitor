/**
 * Analytics facade — wired to Umami.
 *
 * All functions use window.umami?.track() so they are safe to call
 * even if the Umami script has not loaded yet (e.g. ad blockers, SSR).
 */

export async function initAnalytics(): Promise<void> {
  // No-op: Umami initialises itself via the script tag in index.html.
}

// ---------------------------------------------------------------------------
// Generic (kept as no-ops — too noisy / not useful in Umami)
// ---------------------------------------------------------------------------

export function trackEvent(_name: string, _props?: Record<string, unknown>): void {}
export function trackEventBeforeUnload(_name: string, _props?: Record<string, unknown>): void {}
export function trackPanelView(_panelId: string): void {}
export function trackApiKeysSnapshot(): void {}
export function trackUpdateShown(_current: string, _remote: string): void {}
export function trackUpdateClicked(_version: string): void {}
export function trackUpdateDismissed(_version: string): void {}
export function trackDownloadBannerDismissed(): void {}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export function trackSearchUsed(queryLength: number, resultCount: number): void {
  window.umami?.track('search-used', { queryLength, resultCount });
}

export function trackSearchResultSelected(resultType: string): void {
  window.umami?.track('search-result-selected', { type: resultType });
}

// ---------------------------------------------------------------------------
// Country / map
// ---------------------------------------------------------------------------

export function trackCountrySelected(code: string, name: string, source: string): void {
  window.umami?.track('country-selected', { code, name, source });
}

export function trackCountryBriefOpened(countryCode: string): void {
  window.umami?.track('country-brief-opened', { code: countryCode });
}

export function trackMapLayerToggle(layerId: string, enabled: boolean, source: 'user' | 'programmatic'): void {
  window.umami?.track('map-layer-toggle', { layerId, enabled, source });
}

export function trackMapViewChange(view: string): void {
  window.umami?.track('map-view-change', { view });
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

export function trackPanelToggled(panelId: string, enabled: boolean): void {
  window.umami?.track('panel-toggle', { panelId, enabled });
}

export function trackPanelResized(panelId: string, newSpan: number): void {
  window.umami?.track('panel-resized', { panelId, span: newSpan });
}

// ---------------------------------------------------------------------------
// App-wide settings
// ---------------------------------------------------------------------------

export function trackVariantSwitch(from: string, to: string): void {
  window.umami?.track('variant-switch', { from, to });
}

export function trackThemeChanged(theme: string): void {
  window.umami?.track('theme-changed', { theme });
}

export function trackLanguageChange(language: string): void {
  window.umami?.track('language-change', { language });
}

export function trackFeatureToggle(featureId: string, enabled: boolean): void {
  window.umami?.track('feature-toggle', { featureId, enabled });
}

// ---------------------------------------------------------------------------
// AI / LLM
// ---------------------------------------------------------------------------

export function trackLLMUsage(provider: string, model: string, cached: boolean): void {
  window.umami?.track('llm-used', { provider, model, cached });
}

export function trackLLMFailure(lastProvider: string): void {
  window.umami?.track('llm-failed', { provider: lastProvider });
}

// ---------------------------------------------------------------------------
// Webcams
// ---------------------------------------------------------------------------

export function trackWebcamSelected(webcamId: string, city: string, viewMode: string): void {
  window.umami?.track('webcam-selected', { webcamId, city, viewMode });
}

export function trackWebcamRegionFiltered(region: string): void {
  window.umami?.track('webcam-region-filter', { region });
}

// ---------------------------------------------------------------------------
// Downloads / banners / findings
// ---------------------------------------------------------------------------

export function trackDownloadClicked(platform: string): void {
  window.umami?.track('download-clicked', { platform });
}

export function trackCriticalBannerAction(action: string, theaterId: string): void {
  window.umami?.track('critical-banner', { action, theaterId });
}

export function trackFindingClicked(id: string, source: string, type: string, priority: string): void {
  window.umami?.track('finding-clicked', { id, source, type, priority });
}

export function trackDeeplinkOpened(type: string, target: string): void {
  window.umami?.track('deeplink-opened', { type, target });
}
