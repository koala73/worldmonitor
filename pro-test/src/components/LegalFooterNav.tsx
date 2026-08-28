import { LEGAL_FOOTER_LINKS } from '../../../shared/legal';

/**
 * The legal cluster both /pro footers carry (#6976).
 *
 * `docs/terms.mdx` opens with "By using the Service, you agree to these Terms"
 * — a browsewrap, which is worth exactly as much as the link it depends on.
 * That link existed nowhere a buyer passes through: not in the welcome footer,
 * not in the pricing footer, only inside one FAQ answer.
 *
 * One component rather than two hand-written rows because only the welcome page
 * is prerendered — `tests/legal-footer-links.test.mts` proves the rendered
 * anchors against `public/pro/welcome.html`, and the pricing page inherits that
 * proof by rendering the same component instead of a copy that could drift.
 *
 * Its own row, not more entries in the product nav: this is the legal footer,
 * not four more destinations.
 */
export const LegalFooterNav = () => (
  <nav
    aria-label="Legal"
    className="max-w-7xl mx-auto mt-6 pt-4 border-t border-wm-border/60 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-[11px] text-wm-muted font-mono"
  >
    {LEGAL_FOOTER_LINKS.map(link => (
      <a key={link.path} href={link.path} className="hover:text-wm-text transition-colors">
        {link.label}
      </a>
    ))}
  </nav>
);
