/**
 * Pro Activation Interstitial — the day-0 post-checkout activation flow (SHELL).
 *
 * A full-screen overlay that opens right after the entitlement-unlock reload for
 * a brand-new Pro subscriber. It walks them through the highest-retention Pro
 * actions one step at a time (morning brief, real-time alerts, Pro toolkit),
 * then shows a delivery-honest exit summary of what is running vs. still to do.
 *
 * This module is the SHELL only: navigation, skip affordances, the step-position
 * indicator, Escape-to-close + focus trap, per-step pending/verified/failed
 * visual states, and the exit summary. Every decision (which steps exist, each
 * step's state, the summary lines) comes from the pure leaf
 * `@/services/pro-activation-state`; this file never re-derives that logic.
 *
 * The real per-step behaviour (turning the brief on, requesting push, opening
 * the Pro toolkit) and telemetry are injected by later units through the
 * `onConfirmStep` / `onSkipStep` / `onExit` callbacks — the shell stays generic
 * and renders a working skip for any step whose handler is not yet wired.
 *
 * Construction mirrors `McpConnectModal.ts` (module-level overlay handle,
 * `open*()`/`close*()`, `.modal-overlay`/`.modal` classes, `setTrustedHtml` +
 * `escapeHtml` for ALL dynamic HTML) and the focus-trap conventions in
 * `CountryDeepDivePanel.ts` / `confirm-dialog.ts` (Escape + Tab cycling,
 * focus restore on close).
 */

import { t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';
import {
  buildExitSummary,
  type ActivationStep,
  type ActivationStepId,
  type ActivationStepOutcome,
  type ActivationStepResult,
  type ActivationSummaryLine,
} from '@/services/pro-activation-state';

export interface ProActivationInterstitialOptions {
  /** Ordered steps from `buildActivationSteps` (computed by the caller). */
  steps: readonly ActivationStep[];
  /** Account email for display, so the user sees which account got Pro. */
  accountEmail: string;
  /**
   * Complete a step in-flow. Resolves `'verified'` on success, `'failed'`
   * otherwise. Injected by a later unit; until then a stub can resolve either.
   */
  onConfirmStep: (stepId: ActivationStepId) => Promise<'verified' | 'failed'>;
  /** Fire-and-forget skip signal (bookkeeping/telemetry wired by later units). */
  onSkipStep: (stepId: ActivationStepId) => void;
  /** Called exactly once when the flow ends, with the ordered step results. */
  onExit: (results: ActivationStepResult[]) => void;
}

/** Transient UI state for the CURRENT confirmable step only. */
type TransientState = 'idle' | 'in-flight' | 'failed';

/** Per-step visual status driving the badge (R15: pending/verified/failed distinct). */
type StepStatus = 'pending' | 'in-flight' | 'verified' | 'failed' | 'blocked' | 'unavailable';

// Module-level singleton handles (single instance at a time, like McpConnectModal).
let overlay: HTMLElement | null = null;
let lastFocusedElement: HTMLElement | null = null;
let docKeydownHandler: ((e: KeyboardEvent) => void) | null = null;

const FOCUSABLE_SELECTOR = 'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

interface StepFrameCopy {
  heading: string;
  body: string;
  confirmCta: string;
  confirming: string;
  doneNote: string;
}

/** Per-step frame copy. Literal keys keep the i18n key-existence gate honest. */
function stepFrameCopy(id: ActivationStepId): StepFrameCopy {
  switch (id) {
    case 'brief':
      return {
        heading: t('components.proActivation.steps.brief.heading', {
          defaultValue: 'Your daily brief, every morning',
        }),
        body: t('components.proActivation.steps.brief.body', {
          defaultValue:
            'A curated intelligence briefing in your inbox each morning — the overnight signals that matter, distilled into a five-minute read.',
        }),
        confirmCta: t('components.proActivation.steps.brief.confirmCta', {
          defaultValue: 'Turn on my morning brief',
        }),
        confirming: t('components.proActivation.steps.brief.confirming', {
          defaultValue: 'Turning it on…',
        }),
        doneNote: t('components.proActivation.steps.brief.doneNote', {
          defaultValue: 'Your morning brief is already running.',
        }),
      };
    case 'alerts':
      return {
        heading: t('components.proActivation.steps.alerts.heading', {
          defaultValue: 'Real-time alerts',
        }),
        body: t('components.proActivation.steps.alerts.body', {
          defaultValue:
            "Be first to know. A push the moment a watched signal breaks — conflict escalations, market shocks, fresh sanctions — so you're not waiting on the next brief.",
        }),
        confirmCta: t('components.proActivation.steps.alerts.confirmCta', {
          defaultValue: 'Enable alerts',
        }),
        confirming: t('components.proActivation.steps.alerts.confirming', {
          defaultValue: 'Enabling…',
        }),
        doneNote: t('components.proActivation.steps.alerts.doneNote', {
          defaultValue: 'Real-time alerts are already on.',
        }),
      };
    case 'power':
      return {
        heading: t('components.proActivation.steps.power.heading', {
          defaultValue: 'Your Pro toolkit',
        }),
        body: t('components.proActivation.steps.power.body', {
          defaultValue:
            'Custom widgets, MCP connections, and the AI researcher are unlocked. Build the board you actually want to watch.',
        }),
        confirmCta: t('components.proActivation.steps.power.confirmCta', {
          defaultValue: 'Explore Pro tools',
        }),
        confirming: t('components.proActivation.steps.power.confirming', {
          defaultValue: 'Opening…',
        }),
        doneNote: t('components.proActivation.steps.power.doneNote', {
          defaultValue: "You're already using your Pro tools.",
        }),
      };
  }
}

/** Short noun for a step in the exit summary. */
function summaryLabel(id: ActivationStepId): string {
  switch (id) {
    case 'brief':
      return t('components.proActivation.steps.brief.summaryLabel', { defaultValue: 'Morning brief' });
    case 'alerts':
      return t('components.proActivation.steps.alerts.summaryLabel', { defaultValue: 'Real-time alerts' });
    case 'power':
      return t('components.proActivation.steps.power.summaryLabel', { defaultValue: 'Pro toolkit' });
  }
}

/** Delivery-honest "what's running" line for a verified step. */
function summaryVerifiedDetail(id: ActivationStepId): string {
  switch (id) {
    case 'brief':
      return t('components.proActivation.steps.brief.summaryVerified', {
        defaultValue: 'On — starts with your next morning brief.',
      });
    case 'alerts':
      return t('components.proActivation.steps.alerts.summaryVerified', {
        defaultValue: "On — you'll get the next breaking signal.",
      });
    case 'power':
      return t('components.proActivation.steps.power.summaryVerified', {
        defaultValue: 'Unlocked and ready when you are.',
      });
  }
}

function statusLabel(status: StepStatus): string {
  switch (status) {
    case 'pending':
      return t('components.proActivation.status.pending', { defaultValue: 'Not set up' });
    case 'in-flight':
      return t('components.proActivation.status.inFlight', { defaultValue: 'Setting up…' });
    case 'verified':
      return t('components.proActivation.status.verified', { defaultValue: 'Ready' });
    case 'failed':
      return t('components.proActivation.status.failed', { defaultValue: "Didn't work" });
    case 'blocked':
      return t('components.proActivation.status.blocked', { defaultValue: 'Blocked' });
    case 'unavailable':
      return t('components.proActivation.status.unavailable', { defaultValue: 'Not available' });
  }
}

export function openProActivationInterstitial(options: ProActivationInterstitialOptions): void {
  closeProActivationInterstitial();

  const steps = options.steps;
  // Nothing to onboard (all steps somehow absent) → resolve the flow cleanly
  // rather than mounting an empty overlay.
  if (steps.length === 0) {
    options.onExit([]);
    return;
  }

  let currentIndex = 0;
  let transient: TransientState = 'idle';
  // Bumped on every navigation so a confirm resolving after the user has
  // moved on (skip / Escape / dismiss mid-await) is ignored.
  let generation = 0;
  let finished = false;
  const outcomes = new Map<ActivationStepId, ActivationStepOutcome>();

  const onSummary = (): boolean => currentIndex >= steps.length;

  /** Default disposition for a step never explicitly acted on. */
  const defaultOutcome = (step: ActivationStep): ActivationStepOutcome =>
    step.state === 'already-done' ? 'done' : 'skipped';

  const buildResults = (): ActivationStepResult[] =>
    steps.map((step) => ({ id: step.id, outcome: outcomes.get(step.id) ?? defaultOutcome(step) }));

  const currentStatus = (step: ActivationStep): StepStatus => {
    if (step.state === 'already-done') return 'verified';
    if (step.state === 'blocked') return 'blocked';
    if (step.state === 'unavailable') return 'unavailable';
    if (transient === 'in-flight') return 'in-flight';
    if (transient === 'failed') return 'failed';
    return 'pending';
  };

  const noteHtml = (message: string, kind: 'ok' | 'muted' | 'warn' | 'error'): string =>
    `<p class="pro-activation-note note-${kind}">${escapeHtml(message)}</p>`;

  const stepNotesHtml = (step: ActivationStep): string => {
    const copy = stepFrameCopy(step.id);
    const notes: string[] = [];
    if (step.state === 'already-done') {
      notes.push(noteHtml(copy.doneNote, 'ok'));
      if (step.id === 'brief' && step.preservesSchedule) {
        notes.push(
          noteHtml(
            t('components.proActivation.steps.brief.scheduleNote', {
              defaultValue: "We'll keep your current delivery time.",
            }),
            'muted',
          ),
        );
      }
    } else if (step.state === 'blocked') {
      const blocked =
        step.id === 'alerts'
          ? t('components.proActivation.steps.alerts.blockedNote', {
              defaultValue:
                "Notifications are blocked in your browser. Turn them on in your browser's site settings to get alerts.",
            })
          : t('components.proActivation.status.blockedNote', {
              defaultValue: "This isn't available right now — you can set it up later from settings.",
            });
      notes.push(noteHtml(blocked, 'warn'));
    } else if (step.state === 'unavailable') {
      notes.push(
        noteHtml(
          t('components.proActivation.status.unavailableNote', {
            defaultValue: "This isn't available on your device — you can set it up later.",
          }),
          'muted',
        ),
      );
    } else if (transient === 'failed') {
      notes.push(
        noteHtml(
          t('components.proActivation.status.failedBody', {
            defaultValue: 'Something went wrong. You can try again, or set it up later from settings.',
          }),
          'error',
        ),
      );
    }
    return notes.join('');
  };

  const stepActionsHtml = (step: ActivationStep): string => {
    const copy = stepFrameCopy(step.id);
    const primary = (label: string, action: string, disabled = false, busy = false): string =>
      `<button type="button" class="btn btn-primary pro-activation-primary" data-action="${action}"${
        disabled ? ' disabled' : ''
      }${busy ? ' aria-busy="true"' : ''}>${escapeHtml(label)}</button>`;
    const skip = (): string =>
      `<button type="button" class="btn btn-ghost pro-activation-skip" data-action="skip">${escapeHtml(
        t('components.proActivation.actions.skip', { defaultValue: 'Skip for now' }),
      )}</button>`;
    const cont = (action: string): string =>
      primary(t('components.proActivation.actions.continue', { defaultValue: 'Continue' }), action);

    if (step.state === 'already-done') return cont('advance-done');
    if (step.state === 'blocked' || step.state === 'unavailable') return cont('advance-skip');
    // confirmable
    if (transient === 'in-flight') return primary(copy.confirming, 'confirm', true, true);
    const label =
      transient === 'failed'
        ? t('components.proActivation.status.retry', { defaultValue: 'Try again' })
        : copy.confirmCta;
    return primary(label, 'confirm') + skip();
  };

  const stepHtml = (step: ActivationStep): string => {
    const copy = stepFrameCopy(step.id);
    const status = currentStatus(step);
    return `
      <div class="pro-activation-step">
        <span class="pro-activation-status status-${status}">${escapeHtml(statusLabel(status))}</span>
        <h2 class="pro-activation-heading">${escapeHtml(copy.heading)}</h2>
        <p class="pro-activation-step-body">${escapeHtml(copy.body)}</p>
        ${stepNotesHtml(step)}
        <div class="pro-activation-actions">${stepActionsHtml(step)}</div>
      </div>`;
  };

  const summaryLineHtml = (line: ActivationSummaryLine): string => {
    const detail =
      line.status === 'verified'
        ? summaryVerifiedDetail(line.id)
        : line.status === 'failed'
          ? t('components.proActivation.summary.lineFailed', {
              defaultValue: "We couldn't set this up — try again from settings.",
            })
          : t('components.proActivation.summary.linePending', {
              defaultValue: 'Not set up yet — finish any time in settings.',
            });
    const icon = line.status === 'verified' ? '✓' : line.status === 'failed' ? '!' : '○';
    return `
      <li class="pro-activation-summary-line status-${line.status}">
        <span class="pro-activation-summary-icon" aria-hidden="true">${icon}</span>
        <span class="pro-activation-summary-text">
          <span class="pro-activation-summary-label">${escapeHtml(summaryLabel(line.id))}</span>
          <span class="pro-activation-summary-detail">${escapeHtml(detail)}</span>
        </span>
      </li>`;
  };

  const summaryHtml = (): string => {
    const lines = buildExitSummary(buildResults());
    const anyVerified = lines.some((line) => line.status === 'verified');
    const sub = anyVerified
      ? t('components.proActivation.summary.subVerified', {
          defaultValue: "Here's what's running on your account.",
        })
      : t('components.proActivation.summary.subPending', {
          defaultValue: 'You can finish setup any time from settings.',
        });
    return `
      <div class="pro-activation-summary">
        <h2 class="pro-activation-heading">${escapeHtml(
          t('components.proActivation.summary.heading', { defaultValue: "You're all set" }),
        )}</h2>
        <p class="pro-activation-summary-sub">${escapeHtml(sub)}</p>
        <ul class="pro-activation-summary-list">${lines.map(summaryLineHtml).join('')}</ul>
        <div class="pro-activation-actions">
          <button type="button" class="btn btn-primary pro-activation-primary" data-action="finish">${escapeHtml(
            t('components.proActivation.summary.finish', { defaultValue: 'Go to my dashboard' }),
          )}</button>
        </div>
      </div>`;
  };

  const headerHtml = (): string => {
    const badge = escapeHtml(t('components.proActivation.badge', { defaultValue: 'PRO' }));
    const closeLabel = escapeHtml(
      t('components.proActivation.closeLabel', { defaultValue: 'Skip setup' }),
    );
    const progress = onSummary()
      ? ''
      : `<span class="pro-activation-progress">${escapeHtml(
          t('components.proActivation.progress', {
            current: String(currentIndex + 1),
            total: String(steps.length),
            defaultValue: 'Step {{current}} of {{total}}',
          }),
        )}</span>`;
    const account = escapeHtml(
      t('components.proActivation.signedInAs', {
        email: options.accountEmail,
        defaultValue: 'Signed in as {{email}}',
      }),
    );
    return `
      <div class="pro-activation-header">
        <div class="pro-activation-header-top">
          <span class="pro-activation-badge">${badge}</span>
          ${progress}
          <button type="button" class="pro-activation-close" aria-label="${closeLabel}">✕</button>
        </div>
        <p class="pro-activation-account">${account}</p>
      </div>`;
  };

  const modal = document.createElement('div');
  modal.className = 'modal pro-activation-modal';

  const advance = (): void => {
    generation += 1;
    transient = 'idle';
    currentIndex += 1;
    renderModal();
  };

  const finishFlow = (): void => {
    if (finished) return;
    finished = true;
    const results = buildResults();
    closeProActivationInterstitial();
    options.onExit(results);
  };

  const finalizeAndShowSummary = (): void => {
    generation += 1;
    for (let i = currentIndex; i < steps.length; i += 1) {
      const step = steps[i]!;
      if (outcomes.has(step.id)) continue;
      if (step.state === 'already-done') {
        outcomes.set(step.id, 'done');
        continue;
      }
      // Preserve a genuine failure signal on the step the user is abandoning.
      if (i === currentIndex && transient === 'failed') {
        outcomes.set(step.id, 'failed');
        continue;
      }
      options.onSkipStep(step.id);
      outcomes.set(step.id, 'skipped');
    }
    transient = 'idle';
    currentIndex = steps.length;
    renderModal();
  };

  /** X and Escape both mean "skip remaining steps" → summary; on the summary they dismiss. */
  const handleDismiss = (): void => {
    if (onSummary()) finishFlow();
    else finalizeAndShowSummary();
  };

  const handleSkip = (step: ActivationStep): void => {
    options.onSkipStep(step.id);
    outcomes.set(step.id, transient === 'failed' ? 'failed' : 'skipped');
    advance();
  };

  const handleConfirm = async (step: ActivationStep): Promise<void> => {
    transient = 'in-flight';
    renderModal();
    const gen = generation;
    let result: 'verified' | 'failed';
    try {
      result = await options.onConfirmStep(step.id);
    } catch {
      result = 'failed';
    }
    // Ignore a late resolution if the user navigated away or closed mid-await.
    if (!overlay || generation !== gen) return;
    if (result === 'verified') {
      outcomes.set(step.id, 'confirmed');
      advance();
    } else {
      transient = 'failed';
      renderModal();
    }
  };

  const getFocusable = (): HTMLElement[] => {
    if (!overlay) return [];
    return Array.from(overlay.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
      (el) =>
        !el.hasAttribute('disabled') &&
        el.getAttribute('aria-hidden') !== 'true' &&
        el.offsetParent !== null,
    );
  };

  const onKeydown = (e: KeyboardEvent): void => {
    if (!overlay) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      handleDismiss();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusable = getFocusable();
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = document.activeElement as HTMLElement | null;
    if (!active || !focusable.includes(active)) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  function renderModal(): void {
    if (!overlay) return;
    const body = onSummary() ? summaryHtml() : stepHtml(steps[currentIndex]!);
    setTrustedHtml(
      modal,
      trustedHtml(
        `${headerHtml()}<div class="pro-activation-body">${body}</div>`,
        'pro-activation interstitial; every interpolated value escaped via escapeHtml',
      ),
    );

    modal.querySelector('.pro-activation-close')?.addEventListener('click', handleDismiss);

    if (onSummary()) {
      modal.querySelector('[data-action="finish"]')?.addEventListener('click', finishFlow);
    } else {
      const step = steps[currentIndex]!;
      const primaryBtn = modal.querySelector<HTMLButtonElement>('.pro-activation-primary');
      primaryBtn?.addEventListener('click', () => {
        switch (primaryBtn.dataset.action) {
          case 'confirm':
            void handleConfirm(step);
            break;
          case 'advance-done':
            outcomes.set(step.id, 'done');
            advance();
            break;
          case 'advance-skip':
            options.onSkipStep(step.id);
            outcomes.set(step.id, 'skipped');
            advance();
            break;
        }
      });
      modal.querySelector('.pro-activation-skip')?.addEventListener('click', () => handleSkip(step));
    }

    requestAnimationFrame(() => {
      modal.querySelector<HTMLElement>('.pro-activation-primary')?.focus();
    });
  }

  lastFocusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  overlay = document.createElement('div');
  overlay.className = 'modal-overlay pro-activation-overlay active';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute(
    'aria-label',
    t('components.proActivation.ariaLabel', { defaultValue: 'Pro activation setup' }),
  );
  overlay.appendChild(modal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) handleDismiss();
  });

  docKeydownHandler = onKeydown;
  document.addEventListener('keydown', docKeydownHandler, true);
  document.body.appendChild(overlay);
  renderModal();
}

export function closeProActivationInterstitial(): void {
  if (docKeydownHandler) {
    document.removeEventListener('keydown', docKeydownHandler, true);
    docKeydownHandler = null;
  }
  overlay?.remove();
  overlay = null;
  const toRestore = lastFocusedElement;
  lastFocusedElement = null;
  toRestore?.focus?.();
}
