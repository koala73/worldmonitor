/**
 * MCP paid-funnel upgrade attribution (#6716).
 *
 * Re-exports the shared constants and denial helpers used by the MCP edge
 * path. Checkout metadata round-trip lives in convex/payments/*; the
 * campaign marker itself is owned by `shared/mcp-attribution.ts`.
 */

import { MCP_UPGRADE_URL } from '../../shared/mcp-attribution';
import { recommendedPlanFor, START_UPGRADE_TOOL } from './checkout';

export {
  MCP_ATTRIBUTION_SOURCE,
  MCP_UPGRADE_URL,
  MCP_UPGRADE_UTM_CAMPAIGN,
  MCP_UPGRADE_UTM_MEDIUM,
  MCP_UPGRADE_UTM_SOURCE,
  isMcpAttributionSource,
  normalizeCheckoutAttributionSource,
  readMcpAttributionFromSearch,
} from '../../shared/mcp-attribution';

/**
 * Denial reasons whose copy is a constant — the whole answer is known without
 * looking at the caller.
 */
export type McpStaticDenialReason =
  | 'no-account'
  | 'allowance-exhausted'
  | 'upgrade-required'
  | 'lapsed-subscription';

/** Machine-readable denial reasons agents can branch on. */
export type McpDenialReason = McpStaticDenialReason | 'quota-exceeded';

/** Denials an agent can answer by calling `start_upgrade` (#9144). */
type McpUpgradeableReason = 'allowance-exhausted' | 'upgrade-required' | 'quota-exceeded';

/**
 * A denial to build, carrying whatever that reason's copy and payload need.
 *
 * `quota-exceeded` is the one reason whose answer depends on the caller: the
 * limit that actually rejected, and whether that limit is the shared REST
 * budget (post-`API_RATE_LIMIT_ENFORCE`, an API-tier exhaustion can be entirely
 * REST-driven, so "you have used your MCP quota" would be a lie). Modelling it
 * as a variant rather than optional fields on a flat object means a quota
 * denial without its limit cannot be built at all.
 *
 * `upgradeFrom` is the caller's current plan key (`'free'` on the free-account
 * allowance). Set it only for a user-bound caller, who can call
 * `start_upgrade`; the denial then names the plan to buy and the tool.
 */
export type McpDenial =
  | { reason: McpStaticDenialReason; upgradeFrom?: string }
  | {
      reason: 'quota-exceeded';
      /** The daily limit the reservation ENFORCED, so copy and cap agree. */
      limit: number;
      /** True when REST requests spend this same budget. */
      sharedWithRestApi: boolean;
      upgradeFrom?: string;
    };

/**
 * `checkoutTool` appears only beside a plan `start_upgrade` can sell this
 * caller. A paid caller's step up is in the same billing family (Pro → Pro
 * Business, API Starter → API Business), which the checkout guard refuses while
 * the current plan is active: those denials name the plan and leave the tool out.
 */
interface McpCheckoutHint {
  recommendedPlan?: string;
  checkoutTool?: typeof START_UPGRADE_TOOL;
}

/**
 * The `error.data` block. Every reason carries `{reason, nextStep, upgradeUrl}`.
 * `quota-exceeded` adds the two numbers an agent would otherwise have to parse
 * out of the message, and the three upgradeable reasons add the checkout hint
 * when the caller has a plan to move to.
 */
export type McpStructuredDenial =
  | ({ reason: McpStaticDenialReason; nextStep: string; upgradeUrl: string } & McpCheckoutHint)
  | ({
      reason: 'quota-exceeded';
      nextStep: string;
      upgradeUrl: string;
      limit: number;
      sharedWithRestApi: boolean;
    } & McpCheckoutHint);

const UPGRADEABLE_REASONS: ReadonlySet<McpDenial['reason']> = new Set<McpUpgradeableReason>([
  'allowance-exhausted',
  'upgrade-required',
  'quota-exceeded',
]);

function checkoutHint(denial: McpDenial): McpCheckoutHint {
  if (!UPGRADEABLE_REASONS.has(denial.reason) || denial.upgradeFrom === undefined) return {};
  const recommendedPlan = recommendedPlanFor(denial.upgradeFrom);
  if (recommendedPlan === undefined) return {};
  return denial.upgradeFrom === 'free' ? { recommendedPlan, checkoutTool: START_UPGRADE_TOOL } : { recommendedPlan };
}

const DENIAL_COPY: Record<McpStaticDenialReason, { message: string; nextStep: string }> = {
  'no-account': {
    message: 'Authentication required to call this tool.',
    // The first denial a cold agent reads. Name both free paths before Pro;
    // pointing only at the upgrade URL sent agents to checkout when a free
    // account and the credential-free get_sources tool were available.
    nextStep:
      'Connect via OAuth (see the WWW-Authenticate header) to sign in with a free account, '
      + 'or call get_sources, which needs no credential. '
      + 'Subscribe to Pro at the upgrade URL for the full daily allowance.',
  },
  'allowance-exhausted': {
    message: 'Free-account MCP allowance exhausted for today.',
    nextStep:
      'Wait until the next UTC day for another free allowance window, '
      + 'or upgrade to Pro for a higher daily limit.',
  },
  // #6716 F1: the free allowance covers cache-backed tools only. Tools with a
  // downstream `_execute` are re-gated by server/gateway.ts's own
  // checkProMcpAccess, which this feature deliberately does not relax — so a
  // free caller must be refused HERE, before a slot is charged on a call the
  // gateway will reject. Terminal until upgrade: retrying and re-authenticating
  // both fail, which is why this rides the 403 envelope, not 401 or 429.
  'upgrade-required': {
    message: 'This tool requires a WorldMonitor Pro subscription.',
    nextStep:
      'The free allowance covers cached-data tools only. Call one of those, '
      + 'or subscribe to Pro at the upgrade URL for the full tool set.',
  },
  // The lapsed MESSAGE is owned by getMcpBillingVerificationDenial (it keeps the
  // "Re-authenticating will not help" clause the error catalog documents); only
  // `nextStep` and `upgradeUrl` from here reach the wire for this reason. Do not
  // say "reconnect MCP" — that is the OAuth retry this envelope exists to prevent.
  'lapsed-subscription': {
    message: 'Your WorldMonitor Pro subscription is no longer active.',
    nextStep:
      'Resubscribe at the upgrade URL. The existing credential stays valid — '
      + 're-authenticating will not restore access.',
  },
};

export function buildMcpStructuredDenial(denial: McpDenial): {
  message: string;
  data: McpStructuredDenial;
} {
  if (denial.reason === 'quota-exceeded') {
    return {
      // Byte-identical to the copy this denial has always carried, because
      // docs/mcp-error-catalog.mdx publishes it and clients string-match it.
      // What changes is that the same two facts now also ride `data`.
      message: `Daily MCP quota exceeded (${denial.limit}/day). Resets at next UTC midnight.`,
      data: {
        reason: denial.reason,
        nextStep: denial.sharedWithRestApi
          ? 'This allowance is shared with your REST API requests, so REST traffic spends it too — '
            + 'the exhaustion may not be your tool calls. Wait for the next UTC day, or upgrade at the '
            + 'upgrade URL for a higher daily limit.'
          : 'Wait for the next UTC day, or upgrade at the upgrade URL for a higher daily limit.',
        upgradeUrl: MCP_UPGRADE_URL,
        limit: denial.limit,
        sharedWithRestApi: denial.sharedWithRestApi,
        ...checkoutHint(denial),
      },
    };
  }
  const copy = DENIAL_COPY[denial.reason];
  return {
    message: copy.message,
    data: {
      reason: denial.reason,
      nextStep: copy.nextStep,
      upgradeUrl: MCP_UPGRADE_URL,
      ...checkoutHint(denial),
    },
  };
}
