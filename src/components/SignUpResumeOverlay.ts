/**
 * WM-owned dialog chrome around Clerk's mounted SignUp on a resumed attempt.
 *
 * Clerk's HashRouter reads `location.hash` at mount, so the hash is written
 * before `mount` and stripped after `unmount`; a later reload never carries a
 * stale route. The dashboard keeps its state in the query string, which both
 * `replaceState` calls preserve. Completion is Clerk's own navigation to
 * `fallbackRedirectUrl`, a full page load the overlay never sees.
 */

import { mountSignUpInto, unmountSignUpFrom } from '@/services/clerk';
import { t } from '@/services/i18n';
import type { ResumeSurface } from '@/services/sign-up-resume';
import { createFocusTrap } from '@/utils/focus-trap';
import { declareOverlay } from '@/utils/open-modal';

export const SIGN_UP_VERIFY_HASH = '#/verify-email-address';

export interface SignUpResumeMountProps {
  readonly routing: 'hash';
  readonly fallbackRedirectUrl: string;
}

export interface SignUpResumeOverlayDeps {
  readonly document: Document;
  readonly history: Pick<History, 'replaceState' | 'state'>;
  readonly location: Pick<Location, 'href'>;
  readonly mount: (host: HTMLDivElement, props: SignUpResumeMountProps) => void;
  readonly unmount: (host: HTMLDivElement) => void;
}

export function urlWithHash(href: string, hash: string): string {
  const url = new URL(href);
  url.hash = hash;
  return url.href;
}

export function urlWithoutHash(href: string): string {
  const url = new URL(href);
  url.hash = '';
  return url.href;
}

export function createSignUpResumeOverlay(overrides: Partial<SignUpResumeOverlayDeps> = {}): ResumeSurface {
  const deps: SignUpResumeOverlayDeps = {
    document,
    history: window.history,
    location: window.location,
    mount: mountSignUpInto,
    unmount: unmountSignUpFrom,
    ...overrides,
  };

  const el = deps.document.createElement('div');
  el.className = 'modal-overlay signup-resume-overlay';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', t('auth.createAccount'));
  // Not 'safe' even though a reload now re-resumes: the flow ends in Clerk's
  // completion navigation, so a deferred reload heals inside the flow, and
  // 'blocking' spares the user a card that vanishes mid-keystroke.
  declareOverlay(el, { reload: 'blocking' });

  const card = deps.document.createElement('div');
  card.className = 'modal signup-resume-modal';
  const closeButton = deps.document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'modal-close signup-resume-close';
  closeButton.setAttribute('aria-label', t('common.close'));
  closeButton.textContent = '✕';
  const host = deps.document.createElement('div');
  host.className = 'signup-resume-host';
  card.append(closeButton, host);
  el.append(card);

  let onDismiss: (() => void) | null = null;
  const focusTrap = createFocusTrap(el, { onEscape: () => dismiss(), initialFocus: closeButton });

  const close = (): void => {
    if (!el.isConnected) return;
    onDismiss = null;
    deps.unmount(host);
    focusTrap.deactivate();
    el.classList.remove('active');
    el.remove();
    deps.history.replaceState(deps.history.state, '', urlWithoutHash(deps.location.href));
  };

  const dismiss = (): void => {
    const notify = onDismiss;
    close();
    notify?.();
  };

  closeButton.addEventListener('click', dismiss);
  el.addEventListener('click', (event) => {
    if (event.target === el) dismiss();
  });

  return {
    open(_attempt, handleDismiss) {
      if (el.isConnected) return;
      onDismiss = handleDismiss;
      deps.history.replaceState(deps.history.state, '', urlWithHash(deps.location.href, SIGN_UP_VERIFY_HASH));
      deps.document.body.appendChild(el);
      el.classList.add('active');
      deps.mount(host, { routing: 'hash', fallbackRedirectUrl: urlWithoutHash(deps.location.href) });
      focusTrap.activate();
    },
    close,
    isOpen: () => el.isConnected,
  };
}
