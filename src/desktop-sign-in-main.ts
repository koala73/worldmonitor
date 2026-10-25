/**
 * www /desktop-sign-in bootstrap. The flow logic lives in
 * services/desktop-sign-in-page.ts; this file wires it to the DOM and Clerk.
 */

import { getClerk, getClerkToken, getCurrentClerkUser, initClerk, openSignIn, subscribeClerk } from '@/services/clerk';
import { resolveLaunch, runDesktopSignInContinue, type LaunchStorage } from '@/services/desktop-sign-in-page';
import { safeStorageGet } from '@/utils/safe-storage';

if (safeStorageGet('worldmonitor-theme') === 'light') document.documentElement.dataset.theme = 'light';

const sessionStore: LaunchStorage = {
  get: (key) => { try { return sessionStorage.getItem(key); } catch { return null; } },
  set: (key, value) => { try { sessionStorage.setItem(key, value); } catch { /* best effort */ } },
  remove: (key) => { try { sessionStorage.removeItem(key); } catch { /* best effort */ } },
};

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} missing`);
  return node;
}

function show(id: 'loading' | 'invalid' | 'signedOut' | 'confirm' | 'done'): void {
  for (const section of ['loading', 'invalid', 'signedOut', 'confirm', 'done']) {
    el(section).hidden = section !== id;
  }
}

const { launch, clearHash } = resolveLaunch(location.hash, sessionStore);
if (clearHash) history.replaceState(null, '', location.pathname);

function render(): void {
  if (!launch) {
    show('invalid');
    return;
  }
  const user = getCurrentClerkUser();
  if (!user) {
    show('signedOut');
    return;
  }
  el('account').textContent = user.email || user.name;
  show('confirm');
}

async function boot(): Promise<void> {
  if (!launch) {
    show('invalid');
    return;
  }
  try {
    await initClerk();
  } catch {
    show('signedOut');
    return;
  }
  subscribeClerk(render);
  render();
  if (!getCurrentClerkUser()) openSignIn();
}

el('signInButton').addEventListener('click', () => openSignIn());

el('switchButton').addEventListener('click', () => {
  // Stay on this page: the launch is in session storage.
  void getClerk()?.signOut({ redirectUrl: location.pathname }).then(() => openSignIn());
});

el('continueButton').addEventListener('click', async () => {
  if (!launch) return;
  const button = el('continueButton') as HTMLButtonElement;
  const error = el('error');
  button.disabled = true;
  error.hidden = true;
  try {
    const outcome = await runDesktopSignInContinue(launch, {
      getToken: getClerkToken,
      fetch: (url, init) => fetch(url, init),
      navigate: (url) => location.assign(url),
      storage: sessionStore,
    });
    if (outcome.kind === 'redirected') {
      show('done');
      return;
    }
    if (outcome.kind === 'signed_out' || (outcome.kind === 'failed' && outcome.status === 401)) {
      openSignIn();
    } else {
      error.textContent = outcome.kind === 'failed' && outcome.status === 429
        ? 'Too many attempts. Wait a few minutes, then try again.'
        : 'Could not reach World Monitor. Try again in a moment.';
      error.hidden = false;
    }
  } catch {
    error.textContent = 'Could not reach World Monitor. Try again in a moment.';
    error.hidden = false;
  }
  button.disabled = false;
});

void boot();
