/**
 * Apex `/mcp-grant` page bootstrap.
 *
 * Clerk-protected consent screen for the cross-subdomain Pro MCP flow.
 * The user lands here from the api-subdomain consent page (U4 will add
 * a "Sign in with WorldMonitor Pro" CTA on `api/oauth/authorize.js`).
 *
 * Flow on this page:
 *   1. Boot Clerk; if signed-out, openSignIn(). On sign-in, the modal
 *      closes and we re-enter via subscribeClerk().
 *   2. Read `?nonce=<n>` from the query string.
 *   3. GET /api/internal/mcp-grant-context?nonce=<n> with Bearer JWT to
 *      load the REAL `client_name` + `redirect_host`.
 *   4. Render the consent card (real metadata so users can spot phishing).
 *   5. On Authorize click: POST /api/internal/mcp-grant-mint {nonce}
 *      with Bearer JWT, navigate to the returned `redirect` URL (always
 *      `https://api.worldmonitor.app/oauth/authorize-pro?...` — the
 *      apex page never controls the host).
 */

import { initClerk, getClerkToken, getCurrentClerkUser, openSignIn, subscribeClerk } from '@/services/clerk';

// Apply user's saved theme preference. Inlined here (not the index.html head)
// because the page's global CSP is hash-allowlisted and adding per-page
// inline-script hashes is brittle. A brief default-theme flash on light-
// preference users is acceptable for this transient consent UI.
try {
  const savedTheme = localStorage.getItem('worldmonitor-theme');
  if (savedTheme === 'light') document.documentElement.dataset.theme = 'light';
} catch {
  // localStorage may be unavailable in privacy modes — proceed with default.
}

const API_BASE = ''; // same-origin (apex)

interface ContextResponse {
  client_name: string;
  redirect_host: string;
}

interface MintResponse {
  redirect: string;
}

interface ApiError {
  error: string;
  error_description?: string;
}

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Element #${id} not found`);
  return el;
}

function setText(id: string, text: string): void { $(id).textContent = text; }

function show(id: string): void { $(id).hidden = false; }
function hide(id: string): void { $(id).hidden = true; }

function showErrorView(message: string): void {
  hide('loading');
  hide('consent');
  setText('errorBody', message);
  show('errorView');
}

function getNonceFromQuery(): string | null {
  const p = new URLSearchParams(window.location.search);
  const n = p.get('nonce');
  return typeof n === 'string' && n.length > 0 ? n : null;
}

async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getClerkToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(`${API_BASE}${path}`, { ...init, headers });
}

async function loadContext(nonce: string): Promise<void> {
  let resp: Response;
  try {
    resp = await authedFetch(`/api/internal/mcp-grant-context?nonce=${encodeURIComponent(nonce)}`);
  } catch {
    showErrorView('Could not reach the authorization service. Check your connection and try again.');
    return;
  }

  if (resp.status === 401) {
    // Token went stale between page load and fetch — re-prompt.
    openSignIn();
    return;
  }

  if (!resp.ok) {
    let body: ApiError | null = null;
    try { body = (await resp.json()) as ApiError; } catch { /* ignore */ }
    const msg = errorCodeToMessage(body?.error);
    showErrorView(msg);
    return;
  }

  let ctx: ContextResponse;
  try {
    ctx = (await resp.json()) as ContextResponse;
  } catch {
    showErrorView('The authorization service returned an unexpected response.');
    return;
  }

  setText('clientName', ctx.client_name);
  setText('clientHost', ctx.redirect_host);
  const u = getCurrentClerkUser();
  setText('userEmail', u?.email ?? 'your account');
  hide('loading');
  show('consent');
}

function errorCodeToMessage(code: string | undefined): string {
  switch (code) {
    case 'INVALID_NONCE':
      return 'This authorization request expired or is invalid. Start over from your MCP client.';
    case 'UNKNOWN_CLIENT':
      return 'The OAuth client is no longer registered. Start over from your MCP client.';
    case 'INVALID_REDIRECT_URI':
      return 'The redirect destination is not allowed. Start over from your MCP client.';
    case 'INSUFFICIENT_TIER':
      return 'A WorldMonitor Pro subscription is required to authorize MCP clients.';
    case 'CONFIGURATION_ERROR':
      return 'MCP authorization is temporarily unavailable. Please try again later.';
    case 'SERVICE_UNAVAILABLE':
      return 'The authorization service is temporarily unavailable. Please try again in a moment.';
    default:
      return 'This authorization request could not be completed. Start over from your MCP client.';
  }
}

async function onAuthorizeClick(nonce: string): Promise<void> {
  const btn = $('authorizeBtn') as HTMLButtonElement;
  const errEl = $('mintError');
  btn.disabled = true;
  btn.textContent = 'Authorizing…';
  hide('mintError');

  let resp: Response;
  try {
    resp = await authedFetch('/api/internal/mcp-grant-mint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce }),
    });
  } catch {
    btn.disabled = false;
    btn.textContent = 'Authorize';
    errEl.textContent = 'Network error. Please try again.';
    show('mintError');
    return;
  }

  if (resp.status === 401) {
    openSignIn();
    btn.disabled = false;
    btn.textContent = 'Authorize';
    return;
  }

  if (!resp.ok) {
    let body: ApiError | null = null;
    try { body = (await resp.json()) as ApiError; } catch { /* ignore */ }
    showErrorView(errorCodeToMessage(body?.error));
    return;
  }

  let mint: MintResponse;
  try {
    mint = (await resp.json()) as MintResponse;
  } catch {
    btn.disabled = false;
    btn.textContent = 'Authorize';
    errEl.textContent = 'Unexpected response from the authorization service.';
    show('mintError');
    return;
  }

  // Defense-in-depth: the apex page MUST navigate only to api.worldmonitor.app.
  // The server-returned URL is hard-coded to that host, but check anyway so a
  // future server bug (or an XSS that swaps the response) cannot bounce to
  // an attacker-controlled host.
  let target: URL;
  try {
    target = new URL(mint.redirect);
  } catch {
    showErrorView('The authorization service returned an invalid redirect.');
    return;
  }
  if (target.origin !== 'https://api.worldmonitor.app') {
    showErrorView('The authorization service returned an unexpected redirect host.');
    return;
  }

  window.location.assign(target.toString());
}

async function bootstrap(): Promise<void> {
  const nonce = getNonceFromQuery();
  if (!nonce) {
    showErrorView('Missing authorization parameter. Start over from your MCP client.');
    return;
  }

  try {
    await initClerk();
  } catch {
    showErrorView('Sign-in is unavailable. Please try again later.');
    return;
  }

  const reactToAuth = async (): Promise<void> => {
    if (!getCurrentClerkUser()) {
      // Open sign-in modal; on success subscribeClerk() fires reactToAuth again.
      openSignIn();
      return;
    }
    await loadContext(nonce);
  };

  subscribeClerk(() => { void reactToAuth(); });
  await reactToAuth();

  $('authorizeBtn').addEventListener('click', () => { void onAuthorizeClick(nonce); });
}

void bootstrap();
