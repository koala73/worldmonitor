import { t } from '../i18n';

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

// One row that scrolls sideways, so the quotes cost one card of height.
export const VoiceCards = () => (
  <ul className="flex gap-4 overflow-x-auto snap-x snap-mandatory pb-4">
    {VOICES.map((voice) => (
      <li key={voice.href} className="snap-start shrink-0 w-[85%] sm:w-[22rem] flex">
        <a
          href={voice.href}
          target="_blank"
          rel="noopener noreferrer"
          className="flex flex-col w-full bg-wm-card border border-wm-border p-6 hover:border-wm-green transition-colors"
        >
          {/* Quotes stay verbatim in English on every locale; say so for screen readers. */}
          <blockquote lang="en" className="text-wm-text leading-relaxed flex-1">“{voice.quote}”</blockquote>
          <span className="block mt-4 text-sm">
            <span className="font-bold text-wm-text">{voice.name}</span>
            <span className="text-wm-muted"> · {voice.role}</span>
            {voice.translatedFrom === 'ja' && (
              <span className="block mt-1 font-mono text-xs text-wm-muted">{t('welcome.voices.translatedJa')}</span>
            )}
          </span>
        </a>
      </li>
    ))}
  </ul>
);
