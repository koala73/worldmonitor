import { isDesktopRuntime, getRemoteApiBaseUrl } from '@/services/runtime';

interface LiveVideoInfo {
  videoId: string | null;
  hlsUrl: string | null;
}

const liveVideoCache = new Map<string, { videoId: string | null; hlsUrl: string | null; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function fetchLiveVideoInfo(channelHandle: string): Promise<LiveVideoInfo> {
  const cached = liveVideoCache.get(channelHandle);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return { videoId: cached.videoId, hlsUrl: cached.hlsUrl };
  }

  try {
    const baseUrl = isDesktopRuntime() ? getRemoteApiBaseUrl() : '';
    const res = await fetch(`${baseUrl}/api/youtube/live?channel=${encodeURIComponent(channelHandle)}`);
    if (!res.ok) throw new Error('API error');
    const data = await res.json();
    const videoId = data.videoId || null;
    const hlsUrl = data.hlsUrl || null;
    liveVideoCache.set(channelHandle, { videoId, hlsUrl, timestamp: Date.now() });
    return { videoId, hlsUrl };
  } catch (error) {
    console.warn(`[LiveNews] Failed to fetch live info for ${channelHandle}:`, error);
    return { videoId: null, hlsUrl: null };
  }
}

/** @deprecated Use fetchLiveVideoInfo instead */
export async function fetchLiveVideoId(channelHandle: string): Promise<string | null> {
  const info = await fetchLiveVideoInfo(channelHandle);
  return info.videoId;
}
