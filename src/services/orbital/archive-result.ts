export type ArchiveId = 'earth-search' | 'planetary-computer' | 'nasa-gibs' | 'eumetsat';

/** Why an archive gave no answer. Carries no URL, so no coordinate can ride along into a log or error report. */
export type ArchiveFailureReason = 'network' | 'http-status' | 'invalid-response' | 'timeout' | 'aborted';

export interface ArchiveFailure {
  archive: ArchiveId;
  reason: ArchiveFailureReason;
  httpStatus?: number;
  /** The layer that failed, when an archive answers per layer. */
  source?: string;
}

export type ArchiveResult<T> =
  /** `failures` lists layers that failed while others answered. */
  | { status: 'ok'; archive: ArchiveId; items: T[]; failures?: ArchiveFailure[] }
  | { status: 'failed'; archive: ArchiveId; failure: ArchiveFailure };

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const defaultFetch: FetchLike = (...args) => globalThis.fetch(...args);

/** How long one archive request, body included, may take before it counts as unanswered. */
export const ARCHIVE_REQUEST_TIMEOUT_MS = 15_000;

export interface ArchiveRequestOptions {
  fetch?: FetchLike;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type ArchiveReply<T> =
  | { ok: true; value: T }
  | { ok: false; failure: ArchiveFailure };

function eitherSignal(a: AbortSignal, b: AbortSignal): { signal: AbortSignal; release: () => void } {
  if (typeof AbortSignal.any === 'function') return { signal: AbortSignal.any([a, b]), release: () => {} };
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (a.aborted || b.aborted) abort();
  a.addEventListener('abort', abort, { once: true });
  b.addEventListener('abort', abort, { once: true });
  const release = () => {
    a.removeEventListener('abort', abort);
    b.removeEventListener('abort', abort);
  };
  return { signal: controller.signal, release };
}

/**
 * Fetches and reads one archive answer inside a deadline. `read` throwing
 * means the archive answered with something unreadable.
 */
export async function requestArchive<T>(
  archive: ArchiveId,
  url: string,
  init: RequestInit,
  options: ArchiveRequestOptions,
  read: (response: Response) => Promise<T>,
): Promise<ArchiveReply<T>> {
  const fetchFn = options.fetch ?? defaultFetch;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), options.timeoutMs ?? ARCHIVE_REQUEST_TIMEOUT_MS);
  const { signal, release } = options.signal ? eitherSignal(options.signal, deadline.signal) : { signal: deadline.signal, release: () => {} };
  const stopped = () => ({ ok: false as const, failure: { archive, reason: deadline.signal.aborted && !options.signal?.aborted ? 'timeout' as const : 'aborted' as const } });
  const work = (async (): Promise<ArchiveReply<T>> => {
    let response: Response;
    try {
      response = await fetchFn(url, { ...init, signal });
    } catch {
      return signal.aborted ? stopped() : { ok: false, failure: { archive, reason: 'network' } };
    }
    if (!response.ok) return { ok: false, failure: { archive, reason: 'http-status', httpStatus: response.status } };
    try {
      return { ok: true, value: await read(response) };
    } catch {
      return signal.aborted ? stopped() : { ok: false, failure: { archive, reason: 'invalid-response' } };
    }
  })();
  const abandoned = new Promise<ArchiveReply<T>>((resolve) => {
    if (signal.aborted) resolve(stopped());
    else signal.addEventListener('abort', () => resolve(stopped()), { once: true });
  });
  try {
    return await Promise.race([work, abandoned]);
  } finally {
    clearTimeout(timer);
    release();
  }
}

export function failed<T>(failure: ArchiveFailure): ArchiveResult<T> {
  return { status: 'failed', archive: failure.archive, failure };
}
