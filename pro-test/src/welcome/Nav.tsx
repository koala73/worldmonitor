import { ArrowRight } from 'lucide-react';
import { Logo } from '../components/Logo';
import { t } from '../i18n';
import { DASHBOARD_PATH } from '../routes';

export const Nav = () => (
  <nav className="fixed top-0 left-0 right-0 z-50 glass-panel border-b-0 border-x-0 rounded-none" aria-label="Main navigation">
    <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-3">
      <Logo />
      <div className="hidden md:flex items-center gap-8 text-sm font-mono text-wm-muted">
        <a href="#moments" className="hover:text-wm-text transition-colors">{t('welcome.nav.useCases')}</a>
        <a href="#first-five" className="hover:text-wm-text transition-colors">{t('welcome.nav.firstFive')}</a>
        <a href="#depth" className="hover:text-wm-text transition-colors">{t('welcome.nav.depth')}</a>
        <a href="/pro#pricing" className="hover:text-wm-green transition-colors">{t('welcome.nav.pricing')}</a>
        <a href="#faq" className="hover:text-wm-text transition-colors">{t('welcome.nav.faq')}</a>
        <a href="https://www.worldmonitor.app/docs" className="hover:text-wm-text transition-colors">{t('welcome.nav.docs')}</a>
      </div>
      <a
        href={`${DASHBOARD_PATH}?ref=welcome-nav`}
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
