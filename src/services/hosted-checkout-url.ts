/**
 * Open-redirect guard for Dodo redirect-mode checkout (#4449).
 *
 * Redirect mode navigates the top window to the server-provided
 * `checkout_url` (`window.location.assign`). This validates that URL first so
 * a compromised or unexpected checkout response can never navigate the buyer
 * to a `javascript:` URL, an `http:` downgrade, or a third-party host — only
 * Dodo's hosted-checkout origins over HTTPS are allowed.
 *
 * Extracted to its own dependency-free module so it can be unit-tested without
 * pulling the full checkout service graph (browser globals, the Dodo SDK, etc.).
 */
export const HOSTED_CHECKOUT_HOSTS = new Set([
  'checkout.dodopayments.com',
  'test.checkout.dodopayments.com',
]);

export function safeHostedCheckoutUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return null;
    if (!HOSTED_CHECKOUT_HOSTS.has(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}
