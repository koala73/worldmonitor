// Shared helpers for the OpenAPI post-generation injectors
// (scripts/openapi-inject-*.mjs) and their contract tests. Single-sourcing the
// byte-faithful serializer, the gateway/entitlement source-of-truth parsers, and
// the public-gate registry here removes the copy-paste drift between injectors
// and — crucially — lets the tests import the SAME constants the injectors use
// instead of re-scraping the injector source with duplicate regexes (which could
// silently diverge). Pure node builtins only: this runs under plain `node` in the
// `make generate` codegen context, so it must not import any npm dependency; a
// relative import like this one adds zero deps and runs identically.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// scripts/lib/ -> repo root.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// ── Byte-faithful JSON serializer (matches protoc-gen-openapiv3 output) ──────
// Recursively sorted keys + Go-style escaping of < > & U+2028 U+2029, no
// trailing newline — reproduces the generator's bytes so injected diffs are
// additions-only.
export const sortRec = (x) =>
  Array.isArray(x)
    ? x.map(sortRec)
    : x && typeof x === 'object'
      ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sortRec(x[k])]))
      : x;

export const goEscape = (s) => {
  let r = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    r += c === 0x3c || c === 0x3e || c === 0x26 || c === 0x2028 || c === 0x2029
      ? '\\u' + c.toString(16).padStart(4, '0')
      : ch;
  }
  return r;
};

export const serialize = (obj) => goEscape(JSON.stringify(sortRec(obj)));

// Order-insensitive deep-equal (keys sorted before compare) so change detection
// is stable across the sort-on-write round-trip.
export const eq = (a, b) => JSON.stringify(sortRec(a)) === JSON.stringify(sortRec(b));

// Normalize a parameter name to a lookup key (strip separators, lowercase).
export const normalizeKey = (name = '') => String(name).replace(/[_\-\s]/g, '').toLowerCase();

// ── Source-of-truth parsers (fail-closed) ───────────────────────────────────
// Read the authoritative Set/Record literals straight from the gateway-adjacent
// TypeScript so the published auth contract can never drift from runtime. Each
// throws on a full parse miss or empty set — a rename can't silently mislabel
// auth (the caller adds a further non-empty guard on the union).
export function readPublicNoAuthPaths() {
  const src = readFileSync(resolve(root, 'server/gateway.ts'), 'utf8');
  const block = src.match(/PUBLIC_NO_AUTH_RPC_PATHS\s*=\s*new Set<string>\(\[([\s\S]*?)\]\)/);
  if (!block) throw new Error('could not locate PUBLIC_NO_AUTH_RPC_PATHS in server/gateway.ts');
  const paths = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  if (paths.length === 0) throw new Error('PUBLIC_NO_AUTH_RPC_PATHS parsed as empty — refusing to run');
  return new Set(paths);
}

export function readEndpointEntitlements() {
  const src = readFileSync(resolve(root, 'server/_shared/entitlement-check.ts'), 'utf8');
  const block = src.match(/ENDPOINT_ENTITLEMENTS\s*:\s*Record<string,\s*number>\s*=\s*\{([\s\S]*?)\};/);
  if (!block) throw new Error('could not locate ENDPOINT_ENTITLEMENTS in server/_shared/entitlement-check.ts');
  const entries = [...block[1].matchAll(/'([^']+)'\s*:\s*(\d+)/g)].map((m) => [m[1], Number(m[2])]);
  if (entries.length === 0) throw new Error('ENDPOINT_ENTITLEMENTS parsed as empty — refusing to run');
  return new Map(entries);
}

export function readPremiumRpcPaths() {
  const src = readFileSync(resolve(root, 'src/shared/premium-paths.ts'), 'utf8');
  const block = src.match(/PREMIUM_RPC_PATHS\s*=\s*new Set<string>\(\[([\s\S]*?)\]\)/);
  if (!block) throw new Error('could not locate PREMIUM_RPC_PATHS in src/shared/premium-paths.ts');
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

// ── Public 403 gates ─────────────────────────────────────────────────────────
// Public RPCs (security: []) that nonetheless document a 403 the handler throws.
// Lead capture opts out of API-key auth at the gateway, then fails closed in the
// handler on a Turnstile / desktop-auth failure. Single-sourced here so the
// contract test asserts specs against the SAME map the injector stamps from.
export const PUBLIC_FORBIDDEN_GATES = new Map([
  ['/api/leads/v1/submit-contact', {
    note: 'Turnstile-gated. Missing or invalid Cloudflare Turnstile token returns 403 Bot verification failed.',
    response: {
      description: 'Bot verification failed.',
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/Error' },
        },
      },
    },
  }],
  ['/api/leads/v1/register-interest', {
    // The handler (server/worldmonitor/leads/v1/register-interest.ts) fails
    // closed with two distinct 403s: browser callers that fail the Cloudflare
    // Turnstile check get 403 Bot verification failed; desktop-source callers
    // whose shared-secret HMAC bypass is missing/invalid get 403 Desktop
    // authentication failed. Both are thrown as the sebuf ApiError, so the body
    // is the generated Error schema (a `message` string) — same shape the
    // submit-contact gate documents.
    note: 'Turnstile-gated (desktop sources authenticate a bypass with a shared-secret HMAC instead). A failed Cloudflare Turnstile check returns 403 Bot verification failed; a desktop-source request with a missing or invalid HMAC signature returns 403 Desktop authentication failed.',
    response: {
      description: 'Bot verification or desktop authentication failed.',
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/Error' },
        },
      },
    },
  }],
]);
