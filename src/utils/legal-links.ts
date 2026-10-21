/**
 * Legal-link and pre-payment-assent markup for the dashboard (#6976).
 *
 * The dashboard had no path to the Terms at all, and every upgrade CTA dropped
 * the user into Dodo's hosted checkout — where Dodo, as merchant of record,
 * shows *its* terms and never ours. Both gaps are fixed from here so the
 * sentence and the destinations exist once, not once per surface.
 *
 * Lives in `utils/`, not `components/`, because `services/notifications-settings`
 * renders a gate too and a services → components import is a backward edge
 * (`npm run lint:boundaries`). Deliberately dependency-light (one import,
 * `escapeHtml`), which also keeps it reachable from the `tsx --test` unit
 * profile, unlike the gate components that pull in `@/services/i18n` and its
 * `import.meta.glob`.
 *
 * Links are ABSOLUTE against the web origin. The docs live on worldmonitor.app
 * while the desktop build runs from a Tauri WebView origin, where a
 * root-relative `/docs/terms` resolves inside the app bundle and 404s.
 * `data-legal-link` lets a host attach the `openExternalUrl` handoff that
 * desktop needs (#5911) without this module importing the runtime.
 */
import { escapeHtml } from './sanitize';
import {
  CHECKOUT_CONSENT_CONJUNCTION,
  CHECKOUT_CONSENT_LEAD,
  CHECKOUT_CONSENT_PRIVACY_LABEL,
  CHECKOUT_CONSENT_LICENSE_LABEL,
  EULA_PATH,
  LEGAL_FOOTER_LINKS,
  PRIVACY_PATH,
  absoluteLegalUrl,
} from '../../shared/legal';

/** Marks an anchor a host may re-route through the OS browser on desktop. */
export const LEGAL_LINK_ATTR = 'data-legal-link';

function anchor(href: string, label: string, className: string): string {
  return `<a class="${className}" ${LEGAL_LINK_ATTR} href="${escapeHtml(href)}"`
    + ` target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
}

/**
 * The legal row for the settings modal — the dashboard's shell surface, shown
 * on every tab so the Terms are one click away from anywhere in the app.
 */
export function legalLinksHtml(origin: string): string {
  const links = LEGAL_FOOTER_LINKS
    .map(link => anchor(absoluteLegalUrl(link.path, origin), link.label, 'legal-links-item'))
    .join('');
  return `<nav aria-label="Legal" class="legal-links-row">${links}</nav>`;
}

/**
 * Pre-payment assent, rendered immediately above a checkout CTA. Presenting the
 * Terms *before* payment is what the click-through is for — a link buried in
 * one FAQ answer was the only path before this.
 */
export function checkoutConsentHtml(origin: string): string {
  const license = anchor(
    absoluteLegalUrl(EULA_PATH, origin),
    CHECKOUT_CONSENT_LICENSE_LABEL,
    'checkout-consent-link',
  );
  const privacy = anchor(
    absoluteLegalUrl(PRIVACY_PATH, origin),
    CHECKOUT_CONSENT_PRIVACY_LABEL,
    'checkout-consent-link',
  );
  return `<p class="checkout-consent">${escapeHtml(CHECKOUT_CONSENT_LEAD)} ${license}`
    + ` ${escapeHtml(CHECKOUT_CONSENT_CONJUNCTION)} ${privacy}.</p>`;
}

/**
 * Node form of {@link checkoutConsentHtml}, for surfaces built with element
 * factories rather than HTML templates (the locked-panel state). Same text and
 * same destinations by construction — `tests/legal-checkout-consent.test.mts`
 * pins the two renderings together so neither can drift.
 */
export function createCheckoutConsentElement(origin: string): HTMLParagraphElement {
  const p = document.createElement('p');
  p.className = 'checkout-consent';
  p.append(`${CHECKOUT_CONSENT_LEAD} `);
  p.append(consentAnchor(absoluteLegalUrl(EULA_PATH, origin), CHECKOUT_CONSENT_LICENSE_LABEL));
  p.append(` ${CHECKOUT_CONSENT_CONJUNCTION} `);
  p.append(consentAnchor(absoluteLegalUrl(PRIVACY_PATH, origin), CHECKOUT_CONSENT_PRIVACY_LABEL));
  p.append('.');
  return p;
}

function consentAnchor(href: string, label: string): HTMLAnchorElement {
  const a = document.createElement('a');
  a.className = 'checkout-consent-link';
  a.setAttribute(LEGAL_LINK_ATTR, '');
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = label;
  return a;
}
