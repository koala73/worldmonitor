import { PRESS_LINKS } from '../../../shared/press';

/**
 * "In the press" row (#7377).
 *
 * Press URLs previously lived only in `/world-monitor.md` and `/docs/about`
 * while the homepage asserted "as featured in WIRED" beside an uncited 2M
 * figure. One shared list keeps the pages and agent briefings aligned. The
 * homepage and /pro show it once, beside the quotes section rather than in
 * the footer, so the proof is not hidden at the bottom of the page.
 */
export const PressNav = ({ className = 'mt-4' }: { className?: string }) => (
  <nav
    aria-label="In the press"
    className={`max-w-7xl mx-auto ${className} flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-wm-muted font-mono`}
  >
    <span className="uppercase tracking-[2px] text-wm-muted">In the press</span>
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
