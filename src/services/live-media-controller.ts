export type LiveMediaStopReason = 'user-paused' | 'replaced' | 'idle' | 'hidden' | 'scroll-away' | 'destroyed';

export interface ActiveLiveMediaSnapshot {
  panelId: string;
  streamId: string;
}

interface LiveMediaPlaybackOptions {
  exclusive?: boolean;
}

interface ActiveLiveMedia {
  panelId: string;
  streamId: string;
  stop: (reason: LiveMediaStopReason) => void;
}

const activeLiveMedia = new Map<string, ActiveLiveMedia>();

function stopActiveEntry(entry: ActiveLiveMedia, reason: LiveMediaStopReason): void {
  activeLiveMedia.delete(entry.panelId);
  entry.stop(reason);
}

export function requestLiveMediaPlayback(
  panelId: string,
  streamId: string,
  start: () => void,
  stop: (reason: LiveMediaStopReason) => void,
  options: LiveMediaPlaybackOptions = {},
): void {
  const exclusive = options.exclusive ?? true;
  const currentPanel = activeLiveMedia.get(panelId);
  if (currentPanel && currentPanel.streamId !== streamId) {
    stopActiveEntry(currentPanel, 'replaced');
  }

  if (exclusive) {
    for (const entry of Array.from(activeLiveMedia.values())) {
      if (entry.panelId !== panelId) {
        stopActiveEntry(entry, 'replaced');
      }
    }
  }

  activeLiveMedia.delete(panelId);
  activeLiveMedia.set(panelId, { panelId, streamId, stop });
  start();
}

export function stopLiveMediaPlayback(panelId: string, reason: LiveMediaStopReason): void {
  const current = activeLiveMedia.get(panelId);
  if (!current) return;
  stopActiveEntry(current, reason);
}

export function releaseLiveMediaPlayback(panelId: string, streamId?: string): void {
  const current = activeLiveMedia.get(panelId);
  if (!current) return;
  if (streamId && current.streamId !== streamId) return;
  activeLiveMedia.delete(panelId);
}

export function enforceExclusiveLiveMediaPlayback(preferredPanelId?: string): void {
  const entries = Array.from(activeLiveMedia.values());
  const latestEntry = entries[entries.length - 1];
  const keepPanelId = preferredPanelId && activeLiveMedia.has(preferredPanelId)
    ? preferredPanelId
    : latestEntry?.panelId;
  if (!keepPanelId) return;

  for (const entry of entries) {
    if (entry.panelId === keepPanelId) continue;
    stopActiveEntry(entry, 'replaced');
  }
}

export function getActiveLiveMedia(panelId?: string): ActiveLiveMediaSnapshot | null {
  const active = panelId
    ? activeLiveMedia.get(panelId)
    : activeLiveMedia.values().next().value as ActiveLiveMedia | undefined;
  if (!active) return null;
  return {
    panelId: active.panelId,
    streamId: active.streamId,
  };
}
