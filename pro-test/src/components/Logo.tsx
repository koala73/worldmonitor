import { Globe, Activity } from 'lucide-react';
import { SOMEONE_CEO_URL } from '../../../shared/press';

export const Logo = () => (
  <div className="flex items-center gap-2">
    <a
      href="https://worldmonitor.app"
      className="flex items-center gap-2 hover:opacity-80 transition-opacity"
    >
      <span className="relative w-8 h-8 rounded-full bg-wm-card border border-wm-border flex items-center justify-center overflow-hidden" aria-hidden="true">
        <Globe className="w-5 h-5 text-wm-blue opacity-50 absolute" />
        <Activity className="w-6 h-6 text-wm-green absolute z-10" />
      </span>
      <span className="font-display font-bold text-sm leading-none tracking-tight">
        WORLD MONITOR
      </span>
    </a>
    <a
      href={SOMEONE_CEO_URL}
      className="text-[10px] text-wm-muted font-mono uppercase tracking-widest leading-none self-end mb-0.5 hover:text-wm-text transition-colors"
      rel="noopener noreferrer"
    >
      by Someone.ceo
    </a>
  </div>
);
