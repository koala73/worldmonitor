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
import {
  classifyGrantDenial,
  describeGrantDelay,
  retryableGrantDelayMs,
  routeGrantContextDenial,
  shouldWaitInline,
  type GrantMintPhase,
} from '@/services/mcp-grant-denial';

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

/**
 * `title` is REQUIRED, not defaulted. It used to default to "Authorization
 * request expired", which was correct for exactly one of the seven call sites —
 * a caller without Pro read that heading above "a WorldMonitor Pro subscription
 * is required", and the anti-phishing redirect-host refusal was labelled an
 * expiry too. Making it required means a new error path has to state what it is
 * rather than inheriting the wrong answer.
 */
function showErrorView(message: string, title: string): void {
  resetMintPhase();
  hide('loading');
  hide('consent');
  hide('retryContextBtn');
  setText('errorTitle', title);
  setText('errorBody', message);
  show('errorView');
}

function showRetryableContextView(message: string): void {
  resetMintPhase();
  hide('loading');
  hide('consent');
  setText('errorTitle', 'Authorization temporarily unavailable');
  setText('errorBody', message);
  show('retryContextBtn');
  show('errorView');
}

function showContextLoading(): void {
  hide('errorView');
  hide('consent');
  setText('loadingBody', 'Loading authorization request…');
  show('loading');
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

/**
 * `subscribeClerk` can re-enter `reactToAuth` -> `loadContext` at any moment.
 * Keep both the in-flight POST and its Retry-After cooldown explicit: a token
 * refresh during either phase must not let a retryable context denial tear down
 * consent. Retaining the timeout identity also lets a terminal transition
 * cancel the pending re-enable instead of mutating a hidden card later.
 */
let mintPhase: GrantMintPhase = 'idle';
let mintRetryTimeout: number | null = null;

function resetMintPhase(): void {
  if (mintRetryTimeout !== null) {
    window.clearTimeout(mintRetryTimeout);
    mintRetryTimeout = null;
  }
  mintPhase = 'idle';
}

const CONTEXT_AUTO_RETRY_BUDGET = 1;
let contextLoadGeneration = 0;

async function loadContext(nonce: string): Promise<void> {
  const generation = ++contextLoadGeneration;
  await loadContextAttempt(nonce, CONTEXT_AUTO_RETRY_BUDGET, generation);
}

async function loadContextAttempt(
  nonce: string,
  retriesRemaining: number,
  generation: number,
): Promise<void> {
  let resp: Response;
  try {
    resp = await authedFetch(`/api/internal/mcp-grant-context?nonce=${encodeURIComponent(nonce)}`);
  } catch {
    // Staleness FIRST. subscribeClerk can re-enter loadContext at any moment,
    // and nothing cancels the older fetch — so without this a superseded
    // attempt that fails late would replace a consent card the newer attempt
    // already rendered. Every other exit path in this function is guarded; this
    // one was not.
    if (generation !== contextLoadGeneration) return;
    if (mintPhase !== 'idle') return;
    showRetryableContextView(
      'Could not reach the authorization service. Check your connection and try again.',
    );
    return;
  }

  if (generation !== contextLoadGeneration) return;

  if (!resp.ok) {
    let body: ApiError | null = null;
    try { body = (await resp.json()) as ApiError; } catch { /* ignore */ }
    const verdict = classifyGrantDenial(resp.status, body?.error);
    const action = routeGrantContextDenial(verdict.action, mintPhase, retriesRemaining);
    switch (action) {
      case 'sign_in':
        // Token went stale between page load and fetch — re-prompt.
        openSignIn();
        return;
      case 'preserve_consent':
        return;
      case 'retry': {
        const waitMs = retryableGrantDelayMs(resp.headers.get('Retry-After'));
        // A long server-requested delay (up to the 60s renewal cooldown) is not
        // worth blocking the page on — surface the manual retry instead of a
        // minute-long spinner. Same threshold the notification client uses.
        if (!shouldWaitInline(waitMs)) {
          showRetryableContextView(
            `${verdict.message} Try again in ${describeGrantDelay(waitMs)}.`,
          );
          return;
        }
        setText('loadingBody', 'Authorization service is temporarily unavailable. Retrying…');
        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, waitMs);
        });
        if (generation !== contextLoadGeneration) return;
        await loadContextAttempt(nonce, retriesRemaining - 1, generation);
        return;
      }
      case 'show_retry':
        showRetryableContextView(verdict.message);
        return;
      case 'terminal':
        showErrorView(verdict.message, verdict.title);
        return;
    }
  }

  let ctx: ContextResponse;
  try {
    ctx = (await resp.json()) as ContextResponse;
  } catch {
    if (generation !== contextLoadGeneration) return;
    showErrorView('The authorization service returned an unexpected response.', 'Unexpected response');
    return;
  }

  // `resp.json()` is a third suspension point — re-check before painting, so a
  // superseded attempt cannot render another nonce's client metadata.
  if (generation !== contextLoadGeneration) return;

  setText('clientName', ctx.client_name);
  setText('clientHost', ctx.redirect_host);
  const u = getCurrentClerkUser();
  setText('userEmail', u?.email ?? 'your account');
  hide('loading');
  show('consent');
}

async function onAuthorizeClick(nonce: string): Promise<void> {
  const btn = $('authorizeBtn') as HTMLButtonElement;
  const errEl = $('mintError');
  const reenable = (): void => {
    resetMintPhase();
    btn.disabled = false;
    btn.textContent = 'Authorize';
  };
  resetMintPhase();
  btn.disabled = true;
  btn.textContent = 'Authorizing…';
  hide('mintError');

  let resp: Response;
  mintPhase = 'in_flight';
  try {
    resp = await authedFetch('/api/internal/mcp-grant-mint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce }),
    });
  } catch {
    reenable();
    errEl.textContent = 'Network error. Please try again.';
    show('mintError');
    return;
  }

  if (!resp.ok) {
    let body: ApiError | null = null;
    try { body = (await resp.json()) as ApiError; } catch { /* ignore */ }
    const verdict = classifyGrantDenial(resp.status, body?.error);
    if (verdict.action === 'sign_in') {
      openSignIn();
      reenable();
      return;
    }
    if (verdict.action === 'retryable') {
      // #5622: a transient entitlement-verification failure used to replace the
      // consent card with a terminal "start over from your MCP client" — the
      // nonce is still valid and the SAME click would succeed a moment later, so
      // keep the card and hand the button back.
      //
      // But hand it back only AFTER the delay the server asked for. An immediate
      // re-click is answered from the server's own few-second negative cache
      // (UNAVAILABLE_NEGATIVE_CACHE_TTL_MS in
      // server/_shared/entitlement-check.ts), so re-enabling instantly would
      // invite the user to reproduce the same failure by hand. Same-origin
      // request, so Retry-After is readable without CORS exposure.
      const waitMs = retryableGrantDelayMs(resp.headers.get('Retry-After'));
      // Only hold the button when the wait is short enough to be worth holding.
      // The 60s renewal cooldown is not: parking Authorize on "Retry shortly…"
      // for a minute reads as a hung page. Above the threshold, name the delay
      // and hand the button back — the user waits, not a timer.
      if (!shouldWaitInline(waitMs)) {
        errEl.textContent = `${verdict.message} Try again in ${describeGrantDelay(waitMs)}.`;
        show('mintError');
        reenable();
        return;
      }
      errEl.textContent = verdict.message;
      show('mintError');
      btn.textContent = 'Retry shortly…';
      mintPhase = 'retry_cooldown';
      mintRetryTimeout = window.setTimeout(reenable, waitMs);
      return;
    }
    resetMintPhase();
    showErrorView(verdict.message, verdict.title);
    return;
  }

  let mint: MintResponse;
  try {
    mint = (await resp.json()) as MintResponse;
  } catch {
    reenable();
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
    showErrorView('The authorization service returned an invalid redirect.', 'Invalid redirect');
    return;
  }
  if (target.origin !== 'https://api.worldmonitor.app') {
    showErrorView('The authorization service returned an unexpected redirect host.', 'Unexpected redirect host');
    return;
  }

  window.location.assign(target.toString());
}

async function bootstrap(): Promise<void> {
  const nonce = getNonceFromQuery();
  if (!nonce) {
    showErrorView('Missing authorization parameter. Start over from your MCP client.', 'Missing authorization parameter');
    return;
  }

  try {
    await initClerk();
  } catch {
    showErrorView('Sign-in is unavailable. Please try again later.', 'Sign-in unavailable');
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

  // Wire the controls BEFORE the first load. `bootstrap()` is fire-and-forget
  // (`void bootstrap()`), so anything that rejects inside `reactToAuth` —
  // `openSignIn()` throwing, say — would skip the rest of this function and
  // leave both buttons inert. That is survivable for Authorize, but the error
  // view now *offers* a "Try again" button, and a visible control that does
  // nothing is worse than no control. Attaching first costs nothing: neither
  // handler can fire before the user sees a rendered view.
  $('retryContextBtn').addEventListener('click', () => {
    showContextLoading();
    void loadContext(nonce);
  });
  $('authorizeBtn').addEventListener('click', () => { void onAuthorizeClick(nonce); });

  subscribeClerk(() => { void reactToAuth(); });
  await reactToAuth();
}

void bootstrap();
