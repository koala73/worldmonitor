/**
 * MCP paid-funnel upgrade attribution (#6716).
 *
 * Re-exports the shared constants and denial helpers used by the MCP edge
 * path. Checkout metadata round-trip lives in convex/payments/*; the
 * campaign marker itself is owned by `shared/mcp-attribution.ts`.
 */

import { MCP_UPGRADE_URL } from '../../shared/mcp-attribution';

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

/** Machine-readable denial reasons agents can branch on. */
export type McpDenialReason =
  | 'no-account'
  | 'allowance-exhausted'
  | 'upgrade-required'
  | 'lapsed-subscription';

export type McpStructuredDenial = {
  reason: McpDenialReason;
  nextStep: string;
  upgradeUrl: string;
};

const DENIAL_COPY: Record<McpDenialReason, { message: string; nextStep: string }> = {
  'no-account': {
    message: 'Authentication required to call this tool.',
    nextStep:
      'Sign in at the upgrade URL, connect WorldMonitor MCP with your account, '
      + 'or subscribe to Pro for the full daily allowance.',
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

export function buildMcpStructuredDenial(reason: McpDenialReason): {
  message: string;
  data: McpStructuredDenial;
} {
  const copy = DENIAL_COPY[reason];
  return {
    message: copy.message,
    data: {
      reason,
      nextStep: copy.nextStep,
      upgradeUrl: MCP_UPGRADE_URL,
    },
  };
}
