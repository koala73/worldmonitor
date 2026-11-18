/**
 * The way back from Clerk's sign-up code card to sign-in.
 *
 * Strict enumeration protection hides whether an email has an account. An
 * existing account typed into sign-up therefore reaches the "Verify your email"
 * code card, no code is ever sent, and Clerk emails "sign in instead" without a
 * link. Clerk renders no footer action on that card, so the customer is stuck
 * there. This adds the missing "Already have an account? Sign in" action; each
 * app decides what Sign in does.
 *
 * Shared by the dashboard and /pro, which load Clerk separately.
 */

/** Clerk's class for the card of flow `signUp`, part `emailCode`. */
export const SIGN_UP_CODE_CARD_CLASS = 'cl-signUp-emailCode';
export const SIGN_UP_CODE_CARD_SELECTOR = `.${SIGN_UP_CODE_CARD_CLASS}`;

/** Clerk localization for that card's subtitle (`signUp.emailCode.subtitle`). */
export const SIGN_UP_CODE_SUBTITLE =
  'Enter the code sent to your email. No code after a minute? This email may already have an account: use Sign in below.';

const ESCAPE_ATTR = 'data-wm-sign-in-escape';

function buildEscape(doc: Document, onSignIn: () => void): HTMLElement {
  const row = doc.createElement('p');
  row.setAttribute(ESCAPE_ATTR, '');
  row.style.margin = '16px 0 0';
  row.style.textAlign = 'center';
  row.style.fontSize = '13px';
  row.append(doc.createTextNode('Already have an account? '));

  const button = doc.createElement('button');
  button.type = 'button';
  button.textContent = 'Sign in';
  button.style.background = 'none';
  button.style.border = '0';
  button.style.padding = '0';
  button.style.font = 'inherit';
  button.style.fontWeight = '600';
  button.style.color = 'inherit';
  button.style.textDecoration = 'underline';
  button.style.cursor = 'pointer';
  button.addEventListener('click', (event) => {
    event.preventDefault();
    onSignIn();
  });
  row.append(button);
  return row;
}

/**
 * Watch `doc` for Clerk's sign-up code card and add the Sign in action to it.
 * Returns a disposer that stops watching and removes every added action.
 */
export function installSignUpSignInEscape(doc: Document, onSignIn: () => void): () => void {
  // Live collection: the dashboard mutates its DOM constantly, and an empty
  // collection makes each mutation batch a length check.
  const cards = doc.getElementsByClassName(SIGN_UP_CODE_CARD_CLASS);
  const decorate = (): void => {
    for (const card of Array.from(cards)) {
      // Clerk also puts the class on an ancestor of the card. Only the
      // innermost match is the card; decorating both renders a second row.
      if (card.getElementsByClassName(SIGN_UP_CODE_CARD_CLASS).length > 0) continue;
      if (!card.querySelector(`[${ESCAPE_ATTR}]`)) card.append(buildEscape(doc, onSignIn));
    }
  };
  const observer = new MutationObserver(decorate);
  observer.observe(doc.documentElement, { childList: true, subtree: true });
  decorate();
  return () => {
    observer.disconnect();
    for (const row of doc.querySelectorAll(`[${ESCAPE_ATTR}]`)) row.remove();
  };
}

/** Clerk's auth surfaces; reopening sign-in waits until none is mounted. */
const CLERK_AUTH_SURFACE_SELECTOR = '.cl-signUp-root, .cl-signIn-root, .cl-modalBackdrop';
/** Upper bound on that wait, so Sign in always opens. */
export const SIGN_IN_REOPEN_MAX_WAIT_MS = 2_000;

export interface SignInSwitchDeps {
  readonly authSurfaceMounted: () => boolean;
  readonly now: () => number;
  readonly nextFrame: (cb: () => void) => void;
}

function defaultSwitchDeps(): SignInSwitchDeps {
  return {
    authSurfaceMounted: () => document.querySelector(CLERK_AUTH_SURFACE_SELECTOR) !== null,
    now: () => performance.now(),
    nextFrame: (cb) => { requestAnimationFrame(() => cb()); },
  };
}

/**
 * Close Clerk's sign-up and run `open` (which opens sign-in) once it is gone.
 *
 * Sign-up is either its own modal or a route inside the sign-in modal (its
 * footer link), so both are closed. Clerk ignores openSignIn while that modal
 * is still mounted: on production a fixed next-task reopen failed every run
 * under 6x CPU throttling, while waiting for the unmount passed every run
 * (about 50-85 ms).
 */
export function switchSignUpToSignIn(
  clerk: { closeSignUp: () => void; closeSignIn: () => void },
  open: () => void,
  deps: SignInSwitchDeps = defaultSwitchDeps(),
): void {
  clerk.closeSignUp();
  clerk.closeSignIn();
  const startedAt = deps.now();
  const waitThenOpen = (): void => {
    if (deps.authSurfaceMounted() && deps.now() - startedAt < SIGN_IN_REOPEN_MAX_WAIT_MS) {
      deps.nextFrame(waitThenOpen);
      return;
    }
    open();
  };
  deps.nextFrame(waitThenOpen);
}
