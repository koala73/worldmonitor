/**
 * Data-export gate + dashboard tab cap — the reactive half (#5813).
 *
 * `export-resolver.ts` next door is the pure decision chain, testable under
 * `tsx --test` with no DOM. This module is its reader: it snapshots the live
 * entitlement / billing / secret state and hands the resulting inputs to the
 * resolver, so the resolver never learns where its inputs come from.
 *
 * Split out of `panel-gating.ts` (#5813) once the third `readX`/`evaluateX`
 * pair landed there. Deliberately NOT unified with `playback.ts` behind a gate
 * factory: the input shapes genuinely differ — export carries the Pro Business
 * catalog probe and the billing-state refinement, playback needs neither — and
 * a shared abstraction would force a lowest-common-denominator input type onto
 * gates that are correctly independent.
 */

import type { AuthSession } from '../auth-state';
import { getSubscription } from '../billing';
import { deriveBillingUxState } from '../billing-state';
import { getEntitlementState } from '../entitlements';
import { PanelGateReason } from '../panel-gating';
import { getSecretState } from '../runtime-config';
import {
  isExportGateActive,
  resolveAvailableExportFormats,
  resolveExportGate,
  resolveTabCap,
  type DataExportFormat,
  type ExportGateInputs,
  type ExportGateLockReason,
  type ExportGateVerdict,
  type TabCapVerdict,
} from './export-resolver';

/** Export-gate lock reasons carry the same string values as the enum. */
const EXPORT_LOCK_TO_GATE_REASON: Record<ExportGateLockReason, PanelGateReason> = {
  anonymous: PanelGateReason.ANONYMOUS,
  free_tier: PanelGateReason.FREE_TIER,
  payment_on_hold: PanelGateReason.PAYMENT_ON_HOLD,
  renewal_pending: PanelGateReason.RENEWAL_PENDING,
  renewal_failed: PanelGateReason.RENEWAL_FAILED,
  lapsed: PanelGateReason.LAPSED,
};

export function exportLockToGateReason(reason: ExportGateLockReason): PanelGateReason {
  return EXPORT_LOCK_TO_GATE_REASON[reason];
}

/**
 * Snapshot the live inputs of the data-export gate (plan 2026-07-25-001, KTD2)
 * and the dashboard tab cap (KTD8) — one reactive read shared by both.
 * The decisions themselves live in the pure `export-resolver` leaf so they can
 * be unit-tested without a DOM; this function only reads the reactive sources.
 *
 * Module-private: the public entry points below wrap it, and no caller outside
 * this file has ever needed the raw inputs.
 */
function readExportGateInputs(authState: AuthSession): ExportGateInputs {
  const entitlement = getEntitlementState();
  return {
    gateActive: isExportGateActive(),
    desktopKeyPresent: getSecretState('WORLDMONITOR_API_KEY').present,
    authPending: authState.isPending,
    signedIn: Boolean(authState.user),
    features: entitlement
      ? {
          tier: entitlement.features.tier,
          dataExport: entitlement.features.dataExport,
          exportFormats: entitlement.features.exportFormats,
          maxDashboards: entitlement.features.maxDashboards,
        }
      : null,
    billingState: deriveBillingUxState(getSubscription(), entitlement, Date.now()),
  };
}

/** Current data-export verdict for the given auth session. */
export function evaluateExportGate(authState: AuthSession): ExportGateVerdict {
  return resolveExportGate(readExportGateInputs(authState));
}

/** Formats the unlocked export menu may expose for this live session. */
export function evaluateAvailableExportFormats(authState: AuthSession): DataExportFormat[] {
  return resolveAvailableExportFormats(readExportGateInputs(authState));
}

/**
 * May this session create another dashboard tab? Creation-only — the verdict
 * never asks a caller to remove tabs that already exist (KTD8).
 */
export function evaluateTabCap(authState: AuthSession, currentTabCount: number): TabCapVerdict {
  return resolveTabCap(readExportGateInputs(authState), currentTabCount);
}
