/**
 * Analytics facade.
 *
 * PostHog has been removed from the application.
 * Vercel Analytics remains initialized in src/main.ts.
 * Event-level helpers are kept as no-ops to preserve existing call sites.
 */

export async function initAnalytics(): Promise<void> {
  // Intentionally no-op.
}

export function trackEvent(_name: string, _props?: Record<string, unknown>): void {
  // Intentionally no-op.
}

export function trackEventBeforeUnload(_name: string, _props?: Record<string, unknown>): void {
  // Intentionally no-op.
}

export function trackPanelView(_panelId: string): void {
  // Intentionally no-op.
}

export function trackApiKeysSnapshot(): void {
  // Intentionally no-op.
}

export function trackLLMUsage(_provider: string, _model: string, _cached: boolean): void {
  // Intentionally no-op.
}

export function trackLLMFailure(_lastProvider: string): void {
  // Intentionally no-op.
}

export function trackPanelResized(_panelId: string, _newSpan: number): void {
  // Intentionally no-op.
}

export function trackVariantSwitch(_from: string, _to: string): void {
  // Intentionally no-op.
}

export function trackMapLayerToggle(_layerId: string, _enabled: boolean, _source: 'user' | 'programmatic'): void {
  // Intentionally no-op.
}

export function trackCountryBriefOpened(_countryCode: string): void {
  // Intentionally no-op.
}

export function trackThemeChanged(_theme: string): void {
  // Intentionally no-op.
}

export function trackLanguageChange(_language: string): void {
  // Intentionally no-op.
}

export function trackFeatureToggle(_featureId: string, _enabled: boolean): void {
  // Intentionally no-op.
}

export function trackSearchUsed(_queryLength: number, _resultCount: number): void {
  // Intentionally no-op.
}

export function trackMapViewChange(_view: string): void {
  // Intentionally no-op.
}

export function trackCountrySelected(_code: string, _name: string, _source: string): void {
  // Intentionally no-op.
}

export function trackSearchResultSelected(_resultType: string): void {
  // Intentionally no-op.
}

export function trackPanelToggled(_panelId: string, _enabled: boolean): void {
  // Intentionally no-op.
}

export function trackFindingClicked(_id: string, _source: string, _type: string, _priority: string): void {
  // Intentionally no-op.
}

export function trackUpdateShown(_current: string, _remote: string): void {
  // Intentionally no-op.
}

export function trackUpdateClicked(_version: string): void {
  // Intentionally no-op.
}

export function trackUpdateDismissed(_version: string): void {
  // Intentionally no-op.
}

export function trackCriticalBannerAction(_action: string, _theaterId: string): void {
  // Intentionally no-op.
}

export function trackDownloadClicked(_platform: string): void {
  // Intentionally no-op.
}

export function trackDownloadBannerDismissed(): void {
  // Intentionally no-op.
}

export function trackWebcamSelected(_webcamId: string, _city: string, _viewMode: string): void {
  // Intentionally no-op.
}

export function trackWebcamRegionFiltered(_region: string): void {
  // Intentionally no-op.
}

export function trackDeeplinkOpened(_type: string, _target: string): void {
  // Intentionally no-op.
}
