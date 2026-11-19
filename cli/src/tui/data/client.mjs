// HTTP client for the hosted WorldMonitor API. Public reads need no credential;
// session reads mint an anonymous short-lived token exactly like the browser
// (POST /api/wm-session) and send it in X-WorldMonitor-Key. A user API key, when
// configured, is sent instead of the session token.
import { API_KEY_HEADER, DEFAULT_BASE_URL, VERSION } from '../../core.mjs';

export class ApiError extends Error {
  constructor(status, body, url) {
    const detail = body && typeof body === 'object' ? body.error || body.message || JSON.stringify(body).slice(0, 120) : String(body || '').slice(0, 120);
    super(`HTTP ${status}${detail ? `: ${detail}` : ''}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

function trimSlash(url) {
  const text = String(url || '');
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 47) end--;
  return text.slice(0, end);
}

export function createClient(options = {}) {
  const baseUrl = trimSlash(options.baseUrl || DEFAULT_BASE_URL);
  const apiKey = options.apiKey || '';
  const userAgent = options.userAgent || `worldmonitor-tui/${VERSION} (+https://worldmonitor.app)`;
  const fetchImpl = options.fetch || globalThis.fetch;
  const timeoutMs = options.timeoutMs || 25000;
  const now = options.now || (() => Date.now());
  let session = null; // { token, exp }
  let minting = null;
  let closed = false;
  const inflight = new Set(); // AbortControllers of requests still running

  async function request(path, init = {}) {
    if (closed) throw new Error('client closed');
    const url = path.startsWith('http') ? path : `${baseUrl}${path}`;
    const controller = new AbortController();
    inflight.add(controller);
    const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        ...init,
        // Never follow redirects: fetch would forward the key or session
        // token in X-WorldMonitor-Key to the target, even on another host.
        redirect: 'manual',
        headers: { 'user-agent': userAgent, accept: 'application/json', ...(init.headers || {}) },
        signal: controller.signal,
      });
      const text = await res.text();
      let body = text;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      if (!res.ok) throw new ApiError(res.status, body, url);
      return body;
    } finally {
      clearTimeout(timer);
      inflight.delete(controller);
    }
  }

  async function mintSession() {
    if (!minting) {
      minting = request('/api/wm-session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
        .then((body) => {
          if (!body || typeof body.token !== 'string') throw new Error('session mint returned no token');
          session = { token: body.token, exp: Number(body.exp) || now() + 11 * 3600 * 1000 };
          return session.token;
        })
        .finally(() => {
          minting = null;
        });
    }
    return minting;
  }

  async function credential() {
    if (apiKey) return apiKey;
    if (session && session.exp - 60000 > now()) return session.token;
    return mintSession();
  }

  return {
    baseUrl,
    hasApiKey: Boolean(apiKey),
    async getJson(path, { auth = 'none' } = {}) {
      if (auth === 'none') return request(path);
      let token = await credential();
      try {
        return await request(path, { headers: { [API_KEY_HEADER]: token } });
      } catch (err) {
        if (err instanceof ApiError && err.status === 401 && !apiKey) {
          session = null;
          token = await mintSession();
          return request(path, { headers: { [API_KEY_HEADER]: token } });
        }
        throw err;
      }
    },
    sessionState() {
      return session ? { ...session } : null;
    },
    // Abort every in-flight request and refuse new ones, so quitting the
    // dashboard does not leave the process waiting on open sockets.
    close() {
      closed = true;
      for (const controller of inflight) controller.abort(new Error('client closed'));
      inflight.clear();
    },
  };
}
