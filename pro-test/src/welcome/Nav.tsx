import { ArrowRight, ChevronDown, Menu as MenuIcon } from 'lucide-react';
import { Logo } from '../components/Logo';
import { t } from '../i18n';
import { DASHBOARD_PATH } from '../routes';

// The menu is kept under its original id: the prerender and a11y suites
// locate the nav's link groups by it.
const MENU_ID = 'welcome-tablet-navigation';

// `inline` is the breakpoint from which a link sits in the desktop row;
// below it, and for links with `inline: false`, it lives only in the menu.
// Nine inline links could not fit beside the logo and Launch in most
// locales (French needed ~1474px against a 1280px container), which pushed
// Launch off-screen, so the in-page section anchors moved to the menu.
// Sources and Blog wait for xl: with them, Bulgarian and Russian overflow
// the 1024px row.
const NAV_ITEMS = [
  { href: '/use-cases/', labelKey: 'welcome.nav.useCases', inline: 'lg' },
  { href: '/sources/', labelKey: 'welcome.depth.s3l', inline: 'xl' },
  { href: '/pro#pricing', labelKey: 'welcome.nav.pricing', inline: 'lg' },
  { href: '/blog/', labelKey: 'welcome.nav.blog', inline: 'xl' },
  { href: '/docs/documentation', labelKey: 'welcome.nav.docs', inline: 'lg' },
  { href: '#first-five', labelKey: 'welcome.nav.firstFive', inline: false },
  { href: '#depth', labelKey: 'welcome.nav.depth', inline: false },
  { href: '#agents', labelKey: 'welcome.nav.agents', inline: false },
  { href: '#faq', labelKey: 'welcome.nav.faq', inline: false },
] as const;

// Literal class names so Tailwind's scanner generates both variants.
const MENU_HIDDEN_FROM = { lg: ' lg:hidden', xl: ' xl:hidden' } as const;

const InlineItems = () => (
  <>
    {NAV_ITEMS.filter(({ inline }) => inline).map(({ href, labelKey, inline }) => (
      <a key={href} href={href} className={`transition-colors hover:text-wm-text${inline === 'xl' ? ' hidden xl:inline' : ''}`}>
        {t(labelKey)}
      </a>
    ))}
  </>
);

// Every link is in the menu; the inline ones hide there from the
// breakpoint where the desktop row shows them.
const MenuItems = () => (
  <>
    {NAV_ITEMS.map(({ href, labelKey, inline }) => (
      <a
        key={href}
        href={href}
        className={`block px-4 py-2 hover:bg-white/5 hover:text-wm-text transition-colors${inline ? MENU_HIDDEN_FROM[inline] : ''}`}
        onClick={() => document.getElementById(MENU_ID)?.removeAttribute('open')}
      >
        {t(labelKey)}
      </a>
    ))}
  </>
);

export const Nav = () => (
  // <header> gives the page its banner landmark; the fixed <nav> inside it
  // keeps the data-wm-nav hook the critical CSS is scoped to.
  <header>
    <nav data-wm-nav="primary" className="fixed top-0 left-0 right-0 z-50 glass-panel border-b-0 border-x-0 rounded-none" aria-label="Main navigation">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-3">
        {/* Glyph-only below 375px: at 360px the full lockup, the menu button
            and a translated Launch label do not fit on one row. */}
        <Logo compactOnNarrow />
        <div className="hidden lg:flex items-center gap-4 xl:gap-6 whitespace-nowrap text-xs xl:text-sm text-wm-muted ms-auto me-2">
          <InlineItems />
        </div>
        {/* Below sm the panel anchors to the fixed nav, not the button, and spans
            the row: a 14rem panel hung off the button ran 64px past the left
            edge at 320px. The panel is capped to the space under the fixed
            nav and scrolls, or a landscape phone could not reach its last
            links. */}
        <details id={MENU_ID} className="group sm:relative text-sm text-wm-muted ms-auto lg:ms-0">
          <summary className="list-none cursor-pointer border border-wm-border bg-wm-card min-h-9 px-2 sm:px-3 py-2 rounded-md inline-flex items-center gap-2 hover:text-wm-text transition-colors [&::-webkit-details-marker]:hidden">
            <MenuIcon className="w-4 h-4" aria-hidden="true" />
            {/* Below sm the button is icon-only; the label stays readable to screen readers. */}
            <span className="sr-only sm:not-sr-only">{t('welcome.nav.menu')}</span>
            <ChevronDown className="hidden sm:block w-3 h-3 transition-transform group-open:rotate-180" aria-hidden="true" />
          </summary>
          <div className="absolute inset-x-4 sm:inset-x-auto sm:end-0 top-[calc(100%+0.5rem)] z-10 sm:w-56 max-h-[calc(100dvh-5rem)] overflow-y-auto overscroll-contain rounded-lg border border-wm-border bg-wm-card shadow-xl py-1">
            <MenuItems />
          </div>
        </details>
        {/* Below sm the label may wrap to two lines instead of pushing past
            the edge: French and Vietnamese need ~200px on one line. */}
        <a
          href={DASHBOARD_PATH}
          aria-label={t('welcome.nav.launch')}
          data-umami-event="welcome-cta"
          data-umami-event-target="welcome-nav"
          className="min-w-0 sm:shrink-0 bg-wm-green text-wm-bg min-h-9 py-2 px-3 sm:px-4 rounded-md text-xs sm:text-sm font-medium text-center hover:bg-green-300 transition-colors inline-flex items-center gap-2"
        >
          {t('welcome.nav.launch')} <ArrowRight className="hidden sm:block w-4 h-4" aria-hidden="true" />
        </a>
      </div>
    </nav>
  </header>
);
