/**
 * Canonical tab-id union for the settings modal. Lives in the components layer
 * (a pure leaf type with no imports) so both the UnifiedSettings component and
 * the app-context controller interface can share one declaration without a
 * components -> app backward import.
 */
export type UnifiedSettingsTabId =
  | 'settings'
  | 'panels'
  | 'sources'
  | 'notifications'
  | 'api-keys'
  | 'mcp-clients';
