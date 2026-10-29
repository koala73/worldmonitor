import { t } from '../i18n';

/**
 * What people said about World Monitor, quoted verbatim from their own posts.
 * Every X author below gave permission (2026-10-29); add a voice only with the
 * author's go-ahead. Press stays in the footer "In the press" row, not here.
 * `translatedFrom` marks an English rendering of a non-English original.
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
    quote: 'Palantir sells governments a war room that costs millions a year. So, a guy named Elie just rebuilt it, put it on GitHub, and gave it away.',
    name: 'Ihtesham Ali',
    role: 'Founder and writer',
    href: 'https://x.com/ihteshamali/status/2079156922406875492',
  },
  {
    quote: 'This is how you monitor the situation.',
    name: 'Didier Lopes',
    role: 'Founded OpenBB',
    href: 'https://x.com/didier_lopes/status/2025977905889554522',
  },
  {
    quote: '…feels like Palantir meets Bloomberg Terminal. Very nice build and Tauri app!',
    name: 'Bilawal Sidhu',
    role: 'Spatial-tech creator',
    href: 'https://x.com/bilawalsidhu/status/2025702618895360204',
  },
  {
    quote: 'Think of it as a CNN war room meets Bloomberg Terminal for geopolitics but anyone can use it.',
    name: 'Nav Toor',
    role: 'AI educator',
    href: 'https://x.com/heynavtoor/status/2025533164454846629',
  },
  {
    quote: 'Hard at work monitoring the sit through @eliehabib \'s worldmonitor app',
    name: 'Prof. Akin Unver',
    role: 'Ozyegin University',
    href: 'https://x.com/AkinUnver/status/2027787008035205152',
  },
  {
    quote: 'We put that trending CIA-like thing up on a 300-inch LED screen. Nice.',
    name: 'Nippon TV R&D Lab',
    role: 'Nippon TV',
    href: 'https://x.com/ntv_rd/status/2024068565490618854',
    translatedFrom: 'ja',
  },
  {
    quote: 'Think Palantir for everyone.',
    name: 'Mario Nawfal',
    role: 'News host',
    href: 'https://x.com/MarioNawfal/status/2079427397942927655',
  },
  {
    quote: 'Breadth of coverage is unmatched at zero cost.',
    name: 'OSINTBench',
    role: 'Independent tool review',
    href: 'https://osintbench.com/tools/worldmonitor/',
  },
];

export const VoiceCards = () => (
  <div className="columns-1 md:columns-2 lg:columns-3 gap-6">
    {VOICES.map((voice) => (
      <figure key={voice.href} className="break-inside-avoid mb-6 bg-wm-card border border-wm-border p-6">
        <blockquote className="text-wm-text leading-relaxed">“{voice.quote}”</blockquote>
        <figcaption className="mt-4 text-sm">
          <a href={voice.href} target="_blank" rel="noopener noreferrer" className="font-bold text-wm-text hover:text-wm-green transition-colors">
            {voice.name}
          </a>
          <span className="text-wm-muted"> · {voice.role}</span>
          {voice.translatedFrom === 'ja' && (
            <span className="block mt-1 font-mono text-xs text-wm-muted">{t('welcome.voices.translatedJa')}</span>
          )}
        </figcaption>
      </figure>
    ))}
  </div>
);
