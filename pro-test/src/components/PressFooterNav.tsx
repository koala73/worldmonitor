import { PRESS_LINKS } from '../../../shared/press';

/**
 * "In the press" row for marketing footers (#7377).
 *
 * Press URLs previously lived only in `/world-monitor.md` and `/docs/about`
 * while the homepage asserted "as featured in WIRED" beside an uncited 2M
 * figure. One shared list keeps footers and agent briefings aligned.
 */
export const PressFooterNav = () => (
  <nav
    aria-label="In the press"
    className="max-w-7xl mx-auto mt-4 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-[11px] text-wm-muted font-mono"
  >
    <span className="uppercase tracking-[2px] opacity-60">In the press</span>
    {PRESS_LINKS.map(link => (
      <a
        key={link.url}
        href={link.url}
        target="_blank"
        rel="noopener noreferrer"
        className="hover:text-wm-text transition-colors"
      >
        {link.label}
      </a>
    ))}
  </nav>
);
