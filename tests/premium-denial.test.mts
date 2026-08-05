/**
 * Unit tests for the pure premium-denial classifier (#5608).
 *
 * The module under test is a zero-import leaf, so it stays importable under
 * `tsx --test` (no jsdom, no Vite globals) — same pattern as
 * tests/billing-state.test.mts and tests/pro-activation-state.test.mts.
 *
 * The bug: a 403 from a premium endpoint was rendered as "Pro required —
 * upgrade" unconditionally, so a user who had paid minutes earlier saw an
 * upsell during the #5600 entitlement-cache poison window. A 403 the client's
 * own entitlement state disagrees with is a server-side desync, not a missing
 * plan, and `/api/latest-brief` additionally returns 403 for a rejected origin
 * — which is not an entitlement verdict at all.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyDenialResponse,
  classifyPremiumDenial,
  clientBelievesPro,
  isTransientDenial,
  readDenialErrorCode,
  routeDenial,
  shouldSkipDoomedFetch,
  PRO_TIER,
  type ClientEntitlementBelief,
} from '@/services/premium-denial';
import { classifyBillingVerification } from '../server/_shared/entitlement-check.ts';

/** No entitlement snapshot has arrived and the session carries no Pro role. */
const UNKNOWN: ClientEntitlementBelief = { entitlementTier: null, authRole: null };
/** Convex snapshot arrived and says free. */
const FREE: ClientEntitlementBelief = { entitlementTier: 0, authRole: null };
/** Convex snapshot arrived and says Pro — the #5608 case. */
const PRO: ClientEntitlementBelief = { entitlementTier: PRO_TIER, authRole: null };
/** No snapshot, but the Clerk session claims the Pro role. */
const CLERK_PRO: ClientEntitlementBelief = { entitlementTier: null, authRole: 'pro' };

describe('clientBelievesPro', () => {
  it('no snapshot and no role claim → no affirmative Pro belief', () => {
    assert.equal(clientBelievesPro(UNKNOWN), false);
  });

  it('snapshot says free → no affirmative Pro belief', () => {
    assert.equal(clientBelievesPro(FREE), false);
  });

  it('snapshot at or above the Pro tier → affirmative Pro belief', () => {
    assert.equal(clientBelievesPro(PRO), true);
    assert.equal(clientBelievesPro({ entitlementTier: PRO_TIER + 5, authRole: null }), true);
  });

  it('Clerk role claim alone is an affirmative Pro belief', () => {
    assert.equal(clientBelievesPro(CLERK_PRO), true);
  });

  it('a free snapshot does not veto a Pro role claim (either signal suffices)', () => {
    assert.equal(clientBelievesPro({ entitlementTier: 0, authRole: 'pro' }), true);
  });

  it('non-pro role strings are not a Pro belief', () => {
    assert.equal(clientBelievesPro({ entitlementTier: null, authRole: 'free' }), false);
    assert.equal(clientBelievesPro({ entitlementTier: null, authRole: 'admin' }), false);
    assert.equal(clientBelievesPro({ entitlementTier: null, authRole: 'PRO' }), false);
  });

  it('a negative or fractional tier below PRO_TIER is not a Pro belief', () => {
    assert.equal(clientBelievesPro({ entitlementTier: -1, authRole: null }), false);
    assert.equal(clientBelievesPro({ entitlementTier: 0.5, authRole: null }), false);
  });
});

describe('classifyPremiumDenial — non-denial statuses', () => {
  it('returns null for success and for server errors the caller retries anyway', () => {
    for (const status of [200, 204, 400, 404, 429, 500, 502, 503]) {
      assert.equal(
        classifyPremiumDenial({ status, errorCode: null, belief: PRO }),
        null,
        `status ${status} is not a denial the classifier owns`,
      );
    }
  });
});

describe('classifyPremiumDenial — 401', () => {
  it('is always sign_in_required, whatever the client believes', () => {
    for (const belief of [UNKNOWN, FREE, PRO, CLERK_PRO]) {
      assert.equal(
        classifyPremiumDenial({ status: 401, errorCode: 'UNAUTHENTICATED', belief }),
        'sign_in_required',
      );
    }
  });

  it('does not need an error code', () => {
    assert.equal(
      classifyPremiumDenial({ status: 401, errorCode: null, belief: PRO }),
      'sign_in_required',
    );
  });
});

describe('classifyPremiumDenial — 403 entitlement denials', () => {
  it('client agrees it is free → upgrade_required (the honest upsell)', () => {
    assert.equal(
      classifyPremiumDenial({ status: 403, errorCode: 'pro_required', belief: FREE }),
      'upgrade_required',
    );
  });

  it('client has no opinion yet → upgrade_required (server is authoritative)', () => {
    assert.equal(
      classifyPremiumDenial({ status: 403, errorCode: 'pro_required', belief: UNKNOWN }),
      'upgrade_required',
    );
  });

  it('#5608: client entitlement snapshot says Pro → entitlement_desync, never an upsell', () => {
    assert.equal(
      classifyPremiumDenial({ status: 403, errorCode: 'pro_required', belief: PRO }),
      'entitlement_desync',
    );
  });

  it('#5608: Clerk Pro role claim also blocks the upsell', () => {
    assert.equal(
      classifyPremiumDenial({ status: 403, errorCode: 'pro_required', belief: CLERK_PRO }),
      'entitlement_desync',
    );
  });

  /**
   * Every entitlement 403 our own handlers emit carries a JSON `error` string
   * (api/latest-brief.ts:199-207, api/chat-analyst.ts:126, and every branch of
   * entitlement-check.ts). So a 403 with no parseable code did NOT come from
   * our entitlement logic — it is an intermediary (WAF, CDN, proxy). Calling
   * that "Pro required" is the exact conflation this change exists to remove.
   */
  it('a 403 with no parseable error code is infrastructure, not an entitlement verdict', () => {
    for (const belief of [UNKNOWN, FREE, PRO, CLERK_PRO]) {
      assert.equal(
        classifyPremiumDenial({ status: 403, errorCode: null, belief }),
        'access_denied',
        'a bodyless/unlabelled 403 must never be rendered as a missing plan',
      );
    }
  });

  /**
   * Every string a 403 actually carries today. Drift here silently turns an
   * upsell into a retry loop (or back again), so they are pinned explicitly:
   *   api/latest-brief.ts:201                  → 'pro_required'
   *   api/chat-analyst.ts:126                  → 'Pro subscription required'
   *   server/_shared/entitlement-check.ts:556  → 'Upgrade required'
   *   server/_shared/entitlement-check.ts:446  → 'Subscription lapsed'
   *   api/internal/mcp-grant-*.ts              → 'INSUFFICIENT_TIER'
   */
  it('recognises every entitlement code the REST, RPC and MCP surfaces emit', () => {
    for (const code of [
      'pro_required',
      'Pro subscription required',
      'upgrade_required',
      'Upgrade required',
      'INSUFFICIENT_TIER',
      'PRO_REQUIRED',
    ]) {
      assert.equal(
        classifyPremiumDenial({ status: 403, errorCode: code, belief: FREE }),
        'upgrade_required',
        `${code} is an entitlement denial`,
      );
      assert.equal(
        classifyPremiumDenial({ status: 403, errorCode: code, belief: PRO }),
        'entitlement_desync',
        `${code} must not upsell a client that believes it is Pro`,
      );
    }
  });

  it('normalises separators and case so pro_required and "Pro required" agree', () => {
    for (const code of ['pro_required', 'PRO-REQUIRED', 'Pro required', '  pro_required  ']) {
      assert.equal(
        classifyPremiumDenial({ status: 403, errorCode: code, belief: FREE }),
        'upgrade_required',
      );
    }
  });
});

describe('classifyPremiumDenial — billing verdicts the client cannot contradict', () => {
  /**
   * `Subscription lapsed` (server/_shared/entitlement-check.ts:446) comes from
   * `entitlements.billingStatus` — the provider confirmed coverage ended. It is
   * NOT the cache-poisonable tier check, and the client literally cannot
   * disagree with it: `EntitlementState` (src/services/entitlements.ts) carries
   * planKey/features/validUntil and no billingStatus. Treating it as a desync
   * would retry a lapsed subscriber forever behind "Verifying your Pro access"
   * instead of giving them a way back.
   */
  it('Subscription lapsed stays terminal even when the client believes it is Pro', () => {
    for (const belief of [UNKNOWN, FREE, PRO, CLERK_PRO]) {
      assert.equal(
        classifyPremiumDenial({ status: 403, errorCode: 'Subscription lapsed', belief }),
        'upgrade_required',
        'a provider-confirmed lapse must never become an infinite retry',
      );
    }
  });

  it('normalises the lapsed code the same way as the rest', () => {
    assert.equal(
      classifyPremiumDenial({ status: 403, errorCode: 'subscription_lapsed', belief: PRO }),
      'upgrade_required',
    );
  });
});

describe('classifyPremiumDenial — 403 that means "authenticate", not "upgrade"', () => {
  /**
   * The shared gateway 403s (not 401s) an unauthenticated caller —
   * server/_shared/entitlement-check.ts:508. Rendering that as an upsell
   * tells a signed-out user to buy a plan they may already own.
   */
  it("gateway 'Authentication required' is sign_in_required", () => {
    for (const belief of [UNKNOWN, FREE, PRO, CLERK_PRO]) {
      assert.equal(
        classifyPremiumDenial({ status: 403, errorCode: 'Authentication required', belief }),
        'sign_in_required',
      );
    }
  });

  it("'UNAUTHENTICATED' on a 403 is also sign_in_required", () => {
    assert.equal(
      classifyPremiumDenial({ status: 403, errorCode: 'UNAUTHENTICATED', belief: FREE }),
      'sign_in_required',
    );
  });
});

describe('classifyPremiumDenial — 403 that is not about entitlement', () => {
  it('origin and generic access denials stay access_denied for every belief', () => {
    for (const errorCode of ['Origin not allowed', 'Forbidden']) {
      for (const belief of [UNKNOWN, FREE, PRO, CLERK_PRO]) {
        assert.equal(
          classifyPremiumDenial({ status: 403, errorCode, belief }),
          'access_denied',
          `${errorCode} must never be rendered as a missing plan`,
        );
      }
    }
  });

  it('an unrecognised 403 code is access_denied even for a free client', () => {
    assert.equal(
      classifyPremiumDenial({ status: 403, errorCode: 'forbidden_by_waf', belief: FREE }),
      'access_denied',
    );
  });

  /**
   * server/_shared/entitlement-check.ts:527 fails CLOSED when Redis and Convex
   * are both unreachable. That 403 states nothing about the plan, so it must
   * never upsell — not even a client with no entitlement snapshot.
   */
  it("'Unable to verify entitlements' is access_denied for every belief", () => {
    for (const belief of [UNKNOWN, FREE, PRO, CLERK_PRO]) {
      assert.equal(
        classifyPremiumDenial({ status: 403, errorCode: 'Unable to verify entitlements', belief }),
        'access_denied',
        'a failed entitlement lookup is not a verdict about the plan',
      );
    }
  });
});

describe('readDenialErrorCode', () => {
  const json = (body: unknown, status = 403) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  it("extracts the real api/latest-brief 403 body's error field", async () => {
    const res = json({
      error: 'pro_required',
      message: 'The Brief is available on the Pro plan.',
      upgradeUrl: 'https://worldmonitor.app/pro',
    });
    assert.equal(await readDenialErrorCode(res), 'pro_required');
  });

  it("extracts the gateway's 'Upgrade required' body", async () => {
    const res = json({ error: 'Upgrade required', requiredTier: 1, currentTier: 0, planKey: 'free' });
    assert.equal(await readDenialErrorCode(res), 'Upgrade required');
  });

  it('a non-JSON body yields null rather than throwing', async () => {
    const res = new Response('<html>403 Forbidden</html>', { status: 403 });
    assert.equal(await readDenialErrorCode(res), null);
  });

  it('an empty body yields null', async () => {
    assert.equal(await readDenialErrorCode(new Response(null, { status: 403 })), null);
  });

  it('a JSON body with no error field yields null', async () => {
    assert.equal(await readDenialErrorCode(json({ message: 'nope' })), null);
  });

  it('a non-string error field yields null (no [object Object] codes)', async () => {
    assert.equal(await readDenialErrorCode(json({ error: { code: 'pro_required' } })), null);
    assert.equal(await readDenialErrorCode(json({ error: 403 })), null);
  });

  it('an already-consumed body yields null rather than throwing', async () => {
    const res = json({ error: 'pro_required' });
    await res.text();
    assert.equal(await readDenialErrorCode(res), null);
  });

  it('null composes into access_denied — an unreadable 403 is never an upsell', async () => {
    const code = await readDenialErrorCode(new Response('not json', { status: 403 }));
    assert.equal(code, null);
    assert.equal(classifyPremiumDenial({ status: 403, errorCode: code, belief: PRO }), 'access_denied');
    assert.equal(classifyPremiumDenial({ status: 403, errorCode: code, belief: FREE }), 'access_denied');
  });
});

describe('isTransientDenial', () => {
  it('desync and access_denied are worth retrying', () => {
    assert.equal(isTransientDenial('entitlement_desync'), true);
    assert.equal(isTransientDenial('access_denied'), true);
  });

  it('sign-in and upgrade are terminal — retrying cannot flip them', () => {
    assert.equal(isTransientDenial('sign_in_required'), false);
    assert.equal(isTransientDenial('upgrade_required'), false);
  });

  it('null (no denial) is not transient', () => {
    assert.equal(isTransientDenial(null), false);
  });
});

// ---------------------------------------------------------------------------
// Wiring guard
// ---------------------------------------------------------------------------

/**
 * The classifier is only worth anything if the panels actually call it. These
 * panels build their DOM with `replaceChildren`, so there is no jsdom in this
 * repo to drive them end-to-end (see tests/panel-attached-fetch-guard.test.mts
 * for the same constraint). Pin the wiring at the source level instead, so a
 * future edit cannot quietly restore the blanket `403 → upsell` branch.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (rel: string): string => readFileSync(resolve(root, rel), 'utf8');

const WIRED_PANELS = [
  'src/components/LatestBriefPanel.ts',
  'src/components/ChatAnalystPanel.ts',
];

describe('premium panels route their denials through the classifier', () => {
  for (const rel of WIRED_PANELS) {
    it(`${rel} classifies denials through the shared helper`, () => {
      assert.match(readSource(rel), /classifyDenialResponse\(/);
    });

    /**
     * The only legitimate reason these panels still mention 403 is deciding
     * whether to read the body for the classifier — and that check always
     * pairs 403 with 401. A line that inspects 403 alone is a verdict reached
     * without consulting the client's entitlement state, which is the bug.
     */
    it(`${rel} never inspects a 403 on its own`, () => {
      const offenders = readSource(rel)
        .split('\n')
        .map((line, i) => ({ line: line.trim(), lineNumber: i + 1 }))
        // Prose about the old behaviour is not the old behaviour.
        .filter(({ line }) => !/^(\/\/|\/\*|\*)/.test(line))
        .filter(({ line }) => /\bstatus\s*[!=]==?\s*403\b/.test(line))
        .filter(({ line }) => !/\bstatus\s*[!=]==?\s*401\b/.test(line));
      assert.deepEqual(
        offenders,
        [],
        `${rel} branches on a bare 403 instead of classifying it`,
      );
    });
  }

  /**
   * The routing itself is proven by the executable `routeDenial` truth table
   * below, not by grepping this file — an earlier proximity-regex version of
   * this guard was shown to stay green with the #5608 bug restored verbatim,
   * because a neighbouring branch supplied the token it searched for.
   *
   * What IS worth pinning in source: the panel must route through routeDenial
   * rather than re-deriving the decision inline, and there must be exactly the
   * expected number of upsell call sites — a third one is the mutation that
   * reintroduces the bug.
   */
  it('LatestBriefPanel routes its denials through routeDenial', () => {
    assert.match(readSource('src/components/LatestBriefPanel.ts'), /routeDenial\(/);
  });

  it('LatestBriefPanel has exactly two renderUpgradeRequired call sites', () => {
    const source = readSource('src/components/LatestBriefPanel.ts');
    const calls = [...source.matchAll(/this\.renderUpgradeRequired\(\)/g)];
    assert.equal(
      calls.length,
      2,
      'expected exactly two upsell call sites — the pre-fetch affirmative-denial '
      + "gate and routeDenial's 'upgrade' case. A third is how #5608 comes back.",
    );
  });

  it("ChatAnalystPanel no longer hardcodes the upsell as its only 403 copy", () => {
    // The decision moved to src/services/analyst-denial.ts (a zero-runtime-import
    // leaf) so it is reachable from tsx --test — ChatAnalystPanel imports
    // DOMPurify at module scope and cannot be loaded there. The copy itself is
    // now pinned by EXECUTION in tests/analyst-denial.test.mts rather than by
    // this regex, which is strictly stronger: a swapped branch fails there and
    // would not have failed here.
    const panel = readSource('src/components/ChatAnalystPanel.ts');
    assert.equal(
      [...panel.matchAll(/'Pro subscription required\.'/g)].length,
      0,
      'the panel must not re-inline the upsell copy it delegates',
    );
    assert.match(
      panel,
      /analystDenialMessage\(res\.status, verdict\)/,
      'the panel must route its denial copy through the extracted decision',
    );

    const leaf = readSource('src/services/analyst-denial.ts');
    const upsells = [...leaf.matchAll(/'Pro subscription required\.'/g)];
    assert.equal(upsells.length, 1, 'exactly one upsell string, in the verdict switch');
    const preceding = leaf.slice(Math.max(0, upsells[0].index - 200), upsells[0].index);
    assert.match(
      preceding,
      /case 'upgrade_required':/,
      'the upsell string must sit under the upgrade_required case',
    );
  });

  it('reports the only three client-side entitlement-desync decision sites', () => {
    const expectedCalls = new Map([
      ['src/components/LatestBriefPanel.ts', "if (verdict === 'entitlement_desync') reportEntitlementDesync('latest-brief');"],
      ['src/components/ChatAnalystPanel.ts', "if (verdict === 'entitlement_desync') reportEntitlementDesync('chat-analyst');"],
      ['src/components/WidgetChatModal.ts', "if (verdict === 'entitlement_desync') reportEntitlementDesync('widget-chat');"],
    ]);
    for (const [rel, expectedCall] of expectedCalls) {
      assert.match(
        readSource(rel),
        new RegExp(expectedCall.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        `${rel} must make its client-side desync decision observable`,
      );
    }
  });

  it('classifies widget preflight denials from the account belief, not the widget tier', () => {
    const source = readSource('src/components/WidgetChatModal.ts');
    assert.match(
      source,
      /function reportWidgetEntitlementDesync\([\s\S]*?if \(usedTesterKey \|\| \(getAuthState\(\)\.user\?\.id \?\? null\) !== requestUserId\) return;[\s\S]*?const verdict = classifyPremiumDenial\(\{\s*status,\s*errorCode: payload\?\.error \?\? null,\s*belief: requestBelief,\s*\}\);[\s\S]*?if \(verdict === 'entitlement_desync'\) reportEntitlementDesync\('widget-chat'\);/,
      'widget telemetry must classify the request-time account belief and reject responses from another account',
    );
    assert.match(
      source,
      /const requestAuthState = getAuthState\(\);[\s\S]*?const requestUserId = requestAuthState\.user\?\.id \?\? null;[\s\S]*?const requestBelief = readClientEntitlementBelief\(requestAuthState\);[\s\S]*?const res = await fetch\(widgetAgentHealthUrl\(\)[\s\S]*?resolvePreflightMessage\([\s\S]*?requestBelief,[\s\S]*?requestUserId,[\s\S]*?\);/,
      'widget preflight must carry its request account snapshot into denial telemetry',
    );
    assert.match(
      source,
      /const res = await fetch\(widgetAgentUrl\(\),[\s\S]*?if \(!res\.ok\) \{[\s\S]*?reportWidgetEntitlementDesync\(\s*res\.status,\s*payload,\s*auth\.usedTesterKey,\s*requestBelief,\s*requestUserId,\s*\);/,
      'widget POST denials must classify and report with their request account snapshot',
    );
    assert.equal(
      [...source.matchAll(/reportWidgetEntitlementDesync\(/g)].length,
      3,
      'the widget telemetry helper must be declared once and called from both preflight and POST',
    );
  });

  it('binds Chat Analyst denial telemetry to the account that made the request', () => {
    const source = readSource('src/components/ChatAnalystPanel.ts');
    assert.match(
      source,
      /const requestAuthState = getAuthState\(\);[\s\S]*?const requestUserId = requestAuthState\.user\?\.id \?\? null;[\s\S]*?const requestBelief = readClientEntitlementBelief\(requestAuthState\);/,
      'Chat Analyst must snapshot the request account and its entitlement belief',
    );
    assert.match(
      source,
      /if \(requestIdentityChanged\(\)\) throw[\s\S]*?const verdict = await classifyDenialResponse\(res, requestBelief\);[\s\S]*?if \(requestIdentityChanged\(\)\) throw[\s\S]*?if \(verdict === 'entitlement_desync'\) reportEntitlementDesync\('chat-analyst'\);/,
      'Chat Analyst must reject account changes both before and after consuming the denial body',
    );
    assert.match(
      source,
      /describeDenial\(res, requestBelief, requestUserId\)/,
      'Chat Analyst must pass the request-time account snapshot into denial classification',
    );
  });
});

// ---------------------------------------------------------------------------
// Server-vocabulary contract
// ---------------------------------------------------------------------------

/**
 * The classifier matches on error strings the backends emit, which is an
 * implicit unversioned contract: a server-side rename silently reroutes a
 * denial (an upsell becomes an infinite retry, or vice versa) with nothing
 * failing. Parse the real server sources and assert every 401/403 string they
 * emit is one the classifier deliberately accounts for.
 *
 * A new server denial string fails this test. Fix it by classifying the string
 * — add it to ENTITLEMENT_DENIAL_CODES / AUTHENTICATION_CODES in
 * src/services/premium-denial.ts, or to KNOWN_NON_ENTITLEMENT_CODES below if it
 * is genuinely not a statement about the user's plan.
 */
const DENIAL_SOURCES = [
  'api/latest-brief.ts',
  'api/chat-analyst.ts',
  'server/_shared/entitlement-check.ts',
];

/**
 * 403/401 strings that are deliberately NOT entitlement verdicts, so the
 * classifier routes them to access_denied / sign_in_required rather than an
 * upsell. Each must stay non-upselling.
 */
const KNOWN_NON_ENTITLEMENT_CODES = new Set([
  'Origin not allowed',            // api/latest-brief.ts — rejected origin
  'Unable to verify entitlements', // entitlement-check.ts — fail-closed lookup
  'Unable to verify API access',   // entitlement-check.ts — 503 verification path
  'UNAUTHENTICATED',               // api/latest-brief.ts — 401
  'Authentication required',       // entitlement-check.ts — 403-shaped 401
]);

/**
 * Pull every `error: '<literal>'` whose OWN response carries a 401/403.
 *
 * Scope note (#5622): this covers hand-written response literals only. The
 * billing-verification strings are NOT reachable this way any more — they moved
 * behind `classifyBillingVerification`, which returns `{ message, status }` for a
 * renderer to map onto the wire `error` field. Widening the pattern to `message:`
 * is the wrong fix: it also scrapes prose fields like api/latest-brief.ts's
 * `message: 'The Brief is available on the Pro plan.'`, which is copy, not a code.
 * Those strings are covered by executing the classifier instead — see the
 * describe block below this one.
 *
 * Pairing matters: a proximity window would attribute the 401 a few lines
 * below `{ error: 'Method not allowed' }, 405` to that 405, so scan forward to
 * the FIRST status literal after the error string and use only that one.
 */
function extractDenialStrings(source: string): string[] {
  const found = new Set<string>();
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = /error:\s*'([^']+)'/.exec(lines[i]);
    if (!match) continue;
    const ahead = lines.slice(i, i + 10).join('\n').slice(match.index);
    // Status appears either as a positional arg (`}, 403,`) or a property
    // (`status: 403`). Take the first one — it belongs to this response.
    const status = /(?:,\s*|status:\s*)(\d{3})\b/.exec(ahead);
    if (status && (status[1] === '401' || status[1] === '403')) found.add(match[1]);
  }
  return [...found];
}

describe('classifier vocabulary matches what the servers actually emit', () => {
  for (const rel of DENIAL_SOURCES) {
    it(`every 401/403 error string in ${rel} is accounted for`, () => {
      const strings = extractDenialStrings(readSource(rel));
      assert.ok(strings.length > 0, `${rel} should emit at least one denial string`);
      for (const code of strings) {
        if (KNOWN_NON_ENTITLEMENT_CODES.has(code)) {
          // Must NOT upsell — not even a client with no entitlement opinion.
          assert.notEqual(
            classifyPremiumDenial({ status: 403, errorCode: code, belief: UNKNOWN }),
            'upgrade_required',
            `${rel}: '${code}' is not an entitlement verdict and must never upsell`,
          );
          continue;
        }
        // Everything else must be a recognised entitlement verdict: it upsells
        // a client that agrees it is free, and never upsells one that believes
        // it is Pro (unless it is a terminal billing verdict).
        const asFree = classifyPremiumDenial({ status: 403, errorCode: code, belief: FREE });
        assert.equal(
          asFree,
          'upgrade_required',
          `${rel}: '${code}' is unclassified — it would silently route to access_denied `
          + 'and retry forever instead of showing the upgrade CTA. Add it to '
          + 'ENTITLEMENT_DENIAL_CODES or KNOWN_NON_ENTITLEMENT_CODES.',
        );
      }
    });
  }

  it('pro_required and Pro subscription required are the live blast radius', () => {
    // The two panels wired today only call /api/latest-brief and
    // /api/chat-analyst; the gateway strings are forward-looking coverage.
    assert.equal(
      classifyPremiumDenial({ status: 403, errorCode: 'pro_required', belief: PRO }),
      'entitlement_desync',
    );
    assert.equal(
      classifyPremiumDenial({ status: 403, errorCode: 'Pro subscription required', belief: PRO }),
      'entitlement_desync',
    );
  });
});

// ---------------------------------------------------------------------------
// Billing-verification vocabulary — executed, not scraped
// ---------------------------------------------------------------------------

/**
 * The billing strings used to be hand-written `error: '...'` literals that
 * `extractDenialStrings` above could scrape. #5622 moved them behind
 * `classifyBillingVerification`, which returns `{ message, status }` for a
 * renderer to map onto the wire `error` field — so the regex silently stopped
 * covering them (it kept passing on the file's other literals).
 *
 * Widening the regex to `message:` is the wrong repair: it also scrapes prose
 * fields like api/latest-brief.ts's `message: 'The Brief is available on the Pro
 * plan.'`, which is copy rather than a code. Instead, CALL the classifier and
 * assert the client agrees with every string it can actually emit. Exact by
 * construction, and it cannot drift — a new billing status shows up here the
 * moment the classifier can return it.
 */
describe('the client classifies every string classifyBillingVerification can emit', () => {
  const BILLING_INPUTS = [
    { label: 'transient lookup failure', input: { verificationUnavailable: true as const } },
    { label: 'confirmed lapse', input: { billingStatus: 'subscription_lapsed' as const } },
    { label: 'renewal pending', input: { billingStatus: 'renewal_verification_pending' as const } },
    { label: 'renewal failed', input: { billingStatus: 'renewal_verification_failed' as const } },
  ];

  for (const { label, input } of BILLING_INPUTS) {
    it(`${label}: its wire string is accounted for at its own status`, () => {
      const denial = classifyBillingVerification(input);
      assert.ok(denial, `${label} must produce a denial`);

      const verdict = classifyPremiumDenial({
        status: denial.status,
        errorCode: denial.message,
        belief: PRO,
      });

      if (denial.retryable) {
        // A retryable denial rides a 503, which this classifier deliberately does
        // not own (the caller retries on status). What matters is that it is never
        // an upsell.
        assert.notEqual(
          verdict,
          'upgrade_required',
          `${label} is transient and must never render as "buy Pro"`,
        );
      } else {
        // The one terminal member. It must upsell even for a client convinced it
        // is Pro, or a lapsed subscriber retries forever with no way back.
        assert.equal(
          verdict,
          'upgrade_required',
          `${label} is provider-confirmed and must route to the upgrade CTA`,
        );
      }
    });
  }

  it('the terminal member is the only one that upsells', () => {
    const terminal = BILLING_INPUTS.filter(
      ({ input }) => classifyBillingVerification(input)?.retryable === false,
    );
    assert.equal(terminal.length, 1, 'exactly one billing state may be terminal');
    assert.equal(classifyBillingVerification(terminal[0].input)?.code, 'subscription_lapsed');
  });
});

// ---------------------------------------------------------------------------
// routeDenial — the executable truth table that replaces the regex guard
// ---------------------------------------------------------------------------

/**
 * This is the decision #5608 got wrong: a transient verdict routed to the
 * upsell. An earlier source-regex guard was demonstrated to pass with the bug
 * fully restored, so the contract lives here, where it is actually executed.
 */
describe('routeDenial', () => {
  const MAX = 8;

  it('sign_in_required is terminal sign-in, at any streak', () => {
    for (const streak of [0, 1, MAX, MAX + 100]) {
      assert.equal(routeDenial('sign_in_required', streak, MAX), 'sign_in');
    }
  });

  it('upgrade_required is the upsell, at any streak', () => {
    for (const streak of [0, 1, MAX, MAX + 100]) {
      assert.equal(routeDenial('upgrade_required', streak, MAX), 'upgrade');
    }
  });

  it('#5608: a transient verdict NEVER routes to the upsell', () => {
    for (const verdict of ['entitlement_desync', 'access_denied'] as const) {
      for (const streak of [0, 1, MAX, MAX + 1, MAX + 100]) {
        assert.notEqual(
          routeDenial(verdict, streak, MAX),
          'upgrade',
          `${verdict} at streak ${streak} must never become an upsell`,
        );
      }
    }
  });

  it('transient verdicts retry while the budget lasts', () => {
    for (const verdict of ['entitlement_desync', 'access_denied'] as const) {
      for (let streak = 0; streak <= MAX; streak++) {
        assert.equal(routeDenial(verdict, streak, MAX), 'retry', `streak ${streak} still retries`);
      }
    }
  });

  it('the loop terminates once the budget is spent', () => {
    for (const verdict of ['entitlement_desync', 'access_denied'] as const) {
      assert.equal(routeDenial(verdict, MAX + 1, MAX), 'give_up');
      assert.equal(routeDenial(verdict, MAX + 50, MAX), 'give_up');
    }
  });

  it('give_up is terminal but is not an upsell', () => {
    // The whole point: exhausting retries means we could not verify, which is
    // not evidence the user needs to buy anything.
    assert.equal(routeDenial('entitlement_desync', MAX + 1, MAX), 'give_up');
  });
});

// ---------------------------------------------------------------------------
// shouldSkipDoomedFetch — the pre-fetch gate's boolean composition
// ---------------------------------------------------------------------------

describe('shouldSkipDoomedFetch', () => {
  it('no snapshot yet → never pre-empt the server', () => {
    for (const belief of [UNKNOWN, FREE, PRO, CLERK_PRO]) {
      assert.equal(shouldSkipDoomedFetch(false, belief), false);
    }
  });

  it('snapshot says free and nothing contradicts it → skip the doomed fetch', () => {
    assert.equal(shouldSkipDoomedFetch(true, FREE), true);
    assert.equal(shouldSkipDoomedFetch(true, UNKNOWN), true);
  });

  it('#5608: snapshot says Pro → fetch, never pre-render the upsell', () => {
    assert.equal(shouldSkipDoomedFetch(true, PRO), false);
  });

  it('#5608: a free snapshot contradicted by a Clerk Pro role → let the server decide', () => {
    assert.equal(shouldSkipDoomedFetch(true, { entitlementTier: 0, authRole: 'pro' }), false);
  });
});

// ---------------------------------------------------------------------------
// classifyDenialResponse — the real glue, against real Response objects
// ---------------------------------------------------------------------------

/**
 * Both panels call this instead of reimplementing the status gate + body read.
 * Driving it with genuine Response objects covers the seam the source-level
 * guards cannot reach (wrong field, missing await, wrong status gate).
 */
describe('classifyDenialResponse', () => {
  const denial = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  it('leaves a success body unconsumed so the caller can still read it', async () => {
    const res = denial({ status: 'ready', issueDate: '2026-07-25' }, 200);
    assert.equal(await classifyDenialResponse(res, PRO), null);
    assert.equal(res.bodyUsed, false, 'the success stream must survive classification');
    assert.deepEqual(await res.json(), { status: 'ready', issueDate: '2026-07-25' });
  });

  it('leaves a 500 body unconsumed too — only denials are read', async () => {
    const res = denial({ error: 'boom' }, 500);
    assert.equal(await classifyDenialResponse(res, PRO), null);
    assert.equal(res.bodyUsed, false);
  });

  it("#5608: the real api/latest-brief 403 body + a Pro client → desync, not upsell", async () => {
    const res = denial({
      error: 'pro_required',
      message: 'The Brief is available on the Pro plan.',
      upgradeUrl: 'https://worldmonitor.app/pro',
    }, 403);
    assert.equal(await classifyDenialResponse(res, PRO), 'entitlement_desync');
  });

  it('the same body with a free client → the honest upsell', async () => {
    const res = denial({ error: 'pro_required' }, 403);
    assert.equal(await classifyDenialResponse(res, FREE), 'upgrade_required');
  });

  it("api/chat-analyst's 403 body classifies the same way", async () => {
    assert.equal(
      await classifyDenialResponse(denial({ error: 'Pro subscription required' }, 403), PRO),
      'entitlement_desync',
    );
    assert.equal(
      await classifyDenialResponse(denial({ error: 'Pro subscription required' }, 403), FREE),
      'upgrade_required',
    );
  });

  it("a rejected origin is never an upsell", async () => {
    assert.equal(
      await classifyDenialResponse(denial({ error: 'Origin not allowed' }, 403), FREE),
      'access_denied',
    );
  });

  it('a 401 is sign_in_required', async () => {
    assert.equal(
      await classifyDenialResponse(denial({ error: 'UNAUTHENTICATED' }, 401), PRO),
      'sign_in_required',
    );
  });

  it('a non-JSON WAF 403 page is access_denied, not an upsell', async () => {
    const res = new Response('<html><body>403 Forbidden</body></html>', { status: 403 });
    assert.equal(await classifyDenialResponse(res, FREE), 'access_denied');
  });
});
