import { track, type UmamiEvent } from './analytics';

/** The only client surfaces that currently decide an entitlement desync. */
export type EntitlementDesyncPanel = 'latest-brief' | 'chat-analyst' | 'widget-chat';

type AnalyticsTrack = (event: UmamiEvent, data?: Record<string, unknown>) => void;

/**
 * Count a client-asserted disagreement between local Pro state and a server
 * denial. The client belief is deliberately untrusted: it is useful for
 * aggregate incident detection, never for authorization or fraud decisions.
 * Keep the payload bounded to the stable verdict and decision surface; do not
 * attach a user id, entitlement fields, or response body.
 */
export function reportEntitlementDesync(
  panel: EntitlementDesyncPanel,
  emit: AnalyticsTrack = track,
): void {
  emit('entitlement-desync', { verdict: 'entitlement_desync', panel });
}
