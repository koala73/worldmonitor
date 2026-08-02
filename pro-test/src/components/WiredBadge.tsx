import { ExternalLink } from 'lucide-react';
import { t } from '../i18n';

export const WiredBadge = () => (
  <a
    href="https://www.wired.com/story/world-monitor-elie-habib/"
    target="_blank"
    rel="noreferrer"
    className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-wm-border bg-wm-card/50 text-wm-muted text-xs font-mono hover:border-wm-green/30 hover:text-wm-text transition-colors"
  >
    {t('wired.asFeaturedIn')} <span className="text-wm-text font-bold">WIRED</span> <ExternalLink className="w-3 h-3" aria-hidden="true" />
  </a>
);
