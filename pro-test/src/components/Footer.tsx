import { DASHBOARD_PATH } from '../routes';
import { ABOUT_DOCS_PATH, SOMEONE_CEO_URL } from '../../../shared/press';
import { LegalFooterNav } from './LegalFooterNav';
import { PressFooterNav } from './PressFooterNav';

export const Footer = () => (
  <footer className="border-t border-wm-border bg-[#020202] pt-8 pb-12 px-6 text-center">
    <div className="flex flex-col md:flex-row items-center justify-between max-w-7xl mx-auto text-xs text-wm-muted font-mono">
      <div className="flex items-center gap-3 mb-4 md:mb-0">
        <img src="/favico/favicon-32x32.png" alt="" width="28" height="28" loading="lazy" className="rounded-full" />
        <div className="flex flex-col text-left">
          <span className="font-display font-bold text-sm leading-none tracking-tight text-wm-text">WORLD MONITOR</span>
          <a
            href={SOMEONE_CEO_URL}
            className="text-[9px] uppercase tracking-[2px] opacity-60 mt-0.5 hover:opacity-100 hover:text-wm-text transition-colors"
            rel="noopener noreferrer"
          >
            by Someone.ceo
          </a>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
        <a href={DASHBOARD_PATH} className="hover:text-wm-text transition-colors">Dashboard</a>
        <a href={ABOUT_DOCS_PATH} className="hover:text-wm-text transition-colors">About</a>
        <a href="/sources/?utm_source=welcome-footer" className="hover:text-wm-text transition-colors">Sources</a>
        <a href="/countries/" className="hover:text-wm-text transition-colors">Countries</a>
        <a href="/chokepoints/" className="hover:text-wm-text transition-colors">Chokepoints</a>
        <a href="/crises/" className="hover:text-wm-text transition-colors">Crises</a>
        <a href="/tools/" className="hover:text-wm-text transition-colors">Tools</a>
        <a href="https://www.worldmonitor.app/blog/" className="hover:text-wm-text transition-colors">Blog</a>
        <a href="https://www.worldmonitor.app/docs" className="hover:text-wm-text transition-colors">Docs</a>
        <a href="https://status.worldmonitor.app/" target="_blank" rel="noreferrer" className="hover:text-wm-text transition-colors">Status</a>
        <a href="https://github.com/koala73/worldmonitor" target="_blank" rel="noreferrer" className="hover:text-wm-text transition-colors">GitHub</a>
        <a href="https://discord.gg/re63kWKxaz" target="_blank" rel="noreferrer" className="hover:text-wm-text transition-colors">Discord</a>
        <a href="https://x.com/worldmonitorai" target="_blank" rel="noreferrer" className="hover:text-wm-text transition-colors">X</a>
      </div>
      <span className="text-[10px] opacity-40 mt-4 md:mt-0" suppressHydrationWarning>&copy; {new Date().getFullYear()} WorldMonitor</span>
    </div>
    <PressFooterNav />
    <LegalFooterNav />
  </footer>
);
