import { subscribeAuthState, type AuthSession } from '@/services/auth-state';
import { mountUserButton, openSignIn } from '@/services/clerk';
import { t } from '@/services/i18n';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';

export class AuthHeaderWidget {
  private container: HTMLElement;
  private unsubscribeAuth: (() => void) | null = null;
  private unmountUserButton: (() => void) | null = null;
  private onSignInClick?: () => void;
  private onSettingsClick?: () => void;
  private onBillingClick?: () => void;

  constructor(
    onSignInClick?: () => void,
    onSettingsClick?: () => void,
    onBillingClick?: () => void,
  ) {
    this.onSignInClick = onSignInClick;
    this.onSettingsClick = onSettingsClick;
    this.onBillingClick = onBillingClick;
    this.container = document.createElement('div');
    this.container.className = 'auth-header-widget';

    this.unsubscribeAuth = subscribeAuthState((state: AuthSession) => {
      if (state.isPending) {
        this.renderPending();
        return;
      }
      this.render(state);
    });
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    this.unmountUserButton?.();
    this.unmountUserButton = null;
    if (this.unsubscribeAuth) {
      this.unsubscribeAuth();
      this.unsubscribeAuth = null;
    }
  }

  private render(state: AuthSession): void {
    this.unmountUserButton?.();
    this.unmountUserButton = null;
    this.container.classList.remove('auth-header-widget-pending');
    this.container.removeAttribute('aria-busy');
    setTrustedHtml(this.container, trustedHtml('', 'legacy direct innerHTML migration'));

    if (!state.user) {
      this.renderSignedOut();
      return;
    }
    this.renderSignedIn();
  }

  private renderPending(): void {
    this.unmountUserButton?.();
    this.unmountUserButton = null;
    this.container.classList.add('auth-header-widget-pending');
    this.container.setAttribute('aria-busy', 'true');
    setTrustedHtml(this.container, trustedHtml('', 'legacy direct innerHTML migration'));

    const reasonSkeleton = document.createElement('span');
    reasonSkeleton.className = 'auth-header-skeleton auth-header-skeleton-reason';
    reasonSkeleton.setAttribute('aria-hidden', 'true');
    this.container.appendChild(reasonSkeleton);

    const signInSkeleton = document.createElement('span');
    signInSkeleton.className = 'auth-header-skeleton auth-header-skeleton-signin';
    signInSkeleton.setAttribute('aria-hidden', 'true');
    this.container.appendChild(signInSkeleton);
  }

  private renderSignedOut(): void {
    // One header account action (#10464): keep Sign In, fold Create account into
    // Clerk's withSignUp sign-in flow, and show why a free account is worth it.
    const freeReason = document.createElement('span');
    freeReason.className = 'auth-free-reason';
    freeReason.textContent = t('auth.freeReason');
    freeReason.title = freeReason.textContent;
    this.container.appendChild(freeReason);

    const signInBtn = document.createElement('button');
    signInBtn.className = 'auth-signin-btn';
    signInBtn.textContent = t('auth.signIn');
    signInBtn.addEventListener('click', () => {
      if (this.onSignInClick) this.onSignInClick();
      else openSignIn();
    });
    this.container.appendChild(signInBtn);
  }

  private renderSignedIn(): void {
    const userBtnEl = document.createElement('div');
    userBtnEl.className = 'auth-clerk-user-button';
    this.container.appendChild(userBtnEl);
    this.unmountUserButton = mountUserButton(userBtnEl, {
      onBillingClick: this.onBillingClick,
      onSettingsClick: this.onSettingsClick,
    });
  }
}
