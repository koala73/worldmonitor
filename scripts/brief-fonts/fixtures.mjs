// Sample briefs that exercise every part of the magazine layout: cover, digest pages, light and
// dark story pages, every threat level, the public share view and the share button. The `intl`
// brief carries the scripts and symbols news copy can contain, so every subset file is used.
import { renderBriefMagazine } from '../../server/_shared/brief-render.js';
import { BRIEF_ENVELOPE_VERSION } from '../../shared/brief-envelope.js';

const PROBE = '† ‡ non‑breaking ‐ hyphen ‒ figure ― bar 10\u2009000 thin, 5\u202F% narrow, zero\u200Bwidth, fig\u2007ure, soft\u00ADhyphen, word\u2060joiner, 5′ 6″, 1⁄2, ‹a› «b», • ‰ ℓ № € ₹ ₿ ₺ ₴ ₦ ₩ ₪ ₫ ¤ ¢ £ ¥ § ¶ © ® ™ ° ± × ÷ µ ‐‑‒–—―';
const longText = (sentence, count) => Array.from({ length: count }, () => sentence).join(' ');

function story(overrides = {}) {
  return {
    category: 'Energy',
    country: 'IR',
    threatLevel: 'high',
    headline: 'Iran keeps the Strait of Hormuz open while insurers reprice Gulf transit risk.',
    description: 'Tehran signalled that commercial shipping can keep moving through Hormuz, but tanker premiums remain elevated.',
    source: 'Multiple wires',
    sourceUrl: 'https://example.com/hormuz-open',
    clusterId: 'cluster-energy-hormuz-001',
    whyMatters: 'Hormuz carries roughly a fifth of global seaborne oil, so a stability signal can move energy prices faster than diplomatic statements.',
    ...overrides,
  };
}

function envelope(stories, digest = {}) {
  return {
    version: BRIEF_ENVELOPE_VERSION,
    issuedAt: 1_700_000_000_000,
    data: {
      user: { name: 'Elie', tz: 'UTC' },
      issue: '27.05',
      date: '2026-05-27',
      dateLong: '27 May 2026',
      digest: {
        greeting: 'Good evening.',
        lead: longText('The most important development today is not a single flashpoint but a widening pressure band across shipping, energy, and infrastructure risk.', 2),
        numbers: { clusters: 278, multiSource: 21, surfaced: stories.length },
        threads: [
          { tag: 'Energy', teaser: 'Shipping, insurance, and refinery margin signals are moving together.' },
          { tag: 'Cyber', teaser: 'Infrastructure operators are tightening access controls after fresh intrusion reports.' },
          { tag: 'Maritime', teaser: 'Port congestion and war-risk pricing are becoming the same operating story.' },
        ],
        signals: [
          'Whether war-risk premiums fall faster than freight backlogs clear.',
          'Whether operators report fresh disruptions in the next 24 hours.',
        ],
        ...digest,
      },
      stories,
    },
  };
}

const english = envelope([
  story({ threatLevel: 'critical', category: 'Security', country: 'US / CA' }),
  story({ category: 'Diplomacy', country: 'IL / LB', threatLevel: 'medium', clusterId: 'c2' }),
  story({ category: 'Markets', country: 'US', threatLevel: 'low', clusterId: 'c3' }),
]);

const international = envelope([
  story({
    headline: 'Zelenskyy meets Erdoğan in Kraków as Łódź and Gdańsk brace — “no retreat”',
    description: 'Ministers in Bucureşti, Plzeň and Győr said the €4.2 bn package (±3%) covers 1½ years; Düsseldorf’s Société Générale desk called it “très sérieux”… Ørsted, Æon and Ålesund notes followed.',
    source: 'Reuters · Agence France‑Presse',
    clusterId: 'i1',
  }),
  story({
    headline: 'Đà Nẵng and Hải Phòng ports reopen after typhoon',
    description: 'Vietnamese officials in Thừa Thiên Huế said cargo resumed; Москва and Київ issued statements, while Αθήνα monitored Θεσσαλονίκη.',
    category: 'Maritime', country: 'VN', threatLevel: 'medium', clusterId: 'i2',
    whyMatters: 'Temperatures hit 38°C × 3 days; 2,000 km² affected — ™, ®, ©, ‰ and № markers appear in wire copy.',
  }),
  story({
    headline: 'Новые санкции: Россия и Україна',
    description: 'Ελληνικά κείμενα και кириллица в одном абзаце; Ѣ, Ґ, Ӂ and Ա-free extended Cyrillic: Ҕ Ӑ.',
    category: 'Diplomacy', country: 'RU / UA', threatLevel: 'high', clusterId: 'i3', source: 'ТАСС / Καθημερινή',
  }),
  // Punctuation, spaces and symbols that sit in a font's unicode-range without a glyph, or in two files' ranges.
  story({ headline: PROBE, description: PROBE, whyMatters: PROBE, source: PROBE, category: 'Cyber', country: 'FR', threatLevel: 'low', clusterId: 'i4' }),
], {
  greeting: 'Bonsoir — guten Abend.',
  signals: ['Whether São Paulo’s €-denominated bonds rally ≥ 2%.', 'Whether İstanbul and Ağrı report new tremors.'],
});

export function briefFontFixtures() {
  return [
    { name: 'english', html: renderBriefMagazine(english) },
    { name: 'international', html: renderBriefMagazine(international) },
    { name: 'public', html: renderBriefMagazine(english, { publicMode: true, refCode: 'ABC123' }) },
    { name: 'share', html: renderBriefMagazine(english, { shareUrl: 'https://www.worldmonitor.app/api/brief/public/abc', followedCountries: ['IR', 'US'] }) },
  ];
}
