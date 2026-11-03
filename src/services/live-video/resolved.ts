// The video each catalog channel has live now, published every 6 h by seed-live-video-resolved (#8545) and read
// through the on-demand bootstrap URL. Fetched at play intent only, never at boot, and only by slots that list a
// channel. Anything missing, slow, stale or malformed reads as an empty map, so the slot plays its static catalog.
import { track } from '@/services/analytics';
import { ensureHydrated } from '@/services/bootstrap';

import { type LiveVideoSource, parseResolvedLiveVideos, type ResolvedLiveVideos, withResolvedEntries } from './model';

const MEMO_MS = 10 * 60_000;
const DEFAULT_TIMEOUT_MS = 1_500;
const EMPTY: ResolvedLiveVideos = new Map();

let memo: { readonly map: ResolvedLiveVideos; readonly fetchedAtMs: number } | null = null;
let inflight: Promise<ResolvedLiveVideos> | null = null;

function refresh(): Promise<ResolvedLiveVideos> {
  inflight ??= ensureHydrated('liveVideoResolved')
    .then((raw) => parseResolvedLiveVideos(raw, Date.now()), () => EMPTY)
    .then((map) => {
      memo = { map, fetchedAtMs: Date.now() };
      return map;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * The resolved map, memoised for 10 minutes. Waits at most `timeoutMs` for a fetch; past that it answers with the
 * previous map (or an empty one) and lets the fetch keep filling the memo for the next play. Never rejects.
 */
export async function getResolvedLiveVideos({ timeoutMs = DEFAULT_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<ResolvedLiveVideos> {
  if (memo && Date.now() - memo.fetchedAtMs < MEMO_MS) return memo.map;
  const fallback = memo?.map ?? EMPTY;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ResolvedLiveVideos>((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs);
  });
  try {
    return await Promise.race([refresh(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The source with each channel's resolved live video inserted before that channel entry. Callers skip this for a
 * source without a channel entry (`sourceListsChannel`), so such a slot never fetches the map.
 */
export async function withResolvedLiveVideos(source: LiveVideoSource): Promise<LiveVideoSource> {
  const merged = withResolvedEntries(source, await getResolvedLiveVideos(), Date.now());
  if (merged !== source) {
    track('live-video-resolved-applied', { slot: source.slot, count: merged.entries.length - source.entries.length });
  }
  return merged;
}

export function __resetResolvedLiveVideosForTests(): void {
  memo = null;
  inflight = null;
}
