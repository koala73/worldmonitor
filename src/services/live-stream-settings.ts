/**
 * Live stream playback preferences shared across Live News + Live Webcams.
 *
 * `alwaysOn` means autoplay on load; the default requires user intent.
 * `idleStop` is how long live video keeps playing without user activity.
 */

const STORAGE_KEY_LIVE_STREAMS_ALWAYS_ON = 'wm-live-streams-always-on';
export const LIVE_MEDIA_IDLE_STOP_STORAGE_KEY = 'wm-live-media-idle-stop';
const EVENT_NAME = 'wm-live-streams-settings-changed';
const CLOUD_PREFS_APPLIED_EVENT = 'wm:cloud-prefs-applied';
const OWN_KEYS: ReadonlySet<unknown> = new Set([STORAGE_KEY_LIVE_STREAMS_ALWAYS_ON, LIVE_MEDIA_IDLE_STOP_STORAGE_KEY]);

export const LIVE_MEDIA_IDLE_STOP_MINUTES = [15, 30, 60, 120, 240] as const;
export type LiveMediaIdleStopMinutes = (typeof LIVE_MEDIA_IDLE_STOP_MINUTES)[number];
export type LiveMediaIdleStop = LiveMediaIdleStopMinutes | 'never';
export const LIVE_MEDIA_IDLE_STOP_OPTIONS: readonly LiveMediaIdleStop[] = [...LIVE_MEDIA_IDLE_STOP_MINUTES, 'never'];
export const DEFAULT_LIVE_MEDIA_IDLE_STOP: LiveMediaIdleStopMinutes = 60;

export interface LiveStreamSettings {
  readonly alwaysOn: boolean;
  readonly idleStop: LiveMediaIdleStop;
}

function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

function notify(): void {
  window.dispatchEvent(new CustomEvent(EVENT_NAME));
}

/** Parses a stored or submitted idle-stop value. Returns undefined for anything outside the offered options. */
export function parseLiveMediaIdleStop(raw: unknown): LiveMediaIdleStop | undefined {
  return LIVE_MEDIA_IDLE_STOP_OPTIONS.find((option) => option === raw || String(option) === raw);
}

/** Formats an idle-stop duration for the reader, as whole hours when the minutes divide evenly. */
export function formatIdleStopMinutes(minutes: number, locale: string): string {
  const inHours = minutes >= 60 && minutes % 60 === 0;
  return new Intl.NumberFormat(locale, { style: 'unit', unit: inHours ? 'hour' : 'minute', unitDisplay: 'long' })
    .format(inHours ? minutes / 60 : minutes);
}

/** Whether live panels autoplay as soon as they are visible. */
export function getLiveStreamsAlwaysOn(): boolean {
  return readRaw(STORAGE_KEY_LIVE_STREAMS_ALWAYS_ON) === 'true';
}

/**
 * The effective idle-stop duration. An absent or unrecognised value derives from always-on:
 * before this preference existed, always-on also disabled the idle stop (#950).
 */
export function getLiveMediaIdleStop(): LiveMediaIdleStop {
  return parseLiveMediaIdleStop(readRaw(LIVE_MEDIA_IDLE_STOP_STORAGE_KEY))
    ?? (getLiveStreamsAlwaysOn() ? 'never' : DEFAULT_LIVE_MEDIA_IDLE_STOP);
}

/** A snapshot of both preferences as they currently read from storage. */
export function getLiveStreamSettings(): LiveStreamSettings {
  return { alwaysOn: getLiveStreamsAlwaysOn(), idleStop: getLiveMediaIdleStop() };
}

/** Saves the idle-stop duration and notifies subscribers in this tab. */
export function setLiveMediaIdleStop(value: LiveMediaIdleStop): void {
  writeRaw(LIVE_MEDIA_IDLE_STOP_STORAGE_KEY, String(value));
  notify();
}

/** Saves the autoplay preference and notifies subscribers in this tab. */
export function setLiveStreamsAlwaysOn(alwaysOn: boolean): void {
  // The idle default derives from always-on, so pin it first or toggling autoplay would flip the idle select.
  if (parseLiveMediaIdleStop(readRaw(LIVE_MEDIA_IDLE_STOP_STORAGE_KEY)) === undefined) {
    writeRaw(LIVE_MEDIA_IDLE_STOP_STORAGE_KEY, String(getLiveMediaIdleStop()));
  }
  writeRaw(STORAGE_KEY_LIVE_STREAMS_ALWAYS_ON, String(alwaysOn));
  notify();
}

/**
 * Delivers a fresh settings snapshot whenever either key changes: a local write, another tab's
 * `storage` event, or a cloud row applied through `wm:cloud-prefs-applied`.
 */
export function subscribeLiveStreamsSettingsChange(cb: (settings: LiveStreamSettings) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const emit = () => cb(getLiveStreamSettings());
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || OWN_KEYS.has(event.key)) emit();
  };
  const onCloudApplied = (event: Event) => {
    const keys: unknown = (event as CustomEvent<{ keys?: unknown } | undefined>).detail?.keys;
    if (Array.isArray(keys) && keys.some((key) => OWN_KEYS.has(key))) emit();
  };
  window.addEventListener(EVENT_NAME, emit);
  window.addEventListener('storage', onStorage);
  window.addEventListener(CLOUD_PREFS_APPLIED_EVENT, onCloudApplied);
  return () => {
    window.removeEventListener(EVENT_NAME, emit);
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(CLOUD_PREFS_APPLIED_EVENT, onCloudApplied);
  };
}

/** Calls `cb` only when the autoplay preference changes, from any of the sources `subscribeLiveStreamsSettingsChange` covers. */
export function subscribeLiveStreamsAlwaysOnChange(cb: (alwaysOn: boolean) => void): () => void {
  let last = getLiveStreamsAlwaysOn();
  return subscribeLiveStreamsSettingsChange(({ alwaysOn }) => {
    if (alwaysOn === last) return;
    last = alwaysOn;
    cb(alwaysOn);
  });
}
