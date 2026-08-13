/**
 * Applies a dedicated build's variant before the first stylesheet paint.
 *
 * The public web deployment is deliberately left on the runtime hostname
 * branch in index.html. Dedicated builds (desktop and the variant E2E builds)
 * cannot rely on that hostname, so they replace the complete conditional
 * rather than only its `if` arm. Replacing only the arm leaves a dangling
 * `else`, which turns the critical pre-paint script into invalid JavaScript.
 */
const RUNTIME_VARIANT_ASSIGNMENT = 'if(v)document.documentElement.dataset.variant=v;else document.documentElement.removeAttribute(\'data-variant\');';

export function applyBuildVariantToPrepaint(html: string, activeVariant: string): string {
  if (activeVariant === 'full') return html;
  // htmlVariantPlugin intentionally runs for every HTML route, including the
  // map harness used as Playwright's web-server readiness probe. Only the
  // dashboard document owns this pre-paint bootstrap.
  if (!html.includes('<script data-wm-prepaint')) return html;

  const replacement = `v=${JSON.stringify(activeVariant)};document.documentElement.dataset.variant=v;`;
  // Vite can run HTML transforms more than once for a dev-server response.
  // A second pass over this dedicated build is already correct and must not
  // treat the intentionally consumed runtime branch as markup drift.
  if (html.includes(replacement)) return html;
  if (!html.includes(RUNTIME_VARIANT_ASSIGNMENT)) {
    throw new Error('[vite] pre-paint variant assignment anchor is missing from index.html');
  }

  return html.replace(RUNTIME_VARIANT_ASSIGNMENT, replacement);
}
