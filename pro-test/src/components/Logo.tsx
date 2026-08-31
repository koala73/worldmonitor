import { Globe, Activity } from 'lucide-react';

/**
 * Home lockup for the marketing chrome.
 *
 * One anchor wrapping the whole lockup on purpose: the 32px glyph gives the
 * link a target that clears the 24x24 minimum, and the accessible name comes
 * from the visible WORLD MONITOR text rather than a mismatched aria-label.
 * Splitting this into stacked 14px/10px text links scored 0 on axe
 * target-size (#7382).
 */
export const Logo = () => (
  <a
    href="https://worldmonitor.app"
    className="flex items-center gap-2 hover:opacity-80 transition-opacity"
  >
    <span
      className="relative w-8 h-8 rounded-full bg-wm-card border border-wm-border flex items-center justify-center overflow-hidden"
      aria-hidden="true"
    >
      <Globe className="w-5 h-5 text-wm-blue opacity-50 absolute" />
      <Activity className="w-6 h-6 text-wm-green absolute z-10" />
    </span>
    <span className="font-display font-bold text-sm leading-none tracking-tight">
      WORLD MONITOR
    </span>
  </a>
);
