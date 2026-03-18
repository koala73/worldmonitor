import { getRpcBaseUrl } from '@/services/rpc-client';
import {
  WebcamServiceClient,
  type WebcamEntry,
  type WebcamCluster,
  type ListWebcamsResponse,
  type GetWebcamImageResponse,
} from '@/generated/client/worldmonitor/webcam/v1/service_client';

const client = new WebcamServiceClient(getRpcBaseUrl(), {
  fetch: (...args) => globalThis.fetch(...args),
});

const emptyResponse: ListWebcamsResponse = { webcams: [], clusters: [], totalInView: 0 };

// Client-side image cache (9 min, under Windy's 10-min token expiry)
const IMAGE_CACHE_MS = 9 * 60 * 1000;
const IMAGE_CACHE_MAX = 200;
const imageCacheMap = new Map<string, { data: GetWebcamImageResponse; expires: number }>();

export async function fetchWebcams(
  zoom: number,
  bounds: { w: number; s: number; e: number; n: number },
): Promise<ListWebcamsResponse> {
  try {
    return await client.listWebcams({
      zoom,
      boundW: bounds.w,
      boundS: bounds.s,
      boundE: bounds.e,
      boundN: bounds.n,
    });
  } catch (err) {
    console.warn('[webcams] fetch failed:', err);
    return emptyResponse;
  }
}

export async function fetchWebcamImage(webcamId: string): Promise<GetWebcamImageResponse> {
  // Check client cache
  const cached = imageCacheMap.get(webcamId);
  if (cached && cached.expires > Date.now()) return cached.data;

  try {
    const result = await client.getWebcamImage({ webcamId });
    if (!result.error) {
      if (imageCacheMap.size >= IMAGE_CACHE_MAX) {
        const oldest = imageCacheMap.keys().next().value;
        if (oldest) imageCacheMap.delete(oldest);
      }
      imageCacheMap.set(webcamId, { data: result, expires: Date.now() + IMAGE_CACHE_MS });
    }
    return result;
  } catch (err) {
    console.warn('[webcams] image fetch failed:', err);
    return {
      thumbnailUrl: '', playerUrl: '', title: '',
      windyUrl: `https://www.windy.com/webcams/${webcamId}`,
      lastUpdated: '', error: 'unavailable',
    };
  }
}

// Category mapping for marker rendering
export const WEBCAM_CATEGORIES: Record<string, { color: string; emoji: string }> = {
  traffic:   { color: '#ffd700', emoji: '\u{1F697}' },    // 🚗
  city:      { color: '#00d4ff', emoji: '\u{1F3D9}\uFE0F' }, // 🏙️
  landscape: { color: '#45b7d1', emoji: '\u{1F3D4}\uFE0F' }, // 🏔️
  nature:    { color: '#96ceb4', emoji: '\u{1F33F}' },    // 🌿
  beach:     { color: '#f4a460', emoji: '\u{1F3D6}\uFE0F' }, // 🏖️
  water:     { color: '#4169e1', emoji: '\u{1F30A}' },    // 🌊
  other:     { color: '#888888', emoji: '\u{1F4F7}' },    // 📷
};

export function getClusterCellSize(zoom: number): number {
  if (zoom < 3) return 8;
  if (zoom <= 4) return 5;
  if (zoom <= 6) return 2;
  if (zoom <= 8) return 0.5;
  return 0.5;
}

export function getCategoryStyle(category: string) {
  return WEBCAM_CATEGORIES[category] ?? WEBCAM_CATEGORIES.other!;
}

export type { WebcamEntry, WebcamCluster, GetWebcamImageResponse };
