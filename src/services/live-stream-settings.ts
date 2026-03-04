/**
 * Live stream playback preferences shared across Live News + Live Webcams.
 *
 * Default: Always On (no idle auto-pause). Users can enable Eco mode to
 * pause streams after inactivity to reduce CPU/bandwidth.
 */

const STORAGE_KEY_LIVE_STREAMS_ALWAYS_ON = 'wm-live-streams-always-on';
const EVENT_NAME = 'wm-live-streams-settings-changed';

function readBool(key: string, defaultValue: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return defaultValue;
    return raw === 'true';
  } catch {
    return defaultValue;
  }
}

function writeBool(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // ignore
  }
}

export function getLiveStreamsAlwaysOn(): boolean {
  return readBool(STORAGE_KEY_LIVE_STREAMS_ALWAYS_ON, true);
}

export function setLiveStreamsAlwaysOn(alwaysOn: boolean): void {
  writeBool(STORAGE_KEY_LIVE_STREAMS_ALWAYS_ON, alwaysOn);
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { alwaysOn } }));
}

export function subscribeLiveStreamsSettingsChange(cb: (alwaysOn: boolean) => void): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent).detail as { alwaysOn?: boolean } | undefined;
    cb(detail?.alwaysOn ?? getLiveStreamsAlwaysOn());
  };
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}
