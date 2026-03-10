import type { ImageryScene } from '@/generated/server/worldmonitor/imagery/v1/service_server';

export type { ImageryScene };

export interface ImagerySearchParams {
  bbox: string;
  datetime?: string;
  source?: string;
  limit?: number;
}

export async function fetchImageryScenes(params: ImagerySearchParams): Promise<ImageryScene[]> {
  const url = new URL('/api/imagery/v1/search-imagery', window.location.origin);
  url.searchParams.set('bbox', params.bbox);
  if (params.datetime) url.searchParams.set('datetime', params.datetime);
  if (params.source) url.searchParams.set('source', params.source);
  if (params.limit) url.searchParams.set('limit', String(params.limit));

  const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(15_000) });
  if (!resp.ok) return [];
  const data = await resp.json();
  return data.scenes ?? [];
}
