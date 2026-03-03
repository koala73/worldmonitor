import { SITE_VARIANT } from './variant';

export interface LayoutPreset {
  id: string;
  labelKey: string;
  icon: string;
  panelKeys: string[];
}

const FULL_LAYOUTS: LayoutPreset[] = [
  {
    id: 'intelligence-analyst',
    labelKey: 'layouts.intelligenceAnalyst',
    icon: '🔍',
    panelKeys: [
      'map', 'live-news', 'insights', 'strategic-posture', 'cii',
      'strategic-risk', 'intel', 'gdelt-intel', 'cascade', 'telegram-intel',
      'monitors', 'satellite-fires', 'displacement', 'oref-sirens',
    ],
  },
  {
    id: 'market-watch',
    labelKey: 'layouts.marketWatch',
    icon: '📈',
    panelKeys: [
      'map', 'live-news', 'insights', 'markets', 'commodities', 'crypto',
      'economic', 'macro-signals', 'etf-flows', 'stablecoins',
      'gulf-economies', 'heatmap', 'polymarket', 'finance',
    ],
  },
  {
    id: 'breaking-news',
    labelKey: 'layouts.breakingNews',
    icon: '📰',
    panelKeys: [
      'map', 'live-news', 'live-webcams', 'insights', 'politics', 'us',
      'europe', 'middleeast', 'africa', 'latam', 'asia',
    ],
  },
  {
    id: 'minimal',
    labelKey: 'layouts.minimal',
    icon: '◯',
    panelKeys: ['map', 'live-news', 'insights', 'strategic-posture'],
  },
];

const TECH_LAYOUTS: LayoutPreset[] = [
  {
    id: 'tech-overview',
    labelKey: 'layouts.techOverview',
    icon: '💻',
    panelKeys: [
      'map', 'live-news', 'insights', 'ai', 'tech', 'hardware', 'cloud',
      'dev', 'github', 'producthunt', 'service-status', 'tech-readiness',
    ],
  },
  {
    id: 'startup-investor',
    labelKey: 'layouts.startupInvestor',
    icon: '🚀',
    panelKeys: [
      'map', 'live-news', 'insights', 'startups', 'vcblogs', 'unicorns',
      'accelerators', 'funding', 'ipo', 'regionalStartups',
    ],
  },
  {
    id: 'tech-minimal',
    labelKey: 'layouts.minimal',
    icon: '◯',
    panelKeys: ['map', 'live-news', 'insights', 'ai', 'tech'],
  },
];

const FINANCE_LAYOUTS: LayoutPreset[] = [
  {
    id: 'full-markets',
    labelKey: 'layouts.fullMarkets',
    icon: '📊',
    panelKeys: [
      'map', 'live-news', 'insights', 'markets', 'markets-news', 'forex',
      'bonds', 'commodities', 'crypto', 'centralbanks', 'economic',
      'heatmap', 'macro-signals',
    ],
  },
  {
    id: 'crypto-focus',
    labelKey: 'layouts.cryptoFocus',
    icon: '₿',
    panelKeys: [
      'map', 'live-news', 'insights', 'crypto', 'crypto-news', 'etf-flows',
      'stablecoins', 'fintech', 'markets', 'macro-signals',
    ],
  },
  {
    id: 'finance-minimal',
    labelKey: 'layouts.minimal',
    icon: '◯',
    panelKeys: ['map', 'live-news', 'insights', 'markets', 'economic'],
  },
];

const HAPPY_LAYOUTS: LayoutPreset[] = [
  {
    id: 'happy-all',
    labelKey: 'layouts.allGoodNews',
    icon: '☀️',
    panelKeys: [
      'map', 'positive-feed', 'progress', 'counters', 'spotlight',
      'breakthroughs', 'digest', 'species', 'renewable', 'giving',
    ],
  },
  {
    id: 'happy-minimal',
    labelKey: 'layouts.minimal',
    icon: '◯',
    panelKeys: ['map', 'positive-feed', 'digest', 'progress'],
  },
];

export const LAYOUT_PRESETS: LayoutPreset[] =
  SITE_VARIANT === 'happy' ? HAPPY_LAYOUTS
  : SITE_VARIANT === 'tech' ? TECH_LAYOUTS
  : SITE_VARIANT === 'finance' ? FINANCE_LAYOUTS
  : FULL_LAYOUTS;

export const LAYOUT_STORAGE_KEY = 'worldmonitor-active-layout';
export const LAYOUT_OVERRIDES_PREFIX = 'worldmonitor-layout-overrides-';
