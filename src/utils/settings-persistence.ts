export interface ExportedSettings {
  version: number;
  timestamp: string;
  variant: string;
  data: Record<string, string>;
}

export interface ImportResult {
  success: boolean;
  keysImported: number;
  error?: string;
}

import { CLOUD_SYNC_KEYS } from './sync-keys';
import { invalidatePanelStorageCacheForKeys } from './panel-storage';
import { safeStorageSnapshot } from './safe-storage';

const MAX_IMPORT_SIZE_BYTES = 5 * 1024 * 1024;

const SETTINGS_KEYS: readonly string[] = [
  ...CLOUD_SYNC_KEYS,
  // device-local / export-only (excluded from cloud sync)
  'worldmonitor-live-channels',
  'worldmonitor-active-channel',
  'worldmonitor-runtime-feature-toggles',
  'wm-globe-render-scale',
  'wm-live-streams-always-on',
  'worldmonitor-webcam-prefs',
  'worldmonitor-disabled-feeds-schema',
  'map-height',
  'map-split-height',
  'map-col-width',
  'map-side',
  'map-pinned',
  'mobile-map-collapsed',
  'positive-threshold',
];

function isSettingsKey(key: string): boolean {
  return SETTINGS_KEYS.includes(key)
    || /^(?:worldmonitor-panels|worldmonitor-layers|worldmonitor-disabled-feeds)-(?:full|tech|finance|commodity|energy|happy)$/.test(key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isMonitorList(value: unknown): boolean {
  return Array.isArray(value) && value.every(monitor =>
    isRecord(monitor)
    && typeof monitor.id === 'string'
    && typeof monitor.color === 'string'
    && Array.isArray(monitor.keywords)
    && monitor.keywords.every(keyword => typeof keyword === 'string')
    && (monitor.name === undefined || typeof monitor.name === 'string')
    && (monitor.lat === undefined || (typeof monitor.lat === 'number' && Number.isFinite(monitor.lat)))
    && (monitor.lon === undefined || (typeof monitor.lon === 'number' && Number.isFinite(monitor.lon))),
  );
}

function validateSetting(key: string, raw: string, policies: {
  MAX_IMPORTED: number; MAX_INSTRUCTIONS_LEN: number;
  MAP_THEME_OPTIONS: Record<string, { value: string }[]>;
  STREAM_QUALITY_OPTIONS: readonly { value: string }[];
}): void {
  const { MAX_IMPORTED, MAX_INSTRUCTIONS_LEN, MAP_THEME_OPTIONS, STREAM_QUALITY_OPTIONS } = policies;
  const invalid = (): never => { throw new Error(`Invalid setting: ${key}`); };
  if (key === 'worldmonitor-theme' && !['auto', 'dark', 'light'].includes(raw)) invalid();
  if (key === 'wm-map-provider' && !Object.prototype.hasOwnProperty.call(MAP_THEME_OPTIONS, raw)) invalid();
  if (key === 'wm-stream-quality' && !STREAM_QUALITY_OPTIONS.some(option => option.value === raw)) invalid();
  if (key.startsWith('wm-map-theme:')) {
    const provider = key.slice('wm-map-theme:'.length) as keyof typeof MAP_THEME_OPTIONS;
    if (!MAP_THEME_OPTIONS[provider]?.some(option => option.value === raw)) invalid();
  }
  if (key === 'wm-analysis-frameworks') {
    const frameworks: unknown = JSON.parse(raw);
    if (!Array.isArray(frameworks) || frameworks.length > MAX_IMPORTED) invalid();
    if (!Array.isArray(frameworks)) return;
    for (const fw of frameworks) {
      if (!isRecord(fw) || typeof fw.id !== 'string' || typeof fw.name !== 'string'
        || typeof fw.description !== 'string' || typeof fw.systemPromptAppend !== 'string'
        || fw.systemPromptAppend.length > MAX_INSTRUCTIONS_LEN || fw.isBuiltIn !== false
        || typeof fw.createdAt !== 'number' || !Number.isFinite(fw.createdAt)) invalid();
    }
  }
  if (key === 'wm-panel-frameworks') {
    const selections: unknown = JSON.parse(raw);
    if (!isRecord(selections) || !Object.values(selections).every(value => value === null || typeof value === 'string')) invalid();
  }
  if (key === 'worldmonitor-live-channels') {
    const channels: unknown = JSON.parse(raw);
    if (!isRecord(channels) || !Array.isArray(channels.order) || !channels.order.every(id => typeof id === 'string')
      || !Array.isArray(channels.custom)) invalid();
    if (!isRecord(channels) || !Array.isArray(channels.custom)) return;
    for (const channel of channels.custom) {
      if (!isRecord(channel) || typeof channel.id !== 'string' || typeof channel.name !== 'string') invalid();
      if (channel.handle !== undefined && typeof channel.handle !== 'string') invalid();
      if (channel.hlsUrl !== undefined) {
        if (typeof channel.hlsUrl !== 'string' || channel.hlsUrl.length > 2048) invalid();
        const url = new URL(channel.hlsUrl);
        if (url.username || url.password || !(url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === '127.0.0.1'))) invalid();
      }
    }
  }
}

async function parseImportedEntries(parsed: unknown): Promise<Array<[string, string]>> {
  if (!isRecord(parsed) || !isRecord(parsed.data)) {
    throw new Error('Invalid format: expected an object with a data property.');
  }
  if (parsed.version !== 1) {
    throw new Error(`Unsupported settings version: ${parsed.version}`);
  }

  const [frameworks, maps, streams] = await Promise.all([
    import('@/services/analysis-framework-store'), import('@/config/basemap'), import('@/services/ai-flow-settings'),
  ]);
  const policies = { ...frameworks, ...maps, ...streams };
  const entries: Array<[string, string]> = [];
  let decodedBytes = 0;
  const encoder = new TextEncoder();
  for (const [key, value] of Object.entries(parsed.data)) {
    if (!isSettingsKey(key)) continue;
    if (typeof value !== 'string') {
      throw new Error(`Invalid setting: ${key} must be a string.`);
    }
    const size = encoder.encode(value).length;
    decodedBytes += size;
    if (size > 256 * 1024 || decodedBytes > 1024 * 1024) throw new Error('Settings payload is too large.');
    validateSetting(key, value, policies);
    // The monitor reader trusts the stored JSON and immediately uses array
    // and string methods. Reject invalid records before changing any settings.
    if (key === 'worldmonitor-monitors' && !isMonitorList(JSON.parse(value))) {
      throw new Error('Invalid setting: worldmonitor-monitors must contain monitor records.');
    }
    entries.push([key, value]);
  }
  return entries;
}

export const __testing__ = { isSettingsKey };

export function exportSettings(): void {
  const data: Record<string, string> = {};

  // Storage that cannot be read has no settings to export, and handing the
  // user a downloadable file anyway is worse than failing: the caller in
  // preferences-content.ts wraps this in try/catch and shows `exportSuccess`
  // when it returns, so a silent empty payload becomes a green "Exported"
  // toast over a backup containing nothing (#7833 review). Stay loud.
  //
  // Testing AVAILABILITY is not enough on its own, which an earlier round of
  // this fix got wrong: a handle can exist while enumeration or an individual
  // read throws, and the degrading accessors then return `[]`/`null` and
  // rebuild exactly that empty-but-successful backup. The snapshot reports
  // whether the reads themselves succeeded, so a partial one fails instead of
  // shipping a backup the user would only discover was empty when restoring.
  const snapshot = safeStorageSnapshot();
  if (!snapshot.ok) {
    throw new Error('Settings export could not read browser storage.');
  }

  let variant = 'full';
  for (const [key, value] of snapshot.entries) {
    if (key === 'worldmonitor-variant' && value) variant = value;
    if (isSettingsKey(key)) data[key] = value;
  }

  const exportData: ExportedSettings = {
    version: 1,
    timestamp: new Date().toISOString(),
    variant,
    data,
  };

  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.download = `worldmonitor-settings-${ts}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function importSettings(file: File): Promise<ImportResult> {
  return new Promise((resolve, reject) => {
    if (file.size > MAX_IMPORT_SIZE_BYTES) {
      reject(new Error('File is too large. Maximum size is 5MB.'));
      return;
    }

    const reader = new FileReader();

    reader.onload = async (e) => {
      try {
        const result = e.target?.result as string;
        const entries = await parseImportedEntries(JSON.parse(result));
        const { applyLocalPreferenceImport } = await import('./cloud-prefs-sync');
        const { invalidateFrameworkCache } = await import('@/services/analysis-framework-store');

        applyLocalPreferenceImport(entries);
        const importedKeys = entries.map(([key]) => key);
        invalidatePanelStorageCacheForKeys(importedKeys);
        invalidateFrameworkCache();
        const keysImported = entries.length;

        resolve({ success: true, keysImported });
      } catch (err) {
        reject(err);
      }
    };

    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
}
