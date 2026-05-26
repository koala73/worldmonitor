import { subscribeAuthState, type AuthSession } from '@/services/auth-state';
import { mountUserButton, openSignIn, openSignUp } from '@/services/clerk';
import { t } from '@/services/i18n';

export class AuthHeaderWidget {
  private container: HTMLElement;
  private unsubscribeAuth: (() => void) | null = null;
  private unmountUserButton: (() => void) | null = null;
  private onSignInClick?: () => void;
  private onSettingsClick?: () => void;

  constructor(onSignInClick?: () => void, onSettingsClick?: () => void) {
    this.onSignInClick = onSignInClick;
    this.onSettingsClick = onSettingsClick;
    this.container = document.createElement('div');
    this.container.className = 'auth-header-widget';

    this.unsubscribeAuth = subscribeAuthState((state: AuthSession) => {
      if (state.isPending) {
        this.container.innerHTML = '';
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
    this.container.innerHTML = '';

    if (!state.user) {
      this.renderSignedOut();
      return;
    }
    this.renderSignedIn();
  }

  private renderSignedOut(): void {
    const signInBtn = document.createElement('button');
    signInBtn.className = 'auth-signin-btn';
    signInBtn.textContent = t('auth.signIn');
    signInBtn.addEventListener('click', () => {
      if (this.onSignInClick) this.onSignInClick();
      else openSignIn();
    });
    this.container.appendChild(signInBtn);

    const signUpLink = document.createElement('button');
    signUpLink.className = 'auth-signup-link';
    signUpLink.textContent = t('auth.createAccount');
    signUpLink.addEventListener('click', () => openSignUp());
    this.container.appendChild(signUpLink);
  }

  private renderSignedIn(): void {
    const userBtnEl = document.createElement('div');
    userBtnEl.className = 'auth-clerk-user-button';
    this.container.appendChild(userBtnEl);
    this.unmountUserButton = mountUserButton(userBtnEl);

    if (this.onSettingsClick) {
      const settingsBtn = document.createElement('button');
      settingsBtn.className = 'auth-settings-btn';
      settingsBtn.type = 'button';
      settingsBtn.setAttribute('aria-label', t('auth.settings'));
      settingsBtn.title = t('auth.settings');
      settingsBtn.innerHTML = SETTINGS_ICON;
      settingsBtn.addEventListener('click', () => this.onSettingsClick?.());
      this.container.appendChild(settingsBtn);
    }
  }
}

const SETTINGS_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
