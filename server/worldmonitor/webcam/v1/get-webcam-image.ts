import type { GetWebcamImageRequest, GetWebcamImageResponse, ServerContext } from '../../../../src/generated/server/worldmonitor/webcam/v1/service_server';
import { cachedFetchJsonWithMeta, getCachedJson, getHashFieldsBatch } from '../../../_shared/redis';
import { CHROME_UA } from '../../../_shared/constants';

const WINDY_BASE = 'https://api.windy.com/webcams/api/v3/webcams';
const CACHE_TTL = 300;

const WEBCAM_ID_RE = /^[\w-]+$/;
// Windy IDs from the seeded camera catalog are short opaque strings. Bound the
// public request value before it can form a Redis key or a paid provider URL.
const MAX_WEBCAM_ID_LENGTH = 64;

function normalizeWebcamId(value: string | undefined): string | null {
  const webcamId = value?.trim();
  if (!webcamId || webcamId.length > MAX_WEBCAM_ID_LENGTH || !WEBCAM_ID_RE.test(webcamId)) return null;
  return webcamId;
}

async function isSeededWebcamId(webcamId: string): Promise<boolean> {
  // The desktop sidecar has an isolated in-memory cache and does not receive
  // the Railway-seeded catalog. Its requests are local application traffic,
  // not freely mintable public sessions, so preserve its existing image path.
  if (process.env.LOCAL_API_MODE === 'tauri-sidecar') return true;

  // The Railway seeder writes the active pointer outside Vercel's deployment
  // prefix, so preview and development reads must use the seed-owned raw key.
  const activeVersion = await getCachedJson('webcam:cameras:active', true);
  if (activeVersion == null) return false;

  const version = String(activeVersion);
  if (!version) return false;

  // The map only asks this proxy for IDs from this seed-owned metadata hash.
  // On an image-cache miss, check membership before writing a new cache entry
  // or calling the provider.
  const webcamMeta = await getHashFieldsBatch(`webcam:cameras:meta:${version}`, [webcamId], true);
  return webcamMeta.has(webcamId);
}

export async function getWebcamImage(_ctx: ServerContext, req: GetWebcamImageRequest): Promise<GetWebcamImageResponse> {
  const rawWebcamId = req.webcamId ?? '';
  const webcamId = normalizeWebcamId(req.webcamId);
  const windyUrl = `https://www.windy.com/webcams/${encodeURIComponent(webcamId ?? rawWebcamId)}`;

  if (!webcamId) {
    return { thumbnailUrl: '', playerUrl: '', title: '', windyUrl, lastUpdated: '', error: 'missing webcam_id' };
  }

  const apiKey = process.env.WINDY_API_KEY;
  if (!apiKey) {
    return { thumbnailUrl: '', playerUrl: '', title: '', windyUrl, lastUpdated: '', error: 'unavailable' };
  }

  try {
    const { data: result } = await cachedFetchJsonWithMeta<GetWebcamImageResponse>(
      `webcam:image:${webcamId}`,
      CACHE_TTL,
      async () => {
        const resp = await fetch(`${WINDY_BASE}/${encodeURIComponent(webcamId)}?include=images,player,urls`, {
          headers: { 'x-windy-api-key': apiKey, 'User-Agent': CHROME_UA },
          redirect: 'manual',
          signal: AbortSignal.timeout(5000),
        });
        if (!resp.ok) return null;

        const data = await resp.json();
        const wc = data.webcams?.[0] ?? data;
        if (!wc || wc.status === 'inactive') return null;
        // Windy v3: images.current, player.<timespan>, urls.detail (not urls.player).
        // https://api.windy.com/webcams/version-transfer
        const thumbnailUrl = providerUrl(wc.images?.current?.preview) || providerUrl(wc.images?.current?.thumbnail);
        const timelapseUrl = ['day', 'month', 'year', 'lifetime'].map(span => providerUrl(wc.player?.[span])).find(Boolean) || '';
        const playerUrl = timelapseUrl || providerUrl(wc.player?.live);
        if (!thumbnailUrl && !playerUrl) return null;
        const capturedAt = typeof wc.lastUpdatedOn === 'string' ? Date.parse(wc.lastUpdatedOn) : NaN;

        return {
          thumbnailUrl,
          playerUrl,
          title: typeof wc.title === 'string' ? wc.title : '',
          windyUrl: providerUrl(wc.urls?.detail) || windyUrl,
          lastUpdated: Number.isFinite(capturedAt) ? new Date(capturedAt).toISOString() : '',
          resolvedAt: Date.now(),
          mediaType: timelapseUrl ? 'timelapse' : playerUrl ? 'live' : 'snapshot',
          error: '',
        };
      },
      120,
      { shouldFetch: () => isSeededWebcamId(webcamId) },
    );

    return result ?? { thumbnailUrl: '', playerUrl: '', title: '', windyUrl, lastUpdated: '', error: 'unavailable' };
  } catch {
    // Provider timeouts, malformed responses and cache failures are media misses.
    return { thumbnailUrl: '', playerUrl: '', title: '', windyUrl, lastUpdated: '', error: 'unavailable' };
  }
}

function providerUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? value : '';
  } catch { return ''; }
}
