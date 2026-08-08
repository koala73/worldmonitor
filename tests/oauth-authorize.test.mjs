/**
 * Tests for U4 — consent page Pro CTA + "Use API key instead" disclosure.
 *
 * Scope: only the `consentPage(...)` HTML render. The handler logic (POST
 * dispatch, nonce mint, redis ops, validateApiKey) is unchanged by U4 and
 * is exercised by the existing OAuth integration tests; here we only assert
 * the HTML invariants the apex bridge (U3) and the legacy form path (U6+)
 * both depend on.
 *
 * `consentPage` is exported from api/oauth/authorize.js solely for these
 * tests — handler logic uses it via the module-internal call sites at lines
 * 215 and 302.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { consentPage } from '../api/oauth/authorize.js';

const BASE_PARAMS = {
  client_name: 'Claude Desktop',
  redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
  client_id: 'client_abc',
  response_type: 'code',
  code_challenge: 'a'.repeat(43),
  code_challenge_method: 'S256',
  state: '',
};

const NONCE = 'nonce_xyz_12345';

async function renderHtml(params, nonce, errorMsg) {
  const res = consentPage(params, nonce, errorMsg);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'text/html; charset=utf-8');
  assert.equal(res.headers.get('X-Frame-Options'), 'DENY');
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  return await res.text();
}

describe('consentPage — Pro CTA structure (U4)', () => {
  it('renders the brand-green Pro CTA as a top-level <a> with the apex grant URL', async () => {
    const html = await renderHtml(BASE_PARAMS, NONCE);
    // CTA element exists with stable id and class for U3+settings UI to depend on.
    assert.match(html, /<a id="pc" class="pro-cta"[^>]*>Sign in with WorldMonitor Pro<\/a>/);
    // Brand green at the CSS layer (matches existing #2d8a6e for the Authorize
    // button family — keeps visual identity consistent with htmlError + logo).
    assert.match(html, /\.pro-cta\{[^}]*background:#2d8a6e/);
  });

  it('Pro CTA href is exactly https://worldmonitor.app/mcp-grant?nonce=<n> — no www, no return_to, no extra params', async () => {
    const html = await renderHtml(BASE_PARAMS, NONCE);
    const m = html.match(/<a id="pc"[^>]*href="([^"]+)"/);
    assert.ok(m, 'pro-cta anchor with href must exist');
    const href = m[1];
    // Exact wire format (the apex page reads oauth:nonce:<nonce> itself; we
    // do NOT forward client_id / redirect_uri / state via URL — U3 contract).
    assert.equal(href, `https://worldmonitor.app/mcp-grant?nonce=${NONCE}`);
    // Defense-in-depth structural assertions in case the regex above ever
    // matches an unrelated <a id="pc">.
    const u = new URL(href);
    assert.equal(u.origin, 'https://worldmonitor.app');
    assert.equal(u.pathname, '/mcp-grant');
    assert.equal(u.searchParams.get('nonce'), NONCE);
    assert.equal([...u.searchParams.keys()].length, 1, 'no extra query params allowed');
  });

  it('Pro CTA nonce is URL-encoded (defends against malformed nonce shapes from upstream)', async () => {
    // Prod nonces are crypto.randomUUID() (all safe chars) but consentPage
    // must still encode defensively in case any future caller passes a
    // raw value with reserved characters.
    const weirdNonce = 'a b&c=d';
    const html = await renderHtml(BASE_PARAMS, weirdNonce);
    const m = html.match(/<a id="pc"[^>]*href="([^"]+)"/);
    assert.ok(m);
    assert.equal(m[1], 'https://worldmonitor.app/mcp-grant?nonce=a%20b%26c%3Dd');
  });

  it('renders the "Use API key instead" disclosure link below the Pro CTA', async () => {
    const html = await renderHtml(BASE_PARAMS, NONCE);
    assert.match(html, /<div class="disclosure" id="dt"><a id="tk" role="button" tabindex="0">Use API key instead<\/a><\/div>/);
  });

  it('API-key form is in the DOM but hidden by default (display:none)', async () => {
    const html = await renderHtml(BASE_PARAMS, NONCE);
    // Form still in DOM (so the toggle has something to reveal without a
    // re-render round-trip).
    assert.match(html, /<form id="cf"[^>]*style="display:none[^"]*"/);
    assert.match(html, /<input type="password" id="api_key"/);
    // Existing POST action target must be preserved (nothing about the
    // legacy submit path is changed by U4).
    assert.match(html, /method="POST" action="https:\/\/api\.worldmonitor\.app\/oauth\/authorize"/);
  });

  it('inline script wires the disclosure click handler + #api-key fragment + errorMsg auto-show', async () => {
    const html = await renderHtml(BASE_PARAMS, NONCE);
    // Single-IIFE inline script (no external assets — edge runtime constraint).
    assert.match(html, /<script>\(function\(\)\{/);
    // Reveal triggers — three of them, all going through the same showForm() helper.
    assert.match(html, /window\.location\.hash==='#api-key'/);
    assert.match(html, /tk\.addEventListener\('click'/);
    assert.match(html, /em\.textContent\.length>0/);
    // Existing form-submit XHR handler is preserved verbatim except now
    // wrapped in the IIFE — assert the load-bearing pieces are still there.
    assert.match(html, /'\/oauth\/authorize'/);
    assert.match(html, /'invalid_key'/);
  });
});

describe('consentPage — error-state form-visible behaviour (U4)', () => {
  it('errorMsg present: the <p class="error"> renders WITHOUT inline display:none — script then auto-reveals form', async () => {
    const html = await renderHtml(BASE_PARAMS, NONCE, 'Invalid API key. Please check and try again.');
    // Default state: error <p> is hidden via inline style. Error state: the
    // attribute is omitted. The inline script reads textContent to decide
    // whether to call showForm() — so the form pops open without a server
    // round-trip when the user retries.
    assert.match(html, /<p class="error" id="ke">Invalid API key/);
    assert.doesNotMatch(html, /<p class="error" id="ke" style="display:none">Invalid API key/);
  });

  it('errorMsg empty (default render): the <p class="error"> has inline display:none and is empty', async () => {
    const html = await renderHtml(BASE_PARAMS, NONCE);
    assert.match(html, /<p class="error" id="ke" style="display:none"><\/p>/);
  });

  it('errorMsg HTML-escapes — XSS defense (same escapeHtml as the rest of the page)', async () => {
    const html = await renderHtml(BASE_PARAMS, NONCE, '<script>alert(1)</script>');
    assert.doesNotMatch(html, /<p class="error" id="ke"><script>alert\(1\)<\/script>/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });
});

describe('consentPage — XSS defense for client metadata (U4)', () => {
  it('escapes client_name in the consent header (XSS defense)', async () => {
    // redirect_uri is allowlisted upstream (handler's `uris.includes(...)`
    // gate at lines 202+283), so a malformed-URI redirect_uri never reaches
    // consentPage in production. The realistic XSS vector is client_name —
    // anything in the registered client metadata flows into the page.
    const evilParams = {
      ...BASE_PARAMS,
      client_name: '"><script>alert(1)</script>',
    };
    const html = await renderHtml(evilParams, NONCE);
    // Raw injection must not appear anywhere.
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
    // Escaped form must appear in the client-name area.
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    // The Pro CTA href is built from the nonce only (NOT from client_name
    // or redirect_uri) — so a malicious client_name CANNOT influence it.
    const m = html.match(/<a id="pc"[^>]*href="([^"]+)"/);
    assert.equal(m[1], `https://worldmonitor.app/mcp-grant?nonce=${NONCE}`);
  });

  it('rejects (via URL constructor) a redirect_uri that fails to parse — production handler allowlists URIs upstream, so consentPage assumes parseable input', async () => {
    // Codifying the contract: consentPage's `new URL(redirect_uri)` is the
    // last line of defense AFTER the handler's `uris.includes(...)` gate.
    // If a future refactor removes the upstream allowlist, this fail-fast
    // throw is the right behaviour (better than producing a malformed page).
    assert.throws(
      () => consentPage({ ...BASE_PARAMS, redirect_uri: 'not-a-url' }, NONCE),
      /Invalid URL/,
    );
  });

  it('"Unknown Client" fallback (handler line ~217) still renders the Pro CTA correctly', async () => {
    const html = await renderHtml({ ...BASE_PARAMS, client_name: 'Unknown Client' }, NONCE);
    assert.match(html, /<div class="client-name">Unknown Client wants access<\/div>/);
    assert.match(html, /<a id="pc" class="pro-cta"[^>]*>Sign in with WorldMonitor Pro<\/a>/);
    const m = html.match(/<a id="pc"[^>]*href="([^"]+)"/);
    assert.equal(m[1], `https://worldmonitor.app/mcp-grant?nonce=${NONCE}`);
  });
});

describe('consentPage — preserved invariants (regression guard for U6+)', () => {
  it('CSRF nonce is escaped into the hidden _nonce input', async () => {
    const html = await renderHtml(BASE_PARAMS, NONCE);
    assert.match(html, new RegExp(`<input type="hidden" name="_nonce" id="nn" value="${NONCE}">`));
  });

  it('CSRF nonce is HTML-escaped (defense against any future non-UUID nonce mint)', async () => {
    const html = await renderHtml(BASE_PARAMS, '"><x>');
    // Hidden input value must be escaped; raw injection must not appear.
    assert.doesNotMatch(html, /value=""><x>"/);
    assert.match(html, /value="&quot;&gt;&lt;x&gt;"/);
  });

  it('client_name and redirect host appear in the client-hd block', async () => {
    const html = await renderHtml(BASE_PARAMS, NONCE);
    assert.match(html, /<div class="client-name">Claude Desktop wants access<\/div>/);
    assert.match(html, /<div class="client-host">via claude\.ai<\/div>/);
  });

  it('all five scope bullets are still listed (anti-phishing — user sees what they grant)', async () => {
    const html = await renderHtml(BASE_PARAMS, NONCE);
    assert.match(html, /Real-time news/);
    assert.match(html, /flight tracking/);
    assert.match(html, /Weather alerts/);
    assert.match(html, /Geopolitical risk/);
    assert.match(html, /stocks, commodities/);
  });

  it('legacy "Get an API key" footer link is preserved', async () => {
    const html = await renderHtml(BASE_PARAMS, NONCE);
    assert.match(html, /href="https:\/\/www\.worldmonitor\.app\/pro"/);
  });

  it('PAGE_HEADERS contract preserved: text/html + DENY + no-store + Pragma', async () => {
    const res = consentPage(BASE_PARAMS, NONCE);
    assert.equal(res.headers.get('Content-Type'), 'text/html; charset=utf-8');
    assert.equal(res.headers.get('X-Frame-Options'), 'DENY');
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.equal(res.headers.get('Pragma'), 'no-cache');
  });
});
