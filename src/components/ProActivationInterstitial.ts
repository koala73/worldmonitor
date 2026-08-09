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
import { enqueueSentryCall, scheduleSentryInit } from '@/bootstrap/sentry-defer';
import { getAuthState, subscribeAuthState } from '@/services/auth-state';
import {
  claimProActivationPresentation,
  confirmProActivationPresentation,
  openProActivationDay0Presentation,
  recordProActivationOutcome,
  type ProActivationOutcomeSnapshot,
} from '@/services/billing';
import { escapeHtml } from '@/utils/sanitize';
import { withTimeout } from '@/utils/with-timeout';
import { getFocusableElements, setTrustedHtml, trustedHtml, type TrustedHtml } from '@/utils/dom-utils';
import { SITE_VARIANT } from '@/config/variant';
import {
  getChannelsData,
  setEmailChannel,
  setNotificationConfig,
  type ChannelType,
  type ChannelsData,
} from '@/services/notification-channels';
import {
  isWebPushSupported,
  getPushPermission,
  subscribeToPush,
} from '@/services/push-notifications';
import { getServerInsights, fetchServerInsights } from '@/services/insights-loader';
import { loadWidgets, loadWidgetsStrict } from '@/services/widget-store';
import {
  ACTIVATION_EVENTS,
  buildActivationSteps,
  hasAnyActivatedProFunctionality,
  buildBriefDigestPayload,
  buildCriticalAlertsPayload,
  buildExitSummary,
  buildActivationOutcomeBuckets,
  selectAdvanceOutcome,
  selectConfirmOutcome,
  selectStepEvent,
  shouldReportPushSubscribeFailure,
  summarizeActivationExit,
  DEFAULT_DIGEST_HOUR,
  type ActivationEventName,
  type ActivationExistingConfig,
  type ActivationExitSummary,
  type ActivationPlatformCapabilities,
  type ActivationStep,
  type ActivationStepId,
  type ActivationStepOutcome,
  type ActivationStepResult,
  type ActivationStepState,
  type ActivationSummaryLine,
} from '@/services/pro-activation-state';

/**
 * How an in-flow confirm resolved. `blocked` means the platform refused in a
 * way a retry cannot fix — a denied notification permission, which browsers
 * never re-prompt for — so the shell moves the step into its blocked state
 * instead of offering a "Try again" that can only fail identically (#5609).
 */
export type ActivationConfirmResult = 'verified' | 'failed' | 'blocked' | 'declined';

export interface ProActivationInterstitialOptions {
  /** Ordered steps from `buildActivationSteps` (computed by the caller). */
  steps: readonly ActivationStep[];
  /** Account email for display, so the user sees which account got Pro. */
  accountEmail: string;
  /**
   * Complete a step in-flow. Resolves `'verified'` on success, `'blocked'` when
   * the platform refused unrecoverably, `'failed'` for anything retryable.
   * Injected by a later unit; until then a stub can resolve any of them.
   */
  onConfirmStep: (stepId: ActivationStepId) => Promise<ActivationConfirmResult>;
  /** Fire-and-forget skip signal (bookkeeping/telemetry wired by later units). */
  onSkipStep: (stepId: ActivationStepId) => void;
  /**
   * Fire-and-forget signal that a confirm resolved `blocked`. This is the LIVE
   * half of separating browser refusals from voluntary skips; the durable half
   * is the step's own `blocked` outcome and its `blockedSteps` bucket (#5617).
   * Note the step also still emits `onSkipStep` when the user advances past it,
   * so the two events are not mutually exclusive on the stream.
   */
  onBlockStep?: (stepId: ActivationStepId) => void;
  /** Called after each durable step-state transition with a full snapshot. */
  onProgress?: (results: ActivationStepResult[]) => void;
  /** Called exactly once when the flow ends, with the ordered step results. */
  onExit: (results: ActivationStepResult[]) => void;
  /**
   * Optional per-step body extras rendered inside the step frame — the brief
   * hour picker + preview and the power toolkit pointers (U4/U6). Rendered only
   * for `confirmable` steps (already-done/blocked/unavailable never show them).
   */
  stepExtras?: Partial<Record<ActivationStepId, ProActivationStepExtra>>;
}

/** Controls handed to a step's `onMount` so extras can complete the step. */
export interface ProActivationStepControls {
  /**
   * Mark the current step confirmed and end the whole flow — used by the power
   * step's deep-link pointers, which navigate the user into a Pro surface (so
   * the interstitial must close first rather than sit over it).
   */
  confirmAndFinish(): void;
}

/** Per-step body extras injected by the high-level flow (U4/U6). */
export interface ProActivationStepExtra {
  /** Extra body content rendered inside the step frame (caller MUST escape). */
  html: TrustedHtml;
  /** Wire listeners on the rendered extras root; may complete the step early. */
  onMount?(root: HTMLElement, controls: ProActivationStepControls): void;
  /**
   * When true the step renders no confirm CTA — the extras own the actions (the
   * power step's pointers); a single "Continue" advances (counts as skip).
   */
  replacesPrimaryAction?: boolean;
}

/** Transient UI state for the CURRENT confirmable step only. */
type TransientState = 'idle' | 'in-flight' | 'failed';

/** Per-step visual status driving the badge (R15: pending/verified/failed distinct). */
type StepStatus = 'pending' | 'in-flight' | 'verified' | 'failed' | 'blocked' | 'unavailable';

// Module-level singleton handles (single instance at a time, like McpConnectModal).
let overlay: HTMLElement | null = null;
let lastFocusedElement: HTMLElement | null = null;
let docKeydownHandler: ((e: KeyboardEvent) => void) | null = null;
let flowAccountUnsubscribe: (() => void) | null = null;
let flowAbortController: AbortController | null = null;

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

/**
 * Blocked-state note. `justDenied` marks the mid-flow transition — the user
 * acted on the browser prompt just now, so the copy acknowledges that instead
 * of reporting a pre-existing block. Both variants point at the browser's site
 * settings: nothing inside the wizard can undo a denied permission.
 */
function blockedNote(id: ActivationStepId, justDenied: boolean): string {
  if (id !== 'alerts') {
    return t('components.proActivation.status.blockedNote', {
      defaultValue: "This isn't available right now — you can set it up later from settings.",
    });
  }
  return justDenied
    ? t('components.proActivation.steps.alerts.declinedNote', {
        defaultValue:
          "No problem — we won't send browser alerts. You can turn them on later from your browser's site settings.",
      })
    : t('components.proActivation.steps.alerts.blockedNote', {
        defaultValue:
          "Notifications are blocked in your browser. Turn them on in your browser's site settings to get alerts.",
      });
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
  // Steps whose confirm resolved `blocked` (a denied browser permission). They
  // render exactly like a step that was already blocked at mount — the browser
  // will not re-prompt, so a retry CTA would be a dead end (#5609).
  const blockedByConfirm = new Set<ActivationStepId>();
  // Steps parked in the failed state because the user dismissed a permission
  // prompt rather than because a write errored. Same UI (retryable), different
  // funnel meaning — see shouldEmitSkip.
  const declinedByConfirm = new Set<ActivationStepId>();

  const onSummary = (): boolean => currentIndex >= steps.length;

  /**
   * The step's CURRENT state — its declared state plus a mid-flow permission
   * block. Every read goes through this: reading `step.state` directly would
   * silently miss a blocked-by-confirm step the moment a branch cares about it.
   */
  const effectiveState = (step: ActivationStep): ActivationStepState =>
    blockedByConfirm.has(step.id) ? 'blocked' : step.state;

  /** True when the step is parked in the failed state because OUR write errored. */
  const isGenuineFailure = (step: ActivationStep): boolean =>
    transient === 'failed' && !declinedByConfirm.has(step.id);

  /**
   * Default disposition for a step never explicitly acted on (dismiss/Escape).
   * Shares `selectAdvanceOutcome` with the Continue button so a browser-refused
   * step is recorded as `blocked` no matter which way the user leaves it —
   * recording it only on the button would make `blockedSteps` a sample of
   * "denied users who clicked Continue" rather than the denial cohort (#5617).
   */
  const defaultOutcome = (step: ActivationStep): ActivationStepOutcome =>
    selectAdvanceOutcome(effectiveState(step));

  /**
   * Emit the per-step event matching the outcome a step ADVANCED to, so the
   * live stream and the durable buckets count the same cohorts. Firing
   * `onSkipStep` for a browser refusal would leave the funnel's skip count
   * including denials while `skippedSteps` excludes them — two sources of truth
   * disagreeing about the same step (#5617).
   *
   * Exactly one event per step: a mid-flow denial already announced itself from
   * `handleConfirm` the instant the browser refused, so only a step blocked at
   * MOUNT (never confirm-blocked, hence absent from `blockedByConfirm`) still
   * needs its block reported here.
   */
  const reportAdvanceEvent = (stepId: ActivationStepId, outcome: ActivationStepOutcome): void => {
    if (outcome === 'blocked') {
      if (!blockedByConfirm.has(stepId)) options.onBlockStep?.(stepId);
      return;
    }
    options.onSkipStep(stepId);
  };

  const buildResults = (): ActivationStepResult[] =>
    steps.map((step) => ({ id: step.id, outcome: outcomes.get(step.id) ?? defaultOutcome(step) }));

  const recordProgress = (): void => options.onProgress?.(buildResults());

  const currentStatus = (step: ActivationStep): StepStatus => {
    const state = effectiveState(step);
    if (state === 'already-done') return 'verified';
    if (state === 'blocked') return 'blocked';
    if (state === 'unavailable') return 'unavailable';
    if (transient === 'in-flight') return 'in-flight';
    if (transient === 'failed') return 'failed';
    return 'pending';
  };

  const noteHtml = (message: string, kind: 'ok' | 'muted' | 'warn' | 'error'): string =>
    `<p class="pro-activation-note note-${kind}">${escapeHtml(message)}</p>`;

  const stepNotesHtml = (step: ActivationStep): string => {
    const copy = stepFrameCopy(step.id);
    const state = effectiveState(step);
    const notes: string[] = [];
    if (state === 'already-done') {
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
    } else if (state === 'blocked') {
      notes.push(noteHtml(blockedNote(step.id, blockedByConfirm.has(step.id)), 'warn'));
    } else if (state === 'unavailable') {
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
    const primary = (label: string, action: string, busy = false): string =>
      `<button type="button" class="btn btn-primary pro-activation-primary" data-action="${action}"${
        busy ? ' disabled aria-busy="true"' : ''
      }>${escapeHtml(label)}</button>`;
    const skip = (): string =>
      `<button type="button" class="btn btn-ghost pro-activation-skip" data-action="skip">${escapeHtml(
        t('components.proActivation.actions.skip', { defaultValue: 'Skip for now' }),
      )}</button>`;
    const cont = (action: string): string =>
      primary(t('components.proActivation.actions.continue', { defaultValue: 'Continue' }), action);

    const state = effectiveState(step);
    if (state === 'already-done') return cont('advance-done');
    if (state === 'blocked' || state === 'unavailable') return cont('advance-skip');
    // confirmable
    // Power step: the extras' pointers ARE the actions — render only "Continue".
    if (options.stepExtras?.[step.id]?.replacesPrimaryAction) return cont('advance-skip');
    if (transient === 'in-flight') return primary(copy.confirming, 'confirm', true);
    const label =
      transient === 'failed'
        ? t('components.proActivation.status.retry', { defaultValue: 'Try again' })
        : copy.confirmCta;
    return primary(label, 'confirm') + skip();
  };

  const stepExtrasHtml = (step: ActivationStep): string => {
    if (effectiveState(step) !== 'confirmable') return '';
    const extra = options.stepExtras?.[step.id];
    if (!extra) return '';
    return `<div class="pro-activation-extras" data-pro-activation-extras>${extra.html}</div>`;
  };

  const stepHtml = (step: ActivationStep): string => {
    const copy = stepFrameCopy(step.id);
    const status = currentStatus(step);
    return `
      <div class="pro-activation-step">
        <span class="pro-activation-status status-${status}">${escapeHtml(statusLabel(status))}</span>
        <h2 class="pro-activation-heading">${escapeHtml(copy.heading)}</h2>
        <p class="pro-activation-step-body">${escapeHtml(copy.body)}</p>
        ${stepExtrasHtml(step)}
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
          : line.outcome === 'blocked'
            ? // Reuse the single per-step-id source of truth (blockedNote also
              // handles ids other than 'alerts' with generic copy) so a future
              // blockable step can never fall through to the app-settings
              // promise this branch exists to avoid.
              blockedNote(line.id, false)
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
    const anyBlocked = lines.some((line) => line.outcome === 'blocked');
    const sub = anyVerified
      ? t('components.proActivation.summary.subVerified', {
          defaultValue: "Here's what's running on your account.",
        })
      : anyBlocked
        ? null
        : t('components.proActivation.summary.subPending', {
            defaultValue: 'You can finish setup any time from settings.',
          });
    return `
      <div class="pro-activation-summary">
        <h2 class="pro-activation-heading">${escapeHtml(
          t('components.proActivation.summary.heading', { defaultValue: "You're all set" }),
        )}</h2>
        ${sub ? `<p class="pro-activation-summary-sub">${escapeHtml(sub)}</p>` : ''}
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
          <button type="button" class="pro-activation-close" aria-label="${closeLabel}"${
            transient === 'in-flight' ? ' disabled aria-disabled="true"' : ''
          }>✕</button>
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
      const state = effectiveState(step);
      if (state === 'already-done') {
        outcomes.set(step.id, 'done');
        continue;
      }
      // Preserve a genuine failure signal on the step the user is abandoning.
      if (i === currentIndex && isGenuineFailure(step)) {
        outcomes.set(step.id, 'failed');
        continue;
      }
      // Abandoning the flow on a browser-refused step is still a refusal, not
      // a skip — same seam as the Continue button so the two cannot drift.
      const outcome = selectAdvanceOutcome(state);
      reportAdvanceEvent(step.id, outcome);
      outcomes.set(step.id, outcome);
    }
    transient = 'idle';
    currentIndex = steps.length;
    recordProgress();
    renderModal();
  };

  /** X and Escape both mean "skip remaining steps" → summary; on the summary they dismiss. */
  const handleDismiss = (): void => {
    // A notification mutation cannot be cancelled once sent. Keep the modal
    // stable until it settles so the summary/telemetry cannot call a successful
    // write "skipped" simply because Escape or the backdrop won the race.
    if (transient === 'in-flight') return;
    if (onSummary()) finishFlow();
    else finalizeAndShowSummary();
  };

  const handleSkip = (step: ActivationStep): void => {
    // Moving on from a step whose write errored is not a skip. Reporting it as
    // one is what made a systemic day-0 failure look like user disinterest in
    // the funnel (#5600); the failure itself was already reported by
    // onConfirmStep, and the outcome below keeps the summary/ledger honest.
    if (!isGenuineFailure(step)) options.onSkipStep(step.id);
    outcomes.set(step.id, isGenuineFailure(step) ? 'failed' : 'skipped');
    recordProgress();
    advance();
  };

  const handleConfirm = async (step: ActivationStep): Promise<void> => {
    // Each attempt is classified fresh: a retry after a dismissed prompt can
    // resolve any other way.
    declinedByConfirm.delete(step.id);
    transient = 'in-flight';
    renderModal();
    const gen = generation;
    let result: ActivationConfirmResult;
    try {
      result = await options.onConfirmStep(step.id);
    } catch {
      result = 'failed';
    }
    // Ignore a late resolution if the user navigated away or closed mid-await.
    if (!overlay || generation !== gen) return;
    if (result === 'verified') {
      outcomes.set(step.id, 'confirmed');
      recordProgress();
      advance();
    } else if (result === 'blocked') {
      // Unrecoverable refusal: drop the retry CTA and render the blocked state
      // so the user gets the site-settings instructions instead of a "Try
      // again" the browser will refuse identically forever. The step resolves
      // as its own `blocked` outcome (same as one blocked at mount) when they
      // continue.
      blockedByConfirm.add(step.id);
      transient = 'idle';
      options.onBlockStep?.(step.id);
      // Flush the denial NOW, like the `verified` arm above. Being refused and
      // then abandoning the tab is a likely reaction, and without this the last
      // durable snapshot still calls the step `skipped` — losing exactly the
      // cohort the blocked bucket exists to size (#5617).
      recordProgress();
      renderModal();
    } else {
      // 'declined' (dismissed prompt) renders the same retryable failed state as
      // a genuine write error — clicking again re-prompts. Only the funnel
      // meaning differs; isGenuineFailure reads this set.
      if (result === 'declined') declinedByConfirm.add(step.id);
      transient = 'failed';
      renderModal();
    }
  };

  const getFocusable = (): HTMLElement[] => (overlay ? getFocusableElements(overlay) : []);

  const onKeydown = (e: KeyboardEvent): void => {
    if (!overlay) return;
    // The power step teaches Command Search inside a full-screen modal. Handle
    // the shortcut at capture time so it activates the visible pointer instead
    // of opening the search overlay underneath this higher-z-index interstitial.
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'k') {
      const searchPointer = modal.querySelector<HTMLButtonElement>('[data-pointer="search"]');
      if (searchPointer) {
        e.preventDefault();
        e.stopPropagation();
        searchPointer.click();
        return;
      }
    }
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
            recordProgress();
            advance();
            break;
          case 'advance-skip': {
            // `blocked` (mount-time or mid-flow) records as its own outcome so
            // the durable record can still tell a browser refusal from a
            // voluntary skip. The exit summary keeps the pending status/icon
            // while rendering browser-specific guidance (#5617, #5727).
            const advanced = selectAdvanceOutcome(effectiveState(step));
            reportAdvanceEvent(step.id, advanced);
            outcomes.set(step.id, advanced);
            recordProgress();
            advance();
            break;
          }
        }
      });
      modal.querySelector('.pro-activation-skip')?.addEventListener('click', () => handleSkip(step));

      // Wire per-step extras (brief hour picker/preview, power pointers). The
      // controls let the power pointers confirm-and-close before deep-linking
      // the user into a Pro surface.
      const extra = effectiveState(step) === 'confirmable' ? options.stepExtras?.[step.id] : undefined;
      if (extra?.onMount) {
        const extrasRoot = modal.querySelector<HTMLElement>('[data-pro-activation-extras]');
        if (extrasRoot) {
          extra.onMount(extrasRoot, {
            confirmAndFinish: () => {
              outcomes.set(step.id, 'confirmed');
              recordProgress();
              finishFlow();
            },
          });
        }
      }
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
  flowAbortController?.abort();
  flowAbortController = null;
  flowAccountUnsubscribe?.();
  flowAccountUnsubscribe = null;
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

// ===========================================================================
// High-level flow (U4/U5/U6): reads real config, builds steps, supplies the
// per-step confirm handlers, and handles exit (summary + finish-setup chip).
//
// Handlers call the notification-channels / push-notifications / insights
// services DIRECTLY (the plan forbids an intermediate action-layer module).
// The one thing this component cannot reach is the AppContext — so the power
// step's surface openers are INJECTED by the boot hook (a later unit) via the
// options below; the exact ctx wiring each opener needs is documented inline.
// ===========================================================================

/** Injectable configuration for `openProActivationFlow` / the finish-setup chip. */
export interface ProActivationFlowOptions {
  /** Clerk user id that owns this flow. Kept in memory; never persisted. */
  accountUserId: string;
  /** Account email — displayed, and the address the morning brief is sent to. */
  accountEmail: string;
  /** Injectable owner check for the browser harness; production uses live auth. */
  isAccountCurrent?: () => boolean;
  /**
   * Open the MCP-clients settings surface. Boot hook:
   * `ctx.unifiedSettings.open('mcp-clients')`, wired ONLY when the account holds
   * `mcpAccess` — Pro is `apiAccess: false, mcpAccess: true`, and the settings
   * modal renders neither the MCP tab nor its panel without that feature.
   */
  openMcpClients?: () => void;
  /** Reveal the AI analyst / researcher panel. Boot hook: mount + scroll the `chat-analyst` panel into view. */
  openAiAnalyst?: () => void;
  /** Open the custom-widget builder. Boot hook: dispatch `wm:open-widget-creator` on `ctx.container`. */
  openWidgetBuilder?: () => void;
  /** Open the global command search. Boot hook: `App.openSearch()`. */
  openSearch?: () => void;
  /** Open notification settings for multi-step channels (R8). Boot hook: `ctx.unifiedSettings.open('notifications')`. */
  openChannelSettings?: () => void;
  /**
   * Telemetry sink (names from `ACTIVATION_EVENTS`). `stepId` accompanies the
   * per-step confirmed/skipped events; `exit` carries the aggregate completion
   * state on the flow-exit event (absent on every other event).
   */
  onEvent?: (event: ActivationEventName, stepId?: ActivationStepId, exit?: ActivationExitSummary) => void;
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Markerless first-cycle backfill only: require an authoritative config read
   * and suppress the flow if any targeted Pro capability is already active.
   */
  onlyIfUnactivated?: boolean;
  /** Opaque subscription identity whose markerless eligibility was evaluated. */
  expectedActivationKey?: string;
  /** Per-tab nonce used by the server-side cross-device presentation lease. */
  activationClaimNonce?: string;
  /** Day-0 session start; paired with the nonce for ordered row ownership. */
  activationSessionStartedAt?: number;
  /**
   * Finish-setup chip seam. Invoked when the chip is clicked so each reopen
   * gets fresh identity instead of replaying the captured flow's revision
   * namespace.
   */
  createDay0SessionIdentity?: () => {
    activationClaimNonce: string;
    activationSessionStartedAt: number;
  };
}

/** Live activation context read once at flow open: config + platform + fields for the alerts patch. */
export interface ActivationContext {
  config: ActivationExistingConfig;
  capabilities: ActivationPlatformCapabilities;
  /** Existing delivery-channel types (used to merge without clobbering). */
  channels: readonly string[];
  /**
   * Whether `channels` came from a successful read. Confirm handlers require a
   * fresh authoritative read before writing; false is presentation-only state.
   */
  channelsKnown: boolean;
  /** Whether the current-variant rule is enabled (drives alerts patch/seed choice). */
  hasEnabledRule: boolean;
}

export interface ProActivationFlowDependencies {
  readContext: (expectedUserId: string, strict: boolean) => Promise<ActivationContext>;
  claimPresentation: (
    activationKey: string,
    claimNonce: string,
  ) => Promise<'claimed' | 'not_eligible' | 'already_presented' | 'already_claimed'>;
  confirmPresentation: (activationKey: string, claimNonce: string) => Promise<boolean>;
  /** Day-0 counterpart to claim+confirm; best-effort, never gates the flow (#5621). */
  openDay0Presentation: (
    activationKey: string,
    claimNonce: string,
    sessionStartedAt: number,
  ) => Promise<'opened' | 'already_recorded' | 'not_eligible' | 'superseded'>;
  /**
   * Typed against the service's own snapshot rather than a hand-copied shape:
   * the duplicate drifted the moment a bucket was added (#5617), and a stale
   * structural copy would have let the new field be dropped here silently.
   */
  recordOutcome: (
    activationKey: string,
    claimNonce: string,
    outcome: ProActivationOutcomeSnapshot,
  ) => Promise<boolean>;
  openInterstitial: typeof openProActivationInterstitial;
  /** Per-operation deadline; injectable only to keep timeout regressions fast. */
  operationTimeoutMs?: number;
}

function isFlowAccountCurrent(options: ProActivationFlowOptions): boolean {
  return options.isAccountCurrent?.() ?? getAuthState().user?.id === options.accountUserId;
}

const BRIEF_HOUR_SELECT_ID = 'proActivationDigestHour';
const DIGEST_CADENCES = new Set(['daily', 'twice_daily', 'weekly']);
const BRIEF_PREVIEW_MAX = 220;
const BRIEF_PREVIEW_TIMEOUT_MS = 2500;
const ACTIVATION_CONTEXT_TIMEOUT_MS = 5_000;
const ACTIVATION_MUTATION_TIMEOUT_MS = 5_000;
const PRESENTATION_CONFIRM_RETRY_DELAYS_MS = [250, 750, 1_500] as const;
const DAY0_OPEN_RETRY_DELAYS_MS = [250, 750] as const;
const OUTCOME_WRITE_RETRY_DELAYS_MS = [250, 750] as const;

/**
 * The brief step's chosen delivery hour, held outside the re-rendered DOM. The
 * shell rebuilds the hour `<select>` (with only DEFAULT selected) on the
 * in-flight/failed re-render that happens *before* the confirm write reads it,
 * so the pick lives here — written by the select's change listener, re-applied
 * to each rebuilt select, and read by `confirmBrief` ahead of the DOM.
 */
interface DigestHourRef {
  hour: number | null;
}

/** IANA timezone of the browser, defensively defaulted so a write never sends undefined. */
function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Local 12-hour clock label for an hour-of-day (mirrors the settings picker). */
function formatHourLabel(h: number): string {
  if (h === 0) return '12 AM';
  if (h < 12) return `${h} AM`;
  if (h === 12) return '12 PM';
  return `${h - 12} PM`;
}

/** Best-effort synchronous "has the subscriber already used a Pro power feature". */
function hasUsedPowerFeature(): boolean {
  try {
    return loadWidgets().length > 0;
  } catch {
    return false;
  }
}

/** Strict counterpart for markerless cohort suppression; storage failure retries. */
function hasUsedPowerFeatureStrict(): boolean {
  return loadWidgetsStrict().length > 0;
}

/** Platform capabilities from the live push runtime (drives the alerts-step gate). */
function readActivationCapabilities(): ActivationPlatformCapabilities {
  const webPushSupported = isWebPushSupported();
  const perm = getPushPermission();
  return {
    webPushSupported,
    // 'unsupported' is already captured by webPushSupported=false; only forward
    // a real Notification.permission value to buildActivationSteps.
    pushPermission: perm === 'unsupported' ? undefined : perm,
  };
}

/**
 * Read the subscriber's existing channels + alert rule into the pure step
 * inputs. Never throws — an unreachable channels endpoint degrades to an
 * all-unconfigured context so onboarding still opens and offers every step.
 */
export function activationContextFromChannelsData(
  data: ChannelsData,
  capabilities: ActivationPlatformCapabilities,
): ActivationContext {
  const channels = data.channels ?? [];
  const rule = data.alertRules?.find((candidate) => candidate.variant === SITE_VARIANT) ?? null;
  const ruleChannels = rule?.channels ?? [];
  const emailCh = channels.find((channel) => channel.channelType === 'email');
  const webPushCh = channels.find((channel) => channel.channelType === 'web_push');
  const hasEnabledDigestRule =
    !!rule?.enabled && !!rule.digestMode && DIGEST_CADENCES.has(rule.digestMode);
  const hasVerifiedEmailChannel = !!emailCh?.verified;
  const hasWebPushChannel = !!webPushCh?.verified;
  return {
    config: {
      hasVerifiedEmailChannel,
      hasEmailDelivery:
        !!rule?.enabled && hasVerifiedEmailChannel && ruleChannels.includes('email'),
      hasEnabledDigestRule,
      hasTunedDigestHour: rule?.digestHour != null && rule.digestHour !== DEFAULT_DIGEST_HOUR,
      hasWebPushChannel,
      hasWebPushDelivery:
        !!rule?.enabled && hasWebPushChannel && ruleChannels.includes('web_push'),
      hasUsedPowerFeature: hasUsedPowerFeature(),
    },
    capabilities,
    channels: channels.map((channel) => channel.channelType),
    channelsKnown: true,
    hasEnabledRule: !!rule?.enabled,
  };
}

async function readActivationContextStrict(
  expectedUserId: string,
  signal?: AbortSignal,
): Promise<ActivationContext> {
  const controller = new AbortController();
  const abortFromParent = (): void => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromParent();
  else signal?.addEventListener('abort', abortFromParent, { once: true });
  try {
    const data = await withTimeout(
      getChannelsData(expectedUserId, controller.signal),
      ACTIVATION_CONTEXT_TIMEOUT_MS,
      'activation-context-read',
      () => controller.abort(),
    );
    const context = activationContextFromChannelsData(data, readActivationCapabilities());
    context.config.hasUsedPowerFeature = hasUsedPowerFeatureStrict();
    return context;
  } finally {
    signal?.removeEventListener('abort', abortFromParent);
  }
}

export async function readActivationContext(expectedUserId?: string): Promise<ActivationContext> {
  const capabilities = readActivationCapabilities();
  try {
    const data = await getChannelsData(expectedUserId);
    return activationContextFromChannelsData(data, capabilities);
  } catch {
    return {
      config: {
        hasVerifiedEmailChannel: false,
        hasEmailDelivery: false,
        hasEnabledDigestRule: false,
        hasTunedDigestHour: false,
        hasWebPushChannel: false,
        hasWebPushDelivery: false,
        hasUsedPowerFeature: hasUsedPowerFeature(),
      },
      capabilities,
      channels: [],
      channelsKnown: false,
      hasEnabledRule: false,
    };
  }
}

/** Read the hour the user picked in the brief step frame, defaulting safely. */
function readSelectedDigestHour(): number {
  const el = document.getElementById(BRIEF_HOUR_SELECT_ID);
  const value = el instanceof HTMLSelectElement ? Number(el.value) : Number.NaN;
  return Number.isFinite(value) ? value : DEFAULT_DIGEST_HOUR;
}

function truncatePreview(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= BRIEF_PREVIEW_MAX) return clean;
  const cut = clean.slice(0, BRIEF_PREVIEW_MAX);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** Inner HTML for a resolved brief preview (label + snippet), fully escaped. */
function briefPreviewInner(brief: string): TrustedHtml {
  const label = escapeHtml(
    t('components.proActivation.steps.brief.previewLabel', { defaultValue: "This morning's brief" }),
  );
  const text = escapeHtml(truncatePreview(brief));
  return trustedHtml(
    `<span class="pro-activation-brief-preview-label">${label}</span><span class="pro-activation-brief-preview-text">${text}</span>`,
    'pro-activation brief preview; label + snippet escaped via escapeHtml',
  );
}

/** Synchronously-hydrated world brief, if present (else null → background fetch). */
function safeWorldBrief(): string | null {
  try {
    return getServerInsights()?.worldBrief?.trim() || null;
  } catch {
    return null;
  }
}

/** Brief-step extras: a live preview (AE2) + an inline delivery-hour picker (one click). */
function buildBriefExtra(syncBrief: string | null, hourRef: DigestHourRef): ProActivationStepExtra {
  const hourOptions = Array.from({ length: 24 }, (_, h) =>
    `<option value="${h}"${h === DEFAULT_DIGEST_HOUR ? ' selected' : ''}>${escapeHtml(
      formatHourLabel(h),
    )}</option>`,
  ).join('');
  const deliverLabel = escapeHtml(
    t('components.proActivation.steps.brief.deliverAt', { defaultValue: 'Deliver at' }),
  );
  const sendToLabel = escapeHtml(
    t('components.proActivation.steps.brief.previewLoading', {
      defaultValue: 'Preparing a preview of your first brief…',
    }),
  );
  const html = trustedHtml(
    `<div class="pro-activation-brief-preview" data-brief-preview>${sendToLabel}</div>
     <label class="pro-activation-brief-hour">
       <span class="pro-activation-brief-hour-label">${deliverLabel}</span>
       <select id="${BRIEF_HOUR_SELECT_ID}" class="pro-activation-hour-select unified-settings-select">${hourOptions}</select>
     </label>`,
    'pro-activation brief extras; hour labels + preview placeholder escaped via escapeHtml',
  );

  let resolved: string | null = syncBrief;
  // Tri-state so a re-render that lands while the fetch is still in flight leaves
  // the loading copy in place ('pending') instead of tearing it out as if the
  // fetch had already resolved empty ('empty'); the .then() re-queries the live
  // DOM so late content still lands after any such re-render (AE2).
  let fetchState: 'idle' | 'pending' | 'empty' = 'idle';
  return {
    html,
    onMount: (root) => {
      // Persist the delivery-hour pick outside the DOM: re-apply the saved hour to
      // this freshly rendered select, then record future changes into the ref so
      // the confirm write (which fires after an in-flight re-render) reads it.
      const select = root.querySelector<HTMLSelectElement>(`#${BRIEF_HOUR_SELECT_ID}`);
      if (select) {
        if (hourRef.hour != null) select.value = String(hourRef.hour);
        select.addEventListener('change', () => {
          const parsed = Number(select.value);
          if (Number.isFinite(parsed)) hourRef.hour = parsed;
        });
      }

      const el = root.querySelector<HTMLElement>('[data-brief-preview]');
      if (!el) return;
      if (resolved) {
        setTrustedHtml(el, briefPreviewInner(resolved));
        return;
      }
      // A prior fetch already resolved empty → stay copy-only (AE2).
      if (fetchState === 'empty') {
        el.remove();
        return;
      }
      // Fetch still in flight from an earlier mount → leave the loading copy; its
      // .then() re-queries the live DOM and lands the content on resolve.
      if (fetchState === 'pending') return;
      fetchState = 'pending';
      void fetchServerInsights(BRIEF_PREVIEW_TIMEOUT_MS)
        .then((data) => {
          resolved = data?.worldBrief?.trim() || null;
          if (!resolved) fetchState = 'empty';
          const cur = document.querySelector<HTMLElement>('[data-brief-preview]');
          if (!cur) return;
          if (resolved) setTrustedHtml(cur, briefPreviewInner(resolved));
          else cur.remove();
        })
        .catch(() => {
          fetchState = 'empty';
          document.querySelector<HTMLElement>('[data-brief-preview]')?.remove();
        });
    },
  };
}

function commandSearchShortcut(): { keys: readonly string[]; label: string } {
  const isApplePlatform =
    typeof navigator !== 'undefined' &&
    /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);
  return isApplePlatform
    ? { keys: ['⌘', 'K'], label: '⌘K' }
    : { keys: ['Ctrl', 'K'], label: 'Ctrl+K' };
}

/** Power-step extras: command search + deep-link pointers into the Pro surfaces (R8-aware). */
function buildPowerExtra(options: ProActivationFlowOptions): ProActivationStepExtra {
  const pointers: Array<{
    id: string;
    label: string;
    open: () => void;
    shortcut?: { keys: readonly string[]; label: string };
  }> = [];
  const add = (
    id: string,
    key: string,
    defaultValue: string,
    open?: () => void,
    shortcut?: { keys: readonly string[]; label: string },
  ): void => {
    if (typeof open !== 'function') return;
    pointers.push({ id, label: t(key, { defaultValue }), open, shortcut });
  };
  add(
    'search',
    'components.proActivation.steps.power.pointers.search',
    'Search the entire dashboard',
    options.openSearch,
    commandSearchShortcut(),
  );
  add('widgets', 'components.proActivation.steps.power.pointers.widgets', 'Build a custom widget', options.openWidgetBuilder);
  add('analyst', 'components.proActivation.steps.power.pointers.analyst', 'Ask the AI analyst', options.openAiAnalyst);
  add('mcpClients', 'components.proActivation.steps.power.pointers.mcpClients', 'Set up MCP', options.openMcpClients);

  const pointerButtons = pointers
    .map((p) => {
      const trailing = p.shortcut
        ? `<span class="pro-activation-pointer-shortcut" aria-hidden="true">${p.shortcut.keys
            .map((key) => `<kbd>${escapeHtml(key)}</kbd>`)
            .join('')}</span>`
        : '<span class="pro-activation-pointer-arrow" aria-hidden="true">→</span>';
      const ariaLabel = p.shortcut ? `${p.label} (${p.shortcut.label})` : p.label;
      return `<button type="button" class="pro-activation-pointer" data-pointer="${p.id}" aria-label="${escapeHtml(
        ariaLabel,
      )}"><span class="pro-activation-pointer-label">${escapeHtml(p.label)}</span>${trailing}</button>`;
    })
    .join('');

  // R8: multi-step channels are never embedded — link out to settings instead.
  const channelsLine = options.openChannelSettings
    ? `<p class="pro-activation-pointer-note">${escapeHtml(
        t('components.proActivation.steps.power.channelsNote', {
          defaultValue: 'Prefer Telegram, Slack, Discord, or a webhook?',
        }),
      )} <button type="button" class="pro-activation-pointer-link" data-pointer="channels">${escapeHtml(
        t('components.proActivation.steps.power.pointers.channels', {
          defaultValue: 'Set those up in notification settings',
        }),
      )}<span class="pro-activation-pointer-arrow" aria-hidden="true">→</span></button></p>`
    : '';

  const openers = new Map<string, () => void>();
  for (const p of pointers) openers.set(p.id, p.open);
  if (options.openChannelSettings) openers.set('channels', options.openChannelSettings);

  return {
    html: trustedHtml(
      `<div class="pro-activation-pointers">${pointerButtons}</div>${channelsLine}`,
      'pro-activation power pointers; labels escaped via escapeHtml',
    ),
    replacesPrimaryAction: true,
    onMount: (root, controls) => {
      for (const btn of root.querySelectorAll<HTMLElement>('[data-pointer]')) {
        btn.addEventListener('click', () => {
          const open = openers.get(btn.dataset.pointer ?? '');
          options.onEvent?.(ACTIVATION_EVENTS.stepConfirmed, 'power');
          // Close the interstitial FIRST (a full-screen overlay), then deep-link.
          controls.confirmAndFinish();
          try {
            open?.();
          } catch (err) {
            console.warn('[pro-activation] surface opener threw', err);
          }
        });
      }
    },
  };
}

/** Closed vocabulary of failure sites, so a typo'd Sentry tag is a compile error. */
type ActivationFailureStage =
  | 'brief-confirm'
  | 'push-subscribe'
  | 'alerts-config-refresh'
  | 'alerts-rule-write';

/**
 * Surface an activation step failure to Sentry (#5600).
 *
 * These paths used to only `console.warn`, and sentry-init.ts has no
 * captureConsole integration — so the error text never left the browser and a
 * systemic day-0 failure (every network-backed step 403ing after checkout) was
 * invisible server-side for a full day. `activation_path` separates the day-0
 * cohort, which writes no `proActivationPresentations` outcome row at all,
 * from the retro backfill cohort that does.
 *
 * Two guards keep the signal honest:
 *
 * - An account switch mid-confirm makes confirmBrief/confirmAlerts return
 *   'failed' for a write that may well have succeeded. The funnel already
 *   excludes that (it is flow teardown, not a step failure); Sentry must too, or
 *   the cohort counts here and in Umami disagree.
 * - `scheduleSentryInit()` is kicked explicitly. It is idempotent, and without it
 *   the call merely queues: main.ts defers real init ~10s, and the day-0
 *   interstitial opens on that SAME post-checkout page load, so a user who fails
 *   a step and closes the tab inside that window loses the one signal this
 *   function exists to produce. The queue has no pagehide flush.
 */
function reportActivationStepFailure(
  options: ProActivationFlowOptions,
  step: ActivationStepId,
  stage: ActivationFailureStage,
  err: unknown,
): void {
  if (!isFlowAccountCurrent(options)) return;
  void scheduleSentryInit();
  enqueueSentryCall((s) => s.captureException(
    err instanceof Error ? err : new Error(String(err)),
    {
      tags: {
        component: 'pro-activation',
        step,
        stage,
        activation_path: options.onlyIfUnactivated ? 'retro' : 'day0',
      },
    },
  ));
}

/** Brief confirm: link the email channel, then one atomic daily-digest write. */
async function confirmBrief(
  options: ProActivationFlowOptions,
  hourRef: DigestHourRef,
  signal?: AbortSignal,
): Promise<'verified' | 'failed'> {
  // Prefer the ref (survives the in-flight re-render that resets the select to
  // DEFAULT); fall back to the live select / DEFAULT when the user never picked.
  const selectedHour = hourRef.hour ?? readSelectedDigestHour();
  try {
    await setEmailChannel(options.accountEmail, options.accountUserId, signal);
    // Channel registration and rule attachment are separate server mutations.
    // Never infer the second from a failed/stale read: refresh after the row
    // exists, then build the delta from the authoritative current-variant rule.
    const fresh = await readActivationContextStrict(options.accountUserId, signal);
    const payload = buildBriefDigestPayload(fresh.config, selectedHour, browserTimezone());
    if (!payload) return 'verified';
    const channels = fresh.channels.includes('email')
      ? [...fresh.channels]
      : [...fresh.channels, 'email'];
    await setNotificationConfig({
      variant: SITE_VARIANT,
      ...payload,
      channels: channels as ChannelType[],
    }, options.accountUserId, signal);
    return isFlowAccountCurrent(options) ? 'verified' : 'failed';
  } catch (err) {
    console.warn('[pro-activation] brief confirm failed', err);
    reportActivationStepFailure(options, 'brief', 'brief-confirm', err);
    return 'failed';
  }
}

/** Alerts confirm: request+subscribe push, then ensure a rule delivers to it. */
async function confirmAlerts(
  options: ProActivationFlowOptions,
  signal?: AbortSignal,
): Promise<ActivationConfirmResult> {
  try {
    // Requests permission, subscribes, and registers the web_push channel.
    // A denial throws here (AE3: the flow continues, nothing enabled).
    await subscribeToPush(options.accountUserId);
  } catch (err) {
    console.warn('[pro-activation] push subscribe declined/failed', err);
    // Read the LIVE permission rather than the thrown message: once it is
    // `denied` no browser re-prompts, so the step is blocked, not retryable.
    // A dismissed prompt leaves it `default` and stays a retryable failure.
    const permission = getPushPermission();
    // #5600: only granted-then-failed is a real error. `denied` routes to the
    // blocked state below and `default` (prompt dismissed) is a user outcome —
    // reporting either would bury real failures under permission noise.
    if (shouldReportPushSubscribeFailure(permission)) {
      reportActivationStepFailure(options, 'alerts', 'push-subscribe', err);
    }
    if (permission === 'denied') return 'blocked';
    // The permission is still `default`: the user dismissed the prompt without
    // deciding. A retry re-prompts, so the UI keeps the retryable failed state —
    // but this must not reach the step-failed metric, which exists to surface OUR
    // writes erroring. Returning 'failed' for it is what routed the most common
    // alerts-step outcome into that metric. Only a granted-then-failed subscribe
    // is a genuine failure — the same line shouldReportPushSubscribeFailure
    // already draws for Sentry, reused here so the two cannot drift apart.
    return shouldReportPushSubscribeFailure(permission) ? 'failed' : 'declined';
  }
  let fresh: ActivationContext;
  try {
    // A registered push row is not delivery until the current-variant rule
    // includes it. If the authoritative read fails, leave the step retryable.
    fresh = await readActivationContextStrict(options.accountUserId, signal);
  } catch (err) {
    console.warn('[pro-activation] alerts config refresh failed', err);
    reportActivationStepFailure(options, 'alerts', 'alerts-config-refresh', err);
    return 'failed';
  }
  const payload = buildCriticalAlertsPayload(fresh.channels, fresh.hasEnabledRule);
  try {
    await setNotificationConfig({
      variant: SITE_VARIANT,
      enabled: payload.enabled,
      ...(payload.sensitivity ? { sensitivity: payload.sensitivity } : {}),
      channels: payload.channels as ChannelType[],
    }, options.accountUserId, signal);
    return isFlowAccountCurrent(options) ? 'verified' : 'failed';
  } catch (err) {
    console.warn('[pro-activation] alerts rule write failed', err);
    reportActivationStepFailure(options, 'alerts', 'alerts-rule-write', err);
    return 'failed';
  }
}

async function confirmPresentationWithRetry(
  options: ProActivationFlowOptions,
  dependencies: ProActivationFlowDependencies,
): Promise<boolean> {
  if (!options.expectedActivationKey || !options.activationClaimNonce) return false;
  for (let attempt = 0; attempt <= PRESENTATION_CONFIRM_RETRY_DELAYS_MS.length; attempt += 1) {
    if (!isFlowAccountCurrent(options)) return false;
    try {
      return await withTimeout(
        dependencies.confirmPresentation(
          options.expectedActivationKey,
          options.activationClaimNonce,
        ),
        dependencies.operationTimeoutMs ?? ACTIVATION_MUTATION_TIMEOUT_MS,
        'activation-confirm-presentation',
      );
    } catch (error) {
      const delay = PRESENTATION_CONFIRM_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) {
        console.warn('[pro-activation] failed to confirm presentation', error);
        return false;
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
    }
  }
  return false;
}

function reportActivationPersistenceFailure(
  error: unknown,
  action: 'openDay0Presentation' | 'recordOutcome',
  extra?: Record<string, unknown>,
): void {
  // The activation ledger exists to remove a server-side observability blind
  // spot, so its terminal write failures cannot stop at the user's console.
  // Keep Sentry lazy (like the finish-setup chip) so this component retains no
  // static bootstrap dependency, and never surface telemetry failure to the UI.
  void import('@/bootstrap/sentry-defer')
    .then((m) => m.enqueueSentryCall((s) => s.captureException(
      error instanceof Error ? error : new Error(String(error)),
      {
        tags: { component: 'pro-activation', action },
        ...(extra ? { extra } : {}),
      },
    )))
    .catch(() => {});
}

async function openDay0PresentationWithRetry(
  options: ProActivationFlowOptions,
  dependencies: ProActivationFlowDependencies,
): Promise<boolean> {
  const activationKey = options.expectedActivationKey;
  const claimNonce = options.activationClaimNonce;
  const sessionStartedAt = options.activationSessionStartedAt;
  if (!activationKey || !claimNonce || sessionStartedAt === undefined) return false;

  for (let attempt = 0; ; attempt += 1) {
    if (!isFlowAccountCurrent(options)) return false;
    try {
      const status = await dependencies.openDay0Presentation(
        activationKey,
        claimNonce,
        sessionStartedAt,
      );
      // Every server refusal is authoritative and terminal. Only a rejected
      // request is eligible for transport retry.
      return status === 'opened';
    } catch (error) {
      // A late rejection must not keep retrying or report against an account
      // that is no longer active in this browser.
      if (!isFlowAccountCurrent(options)) return false;
      const delay = DAY0_OPEN_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) {
        console.warn('[pro-activation] failed to open day-0 activation record', error);
        reportActivationPersistenceFailure(error, 'openDay0Presentation');
        return false;
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
    }
  }
}

function persistActivationOutcomeWithRetry(
  options: ProActivationFlowOptions,
  dependencies: ProActivationFlowDependencies,
  results: readonly ActivationStepResult[],
  revision: number,
  finalized: boolean,
  /**
   * Day-0 only: resolves once the row these snapshots attach to exists. `false`
   * means the server refused it (ineligible, finalized, or superseded by a
   * newer session), so writing would be rejected anyway — skip quietly.
   */
  day0RowReady?: Promise<boolean>,
): void {
  if (!options.expectedActivationKey || !options.activationClaimNonce) {
    return;
  }
  const cohort = options.onlyIfUnactivated ? undefined : ('day0' as const);
  const buckets = buildActivationOutcomeBuckets(results);
  void (async () => {
    if (day0RowReady && !(await day0RowReady)) return;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await withTimeout(
          dependencies.recordOutcome(
            options.expectedActivationKey!,
            options.activationClaimNonce!,
            {
              ...(cohort ? { cohort } : {}),
              confirmedSteps: [...buckets.confirmedSteps],
              skippedSteps: [...buckets.skippedSteps],
              blockedSteps: [...buckets.blockedSteps],
              failedSteps: [...buckets.failedSteps],
              revision,
              finalized,
            },
          ),
          dependencies.operationTimeoutMs ?? ACTIVATION_MUTATION_TIMEOUT_MS,
          'activation-record-outcome',
        );
        return;
      } catch (error) {
        const delay = OUTCOME_WRITE_RETRY_DELAYS_MS[attempt];
        if (delay === undefined) {
          console.warn('[pro-activation] failed to record activation outcome', error);
          reportActivationPersistenceFailure(error, 'recordOutcome', { revision, finalized });
          return;
        }
        await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
      }
    }
  })();
}

/**
 * Open the full Pro-activation flow: read the subscriber's config, build the
 * ordered steps, wire the real per-step handlers, and on exit decide the
 * finish-setup chip. Safe to await; opens exactly one interstitial.
 */
export async function openProActivationFlow(
  options: ProActivationFlowOptions,
  injected: Partial<ProActivationFlowDependencies> = {},
): Promise<'opened' | 'not-eligible' | 'retry'> {
  const dependencies: ProActivationFlowDependencies = {
    readContext: (expectedUserId, strict) =>
      strict
        ? readActivationContextStrict(expectedUserId)
        : readActivationContext(expectedUserId),
    claimPresentation: claimProActivationPresentation,
    confirmPresentation: confirmProActivationPresentation,
    openDay0Presentation: openProActivationDay0Presentation,
    recordOutcome: recordProActivationOutcome,
    openInterstitial: openProActivationInterstitial,
    ...injected,
  };
  if (!isFlowAccountCurrent(options)) return 'retry';
  let ctx: ActivationContext;
  try {
    ctx = await dependencies.readContext(
      options.accountUserId,
      options.onlyIfUnactivated === true,
    );
  } catch {
    // Markerless backfill must never turn a failed read into a fabricated
    // "nothing activated" snapshot. Retry on a later evaluation/boot.
    return 'retry';
  }
  if (!isFlowAccountCurrent(options)) return 'retry';
  if (
    options.onlyIfUnactivated &&
    hasAnyActivatedProFunctionality(ctx.config)
  ) {
    return 'not-eligible';
  }
  if (options.onlyIfUnactivated) {
    if (!options.expectedActivationKey || !options.activationClaimNonce) {
      return 'retry';
    }
    let claimStatus;
    try {
      claimStatus = await withTimeout(
        dependencies.claimPresentation(
          options.expectedActivationKey,
          options.activationClaimNonce,
        ),
        dependencies.operationTimeoutMs ?? ACTIVATION_MUTATION_TIMEOUT_MS,
        'activation-claim-presentation',
      );
    } catch {
      return 'retry';
    }
    if (!isFlowAccountCurrent(options)) return 'retry';
    if (claimStatus === 'already_claimed') {
      return 'retry';
    }
    if (claimStatus !== 'claimed') {
      return 'not-eligible';
    }
  }
  const steps = buildActivationSteps(ctx.capabilities, ctx.config);

  options.onEvent?.(ACTIVATION_EVENTS.entered);

  // Confirmed BEFORE the interstitial opens -- and therefore before its
  // onProgress/onExit handlers exist to fire a recordProActivationOutcome
  // write -- so a lost claim can never leave a presentedAt side effect from a
  // step the user was never actually given a chance to interact with. This
  // used to run after openInterstitial below; if a step got confirmed/skipped
  // in the window before this awaited call resolved and it then failed here,
  // recordProActivationOutcome's own presentedAt backfill had already fired,
  // permanently blocking a legitimate re-claim via
  // claimProActivationPresentation's already_presented check (review finding,
  // #5584/#5590).
  if (
    options.onlyIfUnactivated &&
    options.expectedActivationKey &&
    options.activationClaimNonce
  ) {
    if (!(await confirmPresentationWithRetry(options, dependencies))) {
      // A false result means this browser no longer owns the server claim;
      // repeated transport errors remain retryable under the short lease.
      return 'retry';
    }
  }

  // Day-0's counterpart (#5621). Deliberately NOT awaited and never able to
  // return 'retry': the post-checkout welcome must open even when Convex is
  // unreachable. The promise is handed to the outcome writer instead, so
  // snapshots queue behind the row they attach to rather than racing it, and
  // a refusal (ineligible / already finalized) silently drops them.
  const day0RowReady =
    !options.onlyIfUnactivated &&
    options.expectedActivationKey &&
    options.activationClaimNonce &&
    options.activationSessionStartedAt !== undefined
      ? openDay0PresentationWithRetry(options, dependencies)
      : undefined;
  if (day0RowReady) {
    // Observe availability within the normal mutation budget, but keep the raw
    // retry promise above as the durable readiness signal. `withTimeout`
    // cannot cancel its source promise, so a slow successful open can still
    // release snapshots queued behind it. The timeout is slow/pending
    // telemetry only; terminal rejection is reported by the retry loop once.
    void withTimeout(
      day0RowReady,
      dependencies.operationTimeoutMs ?? ACTIVATION_MUTATION_TIMEOUT_MS,
      'activation-open-day0-presentation',
    ).catch((error) => {
      console.warn('[pro-activation] day-0 activation record open is still pending', error);
    });
  }

  // Holds the brief step's delivery-hour pick across the shell's re-renders.
  const selectedHourRef: DigestHourRef = { hour: null };

  const stepExtras: Partial<Record<ActivationStepId, ProActivationStepExtra>> = {
    brief: buildBriefExtra(safeWorldBrief(), selectedHourRef),
    power: buildPowerExtra(options),
  };

  // Per-step re-entry guard: belt-and-suspenders on top of the shell disabling
  // the confirm button while in-flight (guard the handler itself against a
  // double-fire, e.g. a stray second click before the first await settles).
  const inFlight = new Set<ActivationStepId>();
  let outcomeRevision = 0;
  const persistOutcome = (results: readonly ActivationStepResult[], finalized: boolean): void => {
    outcomeRevision += 1;
    persistActivationOutcomeWithRetry(
      options,
      dependencies,
      results,
      outcomeRevision,
      finalized,
      day0RowReady,
    );
  };

  // Notification writes can pause for Retry-After. Tie that delay to this
  // interstitial's lifetime so an account switch, replacement flow, or close
  // cannot wake up later and issue a second mutation from a stale wizard.
  flowAbortController?.abort();
  flowAbortController = null;
  const activationController = new AbortController();

  dependencies.openInterstitial({
    steps,
    accountEmail: options.accountEmail,
    stepExtras,
    onConfirmStep: async (stepId) => {
      // A double-fire is not an attempt — return without telemetry so the
      // re-entry guard never inflates either counter.
      if (inFlight.has(stepId)) return 'failed';
      inFlight.add(stepId);
      try {
        const result =
          stepId === 'brief'
            ? await confirmBrief(options, selectedHourRef, activationController.signal)
            : stepId === 'alerts'
              ? await confirmAlerts(options, activationController.signal)
              : 'verified';
        // Attempt-level outcome: one event per real confirm, so a step the
        // user retries is visible as N failures rather than a single terminal
        // state inferred from the exit summary (#5600). Routed through the
        // leaf's selectStepEvent so the outcome -> event mapping has exactly
        // one definition (a parallel inline ternary here would let the unit
        // test stay green while this wiring regressed).
        //
        // `blocked` maps to no event here — the shell fires stepBlocked through
        // onBlockStep (#5609). selectConfirmOutcome owns that decision so it is
        // unit-pinned rather than living as an inline condition.
        //
        // An account switch mid-confirm makes confirmBrief/confirmAlerts return
        // 'failed' for a write that actually succeeded. That is flow teardown,
        // not a step failure — counting it would inflate the same metric.
        const outcome = selectConfirmOutcome(result);
        if (outcome && isFlowAccountCurrent(options)) {
          const stepEvent = selectStepEvent(outcome);
          if (stepEvent) options.onEvent?.(stepEvent, stepId);
        }
        return result;
      } finally {
        inFlight.delete(stepId);
      }
    },
    onSkipStep: (stepId) => {
      const skipEvent = selectStepEvent('skipped');
      if (skipEvent) options.onEvent?.(skipEvent, stepId);
    },
    onBlockStep: (stepId) => options.onEvent?.(ACTIVATION_EVENTS.stepBlocked, stepId),
    onProgress: (results) => persistOutcome(results, false),
    onExit: (results) => {
      activationController.abort();
      if (flowAbortController === activationController) flowAbortController = null;
      options.onEvent?.(ACTIVATION_EVENTS.exit, undefined, summarizeActivationExit(results));
      // Freeze the latest durable snapshot. Progress was already recorded as
      // steps resolved, so a tab close before this best-effort write cannot
      // erase engagement from the cohort.
      persistOutcome(results, true);
      // Chip decision + all localStorage live in the chip module (lazy-imported
      // to keep this component ↔ chip pair free of a static import cycle).
      void import('@/components/ProActivationChip')
        .then((m) => m.showFinishSetupChipForResults(options, results))
        .catch((err) => console.warn('[pro-activation] finish-setup chip failed to load', err));
    },
  });
  if (!activationController.signal.aborted) {
    flowAbortController = activationController;
  }
  flowAccountUnsubscribe = subscribeAuthState(() => {
    if (isFlowAccountCurrent(options)) return;
    // subscribeAuthState emits synchronously before returning its unsubscribe.
    // Defer removal so closeProActivationInterstitial can tear the listener
    // down as well, and never leave user A's email visible to user B.
    queueMicrotask(() => {
      if (!isFlowAccountCurrent(options)) closeProActivationInterstitial();
    });
  });
  return 'opened';
}
