/**
 * Desktop route for Clerk Frontend API calls (#9396).
 *
 * Clerk's production Frontend API rejects the desktop WebView origins
 * (`tauri://localhost`, `http(s)://tauri.localhost`) with `400 origin_invalid`,
 * and a WebView cannot omit `Origin`. On desktop, clerk-js runs with
 * `standardBrowser: false` and every Frontend API request it makes goes
 * through the Rust `clerk_fapi_request` command, which sends it without an
 * `Origin`, in Clerk's native mode, and keeps the client token out of renderer
 * script. Everything else, including the Clerk script bundles, uses the normal
 * fetch.
 */

import { hasTauriInvokeBridge, invokeTauri } from '@/services/tauri-bridge';

export interface ClerkRelayRequest {
  host: string;
  method: string;
  /** Path plus query, e.g. `/v1/client?_clerk_js_version=6.25.6`. */
  path: string;
  contentType?: string;
  body?: string;
}

export interface ClerkRelayResponse {
  status: number;
  contentType: string | null;
  body: string;
}

export type ClerkRelayInvoke = (request: ClerkRelayRequest) => Promise<ClerkRelayResponse>;

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

async function requestBody(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<{ body?: string; contentType?: string }> {
  const body = init?.body ?? null;
  if (body === null) {
    if (input instanceof Request && init?.body === undefined && input.body) {
      return { body: await input.text() };
    }
    return {};
  }
  if (typeof body === 'string') return { body };
  if (body instanceof URLSearchParams) {
    return { body: body.toString(), contentType: 'application/x-www-form-urlencoded;charset=UTF-8' };
  }
  // clerk-js only sends FormData for profile image uploads, which the relay
  // does not carry. Fail the way fetch fails so clerk-js reports an error.
  throw new TypeError('Clerk desktop relay only carries text request bodies');
}

/**
 * The relay request for a Clerk Frontend API call, or null when the request
 * is not one (and should use the normal fetch).
 */
export async function toClerkRelayRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  fapiHost: string,
): Promise<ClerkRelayRequest | null> {
  let url: URL;
  try {
    url = new URL(requestUrl(input));
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.host !== fapiHost || !url.pathname.startsWith('/v1/')) {
    return null;
  }

  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const { body, contentType: implicitContentType } = await requestBody(input, init);
  const contentType = headers.get('content-type') ?? implicitContentType;

  const request: ClerkRelayRequest = { host: fapiHost, method, path: `${url.pathname}${url.search}` };
  if (contentType) request.contentType = contentType;
  if (body !== undefined) request.body = body;
  return request;
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

/** Settles as soon as the caller aborts; Rust may still finish the request. */
function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export function createClerkRelayFetch(
  baseFetch: typeof fetch,
  fapiHost: string,
  invoke: ClerkRelayInvoke,
): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = await toClerkRelayRequest(input, init, fapiHost);
    if (!request) return baseFetch(input, init);

    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (signal?.aborted) throw abortError();

    let relayed: ClerkRelayResponse;
    try {
      relayed = await raceWithAbort(invoke(request), signal);
    } catch (error) {
      if (signal?.aborted) throw abortError();
      throw new TypeError(`Clerk desktop relay failed: ${String(error)}`);
    }

    const headers = new Headers();
    if (relayed.contentType) headers.set('content-type', relayed.contentType);
    const body = NULL_BODY_STATUSES.has(relayed.status) ? null : relayed.body;
    return new Response(body, { status: relayed.status, headers });
  };
}

let installedHost: string | null = null;


/**
 * Route clerk-js Frontend API calls for `fapiHost` through the Rust relay.
 * Returns false, and changes nothing, when there is no Tauri bridge to relay
 * through (a desktop-runtime build opened in a plain browser). Idempotent;
 * wraps whatever `window.fetch` is current, so it composes with the desktop
 * API fetch patch in runtime.ts.
 */
export function installClerkDesktopRelay(fapiHost: string): boolean {
  if (typeof window === 'undefined' || !fapiHost || !hasTauriInvokeBridge()) return false;
  if (installedHost === fapiHost) return true;
  installedHost = fapiHost;
  window.fetch = createClerkRelayFetch(
    window.fetch.bind(window),
    fapiHost,
    (request) => invokeTauri<ClerkRelayResponse>('clerk_fapi_request', { request }),
  );
  return true;
}
