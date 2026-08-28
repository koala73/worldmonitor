import { ArrowRight, ChevronDown, Menu as MenuIcon } from 'lucide-react';
import { Logo } from '../components/Logo';
import { t } from '../i18n';
import { DASHBOARD_PATH } from '../routes';

const TABLET_MENU_ID = 'welcome-tablet-navigation';
const NAV_ITEMS = [
  { href: '#moments', labelKey: 'welcome.nav.useCases', accent: false },
  { href: '#first-five', labelKey: 'welcome.nav.firstFive', accent: false },
  { href: '#depth', labelKey: 'welcome.nav.depth', accent: false },
  { href: '#agents', labelKey: 'welcome.nav.agents', accent: false },
  { href: '/sources/?utm_source=welcome-nav', labelKey: 'welcome.depth.s3l', accent: false },
  { href: '/pro#pricing', labelKey: 'welcome.nav.pricing', accent: true },
  { href: '#faq', labelKey: 'welcome.nav.faq', accent: false },
  { href: '/blog/', labelKey: 'welcome.nav.blog', accent: false },
  { href: 'https://www.worldmonitor.app/docs', labelKey: 'welcome.nav.docs', accent: false },
] as const;

const NavItems = ({ compact = false }: { compact?: boolean }) => (
  <>
    {NAV_ITEMS.map(({ href, labelKey, accent }) => (
      <a
        key={href}
        href={href}
        className={compact
          ? `block px-4 py-2.5 hover:bg-white/5 transition-colors ${accent ? 'text-wm-green' : 'hover:text-wm-text'}`
          : `transition-colors ${accent ? 'hover:text-wm-green' : 'hover:text-wm-text'}`}
        onClick={compact
          ? () => document.getElementById(TABLET_MENU_ID)?.removeAttribute('open')
          : undefined}
      >
        {t(labelKey)}
      </a>
    ))}
  </>
);

export const Nav = () => (
  <nav data-wm-nav="primary" className="fixed top-0 left-0 right-0 z-50 glass-panel border-b-0 border-x-0 rounded-none" aria-label="Main navigation">
    <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-3">
      <Logo />
      <div className="hidden lg:flex items-center gap-4 whitespace-nowrap text-xs font-mono text-wm-muted xl:gap-7 xl:text-sm">
        <NavItems />
      </div>
      <details id={TABLET_MENU_ID} className="group relative hidden md:block lg:hidden text-sm font-mono text-wm-muted">
        <summary className="list-none cursor-pointer border border-wm-border bg-wm-card px-3 py-2 rounded-sm inline-flex items-center gap-2 hover:text-wm-text transition-colors [&::-webkit-details-marker]:hidden">
          <MenuIcon className="w-4 h-4" aria-hidden="true" />
          {t('welcome.nav.menu')}
          <ChevronDown className="w-3 h-3 transition-transform group-open:rotate-180" aria-hidden="true" />
        </summary>
        <div className="absolute right-0 top-[calc(100%+0.5rem)] z-10 w-52 border border-wm-border bg-wm-card shadow-xl py-1">
          <NavItems compact />
        </div>
      </details>
      <a
        href={`${DASHBOARD_PATH}?utm_source=welcome&utm_content=nav`}
        data-umami-event="welcome-cta"
        data-umami-event-target="welcome-nav"
        aria-label={t('welcome.nav.launch')}
        className="shrink-0 bg-wm-green text-wm-bg px-3 sm:px-4 py-2 rounded-sm font-mono text-xs uppercase tracking-wide sm:tracking-wider font-bold hover:bg-green-400 transition-colors inline-flex items-center gap-1.5"
      >
        {t('welcome.nav.launch')} <ArrowRight className="w-3 h-3" aria-hidden="true" />
      </a>
    </div>
  </nav>
);
