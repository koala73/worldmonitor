/**
 * Finish-setup chip — the persistent, dismissible nudge shown AFTER the Pro
 * activation flow when any step was left unfinished (skipped or failed).
 *
 * A small fixed corner banner in the `showCheckoutSuccess` inline-DOM shape
 * (Object.assign styles, textContent — no innerHTML, so no escaping surface).
 * Clicking it re-opens `openProActivationFlow` for whatever is still unfinished
 * (the flow re-reads config, so already-done steps render as done); the X
 * dismisses it for the dismissal TTL.
 *
 * All localStorage (the dismissal record) lives HERE; the decision itself comes
 * from the pure leaf `@/services/pro-activation-state` (shouldShowFinishSetupChip
 * / computeFinishSetupChipDismissal / isChipDismissed).
 */

import { t } from '@/services/i18n';
import { getAuthState, subscribeAuthState } from '@/services/auth-state';
import {
  buildActivationSteps,
  selectAdvanceOutcome,
  shouldShowFinishSetupChip,
  computeFinishSetupChipDismissal,
  deriveActivationAccountKey,
  parseChipDismissal,
  isChipDismissed,
  FINISH_SETUP_CHIP_DISMISS_KEY,
  FINISH_SETUP_CHIP_DISMISS_TTL_MS,
  type ActivationStepResult,
  type FinishSetupChipDismissal,
} from '@/services/pro-activation-state';
import {
  openProActivationFlow,
  readActivationContext,
  type ProActivationFlowOptions,
} from '@/components/ProActivationInterstitial';

// Single instance at a time (like the checkout banner).
let chipEl: HTMLElement | null = null;
let chipAuthUnsubscribe: (() => void) | null = null;

const CHIP_ID = 'pro-activation-finish-chip';

function nowOf(options: ProActivationFlowOptions): number {
  return (options.now ?? Date.now)();
}

/** Opaque account scope for the settled current session. */
function currentChipAccountKey(): string | null {
  return deriveActivationAccountKey(getAuthState().user?.id);
}

function readChipDismissal(now: number): FinishSetupChipDismissal | null {
  try {
    const raw = localStorage.getItem(FINISH_SETUP_CHIP_DISMISS_KEY);
    const dismissal = parseChipDismissal(raw);
    if (dismissal && now - dismissal.dismissedAt > FINISH_SETUP_CHIP_DISMISS_TTL_MS) {
      localStorage.removeItem(FINISH_SETUP_CHIP_DISMISS_KEY);
      return null;
    }
    if (dismissal && raw !== JSON.stringify(dismissal)) {
      localStorage.setItem(FINISH_SETUP_CHIP_DISMISS_KEY, JSON.stringify(dismissal));
    }
    return dismissal;
  } catch {
    return null;
  }
}

function writeChipDismissal(options: ProActivationFlowOptions, now: number): void {
  if (getAuthState().user?.id !== options.accountUserId) return;
  try {
    localStorage.setItem(
      FINISH_SETUP_CHIP_DISMISS_KEY,
      JSON.stringify(computeFinishSetupChipDismissal(currentChipAccountKey(), now)),
    );
  } catch {
    // Storage disabled/full — the chip simply reappears next session.
  }
}

function removeChip(): void {
  chipAuthUnsubscribe?.();
  chipAuthUnsubscribe = null;
  chipEl?.remove();
  chipEl = null;
}

function renderChip(options: ProActivationFlowOptions): void {
  removeChip();

  const chip = document.createElement('div');
  chip.id = CHIP_ID;
  chip.setAttribute('role', 'status');
  Object.assign(chip.style, {
    position: 'fixed',
    bottom: '20px',
    right: '20px',
    zIndex: '9990', // above the dashboard, below modal overlays (9999+)
    maxWidth: '320px',
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '12px 14px',
    background: 'var(--bg-secondary, #16181d)',
    color: 'var(--text, #e8eaed)',
    border: '1px solid var(--border, #2a2d34)',
    borderRadius: '10px',
    boxShadow: '0 6px 24px rgba(0,0,0,0.35)',
    fontSize: '13px',
    lineHeight: '1.4',
  });

  const text = document.createElement('span');
  text.style.flex = '1';
  text.textContent = t('components.proActivation.chip.message', {
    defaultValue: 'Finish setting up your Pro account.',
  });

  const finishBtn = document.createElement('button');
  finishBtn.type = 'button';
  finishBtn.textContent = t('components.proActivation.chip.action', { defaultValue: 'Finish setup' });
  Object.assign(finishBtn.style, {
    flexShrink: '0',
    padding: '6px 12px',
    background: 'var(--green, #22c55e)',
    color: 'var(--bg, #0b0c0f)',
    border: 'none',
    borderRadius: '6px',
    fontWeight: '600',
    fontSize: '12px',
    cursor: 'pointer',
  });
  finishBtn.addEventListener('click', () => {
    removeChip();
    void openProActivationFlow(options).catch((err) =>
      console.warn('[pro-activation] failed to re-open flow from chip', err),
    );
  });

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = '✕';
  closeBtn.setAttribute(
    'aria-label',
    t('components.proActivation.chip.dismissLabel', { defaultValue: 'Dismiss' }),
  );
  Object.assign(closeBtn.style, {
    flexShrink: '0',
    padding: '2px 4px',
    background: 'none',
    border: 'none',
    color: 'var(--text-dim, #8b8f98)',
    fontSize: '14px',
    lineHeight: '1',
    cursor: 'pointer',
  });
  closeBtn.addEventListener('click', () => {
    writeChipDismissal(options, nowOf(options));
    removeChip();
  });

  chip.append(text, finishBtn, closeBtn);
  document.body.appendChild(chip);
  chipEl = chip;
  chipAuthUnsubscribe = subscribeAuthState(() => {
    if (getAuthState().user?.id === options.accountUserId) return;
    // subscribeAuthState emits synchronously before returning its unsubscribe.
    // Defer removal so removeChip can tear the listener down as well.
    queueMicrotask(() => {
      if (chipEl === chip && getAuthState().user?.id !== options.accountUserId) removeChip();
    });
  });
}

/**
 * Show the finish-setup chip for the just-completed flow's step results.
 * No-ops when nothing is unfinished or a fresh dismissal suppresses it.
 */
export function showFinishSetupChipForResults(
  options: ProActivationFlowOptions,
  results: readonly ActivationStepResult[],
): void {
  const now = nowOf(options);
  if (getAuthState().user?.id !== options.accountUserId) return;
  if (!shouldShowFinishSetupChip(results, readChipDismissal(now), currentChipAccountKey(), now)) {
    return;
  }
  renderChip(options);
}

/**
 * Re-evaluate on a later session (e.g. the boot hook): re-derive the step
 * results from current config — every step still not `already-done` reads as
 * unfinished — and show the chip when warranted and not dismissed.
 */
export async function maybeShowFinishSetupChip(options: ProActivationFlowOptions): Promise<void> {
  const now = nowOf(options);
  if (getAuthState().user?.id !== options.accountUserId) return;
  const currentAccountKey = currentChipAccountKey();
  const dismissal = readChipDismissal(now);
  if (isChipDismissed(dismissal, currentAccountKey, now)) return; // avoid the config read when dismissed
  const ctx = await readActivationContext(options.accountUserId);
  // Same seam the wizard uses, so a later-session re-derivation classifies a
  // browser-refused step the same way the flow itself did (#5617). The chip
  // decision is unchanged — blocked and skipped are both "unfinished" — but an
  // independent ternary here is exactly how the two would drift apart.
  const results: ActivationStepResult[] = buildActivationSteps(ctx.capabilities, ctx.config).map(
    (s) => ({ id: s.id, outcome: selectAdvanceOutcome(s.state) }),
  );
  if (getAuthState().user?.id !== options.accountUserId) return;
  if (!shouldShowFinishSetupChip(results, dismissal, currentAccountKey, now)) return;
  renderChip(options);
}

/** Remove the chip if present (used by tests / teardown). */
export function dismissFinishSetupChip(): void {
  removeChip();
}
