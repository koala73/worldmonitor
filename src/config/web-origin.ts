/**
 * Canonical https origin of the WorldMonitor web app.
 *
 * The desktop WebView serves the dashboard from `tauri://localhost` (or
 * `https://localhost:<port>` under `desktop:dev`), so a relative link to a
 * web-only surface — pricing, the billing portal, a payment-provider return
 * URL — resolves against an origin that hosts none of those routes and
 * dead-ends the user. Every desktop-reachable link into the web app must be
 * absolute against this constant.
 *
 * Dependency-free on purpose: consumers span `config`, `services`,
 * `components` and `utils`, and the checkout-return builders are unit-tested
 * without the browser service graph.
 */
export const WEB_APP_ORIGIN = 'https://worldmonitor.app';
