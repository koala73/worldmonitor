/**
 * Historical-playback gate (#5632) — the reactive half (#5813).
 *
 * `playback-resolver.ts` next door is the pure decision chain, testable under
 * `tsx --test` with no DOM. This module is its reader.
 *
 * Split out of `panel-gating.ts` (#5813). See the note in `export.ts` on why
 * the two gates deliberately do NOT share a factory.
 */

import type { AuthSession } from '../auth-state';
import { getEntitlementState } from '../entitlements';
import { hasPremiumAccess } from '../panel-gating';
import {
  resolvePlaybackGate,
  type PlaybackGateInputs,
  type PlaybackGateVerdict,
} from './playback-resolver';

/**
 * Snapshot the live inputs of the historical-playback gate (#5632). Separate
 * from `export.ts`'s reader because playback is a Pro takeaway resolved by
 * `hasPremiumAccess()`, not a Pro Business one — it needs neither the catalog
 * activation probe nor the billing-state refinement (the control has no CTA to
 * route, so there is no denial reason to display).
 *
 * Module-private: `evaluatePlaybackGate` is the only caller, here or anywhere.
 */
function readPlaybackGateInputs(authState: AuthSession): PlaybackGateInputs {
  return {
    premiumAccess: hasPremiumAccess(authState),
    authPending: authState.isPending,
    signedIn: Boolean(authState.user),
    entitlementLoaded: getEntitlementState() !== null,
  };
}

/** Current playback-control verdict for the given auth session. */
export function evaluatePlaybackGate(authState: AuthSession): PlaybackGateVerdict {
  return resolvePlaybackGate(readPlaybackGateInputs(authState));
}
