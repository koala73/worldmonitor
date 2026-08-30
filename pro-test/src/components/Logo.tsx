import { Globe, Activity } from 'lucide-react';
import { SOMEONE_CEO_URL } from '../../../shared/press';

export const Logo = () => (
  <div className="flex items-center gap-2">
    <a href="https://worldmonitor.app" className="relative w-8 h-8 rounded-full bg-wm-card border border-wm-border flex items-center justify-center overflow-hidden hover:opacity-80 transition-opacity" aria-label="World Monitor — Home">
      <Globe className="w-5 h-5 text-wm-blue opacity-50 absolute" aria-hidden="true" />
      <Activity className="w-6 h-6 text-wm-green absolute z-10" aria-hidden="true" />
    </a>
    <div className="flex flex-col">
      <a href="https://worldmonitor.app" className="font-display font-bold text-sm leading-none tracking-tight hover:opacity-80 transition-opacity">
        WORLD MONITOR
      </a>
      <a
        href={SOMEONE_CEO_URL}
        className="text-[9px] text-wm-muted font-mono uppercase tracking-widest leading-none mt-1 hover:text-wm-text transition-colors"
        rel="noopener noreferrer"
      >
        by Someone.ceo
      </a>
    </div>
  </div>
);
