import { Globe, Activity } from 'lucide-react';

export const Logo = () => (
  <a href="https://worldmonitor.app" className="flex items-center gap-2 hover:opacity-80 transition-opacity" aria-label="World Monitor — Home">
    <div className="relative w-8 h-8 rounded-full bg-wm-card border border-wm-border flex items-center justify-center overflow-hidden">
      <Globe className="w-5 h-5 text-wm-blue opacity-50 absolute" aria-hidden="true" />
      <Activity className="w-6 h-6 text-wm-green absolute z-10" aria-hidden="true" />
    </div>
    <div className="flex flex-col">
      <span className="font-display font-bold text-sm leading-none tracking-tight">WORLD MONITOR</span>
      <span className="text-[9px] text-wm-muted font-mono uppercase tracking-widest leading-none mt-1">by Someone.ceo</span>
    </div>
  </a>
);
