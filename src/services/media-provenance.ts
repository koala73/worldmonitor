/**
 * Media checks from the /verify page (#9096). A PRO feature: the page loads
 * sign-in only when someone pastes a media link, so a claim check stays free
 * and works signed out.
 */
import type { GetMediaProvenanceResponse, MediaProvenance } from '@/generated/client/worldmonitor/news/v1/service_client';

export type { MediaProvenance };

export type MediaCheckOutcome =
  | { readonly kind: 'done'; readonly result: MediaProvenance }
  | { readonly kind: 'failed'; readonly error: string }
  | { readonly kind: 'needs-sign-in' }
  | { readonly kind: 'needs-pro' }
  | { readonly kind: 'unavailable' };

const CHECK_PATH = '/api/news/v1/check-media-provenance';
const POLL_INTERVAL_MS = 2_000;
// The worker stops a check after 4 minutes; allow for a short queue on top.
const POLL_TIMEOUT_MS = 300_000;

/** True when the whole input is one http(s) link: /verify then checks the media, not a claim. */
export function isMediaCheckInput(text: string): boolean {
  const value = text.trim();
  if (!value || /\s/.test(value) || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface MediaCheckDeps {
  readonly fetch: FetchLike;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}

function outcomeForStatus(status: number): MediaCheckOutcome | null {
  if (status === 401) return { kind: 'needs-sign-in' };
  if (status === 403) return { kind: 'needs-pro' };
  return null;
}

/** Queue a check and poll it to a result. Never throws. */
export async function checkMediaUrl(url: string, deps: MediaCheckDeps): Promise<MediaCheckOutcome> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  try {
    const started = await deps.fetch(CHECK_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url.trim() }),
      signal: deps.signal,
    });
    const gate = outcomeForStatus(started.status);
    if (gate) return gate;
    if (started.status === 400) {
      const body = await started.json().catch(() => ({})) as { violations?: Array<{ description?: string }> };
      const reason = body.violations?.[0]?.description;
      return { kind: 'failed', error: reason ? `${reason[0]!.toUpperCase()}${reason.slice(1)}.` : 'This link cannot be checked.' };
    }
    if (!started.ok) return { kind: 'unavailable' };
    const job = await started.json() as { statusUrl?: unknown };
    if (typeof job.statusUrl !== 'string' || !job.statusUrl.startsWith('/api/news/v1/get-media-provenance?')) return { kind: 'unavailable' };

    const deadline = now() + POLL_TIMEOUT_MS;
    while (now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      if (deps.signal?.aborted) return { kind: 'unavailable' };
      const res = await deps.fetch(job.statusUrl, { signal: deps.signal });
      const polledGate = outcomeForStatus(res.status);
      if (polledGate) return polledGate;
      if (!res.ok) return { kind: 'unavailable' };
      const body = await res.json() as GetMediaProvenanceResponse;
      if (body.status === 'done' && body.result) return { kind: 'done', result: body.result };
      if (body.status === 'failed') return { kind: 'failed', error: body.error || 'The check could not be completed.' };
    }
    return { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}

/**
 * Sign-in for a media check, loaded on demand. Resolves once Clerk has settled
 * (or after 5 s): true when someone is signed in.
 */
export async function ensureSignedInState(): Promise<boolean> {
  const { initAuthState, subscribeAuthState } = await import('@/services/auth-state');
  await initAuthState();
  return new Promise<boolean>((resolve) => {
    let done = false;
    let unsubscribe: (() => void) | null = null;
    const finish = (signedIn: boolean) => {
      if (done) return;
      done = true;
      unsubscribe?.();
      resolve(signedIn);
    };
    const timer = setTimeout(() => finish(false), 5_000);
    unsubscribe = subscribeAuthState((state) => {
      if (!state.isPending) {
        clearTimeout(timer);
        finish(state.user !== null);
      }
    });
    if (done) unsubscribe();
  });
}

export async function openMediaSignIn(): Promise<void> {
  const { openSignIn } = await import('@/services/clerk');
  openSignIn();
}

export async function premiumMediaFetch(): Promise<FetchLike> {
  const { premiumFetch } = await import('@/services/premium-fetch');
  return (input, init) => premiumFetch(input, init);
}
