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
 */

import catalog from '../../shared/product-catalog.generated.json';
import { MCP_ATTRIBUTION_SOURCE } from '../../shared/mcp-attribution';
// @ts-expect-error — JS module, no declaration file
import { captureSilentError } from '../_sentry-edge.js';
import { rpcError } from './rpc';

export const START_UPGRADE_TOOL = 'start_upgrade';

const CHECKOUT_RELAY_USER_AGENT = 'worldmonitor-mcp-edge/1.0';
const CHECKOUT_RELAY_TIMEOUT_MS = 15_000;

interface CatalogPlan {
  planKey: string;
  tierGroup: string;
  selfServe: boolean;
  currentForCheckout: boolean;
}

const PLANS = catalog.facts.plans as CatalogPlan[];
const PRODUCTS = catalog.products as Record<string, { planKey: string }>;

/** The plans `start_upgrade` accepts: every self-serve plan currently sold. */
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
const NEXT_PLAN_BY_TIER_GROUP: Record<string, string> = {
  free: 'pro_monthly',
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

const BILLING_PORTAL_HINT = 'worldmonitor.app → Settings → Manage Billing';

function alreadySubscribedNextStep(subscription: McpCheckoutSubscription | null, plan: string): string {
  const target = plan.startsWith('pro_business') ? 'pro_business' : plan.startsWith('api_business') ? 'api_business' : null;
  const existing = subscription?.planKey ?? '';
  if (target === 'pro_business' && (existing === 'pro_monthly' || existing === 'pro_annual')) {
    return 'Pro and Pro Business are separate products, not a plan change. Ask the user to cancel Pro in the billing portal '
      + `(${BILLING_PORTAL_HINT}); Pro access runs to the end of the paid term. Then call start_upgrade again.`;
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
): Promise<StartUpgradeResult | Response> {
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
