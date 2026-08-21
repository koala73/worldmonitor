import {
  CHECKOUT_CONSENT_CONJUNCTION,
  CHECKOUT_CONSENT_LEAD,
  CHECKOUT_CONSENT_LICENSE_LABEL,
  CHECKOUT_CONSENT_PRIVACY_LABEL,
  EULA_PATH,
  PRIVACY_PATH,
} from '../../../shared/legal';

/**
 * Pre-payment assent, rendered immediately above a checkout CTA (#6976).
 *
 * Clicking a tier CTA redirects top-level to Dodo's hosted page. Dodo is
 * merchant of record and shows *its* terms there — ours were presented nowhere
 * in the purchase path. Consumer-law pre-contract disclosure (EU/UK distance
 * selling, UAE consumer protection) expects the terms before payment, not
 * findable afterwards, and the clauses we most depend on — the per-plan license
 * scope, the liability cap, the Dubai venue — are exactly the ones struck first
 * when assent is absent.
 *
 * Links the EULA rather than the Terms (#6983): the licence is the document
 * carrying those plan scopes and restrictions, and its section 2 links the
 * Terms in turn.
 *
 * Root-relative paths: /pro is served from the same origin as /docs.
 */
export const CheckoutConsent = () => (
  <p className="mb-2.5 text-[10px] leading-relaxed text-wm-muted/80 text-center font-mono">
    {CHECKOUT_CONSENT_LEAD}{' '}
    <a href={EULA_PATH} className="underline hover:text-wm-text transition-colors">
      {CHECKOUT_CONSENT_LICENSE_LABEL}
    </a>{' '}
    {CHECKOUT_CONSENT_CONJUNCTION}{' '}
    <a href={PRIVACY_PATH} className="underline hover:text-wm-text transition-colors">
      {CHECKOUT_CONSENT_PRIVACY_LABEL}
    </a>
    .
  </p>
);
