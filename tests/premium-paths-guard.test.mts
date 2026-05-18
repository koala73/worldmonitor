import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { PREMIUM_RPC_PATHS } from '../src/shared/premium-paths.ts';

// ---------------------------------------------------------------------------
// Why this test exists
// ---------------------------------------------------------------------------
//
// `premiumFetch` (src/services/premium-fetch.ts) only attaches the Clerk
// Bearer token when the target path is a member of `PREMIUM_RPC_PATHS`. A
// premium-gated direct-edge endpoint that's *missing* from that set silently
// breaks for browser Pro users who don't carry a tester key:
//
//   premiumFetch sees the path is "not premium" → skips Bearer injection →
//   request goes out unauthenticated → server's isCallerPremium returns
//   false → 403 "Pro subscription required" despite a valid subscription.
//
// That exact regression hit `/api/chat-analyst` (post-PR-#3797). The fix is
// trivial — add the path to PREMIUM_RPC_PATHS — but the trap is that it
// stays invisible until someone manages to call the endpoint AND has no
// tester key AND isn't on a desktop with WORLDMONITOR_API_KEY.
//
// This guard fails CI when a new file under `api/` gates on premium auth
// (via `isCallerPremium()` or returns the literal 403 body) but the
// corresponding route isn't covered by PREMIUM_RPC_PATHS or this file's
// allowlist.

// ---------------------------------------------------------------------------
// Allowlist — endpoints whose browser callers deliberately bypass premiumFetch
// ---------------------------------------------------------------------------
//
// Each entry must point to a real file under `api/` and explain WHY path-
// gated Bearer injection isn't the right mechanism for that endpoint.

const PREMIUM_FETCH_BYPASS_ALLOWLIST: Record<string, string> = {
  '/api/widget-agent':
    'WidgetChatModal.ts and McpDataPanel.ts call widgetAgentUrl() via plain ' +
    'fetch() with their own auth surface (X-Widget-Key / X-Pro-Key / Bearer) ' +
    'rather than premiumFetch.',
  '/api/me/entitlement':
    'entitlement-watchdog.ts and checkout.ts attach the Clerk Bearer ' +
    'manually. premiumFetch would short-circuit on tester keys and break the ' +
    'free→pro promotion polling flow.',
};

// ---------------------------------------------------------------------------
// Source scan
// ---------------------------------------------------------------------------

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const apiDir = join(repoRoot, 'api');

// Two server-side premium-gate markers:
//   - isCallerPremium(           — endpoints using the shared check
//   - "Pro subscription required" — literal 403 body used by hand-rolled gates
const PREMIUM_GATE_RE = /(isCallerPremium\s*\(|['"`]Pro subscription required['"`])/;

function walkApiFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    // Skip private helpers (_cors.js, _api-key.js, _mcp-grant-hmac.ts, etc.)
    if (entry.startsWith('_')) continue;
    // Skip internal-only endpoints (api/internal/* — not browser-reachable;
    // auth via gateway HMAC nonce, not Bearer).
    if (entry === 'internal') continue;
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walkApiFiles(full, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

// Map a file under api/ to its Vercel route path.
//   api/foo.ts          → /api/foo
//   api/foo/bar.ts      → /api/foo/bar
//   api/foo/index.ts    → /api/foo
//   api/foo/[id].ts     → null (dynamic route — exact-match set can't represent it;
//                              parent path is typically separately covered)
function fileToRoute(absPath: string): string | null {
  const rel = relative(apiDir, absPath).replace(/\\/g, '/');
  if (rel.includes('[')) return null;
  const noExt = rel.replace(/\.ts$/, '');
  const noIndex = noExt.replace(/\/index$/, '');
  return `/api/${noIndex}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('premium-paths guard — every premium-gated direct-edge endpoint is covered', () => {
  const files = walkApiFiles(apiDir);
  const gated: { route: string; file: string }[] = [];

  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    if (!PREMIUM_GATE_RE.test(src)) continue;
    const route = fileToRoute(file);
    if (!route) continue; // dynamic route — skip
    gated.push({ route, file });
  }

  it('scan finds at least one premium-gated endpoint — sanity check for regex/walk', () => {
    assert.ok(
      gated.length > 0,
      'Scan found zero premium-gated direct-edge endpoints — regex or walk likely broken',
    );
  });

  for (const { route, file } of gated) {
    const fileRel = relative(repoRoot, file);
    it(`${route} (${fileRel}) is covered`, () => {
      if (PREMIUM_RPC_PATHS.has(route)) return;
      const allowlistReason = PREMIUM_FETCH_BYPASS_ALLOWLIST[route];
      assert.ok(
        allowlistReason,
        [
          `Endpoint ${route} (${fileRel}) gates on premium auth`,
          `(matched /${PREMIUM_GATE_RE.source}/) but is NOT in PREMIUM_RPC_PATHS.`,
          ``,
          `If a browser caller uses premiumFetch (or wraps a generated client`,
          `in premiumFetch), add ${JSON.stringify(route)} to`,
          `src/shared/premium-paths.ts so the Clerk Bearer is attached.`,
          `Otherwise every Pro user without a tester key will see 403.`,
          ``,
          `If the browser caller deliberately bypasses premiumFetch (plain`,
          `fetch with manually-attached auth), add an entry to`,
          `PREMIUM_FETCH_BYPASS_ALLOWLIST in this test file with rationale.`,
        ].join('\n'),
      );
    });
  }

  it('every allowlist entry still points to a real, premium-gated endpoint', () => {
    const gatedRoutes = new Set(gated.map((g) => g.route));
    for (const route of Object.keys(PREMIUM_FETCH_BYPASS_ALLOWLIST)) {
      assert.ok(
        gatedRoutes.has(route),
        `Allowlist entry ${route} does not match any premium-gated file under api/. ` +
        `Either the route was renamed/removed or the gate was lifted — drop the stale allowlist entry.`,
      );
    }
  });

  it('no allowlist entry shadows a PREMIUM_RPC_PATHS member', () => {
    for (const route of Object.keys(PREMIUM_FETCH_BYPASS_ALLOWLIST)) {
      assert.equal(
        PREMIUM_RPC_PATHS.has(route),
        false,
        `${route} is BOTH in PREMIUM_RPC_PATHS and in the bypass allowlist. ` +
        `One of them is wrong — pick the canonical source of truth for this endpoint.`,
      );
    }
  });
});
