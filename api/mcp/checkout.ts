/**
 * In-flow MCP upgrade (#9144): `start_upgrade` and the denial hints that
 * point at it.
 *
 * There is no new payment path here. The tool relays to the same Convex
 * `/relay/create-checkout` action `api/create-checkout.ts` uses, so the
 * product allowlist, the per-account checkout admission limit, the Dodo
 * rate-limit ladder and the already-subscribed / pending-payment guards all
 * apply unchanged. The agent receives a checkout URL; the user pays in a
 * browser. Nothing here charges or handles payment details.
 *
 * API Starter is the one exception to "always a checkout": an individual Pro
 * holder moves to it in place (a prorated change on the same subscription),
 * so the tool first asks the switch relay for a quote and, when the account
 * has a Pro to switch, refuses with the dashboard step instead of selling a
 * second subscription. The quote is never confirmed from here.
 */

import catalog from '../../shared/product-catalog.generated.json';
import mcpOffers from '../../shared/mcp-offer-plans.generated.json';
import { MCP_ATTRIBUTION_SOURCE } from '../../shared/mcp-attribution';
// @ts-expect-error — JS module, no declaration file
import { captureSilentError } from '../_sentry-edge.js';
import { rpcError } from './rpc';
import type { McpPlanFeature } from './types';

export const START_UPGRADE_TOOL = 'start_upgrade';

const CHECKOUT_RELAY_USER_AGENT = 'worldmonitor-mcp-edge/1.0';
const CHECKOUT_RELAY_TIMEOUT_MS = 15_000;
// The quote and a following checkout share one edge response, which must
// start within 25 s: 8 s here plus the checkout's 15 s. A timeout reads as
// unknown, so a Pro-entitled caller gets a retryable 503, not a checkout.
const SWITCH_PREVIEW_RELAY_TIMEOUT_MS = 8_000;

/** Plans a Pro holder reaches by switching in place, not through checkout. */
const API_STARTER_SWITCH_PLANS: ReadonlySet<string> = new Set(['api_starter', 'api_starter_annual']);
/** Entitlement plans that may come from an individual Pro the server would switch. */
const API_STARTER_SWITCH_SOURCE_PLANS: ReadonlySet<string> = new Set(['pro_monthly', 'pro_monthly_mcp', 'pro_annual']);
const SWITCH_URL = 'https://www.worldmonitor.app/dashboard?settings=account';

interface CatalogPlan {
  planKey: string;
  tierGroup: string;
  selfServe: boolean;
  currentForCheckout: boolean;
}

interface McpOfferPlan extends CatalogPlan {
  dodoProductId: string;
  priceCents: number;
}

/** Plans sold only through MCP (catalog `offerChannel: "mcp"`), never listed publicly. */
const MCP_OFFER_PLANS = mcpOffers.plans as McpOfferPlan[];
const PLANS: CatalogPlan[] = [...(catalog.facts.plans as CatalogPlan[]), ...MCP_OFFER_PLANS];
const PRODUCTS: Record<string, { planKey: string }> = {
  ...(catalog.products as Record<string, { planKey: string }>),
  ...Object.fromEntries(MCP_OFFER_PLANS.map((plan) => [plan.dodoProductId, { planKey: plan.planKey }])),
};

/** The plans `start_upgrade` accepts: every self-serve plan currently sold, MCP-only plans included. */
export const MCP_CHECKOUT_PLANS: readonly string[] = PLANS
  .filter((plan) => plan.selfServe && plan.currentForCheckout)
  .map((plan) => plan.planKey);

/** Dodo product id for a checkout plan, or undefined when it is not sold. */
export function checkoutProductIdForPlan(plan: string): string | undefined {
  if (!MCP_CHECKOUT_PLANS.includes(plan)) return undefined;
  return Object.entries(PRODUCTS).find(([, product]) => product.planKey === plan)?.[0];
}

// One step up within the same product line. Pro Business, API Business and
// Enterprise have no self-serve step above them, so they get no
// recommendation; in-place plan changes stay with the billing portal.
// A free account is offered the MCP-only Pro price when one is on sale.
const NEXT_PLAN_BY_TIER_GROUP: Record<string, string> = {
  free: MCP_OFFER_PLANS.find((plan) => plan.tierGroup === 'pro' && plan.currentForCheckout)?.planKey ?? 'pro_monthly',
  pro: 'pro_business_monthly',
  api_starter: 'api_business',
};

/**
 * The plan to offer a caller whose current plan is `planKey` (`'free'` for a
 * free account). An unknown or missing plan gets no recommendation: guessing
 * Pro for a paid caller whose row lacks a plan key would offer a downgrade.
 */
export function recommendedPlanFor(planKey: string | undefined): string | undefined {
  const tierGroup = PLANS.find((plan) => plan.planKey === planKey)?.tierGroup;
  const next = tierGroup === undefined ? undefined : NEXT_PLAN_BY_TIER_GROUP[tierGroup];
  return next !== undefined && MCP_CHECKOUT_PLANS.includes(next) ? next : undefined;
}

// The cheapest self-serve plan in the caller's line that carries the feature.
// Pro is the one step up for a free account in general, but Pro lacks these
// features, so a free account is pointed at Pro Business instead.
const FEATURE_PLAN_BY_TIER_GROUP: Record<McpPlanFeature, Record<string, string>> = {
  travelRiskAssessment: {
    free: 'pro_business_monthly',
    pro: 'pro_business_monthly',
    api_starter: 'api_business',
  },
};

/** The plan to offer a caller whose plan lacks `feature`, as `recommendedPlanFor` does for a tier. */
export function recommendedPlanForFeature(planKey: string | undefined, feature: McpPlanFeature): string | undefined {
  const tierGroup = PLANS.find((plan) => plan.planKey === planKey)?.tierGroup;
  const next = tierGroup === undefined ? undefined : FEATURE_PLAN_BY_TIER_GROUP[feature][tierGroup];
  return next !== undefined && MCP_CHECKOUT_PLANS.includes(next) ? next : undefined;
}

/**
 * The sentence that names an MCP-only plan's price in a denial, or undefined
 * for any other plan. ChatGPT replaces `nextStep` wholesale (host-policy.ts),
 * so the price never reaches an inform-only host.
 */
export function mcpOfferSentence(plan: string | undefined): string | undefined {
  const offer = MCP_OFFER_PLANS.find((candidate) => candidate.planKey === plan);
  if (!offer) return undefined;
  const price = (offer.priceCents / 100).toFixed(2);
  return `Pro is $${price} a month for accounts that connect through MCP: `
    + `call ${START_UPGRADE_TOOL} with plan "${offer.planKey}" to get a checkout link.`;
}

export interface StartUpgradeResult {
  checkoutUrl: string;
  plan: string;
  nextStep: string;
}

export interface McpCheckoutSubscription {
  planKey: string;
  displayName: string;
  status: string;
  currentPeriodEnd: number;
}

export type McpCheckoutOutcome =
  | { kind: 'created'; checkoutUrl: string }
  | { kind: 'already-subscribed'; message: string; subscription: McpCheckoutSubscription | null }
  | { kind: 'payment-in-progress'; message: string }
  | { kind: 'rate-limited'; retryAfterSeconds: number }
  | { kind: 'invalid-product' }
  | { kind: 'unavailable'; cause: string };

export type McpCreateCheckout = (input: { userId: string; productId: string }) => Promise<McpCheckoutOutcome>;

/**
 * What the switch relay's quote says about the account:
 * - switch-in-place: it holds a Pro the server switches (a quote, or a refusal
 *   sent only after the server picked that subscription);
 * - resume-first: that Pro is set to cancel;
 * - not-switchable: no Pro to switch, so API Starter is sold as before;
 * - unknown: no answer (an older Convex without the relay, a timeout).
 */
export type McpApiStarterSwitchVerdict =
  | { kind: 'switch-in-place' }
  | { kind: 'resume-first' }
  | { kind: 'not-switchable' }
  | { kind: 'unknown'; cause: string };

export type McpPreviewApiStarterSwitch = (input: { userId: string }) => Promise<McpApiStarterSwitchVerdict>;

const SWITCH_NOT_SWITCHABLE_ERRORS: ReadonlySet<string> = new Set(['NO_UPGRADEABLE_PRO', 'ALREADY_API_PLAN', 'ACCOUNT_DELETION_IN_PROGRESS']);
const SWITCH_HOLDER_ERRORS: ReadonlySet<string> = new Set(['UPGRADE_RATE_LIMITED', 'UPGRADE_IN_PROGRESS', 'DODO_PLAN_CHANGE_ERROR']);

function convexSiteUrl(): string {
  return process.env.CONVEX_SITE_URL
    ?? (process.env.CONVEX_URL ?? '').replace('.convex.cloud', '.convex.site');
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readSubscription(value: unknown): McpCheckoutSubscription | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const planKey = readString(row.planKey);
  const displayName = readString(row.displayName);
  const status = readString(row.status);
  if (!planKey || !displayName || !status || typeof row.currentPeriodEnd !== 'number') return null;
  return { planKey, displayName, status, currentPeriodEnd: row.currentPeriodEnd };
}

/**
 * Production checkout relay. Identity comes from the verified MCP context, so
 * the userId sent here is the one the credential is bound to. No email is
 * sent: the activation webhook reads it from the account's `users` row, which
 * checkout creation writes along with the Terms acceptance record. The Terms
 * count an MCP request as acceptance (docs/terms.mdx, "Accepting these Terms").
 */
export async function relayMcpCheckout(
  input: { userId: string; productId: string },
  fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args),
): Promise<McpCheckoutOutcome> {
  const siteUrl = convexSiteUrl();
  const secret = process.env.CONVEX_TENANT_RELAY_SECRET ?? '';
  if (!siteUrl || !secret) return { kind: 'unavailable', cause: 'relay-unconfigured' };

  let response: Response;
  let data: Record<string, unknown> = {};
  try {
    response = await fetchImpl(`${siteUrl}/relay/create-checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${secret}`,
        'User-Agent': CHECKOUT_RELAY_USER_AGENT,
      },
      body: JSON.stringify({
        userId: input.userId,
        productId: input.productId,
        attributionSource: MCP_ATTRIBUTION_SOURCE,
        // Server-set, unlike attributionSource, which the web checkout
        // forwards from the browser. Convex sells MCP-only plans on this alone.
        checkoutChannel: 'mcp',
      }),
      signal: AbortSignal.timeout(CHECKOUT_RELAY_TIMEOUT_MS),
    });
    const parsed: unknown = await response.json().catch(() => null);
    if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>;
  } catch (err) {
    return { kind: 'unavailable', cause: err instanceof Error ? err.name : 'fetch-failed' };
  }

  if (response.ok) {
    const url = readString(data.checkout_url);
    if (!url || !url.startsWith('https://')) return { kind: 'unavailable', cause: 'missing-checkout-url' };
    return { kind: 'created', checkoutUrl: url };
  }
  if (response.status === 409 && data.error === 'ACTIVE_SUBSCRIPTION_EXISTS') {
    return {
      kind: 'already-subscribed',
      message: readString(data.message) ?? 'A subscription already exists for this account.',
      subscription: readSubscription(data.subscription),
    };
  }
  if (response.status === 409 && data.error === 'PAYMENT_IN_PROGRESS') {
    return {
      kind: 'payment-in-progress',
      message: readString(data.message) ?? 'A payment is already in progress for this account.',
    };
  }
  if (response.status === 429) {
    const header = response.headers.get('retry-after');
    const seconds = header && /^\d{1,5}$/.test(header) ? Number(header) : 10;
    return { kind: 'rate-limited', retryAfterSeconds: Math.max(1, seconds) };
  }
  if (response.status === 400 && data.error === 'INVALID_CHECKOUT_PRODUCT') {
    return { kind: 'invalid-product' };
  }
  return { kind: 'unavailable', cause: `relay-${response.status}` };
}

/**
 * Production switch-quote relay: the same Convex route the dashboard's
 * /api/api-starter-switch uses, with confirm:false only. Nothing changes and
 * nothing is charged; a Pro holder's quote spends one plan-change admission.
 */
export async function relayApiStarterSwitchPreview(
  input: { userId: string },
  fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args),
): Promise<McpApiStarterSwitchVerdict> {
  const siteUrl = convexSiteUrl();
  const secret = process.env.CONVEX_TENANT_RELAY_SECRET ?? '';
  if (!siteUrl || !secret) return { kind: 'unknown', cause: 'relay-unconfigured' };

  let response: Response;
  let data: Record<string, unknown> = {};
  try {
    response = await fetchImpl(`${siteUrl}/relay/api-starter-switch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${secret}`,
        'User-Agent': CHECKOUT_RELAY_USER_AGENT,
      },
      body: JSON.stringify({ userId: input.userId, confirm: false }),
      signal: AbortSignal.timeout(SWITCH_PREVIEW_RELAY_TIMEOUT_MS),
    });
    const parsed: unknown = await response.json().catch(() => null);
    if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>;
  } catch (err) {
    return { kind: 'unknown', cause: err instanceof Error ? err.name : 'fetch-failed' };
  }

  if (response.ok) {
    return data.kind === 'preview' && typeof data.toPlanKey === 'string' && API_STARTER_SWITCH_PLANS.has(data.toPlanKey)
      ? { kind: 'switch-in-place' }
      : { kind: 'unknown', cause: 'unexpected-reply' };
  }
  const code = readString(data.error) ?? '';
  if (code === 'PRO_CANCEL_SCHEDULED') return { kind: 'resume-first' };
  if (SWITCH_NOT_SWITCHABLE_ERRORS.has(code)) return { kind: 'not-switchable' };
  if (SWITCH_HOLDER_ERRORS.has(code)) return { kind: 'switch-in-place' };
  return { kind: 'unknown', cause: `relay-${response.status}` };
}

const BILLING_PORTAL_HINT = 'worldmonitor.app → Settings → Manage Billing';

/**
 * The refusal for an API Starter request from a Pro holder, or null when the
 * account may buy API Starter through checkout.
 */
async function apiStarterSwitchRefusal(
  previewSwitch: McpPreviewApiStarterSwitch | undefined,
  userId: string,
  callerPlanKey: string | undefined,
  id: unknown,
  corsHeaders: Record<string, string>,
  ctx?: { waitUntil: (p: Promise<unknown>) => void },
): Promise<Response | null> {
  let verdict: McpApiStarterSwitchVerdict;
  try {
    verdict = await (previewSwitch ?? relayApiStarterSwitchPreview)({ userId });
  } catch (err) {
    verdict = { kind: 'unknown', cause: err instanceof Error ? err.name : 'Error' };
  }
  switch (verdict.kind) {
    case 'switch-in-place':
      return rpcError(id, -32002, 'This account has a Pro subscription, which moves to API Starter in place.', corsHeaders, {
        reason: 'switch-in-place',
        switchUrl: SWITCH_URL,
        nextStep: 'Pro moves to API Starter as a prorated change on the same subscription, not through a new checkout, and this tool does not charge. '
          + `Ask the user to open ${SWITCH_URL}, which opens Settings, Account, and choose Switch to API Starter; they confirm the prorated charge there.`,
      });
    case 'resume-first':
      return rpcError(id, -32002, 'This account has a Pro subscription that is set to cancel.', corsHeaders, {
        reason: 'pro-cancel-scheduled',
        switchUrl: SWITCH_URL,
        nextStep: `The Pro subscription is set to cancel at the end of this period. Ask the user to resume it in the billing portal (${BILLING_PORTAL_HINT}), `
          + `then switch to API Starter at ${SWITCH_URL}, which opens Settings, Account.`,
      });
    case 'not-switchable':
      return null;
    case 'unknown':
      // A caller entitled through an individual Pro may hold one: selling it
      // a second subscription is worse than asking it to retry.
      if (callerPlanKey === undefined || !API_STARTER_SWITCH_SOURCE_PLANS.has(callerPlanKey)) return null;
      captureSilentError(new Error(`start_upgrade switch preview unavailable: ${verdict.cause}`), {
        tags: { route: 'api/mcp', step: 'start-upgrade-switch-preview', tool: START_UPGRADE_TOOL },
        fingerprint: ['api/mcp', 'start-upgrade-switch-preview', verdict.cause],
        ctx,
      });
      return rpcError(
        id,
        -32603,
        'Checkout service temporarily unavailable. Retry in a moment.',
        { ...corsHeaders, 'Retry-After': '5' },
        undefined,
        503,
      );
  }
}

function alreadySubscribedNextStep(subscription: McpCheckoutSubscription | null, plan: string): string {
  const target = plan.startsWith('pro_business') ? 'pro_business' : plan.startsWith('api_business') ? 'api_business' : null;
  const existing = subscription?.planKey ?? '';
  if (target === 'pro_business' && (existing === 'pro_monthly' || existing === 'pro_monthly_mcp' || existing === 'pro_annual')) {
    return 'Pro moves to Pro Business as a prorated upgrade on the same subscription, not through a new checkout. '
      + 'Ask the user to open worldmonitor.app/pro and choose Pro Business while signed in; they confirm the prorated charge there.';
  }
  if (target === 'api_business' && existing.startsWith('api_starter')) {
    return `API Starter moves to API Business as a prorated plan change in the billing portal (${BILLING_PORTAL_HINT}), not through a new checkout.`;
  }
  return `This account already has this subscription. Manage or change it in the billing portal (${BILLING_PORTAL_HINT}).`;
}

/**
 * Create the `start_upgrade` checkout session (#9144), or the JSON-RPC refusal
 * for why it could not be created. Expected refusals (already subscribed,
 * payment pending, rate limited) are customer states, not errors, so only an
 * unavailable relay reaches Sentry.
 */
export async function startUpgradeCheckout(
  createCheckout: McpCreateCheckout | undefined,
  userId: string,
  plan: string,
  productId: string,
  id: unknown,
  corsHeaders: Record<string, string>,
  ctx?: { waitUntil: (p: Promise<unknown>) => void },
  apiStarterSwitch: {
    previewSwitch?: McpPreviewApiStarterSwitch;
    /** The caller's entitlement plan key; not proof of an own subscription. */
    callerPlanKey?: string;
  } = {},
): Promise<StartUpgradeResult | Response> {
  if (API_STARTER_SWITCH_PLANS.has(plan)) {
    const refusal = await apiStarterSwitchRefusal(
      apiStarterSwitch.previewSwitch, userId, apiStarterSwitch.callerPlanKey, id, corsHeaders, ctx,
    );
    if (refusal) return refusal;
  }
  let outcome: McpCheckoutOutcome;
  try {
    outcome = await (createCheckout ?? relayMcpCheckout)({ userId, productId });
  } catch (err) {
    outcome = { kind: 'unavailable', cause: err instanceof Error ? err.name : 'Error' };
  }
  switch (outcome.kind) {
    case 'created':
      return {
        checkoutUrl: outcome.checkoutUrl,
        plan,
        nextStep: 'Give checkoutUrl to the user to open in a browser and pay; this tool does not charge. '
          + 'Once the payment is confirmed, get_mcp_allowance reports the paid limit with no re-authorization.',
      };
    case 'already-subscribed':
      return rpcError(id, -32002, outcome.message, corsHeaders, {
        reason: 'already-subscribed',
        subscription: outcome.subscription,
        nextStep: alreadySubscribedNextStep(outcome.subscription, plan),
      });
    case 'payment-in-progress':
      return rpcError(id, -32002, outcome.message, corsHeaders, {
        reason: 'payment-in-progress',
        nextStep: 'Finish the checkout already open in the browser, or call start_upgrade again later; '
          + 'a pending payment stops blocking new checkouts 15 minutes after it started.',
      });
    case 'rate-limited':
      return rpcError(
        id,
        -32029,
        'Checkout is temporarily rate limited. Retry shortly.',
        { ...corsHeaders, 'Retry-After': String(outcome.retryAfterSeconds) },
        { reason: 'checkout-rate-limited', retryAfterSeconds: outcome.retryAfterSeconds },
        429,
      );
    case 'invalid-product':
      return rpcError(id, -32602, 'This plan is not available for checkout.', corsHeaders, { plans: MCP_CHECKOUT_PLANS });
    case 'unavailable':
      captureSilentError(new Error(`start_upgrade checkout unavailable: ${outcome.cause}`), {
        tags: { route: 'api/mcp', step: 'start-upgrade', tool: START_UPGRADE_TOOL },
        fingerprint: ['api/mcp', 'start-upgrade', outcome.cause],
        ctx,
      });
      return rpcError(
        id,
        -32603,
        'Checkout service temporarily unavailable. Retry in a moment.',
        { ...corsHeaders, 'Retry-After': '5' },
        undefined,
        503,
      );
  }
}
