// OAuth client resolution shared by the consent, Pro grant, and token routes.
// Route entries import this helper, never each other (AGENTS.md).
//
// A client_id is either a DCR registration (crypto.randomUUID() from
// register.js, stored at `oauth:client:<id>`) or a Client ID Metadata Document
// URL (CIMD, draft-ietf-oauth-client-id-metadata-document). The two shapes
// cannot collide: a UUID has no scheme, so anything with one is CIMD (#9244).
//
// CIMD is not open to any URL. A client_id must be on the trusted list below,
// and only those URLs are ever fetched. That keeps the edge fetch off arbitrary
// hosts (the routes run on Edge, where a resolved IP cannot be pinned), and it
// is no weaker than the DCR callback allowlist: each vendor's document lists
// the callbacks that vendor maintains. Sources are listed in
// docs/mcp-overview.mdx#client-id-metadata-documents.

import { CLIENT_METADATA_SNAPSHOTS } from './_client-metadata-snapshots.js';

// Exact client_id URLs, as each vendor publishes them.
const TRUSTED_CLIENT_METADATA_URLS = new Set([
  // Claude, Claude Code
  'https://claude.ai/oauth/mcp-oauth-client-metadata',
  'https://claude.ai/oauth/claude-code-client-metadata',
  // ChatGPT (stable document, used because we return RFC 9207 `iss`) and Codex
  'https://chatgpt.com/oauth/client.json',
  'https://chatgpt.com/oauth/codex/client.json',
  // Cursor (also lists Grok Bot's callback)
  'https://cursor.com/oauth/mcp-client.json',
  // Grok
  'https://grok.com/oauth/mcp-client.json',
  // VS Code
  'https://vscode.dev/oauth/client-metadata.json',
  // goose
  'https://goose-docs.ai/oauth/client-metadata.json',
  // Notion
  'https://www.notion.so/oauth/mcp-client-metadata.json',
  'https://app.notion.com/oauth/mcp-client-metadata.json',
  // Linear
  'https://linear.app/.well-known/oauth-client-metadata/mcp.json',
  // Lovable
  'https://api.lovable.dev/.well-known/oauth-client',
  // Factory
  'https://api.factory.ai/mcp/oauth-client',
  // Conductor
  'https://api.conductor.build/oauth/client-metadata.json',
  // Skydive
  'https://www.skydive.com/api/v1/external-oauth/client-metadata',
  // MCPJam
  'https://www.mcpjam.com/.well-known/oauth/client-metadata.json',
]);

// Vendors that host one document per connector. The id is one path segment,
// and because each connector's name is chosen by that vendor's user, the
// callbacks are pinned here too rather than taken from the document.
const TRUSTED_CLIENT_METADATA_PREFIXES = [
  // Vercel Connect: https://connect.vercel.com/connectors/<id>
  { prefix: 'https://connect.vercel.com/connectors/', redirectUris: ['https://connect.vercel.com/callback'] },
];
const CONNECTOR_ID = /^[A-Za-z0-9_-]{1,128}$/;

const FETCH_TIMEOUT_MS = 3_000;
const MAX_DOCUMENT_BYTES = 16 * 1024;
const MAX_REDIRECT_URIS = 50;
const MAX_REDIRECT_URI_BYTES = 2 * 1024;
const MAX_CLIENT_NAME_CHARS = 100;
// Cache-Control is honoured up to this cap, so a document change or a vendor
// revocation reaches us within an hour even if the vendor asks for longer.
const MAX_CACHE_TTL_SECONDS = 3600;
const DEFAULT_CACHE_TTL_SECONDS = 300;
const USER_AGENT = 'WorldMonitor-OAuth/1.0 (+https://www.worldmonitor.app/docs/mcp-overview)';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const encoder = new TextEncoder();

export const CLIENT_METADATA_CACHE_PREFIX = 'oauth:cimd:';

// Dispatch by shape (decision 2 in #9244): a scheme means CIMD.
export function isClientMetadataDocumentId(clientId) {
  return typeof clientId === 'string' && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(clientId);
}

class ClientMetadataError extends Error {
  constructor(reason, transient = false) {
    super(reason);
    this.name = 'ClientMetadataError';
    this.reason = reason;
    this.transient = transient;
  }
}

function isIpLiteral(hostname) {
  return hostname.startsWith('[') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || /^\d+$/.test(hostname);
}

// The client_id URL rules from the CIMD draft, plus public-host-only. Every
// trusted entry already satisfies these; they make a rejection say why.
function checkClientIdUrl(clientId) {
  let u;
  try { u = new URL(clientId); } catch { return 'invalid_client_id_url'; }
  if (u.protocol !== 'https:') return 'client_id_not_https';
  if (u.href !== clientId) return 'client_id_not_canonical';
  if (u.username || u.password || u.hash || u.search || u.port) return 'client_id_not_canonical';
  if (u.pathname === '/' || /\/\.\.?(?:\/|$)/.test(u.pathname)) return 'client_id_not_canonical';
  const host = u.hostname;
  if (isIpLiteral(host) || host === 'localhost' || host.endsWith('.localhost')
    || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.')) {
    return 'client_id_not_public_host';
  }
  return null;
}

function trustedEntry(clientId) {
  if (TRUSTED_CLIENT_METADATA_URLS.has(clientId)) return { redirectUris: null };
  for (const entry of TRUSTED_CLIENT_METADATA_PREFIXES) {
    if (clientId.startsWith(entry.prefix) && CONNECTOR_ID.test(clientId.slice(entry.prefix.length))) {
      return { redirectUris: entry.redirectUris };
    }
  }
  return null;
}

// Shared-cache semantics: private, no-store, and no-cache all mean "do not
// store"; s-maxage outranks max-age; anything above the cap is clamped.
export function clientMetadataCacheTtl(cacheControl) {
  if (!cacheControl) return DEFAULT_CACHE_TTL_SECONDS;
  const directives = cacheControl.toLowerCase().split(',').map((d) => d.trim());
  if (directives.some((d) => d === 'no-store' || d === 'no-cache' || d === 'private')) return 0;
  const read = (name) => {
    const d = directives.find((x) => x.startsWith(`${name}=`));
    if (!d) return null;
    // RFC 9111 allows the quoted form, e.g. max-age="300".
    const n = Number.parseInt(d.slice(name.length + 1).replace(/^"(.*)"$/, '$1'), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  const ttl = read('s-maxage') ?? read('max-age') ?? DEFAULT_CACHE_TTL_SECONDS;
  return Math.min(ttl, MAX_CACHE_TTL_SECONDS);
}

async function readCappedBody(resp, signal) {
  if (Number(resp.headers.get('content-length')) > MAX_DOCUMENT_BYTES) {
    throw new ClientMetadataError('document_too_large');
  }
  if (!resp.body) return '';
  const reader = resp.body.getReader();
  const bytes = new Uint8Array(MAX_DOCUMENT_BYTES);
  let total = 0;
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (signal.aborted) throw new ClientMetadataError('document_fetch_timeout', true);
      if (done) break;
      if (value.byteLength > MAX_DOCUMENT_BYTES - total) {
        void reader.cancel().catch(() => {});
        throw new ClientMetadataError('document_too_large');
      }
      bytes.set(value, total);
      total += value.byteLength;
    }
  } catch (err) {
    if (err instanceof ClientMetadataError) throw err;
    throw new ClientMetadataError(signal.aborted ? 'document_fetch_timeout' : 'document_fetch_failed', true);
  } finally {
    signal.removeEventListener('abort', onAbort);
    try { reader.releaseLock(); } catch { /* cancelled */ }
  }
  return new TextDecoder().decode(bytes.subarray(0, total));
}

// The start of a rejected response body, for the failure log: it is what
// tells a WAF block page from an outage.
async function withBodySnippet(err, resp, signal) {
  try {
    err.snippet = (await readCappedBody(resp, signal)).replace(/\s+/g, ' ').slice(0, 200);
  } catch { /* the log goes without it */ }
  return err;
}

// One deadline covers the request and the body, so a server that sends
// headers promptly and then trickles the body is still cut off.
async function fetchDocument(clientId, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const timeout = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(new ClientMetadataError('document_fetch_timeout', true)), { once: true });
  });
  let resp;
  try {
    return await Promise.race([timeout, (async () => {
      try {
        resp = await fetchImpl(clientId, {
          method: 'GET',
          redirect: 'manual',
          headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
          signal: controller.signal,
        });
      } catch (fetchErr) {
        const failure = new ClientMetadataError(controller.signal.aborted ? 'document_fetch_timeout' : 'document_fetch_failed', true);
        failure.detail = { error: fetchErr instanceof Error ? `${fetchErr.name}: ${fetchErr.message}` : String(fetchErr) };
        throw failure;
      }
      if (resp.type === 'opaqueredirect' || (resp.status >= 300 && resp.status < 400)) {
        throw new ClientMetadataError('document_redirected');
      }
      // Only "gone" is permanent. A 403, a 5xx, or an HTML bot challenge can be
      // a blip at the vendor's edge, and treating it as permanent would answer
      // a refresh with invalid_client and sign every user of that client out.
      if (resp.status === 404 || resp.status === 410) throw new ClientMetadataError('document_not_found');
      if (resp.status !== 200) throw await withBodySnippet(new ClientMetadataError('document_fetch_failed', true), resp, controller.signal);
      if (!/^application\/(?:[\w.+-]+\+)?json\b/i.test(resp.headers.get('content-type') ?? '')) {
        throw await withBodySnippet(new ClientMetadataError('document_not_json', true), resp, controller.signal);
      }
      const text = await readCappedBody(resp, controller.signal);
      let doc;
      // Retryable like the HTML branch above: a body cut off mid-transfer must
      // not answer a refresh with invalid_client.
      try { doc = JSON.parse(text); } catch { throw new ClientMetadataError('document_not_json', true); }
      return { doc, ttl: clientMetadataCacheTtl(resp.headers.get('cache-control')) };
    })()]);
  } catch (err) {
    // What the vendor sent, for the failure log: a challenge page and an
    // outage look the same to the caller but need different fixes.
    if (err instanceof ClientMetadataError && resp) {
      err.detail = {
        status: resp.status,
        content_type: resp.headers.get('content-type'),
        cf_mitigated: resp.headers.get('cf-mitigated'),
        cf_ray: resp.headers.get('cf-ray'),
        server: resp.headers.get('server'),
        ...(err.snippet !== undefined ? { body: err.snippet } : {}),
      };
    }
    throw err;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

// Returns the stored client shape, or throws ClientMetadataError.
function validateDocument(clientId, doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new ClientMetadataError('document_not_object');
  if (doc.client_id !== clientId) throw new ClientMetadataError('client_id_mismatch');
  // The draft forbids shared secrets in a public document.
  if ('client_secret' in doc || 'client_secret_expires_at' in doc) throw new ClientMetadataError('document_has_client_secret');

  const uris = doc.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
    throw new ClientMetadataError('invalid_redirect_uris');
  }
  for (const uri of uris) {
    if (typeof uri !== 'string' || encoder.encode(uri).byteLength > MAX_REDIRECT_URI_BYTES) {
      throw new ClientMetadataError('invalid_redirect_uris');
    }
  }

  // We are a public-client server (token_endpoint_auth_methods_supported:
  // ["none"]). A document must offer `none`, either as its method or within
  // the list it supports (ChatGPT prefers private_key_jwt but lists none).
  const method = doc.token_endpoint_auth_method;
  const supported = Array.isArray(doc.token_endpoint_auth_methods_supported) ? doc.token_endpoint_auth_methods_supported : [];
  if (method !== undefined && method !== 'none' && !supported.includes('none')) {
    throw new ClientMetadataError('unsupported_token_endpoint_auth_method');
  }
  if (doc.grant_types !== undefined
    && !(Array.isArray(doc.grant_types) && doc.grant_types.includes('authorization_code'))) {
    throw new ClientMetadataError('unsupported_grant_types');
  }
  if (doc.response_types !== undefined
    && !(Array.isArray(doc.response_types) && doc.response_types.includes('code'))) {
    throw new ClientMetadataError('unsupported_response_types');
  }

  const name = typeof doc.client_name === 'string' ? doc.client_name.trim().slice(0, MAX_CLIENT_NAME_CHARS) : '';
  return {
    client_id: clientId,
    client_name: name || new URL(clientId).hostname,
    redirect_uris: uris,
  };
}

function isCachedClient(clientId, value) {
  return !!value && typeof value === 'object' && value.client_id === clientId
    && typeof value.client_name === 'string' && Array.isArray(value.redirect_uris);
}

/**
 * Resolve a client_id to `{ ok: true, client }` or
 * `{ ok: false, reason, transient }`. `transient` failures (storage or the
 * vendor being unreachable) should be answered as retryable; the rest mean the
 * client is unknown or its document is invalid.
 *
 * deps.redisGet(key): parsed value or null; throws on transport failure.
 * deps.redisSetEx(key, value, ttl): best-effort cache write.
 * deps.fetch: defaults to the global fetch.
 * deps.snapshots: defaults to CLIENT_METADATA_SNAPSHOTS.
 */
export async function resolveOAuthClient(clientId, deps) {
  if (typeof clientId !== 'string' || clientId.length === 0) return { ok: false, reason: 'unknown_client', transient: false };

  if (!isClientMetadataDocumentId(clientId)) {
    let client;
    try { client = await deps.redisGet(`oauth:client:${clientId}`); } catch { return { ok: false, reason: 'storage_unavailable', transient: true }; }
    if (!client || typeof client !== 'object') return { ok: false, reason: 'unknown_client', transient: false };
    return { ok: true, client: { ...client, cimd: false } };
  }

  const urlProblem = checkClientIdUrl(clientId);
  if (urlProblem) return { ok: false, reason: urlProblem, transient: false };
  if (!trustedEntry(clientId)) {
    // A client that prefers CIMD does not fall back to DCR, so this is a
    // client that cannot connect at all until its URL is listed. Never
    // fetched; the URL is only recorded.
    console.warn('[oauth/cimd] untrusted client_id', JSON.stringify({ client_id: clientId.slice(0, 300) }));
    return { ok: false, reason: 'untrusted_client_id', transient: false };
  }

  const cacheKey = `${CLIENT_METADATA_CACHE_PREFIX}${clientId}`;
  try {
    const cached = await deps.redisGet(cacheKey);
    if (isCachedClient(clientId, cached)) return { ok: true, client: { ...cached, cimd: true } };
  } catch { /* a cache outage falls through to the vendor */ }

  let client;
  let ttl;
  try {
    const fetched = await fetchDocument(clientId, deps.fetch ?? ((...args) => globalThis.fetch(...args)));
    client = validateDocument(clientId, fetched.doc);
    ttl = fetched.ttl;
  } catch (err) {
    // sentry-coverage-ok a vendor's document being down or invalid is an external condition; callers answer it as retryable or unknown client.
    const failure = err instanceof ClientMetadataError
      ? { ok: false, reason: err.reason, transient: err.transient }
      : { ok: false, reason: 'document_fetch_failed', transient: true };
    // A retryable failure falls back to the vetted copy of a listed document.
    // It is never cached, so the live document is tried again next time.
    const snapshots = deps.snapshots ?? CLIENT_METADATA_SNAPSHOTS;
    const snapshot = failure.transient && Object.hasOwn(snapshots, clientId) ? snapshots[clientId] : null;
    // The document URL is public; nothing logged here is a secret.
    console.warn('[oauth/cimd] client document unusable', JSON.stringify({
      client_id: clientId,
      reason: failure.reason,
      transient: failure.transient,
      ...(snapshot ? { fallback: 'snapshot' } : {}),
      ...(err instanceof ClientMetadataError
        ? err.detail
        : { error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }),
    }));
    if (snapshot) return { ok: true, client: { ...validateDocument(clientId, snapshot), cimd: true } };
    return failure;
  }
  // Only a validated document is cached; a failure above never reaches here.
  if (ttl > 0 && deps.redisSetEx) {
    try { await deps.redisSetEx(cacheKey, client, ttl); } catch { /* best effort */ }
  }
  return { ok: true, client: { ...client, cimd: true } };
}

function isLoopbackHttp(u) {
  return u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname);
}

/**
 * Whether `redirectUri` may receive a code for `client` (a resolved client).
 *
 * DCR: exact membership in the registration. register.js already held every
 * entry to the global allowlist; the Pro mint re-checks it on its own.
 *
 * CIMD: exact membership in the document, except that a loopback http URI may
 * use any port (RFC 8252 §7.3: Claude Code and Codex publish
 * `http://localhost/callback` and pick a port at run time). The redirect must
 * be https or http loopback, and per-connector vendors are held to their
 * pinned callbacks.
 */
export function clientAllowsRedirectUri(client, redirectUri) {
  if (!client || typeof redirectUri !== 'string') return false;
  const uris = Array.isArray(client.redirect_uris) ? client.redirect_uris : [];
  if (!client.cimd) return uris.includes(redirectUri);

  if (encoder.encode(redirectUri).byteLength > MAX_REDIRECT_URI_BYTES) return false;
  const entry = trustedEntry(client.client_id);
  if (!entry) return false;
  if (entry.redirectUris && !entry.redirectUris.includes(redirectUri)) return false;

  let u;
  try { u = new URL(redirectUri); } catch { return false; }
  if (u.username || u.password || u.hash) return false;
  if (u.protocol !== 'https:' && !isLoopbackHttp(u)) return false;
  if (uris.includes(redirectUri)) return true;
  if (!isLoopbackHttp(u)) return false;
  return uris.some((registered) => {
    let r;
    try { r = new URL(registered); } catch { return false; }
    return isLoopbackHttp(r) && r.hostname === u.hostname && r.pathname === u.pathname && r.search === u.search;
  });
}

// The consent screens show the client_id host for a CIMD client (the draft's
// SHOULD), and warn when this authorization goes to a loopback callback: any
// local app can send a published client_id with a loopback redirect, so the
// document's client_name proves nothing there. Keyed on the redirect in use,
// not on whether the document lists only loopback callbacks, so documents
// that mix hosted and loopback callbacks (VS Code, Cursor) still warn.
export function clientDisplayInfo(client, redirectUri) {
  if (!client?.cimd) return { client_host: null, localhost_redirect: false };
  let localhostRedirect = false;
  try { localhostRedirect = isLoopbackHttp(new URL(redirectUri)); } catch { /* not a URL */ }
  return { client_host: new URL(client.client_id).hostname, localhost_redirect: localhostRedirect };
}

// Copy for an unresolvable client, for the HTML consent routes.
export function describeClientFailure(result) {
  if (result.reason === 'storage_unavailable') return 'Authorization service is temporarily unavailable. Please try again shortly.';
  if (result.transient) return 'The client could not be verified right now. Please try again shortly.';
  if (result.reason === 'unknown_client') return 'The client_id is not registered or has expired. Please re-register the client.';
  if (result.reason === 'untrusted_client_id') return 'This client_id URL is not on the list of MCP clients WorldMonitor accepts.';
  return 'The client metadata document for this client_id is invalid.';
}
