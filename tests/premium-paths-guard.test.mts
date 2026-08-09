import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import ts from 'typescript';

import { DIRECT_LLM_GATEWAY_QUOTA_PATHS } from '../server/_shared/direct-llm-quota.ts';
import { TIER_GATED_PATHS } from '../server/_shared/entitlement-check.ts';
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

// Gateway-level direct-LLM routes also require a Clerk identity before quota
// reservation. Browser callers must therefore enter through premiumFetch so
// they attach Bearer auth and so the wm-session interceptor does not mistake
// the expected anonymous 401 for a dead HttpOnly session. Summarize stays out:
// its translate mode is intentionally available to free callers and the
// gateway only applies direct-LLM quota after inspecting the request body.
//
// #5674 — an entry here is NOT sufficient on its own. Membership in
// PREMIUM_RPC_PATHS does two independent jobs: it tells premiumFetch to attach
// a Bearer, and it tells the wm-session interceptor that a 401 on this route is
// an expected auth denial rather than a rejected session cookie. This allowlist
// was originally justified against the FIRST job only, which left the second
// unhandled: every unauthenticated summarize call 401'd, the interceptor minted
// a fresh session, replayed, 401'd again, and suppressed ALL anonymous API
// calls for 15 minutes (#5219). Each entry must therefore also name the
// mechanism that keeps its 401s out of session recovery, and
// SESSION_RECOVERY_BYPASS_PROOF must assert that mechanism is actually wired.
const DIRECT_LLM_PREMIUM_BYPASS_ALLOWLIST: Record<string, string> = {
  '/api/news/v1/summarize-article':
    'The route also serves free translate mode — which REQUIRES the anonymous ' +
    'wms_ cookie, so the path cannot join PREMIUM_RPC_PATHS. Spend-bearing ' +
    'summarize calls opt into premiumFetch with forcePremium instead of gating ' +
    'the whole path, and session recovery is bypassed per-request via the ' +
    'premium-intent marker (src/services/premium-intent.ts).',
};

// The wiring each allowlisted route depends on to keep its expected 401s out of
// wm-session recovery. A rationale in a comment is not a guarantee — this is
// asserted structurally below.
const SESSION_RECOVERY_BYPASS_PROOF: Record<
  string,
  { file: string; premiumFetchCall: string; expectedPremiumFetchCalls: number; rpcMethod: string }
> = {
  '/api/news/v1/summarize-article': {
    file: 'src/services/summarization.ts',
    premiumFetchCall: 'forcePremium',
    // Pinned: see the count assertion below for why a bare "a marking call
    // exists" boolean is not a proof.
    expectedPremiumFetchCalls: 1,
    // The RPC the marked client must be the receiver of. This file calls the
    // same method on the PLAIN client for free translate mode, so the binding
    // is receiver-based, not method-name-based.
    rpcMethod: 'summarizeArticle',
  },
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

describe('premium-paths guard — browser direct-LLM routes cannot trigger wm-session recovery', () => {
  for (const route of DIRECT_LLM_GATEWAY_QUOTA_PATHS) {
    it(`${route} is covered by premium auth routing or an explicit mode-specific bypass`, () => {
      if (PREMIUM_RPC_PATHS.has(route)) return;
      assert.ok(
        DIRECT_LLM_PREMIUM_BYPASS_ALLOWLIST[route],
        [
          `Direct-LLM route ${route} requires a Clerk identity in the gateway`,
          `but is NOT in PREMIUM_RPC_PATHS.`,
          ``,
          `Anonymous browser calls will receive 401, and the wm-session`,
          `interceptor will misclassify that expected denial as a rejected`,
          `fresh cookie, entering the global 15-minute cooldown.`,
        ].join('\n'),
      );
    });
  }

  it('every direct-LLM bypass also proves how its 401s stay out of session recovery', () => {
    // #5674 root cause: the allowlist justified skipping premiumFetch's Bearer
    // injection but said nothing about the interceptor, whose 401 handling
    // reads the SAME path set. An entry without a session-recovery bypass
    // turns every expected Pro denial into a 15-minute anonymous blackout.
    for (const route of Object.keys(DIRECT_LLM_PREMIUM_BYPASS_ALLOWLIST)) {
      const proof = SESSION_RECOVERY_BYPASS_PROOF[route];
      assert.ok(
        proof,
        [
          `Direct-LLM route ${route} is allowlisted out of PREMIUM_RPC_PATHS but has`,
          `no SESSION_RECOVERY_BYPASS_PROOF entry.`,
          ``,
          `PREMIUM_RPC_PATHS membership does TWO jobs: Bearer injection in`,
          `premiumFetch AND telling the wm-session interceptor that a 401 here is`,
          `an expected auth denial. Opting out of the first without handling the`,
          `second means every unauthenticated call to this route mints a session,`,
          `replays, 401s again, and suppresses ALL anonymous API calls for 15`,
          `minutes (#5674 / #5219).`,
          ``,
          `Route the browser caller through premiumFetch with forcePremium (which`,
          `marks premium intent — src/services/premium-intent.ts), then record the`,
          `call site here.`,
        ].join('\n'),
      );

      const source = readFileSync(join(repoRoot, proof.file), 'utf8');
      const ast = ts.createSourceFile(proof.file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      let premiumFetchCalls = 0;
      let markingCalls = 0;

      // Structural check, not a substring scan: find `premiumFetch(...)` calls
      // whose init object literal sets `forcePremium: true`.
      //
      // The hard part is BINDING that call to the route. An earlier version of
      // this guard set one file-level boolean if any marking call existed
      // anywhere in the file, and it stayed green with the #5674 bug restored
      // verbatim — move the spend-bearing dispatch onto the plain client, leave
      // any other forcePremium call behind, and the boolean is still set.
      //
      // Binding that actually holds, in three parts:
      //   1. Identify the client variable whose `fetch` option routes through
      //      `premiumFetch(..., { forcePremium: true })`.
      //   2. Require EVERY premiumFetch call in the file to be a marking one
      //      (a non-marking call here would be a second, unproven dispatch).
      //   3. Require that client variable to be the receiver of at least one
      //      `.summarizeArticle(...)` call.
      //
      // Part 3 is what a count alone cannot give: this file legitimately calls
      // `summarizeArticle` on BOTH clients — the premium one for spend-bearing
      // summarize, the plain one for free `mode: 'translate'`. Moving the
      // summarize dispatch to the plain client is exactly the regression, and
      // it is visible only as the premium client losing its summarizeArticle
      // receiver.
      let markedClientName: string | null = null;
      let markedClientSummarizeCalls = 0;

      function callMarksPremium(node: ts.CallExpression): boolean {
        if (node.expression.getText(ast) !== 'premiumFetch') return false;
        const init = node.arguments[1];
        if (!init || !ts.isObjectLiteralExpression(init)) return false;
        return init.properties.some((prop) =>
          prop.name?.getText(ast) === proof.premiumFetchCall
          && ts.isPropertyAssignment(prop)
          // `forcePremium: false` would not mark intent — require literal true.
          && prop.initializer.kind === ts.SyntaxKind.TrueKeyword);
      }

      function containsMarkingCall(node: ts.Node): boolean {
        let found = false;
        const walk = (n: ts.Node): void => {
          if (found) return;
          if (ts.isCallExpression(n) && callMarksPremium(n)) { found = true; return; }
          ts.forEachChild(n, walk);
        };
        walk(node);
        return found;
      }

      function visit(node: ts.Node): void {
        if (ts.isCallExpression(node) && node.expression.getText(ast) === 'premiumFetch') {
          premiumFetchCalls += 1;
          if (callMarksPremium(node)) markingCalls += 1;
        }
        // Part 1 — the client whose fetch option carries the marking call.
        // Take the OUTERMOST such declaration: this walk is pre-order, and the
        // marking call sits inside a nested `const response = await
        // premiumFetch(...)` within the client's fetch option. Overwriting on
        // each match would land on that inner temp instead of the client.
        if (
          markedClientName === null
          && ts.isVariableDeclaration(node)
          && ts.isIdentifier(node.name)
          && node.initializer
          && containsMarkingCall(node.initializer)
        ) {
          markedClientName = node.name.text;
        }
        ts.forEachChild(node, visit);
      }
      visit(ast);

      // Part 3 — walk again now that the client name is known.
      if (markedClientName) {
        const countSummarize = (node: ts.Node): void => {
          if (
            ts.isCallExpression(node)
            && ts.isPropertyAccessExpression(node.expression)
            && node.expression.name.text === proof.rpcMethod
            && node.expression.expression.getText(ast) === markedClientName
          ) {
            markedClientSummarizeCalls += 1;
          }
          ts.forEachChild(node, countSummarize);
        };
        countSummarize(ast);
      }

      assert.equal(
        premiumFetchCalls,
        proof.expectedPremiumFetchCalls,
        `${proof.file} is expected to contain exactly ${proof.expectedPremiumFetchCalls} ` +
        `premiumFetch call site(s) (found ${premiumFetchCalls}). This count is pinned because ` +
        `an AST walk cannot bind a call to ${route}: with more than one call site, ` +
        `"some call sets forcePremium" stops proving that THIS route does. If you added a ` +
        `dispatch, update this proof and re-verify which call carries the premium intent.`,
      );
      assert.equal(
        markingCalls,
        premiumFetchCalls,
        `Every premiumFetch call in ${proof.file} must set ` +
        `{ ${proof.premiumFetchCall}: true } so the request carries premium intent ` +
        `(${markingCalls}/${premiumFetchCalls} do). Without it the wm-session interceptor ` +
        `treats the expected Pro denial as a rejected cookie and blacks out anonymous ` +
        `browsing for 15 minutes (#5674).`,
      );
      assert.ok(
        markedClientName,
        `Could not find the client in ${proof.file} whose fetch option routes through ` +
        `premiumFetch(..., { ${proof.premiumFetchCall}: true }). The premium-intent marker ` +
        `for ${route} is therefore unproven.`,
      );
      assert.ok(
        markedClientSummarizeCalls > 0,
        `${proof.file} declares a premium-marked client (${markedClientName}) but never calls ` +
        `${markedClientName}.${proof.rpcMethod}(...). The spend-bearing ${route} dispatch has ` +
        `moved off the marked client, so its 401 is once again read as a rejected session ` +
        `cookie and blacks out anonymous browsing for 15 minutes (#5674). Note this file also ` +
        `calls ${proof.rpcMethod} on the PLAIN client for free translate mode — that one must ` +
        `stay unmarked, which is why this assertion checks the receiver, not the method name.`,
      );
    }
  });

  it('every tier-gated endpoint is also in PREMIUM_RPC_PATHS', () => {
    // src/services/premium-fetch.ts documents this as true "at the time of
    // writing" and relies on it — `isPremiumRpcTarget` checks PREMIUM_RPC_PATHS
    // alone and claims that "one check covers both". Nothing enforced it.
    //
    // The gateway sets `forceKey: isTierGated && !sessionUserId`
    // (server/gateway.ts), and forceKey rejects a perfectly valid anonymous
    // wms_ token with 401 "Pro authentication required" (api/_api-key.js). So a
    // route added to ENDPOINT_ENTITLEMENTS but not to PREMIUM_RPC_PATHS 401s
    // every anonymous browser call while the interceptor still treats that 401
    // as a dead cookie — the exact fresh-mint-then-401 loop behind #5674 and
    // #5251, arriving via a one-line map edit in a different directory.
    const missing = [...TIER_GATED_PATHS].filter((route) => !PREMIUM_RPC_PATHS.has(route));
    assert.deepEqual(
      missing,
      [],
      [
        `These endpoints are tier-gated in ENDPOINT_ENTITLEMENTS`,
        `(server/_shared/entitlement-check.ts) but missing from PREMIUM_RPC_PATHS`,
        `(src/shared/premium-paths.ts):`,
        ...missing.map((r) => `  - ${r}`),
        ``,
        `The gateway forces an API key on tier-gated routes, so an anonymous`,
        `browser gets 401 no matter how fresh its session cookie is. The`,
        `wm-session interceptor then mints, replays, 401s again, and suppresses`,
        `ALL anonymous API calls for 15 minutes (#5674).`,
        ``,
        `Add each route to PREMIUM_RPC_PATHS.`,
      ].join('\n'),
    );
  });

  it('every session-recovery-bypass proof still points at a live allowlist entry', () => {
    for (const route of Object.keys(SESSION_RECOVERY_BYPASS_PROOF)) {
      assert.ok(
        DIRECT_LLM_PREMIUM_BYPASS_ALLOWLIST[route],
        `Stale SESSION_RECOVERY_BYPASS_PROOF entry ${route}: the route is no longer ` +
        `allowlisted, so either drop this proof or restore the allowlist rationale.`,
      );
    }
  });

  it('every direct-LLM bypass remains real and intentionally non-premium', () => {
    for (const route of Object.keys(DIRECT_LLM_PREMIUM_BYPASS_ALLOWLIST)) {
      assert.ok(
        DIRECT_LLM_GATEWAY_QUOTA_PATHS.has(route),
        `Stale direct-LLM bypass ${route}: route is no longer quota-gated.`,
      );
      assert.equal(
        PREMIUM_RPC_PATHS.has(route),
        false,
        `${route} is now premium-routed; remove its stale direct-LLM bypass.`,
      );
    }
  });

  it('country-intel sends the direct-LLM brief request through premiumFetch', () => {
    const source = readFileSync(join(repoRoot, 'src/app/country-intel.ts'), 'utf8');
    const ast = ts.createSourceFile('country-intel.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let usesPremiumFetch = false;

    function visitPremiumFetch(node: ts.Node): void {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(ast) === 'premiumFetch' &&
        node.arguments[0] &&
        ts.isCallExpression(node.arguments[0]) &&
        node.arguments[0].expression.getText(ast) === 'toApiUrl'
      ) {
        const route = node.arguments[0].arguments[0];
        if (
          (ts.isTemplateExpression(route) &&
            route.head.text === '/api/intelligence/v1/get-country-intel-brief?') ||
          (ts.isNoSubstitutionTemplateLiteral(route) &&
            route.text.startsWith('/api/intelligence/v1/get-country-intel-brief?'))
        ) {
          usesPremiumFetch = true;
        }
      }
      ts.forEachChild(node, visitPremiumFetch);
    }

    function visitMethod(node: ts.Node): void {
      if (
        ts.isMethodDeclaration(node) &&
        node.name.getText(ast) === 'fetchCountryIntelBrief' &&
        node.body
      ) {
        visitPremiumFetch(node.body);
        return;
      }
      ts.forEachChild(node, visitMethod);
    }

    visitMethod(ast);
    assert.equal(
      usesPremiumFetch,
      true,
      'The country-intel call site must attach Clerk auth through premiumFetch.',
    );
  });
});
