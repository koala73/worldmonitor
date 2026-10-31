import { useEffect, useRef, useState, type RefObject } from 'react';
import { t } from '../i18n';

// Inline rather than lucide-react: the dom-tests CI job installs root deps only,
// and its arrow test renders this component.
const Chevron = ({ pointsLeft }: { pointsLeft: boolean }) => (
  <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={pointsLeft ? 'm15 18-6-6 6-6' : 'm9 18 6-6-6-6'} />
  </svg>
);

/**
 * What the press and notable people said about World Monitor, quoted verbatim.
 * Press quotes were checked word for word against the article. Every X author
 * gave permission (2026-10-29); add an X voice only with the author's go-ahead.
 * Each card opens the article or the exact post. `translatedFrom` marks an
 * English rendering of a non-English original.
 */
export interface Voice {
  quote: string;
  name: string;
  role: string;
  href: string;
  translatedFrom?: 'ja';
}

export const VOICES: ReadonlyArray<Voice> = [
  {
    quote: 'World Monitor, a website that turns any browser into a makeshift situation room, and I love it.',
    name: 'The Atlantic',
    role: 'Charlie Warzel',
    href: 'https://www.theatlantic.com/technology/2026/03/world-monitor-situation-meme/686389/',
  },
  {
    quote: '…an open-source dashboard people around the world were using to track the war in real time.',
    name: 'WIRED',
    role: 'Feature by Lilian Wagdy',
    href: 'https://www.wired.com/story/world-monitor-elie-habib/',
  },
  {
    quote: '…a platform that users would go on to label as ‘a Bloomberg Terminal for geopolitics.’',
    name: 'Entrepreneur Middle East',
    role: 'Cover story',
    href: 'https://mena.entrepreneur.com/business-news/how-elie-habib-built-world-monitor-to-track-global-events-in-real-time',
  },
  {
    quote: 'Think Palantir for everyone.',
    name: 'Mario Nawfal',
    role: 'News host',
    href: 'https://x.com/MarioNawfal/status/2079427397942927655',
  },
  {
    quote: 'We put that trending CIA-like thing up on a 300-inch LED screen. Nice.',
    name: 'Nippon TV R&D Lab',
    role: 'Nippon TV',
    href: 'https://x.com/ntv_rd/status/2024068565490618854',
    translatedFrom: 'ja',
  },
  {
    quote: '…feels like Palantir meets Bloomberg Terminal. Very nice build and Tauri app!',
    name: 'Bilawal Sidhu',
    role: 'Spatial-tech creator',
    href: 'https://x.com/bilawalsidhu/status/2025702618895360204',
  },
];

const isRtl = (row: HTMLElement) => getComputedStyle(row).direction === 'rtl';

// One row that scrolls sideways, so the quotes cost one card of height. Mice
// cannot swipe and macOS hides scrollbars, so arrows page the row. In RTL
// (ar, fa) scrollLeft runs from 0 to negative, so progress is |scrollLeft| and
// paging and the chevrons flip.
export const VoiceCards = () => {
  const rowRef = useRef<HTMLUListElement>(null);
  const [edges, setEdges] = useState({ atStart: true, atEnd: false, rtl: false });

  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const update = () => {
      const progress = Math.abs(row.scrollLeft);
      setEdges({
        atStart: progress <= 1,
        atEnd: progress + row.clientWidth >= row.scrollWidth - 1,
        rtl: isRtl(row),
      });
    };
    update();
    row.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      row.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);

  const page = (direction: 1 | -1) => {
    const row = rowRef.current;
    if (row) row.scrollBy({ left: (isRtl(row) ? -1 : 1) * direction * row.clientWidth * 0.9, behavior: 'smooth' });
  };

  const arrowClass = 'flex items-center justify-center w-10 h-10 border border-wm-border bg-wm-card text-wm-text hover:border-wm-green disabled:opacity-30 disabled:hover:border-wm-border transition-colors';

  return (
    <div>
      <VoiceRow rowRef={rowRef} />
      <div className="flex justify-end gap-2 mt-2">
        <button type="button" className={arrowClass} onClick={() => page(-1)} disabled={edges.atStart} aria-label={t('welcome.voices.prev')}>
          <Chevron pointsLeft={!edges.rtl} />
        </button>
        <button type="button" className={arrowClass} onClick={() => page(1)} disabled={edges.atEnd} aria-label={t('welcome.voices.next')}>
          <Chevron pointsLeft={edges.rtl} />
        </button>
      </div>
    </div>
  );
};

const VoiceRow = ({ rowRef }: { rowRef: RefObject<HTMLUListElement | null> }) => (
  <ul ref={rowRef} className="flex gap-4 overflow-x-auto snap-x snap-mandatory pb-4">
    {VOICES.map((voice) => (
      <li key={voice.href} className="snap-start shrink-0 w-[85%] sm:w-[22rem] flex">
        <a
          href={voice.href}
          target="_blank"
          rel="noopener noreferrer"
          className="flex flex-col w-full bg-wm-card border border-wm-border p-6 hover:border-wm-green transition-colors"
        >
          {/* Quotes stay verbatim in English on every locale: lang for screen
              readers, dir so RTL pages do not move the quote marks and ellipses. */}
          <blockquote lang="en" dir="ltr" className="text-wm-text leading-relaxed flex-1">“{voice.quote}”</blockquote>
          <span className="block mt-4 text-sm">
            <span lang="en" dir="ltr">
              <span className="font-bold text-wm-text">{voice.name}</span>
              <span className="text-wm-muted"> · {voice.role}</span>
            </span>
            {voice.translatedFrom === 'ja' && (
              <span className="block mt-1 font-mono text-xs text-wm-muted">{t('welcome.voices.translatedJa')}</span>
            )}
          </span>
        </a>
      </li>
    ))}
  </ul>
);
