/**
 * Fetch with a deadline that also covers the caller's response-body read.
 */
export async function fetchWithTimeout(url: string, init: RequestInit = {}, timeout = 8000): Promise<Response> {
  const deadline = AbortSignal.timeout(timeout);
  const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  return fetch(url, { ...init, signal });
}
