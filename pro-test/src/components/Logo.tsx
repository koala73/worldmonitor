import type { MouseEventHandler } from 'react';
import { Globe, Activity } from 'lucide-react';

interface LogoProps {
  /** Destination for the lockup. Defaults to the marketing home. */
  href?: string;
  /** Intercept the click — e.g. the Enterprise view clearing its hash route. */
  onClick?: MouseEventHandler<HTMLAnchorElement>;
}

/**
 * Home lockup for the marketing chrome.
 *
 * One anchor wrapping the whole lockup on purpose: the 32px glyph gives the
 * link a target that clears the 24x24 minimum, and the accessible name comes
 * from the visible WORLD MONITOR text rather than a mismatched aria-label.
 * Splitting this into stacked 14px/10px text links scored 0 on axe
 * target-size (#7382).
 *
 * Call sites needing an in-page destination pass `href`/`onClick` instead of
 * wrapping this in another anchor: nesting is invalid HTML, and the outer
 * handler's preventDefault() silently cancelled the inner link's navigation
 * too, so unwrapping without forwarding the handler changes where the logo
 * goes.
 */
export const Logo = ({ href = 'https://worldmonitor.app', onClick }: LogoProps = {}) => (
  <a
    href={href}
    onClick={onClick}
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
