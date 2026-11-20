// MCP Apps host context for the plugin views. No DOM access, so it runs under node tests.
// Claude reports both its side panel and full screen as displayMode "fullscreen";
// only containerDimensions tells them apart. Width breakpoints stay in CSS media queries,
// which inside the view's iframe measure the same width the host reports.

export type PluginDisplayMode = 'inline' | 'fullscreen';

export interface PluginContainerDimensions { width?: number; height?: number; maxWidth?: number; maxHeight?: number }
export interface PluginSafeAreaInsets { top?: number; right?: number; bottom?: number; left?: number }

export interface PluginHostContext {
  theme?: 'light' | 'dark';
  displayMode: PluginDisplayMode;
  /** Counts updates that supplied displayMode, so a late answer can tell whether the host spoke since. */
  displayModeRevision: number;
  availableDisplayModes: string[];
  containerDimensions?: PluginContainerDimensions;
  safeAreaInsets?: PluginSafeAreaInsets;
}

export interface PluginLayoutFlags {
  /** The host offers fullscreen and the view is not already in it. */
  canExpand: boolean;
  /** The view is in fullscreen mode and the host reported a positive height to fill. */
  fillContainer: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function finiteFields<K extends string>(value: unknown, keys: readonly K[]): Partial<Record<K, number>> | undefined {
  const source = record(value);
  if (!source) return undefined;
  const result: Partial<Record<K, number>> = {};
  for (const key of keys) {
    const field = source[key];
    if (typeof field === 'number' && Number.isFinite(field) && field >= 0) result[key] = field;
  }
  return Object.keys(result).length ? result : undefined;
}

function applyUpdate(state: PluginHostContext, update: Record<string, unknown>): PluginHostContext {
  const next: PluginHostContext = { ...state };
  if (update.theme === 'light' || update.theme === 'dark') next.theme = update.theme;
  if ('displayMode' in update) {
    next.displayMode = update.displayMode === 'fullscreen' ? 'fullscreen' : 'inline';
    next.displayModeRevision = state.displayModeRevision + 1;
  }
  if (Array.isArray(update.availableDisplayModes)) {
    next.availableDisplayModes = update.availableDisplayModes.filter((mode): mode is string => typeof mode === 'string');
  }
  const dimensions = finiteFields(update.containerDimensions, ['width', 'height', 'maxWidth', 'maxHeight'] as const);
  if (dimensions) next.containerDimensions = dimensions;
  const insets = finiteFields(update.safeAreaInsets, ['top', 'right', 'bottom', 'left'] as const);
  if (insets) next.safeAreaInsets = insets;
  return next;
}

/** Host state from the `ui/initialize` result. */
export function hostContextFromInitialize(result: unknown): PluginHostContext {
  return mergeHostContext({ displayMode: 'inline', displayModeRevision: 0, availableDisplayModes: [] }, record(result)?.hostContext);
}

/** Merge a `ui/notifications/host-context-changed` payload, flat or wrapped in `hostContext`. */
export function mergeHostContext(state: PluginHostContext, params: unknown): PluginHostContext {
  const source = record(params);
  if (!source) return state;
  return applyUpdate(state, record(source.hostContext) ?? source);
}

export function layoutFlags(state: PluginHostContext): PluginLayoutFlags {
  const fullscreen = state.displayMode === 'fullscreen';
  return {
    canExpand: !fullscreen && state.availableDisplayModes.includes('fullscreen'),
    fillContainer: fullscreen && (state.containerDimensions?.height ?? 0) > 0,
  };
}
