const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const MAX_LOAD_ATTEMPTS = 3;

let loadAttempts = 0;
let pending: Promise<boolean> | null = null;

/**
 * Lazily inject the Turnstile challenge script. Resolves true once
 * window.turnstile is available, false when the load failed. A failed or
 * blocked request does NOT poison the page session: the attempt counter
 * (not an injected flag) gates retries, so the next trigger re-injects,
 * bounded at MAX_LOAD_ATTEMPTS. Injected scripts inherit trust under the
 * CSP's 'strict-dynamic'; the nonce covers browsers that predate it.
 */
export function ensureTurnstileScript(): Promise<boolean> {
  if (window.turnstile) return Promise.resolve(true);
  if (pending) return pending;
  if (loadAttempts >= MAX_LOAD_ATTEMPTS) return Promise.resolve(false);
  loadAttempts++;
  pending = new Promise<boolean>((settle) => {
    const script = document.createElement('script');
    script.src = TURNSTILE_SRC;
    script.async = true;
    script.nonce = 'wm-static-bootstrap';
    script.addEventListener('load', () => {
      pending = null;
      settle(true);
    }, { once: true });
    script.addEventListener('error', () => {
      script.remove();
      pending = null;
      settle(false);
    }, { once: true });
    document.head.appendChild(script);
  });
  return pending;
}
