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
  const decorateCard = (card: Element): void => {
    // Clerk also puts the class on an ancestor of the card. Only the innermost
    // match is the card; decorating both renders a second row.
    if (card.getElementsByClassName(SIGN_UP_CODE_CARD_CLASS).length > 0) return;
    if (!card.querySelector(`[${ESCAPE_ATTR}]`)) card.append(buildEscape(doc, onSignIn));
  };
  const decorateTree = (root: Element): void => {
    if (root.classList.contains(SIGN_UP_CODE_CARD_CLASS)) decorateCard(root);
    for (const card of root.getElementsByClassName(SIGN_UP_CODE_CARD_CLASS)) decorateCard(card);
  };
  // A card enters inside an added subtree, or by a class change on an element
  // already present. Clerk can also replace a mounted card's children, which
  // drops the row, so the nearest card around a child-list change is checked
  // again. Scanning only those keeps unrelated dashboard mutations from
  // walking the whole document.
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      const target = record.target;
      if (!(target instanceof Element)) continue;
      if (record.type === 'attributes') {
        if (target.classList.contains(SIGN_UP_CODE_CARD_CLASS)) decorateTree(target);
        // It left the code step: drop its own row, not a nested card's.
        else for (const row of target.querySelectorAll(`:scope > [${ESCAPE_ATTR}]`)) row.remove();
        continue;
      }
      const card = target.closest(SIGN_UP_CODE_CARD_SELECTOR);
      if (card) decorateCard(card);
      for (const node of record.addedNodes) {
        if (node instanceof Element) decorateTree(node);
      }
    }
  });
  observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  decorateTree(doc.documentElement);
  return () => {
    observer.disconnect();
    for (const row of doc.querySelectorAll(`[${ESCAPE_ATTR}]`)) row.remove();
  };
}

/** Clerk's auth surfaces; reopening sign-in waits until none is mounted. */
const CLERK_AUTH_SURFACE_SELECTOR = '.cl-signUp-root, .cl-signIn-root, .cl-modalBackdrop';
/** Upper bound on each wait (unmount, then sign-in mount), so the switch always ends. */
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

export interface SignUpToSignInSwitch {
  /** Close sign-up and run `open` (which opens sign-in) once it is gone. Ignored while a switch runs. */
  readonly run: (open: () => void) => void;
  /**
   * True from `run` until sign-in is on screen, or until the wait cap passes
   * after `open`. No Clerk form is mounted in that gap, so dismissal watchers
   * must not read it as a cancel.
   */
  readonly inFlight: () => boolean;
}

/**
 * Sign-up is either its own modal or a route inside the sign-in modal (its
 * footer link), so both are closed. Clerk ignores openSignIn while that modal
 * is still mounted: on production a fixed next-task reopen failed every run
 * under 6x CPU throttling, while waiting for the unmount passed every run
 * (about 50-85 ms).
 */
export function createSignUpToSignInSwitch(
  clerk: { closeSignUp: () => void; closeSignIn: () => void },
  deps: SignInSwitchDeps = defaultSwitchDeps(),
): SignUpToSignInSwitch {
  let running = false;
  const waitFor = (done: () => boolean, then: () => void): void => {
    const startedAt = deps.now();
    const poll = (): void => {
      if (!done() && deps.now() - startedAt < SIGN_IN_REOPEN_MAX_WAIT_MS) {
        deps.nextFrame(poll);
        return;
      }
      then();
    };
    deps.nextFrame(poll);
  };
  return {
    run(open) {
      if (running) return;
      running = true;
      clerk.closeSignUp();
      clerk.closeSignIn();
      waitFor(() => !deps.authSurfaceMounted(), () => {
        try {
          open();
        } catch (err) {
          running = false;
          throw err;
        }
        waitFor(deps.authSurfaceMounted, () => { running = false; });
      });
    },
    inFlight: () => running,
  };
}
