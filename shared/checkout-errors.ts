/** Application failures safe to return across the public checkout boundary. */
const PUBLIC_CHECKOUT_ERRORS = new Set([
  'CHECKOUT_FAILED',
  'CHECKOUT_TIMED_OUT',
  'INVALID_CHECKOUT_PRODUCT',
  'Invalid returnUrl: must be a valid absolute URL',
  'Invalid returnUrl: must use a trusted worldmonitor.app origin',
]);

export function publicCheckoutError(value: unknown): string {
  return typeof value === 'string' && PUBLIC_CHECKOUT_ERRORS.has(value)
    ? value
    : 'CHECKOUT_FAILED';
}
