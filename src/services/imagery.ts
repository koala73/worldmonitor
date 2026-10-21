import { toApiUrl } from '@/services/runtime';
import type { ImageryScene } from '@/generated/server/worldmonitor/imagery/v1/service_server';

export type { ImageryScene };

export interface ImagerySearchParams {
  bbox: string;
  datetime?: string;
  source?: string;
  limit?: number;
}

let retryAfterUntil = 0;

export async function fetchImageryScenes(params: ImagerySearchParams): Promise<ImageryScene[]> {
  if (Date.now() < retryAfterUntil) throw new Error('Imagery search rate limited');
  const url = new URL(toApiUrl('/api/imagery/v1/search-imagery'), window.location.origin);
  url.searchParams.set('bbox', params.bbox);
  if (params.datetime) url.searchParams.set('datetime', params.datetime);
  if (params.source) url.searchParams.set('source', params.source);
  if (params.limit) url.searchParams.set('limit', String(params.limit));

  const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(15_000) });
  if (!resp.ok) {
    if (resp.status === 429) {
      const retryAfter = resp.headers.get('Retry-After');
      const seconds = retryAfter === null ? NaN : Number(retryAfter);
      const deadline = Number.isFinite(seconds) ? Date.now() + Math.max(0, seconds) * 1000 : Date.parse(retryAfter ?? '');
      retryAfterUntil = Number.isFinite(deadline) ? deadline : Date.now() + 60_000;
    }
    throw new Error(`Imagery search failed: ${resp.status}`);
  }
  const data = await resp.json();
  return data.scenes ?? [];
}
