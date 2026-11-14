import { trackGithubStarPrompt } from '@/services/analytics';
import { getAuthState } from '@/services/auth-state';
import { openExternalUrl } from '@/services/external-navigation';
import {
  canPersistStarPromptDismissal,
  GITHUB_STAR_REPO_URL,
  markStarPromptDismissed,
  readStarPromptDismissed,
  STAR_PROMPT_IDLE_MS,
  type StarPromptStorage,
} from '@/services/github-star-prompt-state';
import { t } from '@/services/i18n';
import { hasPremiumAccess } from '@/services/panel-gating';
import { isProTierResolved } from '@/services/widget-store';
import { isModalOpen } from '@/utils/open-modal';

/**
 * Shows the ask-once GitHub star toast after the user has gone idle.
 *
 * Loaded on demand: the boot gate in panel-layout fetches this chunk only once
 * `decideStarPrompt` says `ask`. Everything it re-checks here can change during
 * the idle wait — another tab can dismiss, entitlement can arrive, a modal or
 * another toast can open.
 */

// User-driven input starts with one of these; touch fires pointerdown.
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'focus'] as const;
// Elevated notifications that sit in the same top-right corner.
const COMPETING_TOAST_SELECTOR = '.update-toast, .passkey-offer-prompt';

export type StarPromptShowCheck = 'show' | 'dismissed' | 'premium' | 'tier-unresolved' | 'busy';

export interface StarPromptShowInput {
  dismissed: boolean | null;
  premium: boolean;
  /** Auth still loading, or signed in with no entitlement snapshot yet. */
  tierUnresolved: boolean;
  /** A modal, the passkey card, or another toast is on screen. */
  busy: boolean;
}

/** The final gate after the idle wait. `busy` waits for the next idle; the rest end this page life. */
export function checkStarPromptShow(input: StarPromptShowInput): StarPromptShowCheck {
  if (input.dismissed !== false) return 'dismissed';
  if (input.premium) return 'premium';
  // Entitlement is not known yet; a paying user could be pitched. Try next visit.
  if (input.tierUnresolved) return 'tier-unresolved';
  if (input.busy) return 'busy';
  return 'show';
}

const STAR_ICON_PATH = 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z';

export class GitHubStarPromptController {
  private readonly storage: StarPromptStorage | null;
  private readonly premiumHint: () => boolean;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private toast: HTMLElement | null = null;
  private destroyed = false;

  constructor(storage: StarPromptStorage | null, premiumHint: () => boolean) {
    this.storage = storage;
    this.premiumHint = premiumHint;
  }

  start(): void {
    this.waitForIdle();
  }

  destroy(): void {
    this.destroyed = true;
    this.stopListening();
    this.toast?.remove();
    this.toast = null;
  }

  private readonly restartIdle = (): void => {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(this.onIdle, STAR_PROMPT_IDLE_MS);
  };

  private waitForIdle(): void {
    for (const type of ACTIVITY_EVENTS) {
      window.addEventListener(type, this.restartIdle, { capture: true, passive: true });
    }
    this.restartIdle();
  }

  private stopListening(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    for (const type of ACTIVITY_EVENTS) {
      window.removeEventListener(type, this.restartIdle, true);
    }
  }

  private readonly onIdle = (): void => {
    this.idleTimer = null;
    if (this.destroyed) return;
    // Input in another app or an embedded frame never reaches us; the next focus restarts the wait.
    if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
    if (document.activeElement?.matches('iframe, webview')) return;

    const check = checkStarPromptShow({
      dismissed: readStarPromptDismissed(this.storage),
      premium: hasPremiumAccess(getAuthState()) || this.premiumHint(),
      // Settled auth is not settled entitlement: a signed-in subscriber has no
      // verdict until the entitlement snapshot arrives.
      tierUnresolved: !isProTierResolved(),
      busy: isModalOpen(document) || document.querySelector(COMPETING_TOAST_SELECTOR) !== null,
    });
    if (check === 'busy') {
      this.restartIdle();
      return;
    }
    this.stopListening();
    // Last gate: a dismissal must be able to stick, or the ask would repeat.
    if (check === 'show' && canPersistStarPromptDismissal(this.storage)) this.show();
  };

  private show(): void {
    const toast = document.createElement('div');
    toast.className = 'update-toast github-star-prompt';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');

    const icon = document.createElement('div');
    icon.className = 'update-toast-icon github-star-prompt-icon';
    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(svgNs, 'path');
    path.setAttribute('d', STAR_ICON_PATH);
    svg.append(path);
    icon.append(svg);

    const body = document.createElement('div');
    body.className = 'update-toast-body';
    const title = document.createElement('div');
    title.className = 'update-toast-title';
    title.textContent = t('components.githubStarPrompt.title');
    const detail = document.createElement('div');
    detail.className = 'update-toast-detail';
    detail.textContent = t('components.githubStarPrompt.body');
    body.append(title, detail);

    const star = document.createElement('button');
    star.type = 'button';
    star.className = 'update-toast-action';
    star.textContent = t('components.githubStarPrompt.star');
    star.addEventListener('click', () => {
      // The dismissal is permanent on click; `starred` is recorded only once
      // GitHub actually opened, so a blocked popup never counts as a star.
      this.close(null);
      // Never navigate the dashboard away if the popup is blocked.
      void openExternalUrl(GITHUB_STAR_REPO_URL, null, { sameTabFallback: false })
        .then((outcome) => { if (outcome !== 'failed') trackGithubStarPrompt('starred'); })
        .catch(() => { /* open failed: no event */ });
    });

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'update-toast-dismiss';
    dismiss.setAttribute('aria-label', t('components.githubStarPrompt.dismiss'));
    dismiss.textContent = '×';
    dismiss.addEventListener('click', () => this.close('dismissed'));

    toast.append(icon, body, star, dismiss);
    document.body.appendChild(toast);
    this.toast = toast;
    // Next frame, so the opacity/transform transition runs from the hidden state.
    requestAnimationFrame(() => toast.classList.add('visible'));
    trackGithubStarPrompt('shown');
  }

  private close(outcome: 'dismissed' | null): void {
    // Every close path is permanent, including the Star button.
    markStarPromptDismissed(this.storage);
    if (outcome) trackGithubStarPrompt(outcome);
    this.toast?.remove();
    this.toast = null;
  }
}
