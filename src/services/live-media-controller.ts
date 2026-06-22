export type LiveMediaStopReason = 'user-paused' | 'replaced' | 'idle' | 'hidden' | 'scroll-away' | 'destroyed';

export interface ActiveLiveMediaSnapshot {
  panelId: string;
  streamId: string;
}

interface ActiveLiveMedia {
  panelId: string;
  streamId: string;
  stop: (reason: LiveMediaStopReason) => void;
}

// One entry per panel. A panel that owns a single player (Live News) registers here so
// switching its stream replaces the previous one. Panels do NOT evict each other: explicitly
// played feeds coexist (the dashboard "wall"), gated only by user intent. Multi-stream panels
// (the webcam grid) track their own active set and stay out of this map.
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
): void {
  const currentPanel = activeLiveMedia.get(panelId);
  if (currentPanel && currentPanel.streamId !== streamId) {
    stopActiveEntry(currentPanel, 'replaced');
  }

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
