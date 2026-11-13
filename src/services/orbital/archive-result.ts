export type ArchiveId = 'earth-search' | 'planetary-computer' | 'nasa-gibs' | 'eumetsat';

/** Why an archive gave no answer. Carries no URL, so no coordinate can ride along into a log or error report. */
export type ArchiveFailureReason = 'network' | 'http-status' | 'invalid-response' | 'aborted';

export interface ArchiveFailure {
  archive: ArchiveId;
  reason: ArchiveFailureReason;
  httpStatus?: number;
}

export type ArchiveResult<T> =
  | { status: 'ok'; archive: ArchiveId; items: T[] }
  | { status: 'failed'; archive: ArchiveId; failure: ArchiveFailure };

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const defaultFetch: FetchLike = (...args) => globalThis.fetch(...args);

export interface ArchiveRequestOptions {
  fetch?: FetchLike;
  signal?: AbortSignal;
}

export type ArchiveResponse =
  | { ok: true; response: Response }
  | { ok: false; failure: ArchiveFailure };

export async function requestArchive(
  archive: ArchiveId,
  url: string,
  init: RequestInit,
  options: ArchiveRequestOptions,
): Promise<ArchiveResponse> {
  const fetchFn = options.fetch ?? defaultFetch;
  try {
    const response = await fetchFn(url, { ...init, signal: options.signal });
    if (!response.ok) return { ok: false, failure: { archive, reason: 'http-status', httpStatus: response.status } };
    return { ok: true, response };
  } catch (error) {
    const reason = (error as { name?: string })?.name === 'AbortError' ? 'aborted' : 'network';
    return { ok: false, failure: { archive, reason } };
  }
}

export function failed<T>(failure: ArchiveFailure): ArchiveResult<T> {
  return { status: 'failed', archive: failure.archive, failure };
}
