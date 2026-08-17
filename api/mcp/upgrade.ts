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
  'lapsed-subscription': {
    message: 'Your WorldMonitor Pro subscription is no longer active.',
    nextStep: 'Resubscribe at the upgrade URL, then reconnect MCP.',
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
