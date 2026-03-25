/**
 * Panel Titles Configuration
 *
 * Friendly panel title mappings with emoji and count display.
 * Used across all variants for consistent panel header formatting.
 */

export interface PanelTitleConfig {
  /** Emoji icon for the panel */
  emoji: string;
  /** Full title for desktop */
  title: string;
  /** Short title for mobile (optional, falls back to title) */
  shortTitle?: string;
}

/**
 * Panel title configurations for Ireland variant
 */
export const IRELAND_PANEL_TITLES: Record<string, PanelTitleConfig> = {
  ieTech: {
    emoji: '🇮🇪',
    title: 'Irish Tech News',
    shortTitle: 'Irish Tech',
  },
  ieAcademic: {
    emoji: '🎓',
    title: 'Academic Research',
    shortTitle: 'Academia',
  },
  ieSemiconductors: {
    emoji: '💎',
    title: 'Semiconductor Industry',
    shortTitle: 'Semiconductors',
  },
  ieDeals: {
    emoji: '🏢',
    title: 'Tech M&A',
    shortTitle: 'M&A',
  },
  ieJobs: {
    emoji: '💼',
    title: 'Big Tech Jobs',
    shortTitle: 'Jobs',
  },
  startups: {
    emoji: '🚀',
    title: 'Startups & VC',
    shortTitle: 'Startups',
  },
  ieSummits: {
    emoji: '🎤',
    title: 'Tech Summits',
    shortTitle: 'Summits',
  },
  ieBusiness: {
    emoji: '📊',
    title: 'Business News',
    shortTitle: 'Business',
  },
  ai: {
    emoji: '🤖',
    title: 'AI/ML Updates',
    shortTitle: 'AI/ML',
  },
};

/**
 * Default panel titles for other variants (fallback)
 */
export const DEFAULT_PANEL_TITLES: Record<string, PanelTitleConfig> = {
  politics: { emoji: '🌍', title: 'World News', shortTitle: 'World' },
  tech: { emoji: '💻', title: 'Technology', shortTitle: 'Tech' },
  finance: { emoji: '📈', title: 'Financial', shortTitle: 'Finance' },
  ai: { emoji: '🤖', title: 'AI/ML Updates', shortTitle: 'AI/ML' },
  startups: { emoji: '🚀', title: 'Startups & VC', shortTitle: 'Startups' },
  security: { emoji: '🔒', title: 'Cybersecurity', shortTitle: 'Security' },
  hardware: { emoji: '💎', title: 'Semiconductors & Hardware', shortTitle: 'Hardware' },
  cloud: { emoji: '☁️', title: 'Cloud & Infrastructure', shortTitle: 'Cloud' },
  dev: { emoji: '👨‍💻', title: 'Developer Community', shortTitle: 'Dev' },
  github: { emoji: '🐙', title: 'GitHub Trending', shortTitle: 'GitHub' },
  funding: { emoji: '💰', title: 'Funding & VC', shortTitle: 'Funding' },
  layoffs: { emoji: '📉', title: 'Layoffs Tracker', shortTitle: 'Layoffs' },
  ipo: { emoji: '📋', title: 'IPO & SPAC', shortTitle: 'IPO' },
  producthunt: { emoji: '🏆', title: 'Product Hunt', shortTitle: 'PH' },
  crypto: { emoji: '₿', title: 'Crypto', shortTitle: 'Crypto' },
  energy: { emoji: '⚡', title: 'Energy & Resources', shortTitle: 'Energy' },
  intel: { emoji: '🔍', title: 'Intel Feed', shortTitle: 'Intel' },
  gov: { emoji: '🏛️', title: 'Government', shortTitle: 'Gov' },
  middleeast: { emoji: '🕌', title: 'Middle East', shortTitle: 'MENA' },
  africa: { emoji: '🌍', title: 'Africa', shortTitle: 'Africa' },
  latam: { emoji: '🌎', title: 'Latin America', shortTitle: 'LatAm' },
  asia: { emoji: '🌏', title: 'Asia-Pacific', shortTitle: 'APAC' },
  thinktanks: { emoji: '🧠', title: 'Think Tanks', shortTitle: 'Think Tanks' },
  policy: { emoji: '📜', title: 'AI Policy & Regulation', shortTitle: 'Policy' },
  vcblogs: { emoji: '📝', title: 'VC Insights & Essays', shortTitle: 'VC Blogs' },
  regionalStartups: { emoji: '🌐', title: 'Global Startup News', shortTitle: 'Global' },
  unicorns: { emoji: '🦄', title: 'Unicorn Tracker', shortTitle: 'Unicorns' },
  accelerators: { emoji: '🎯', title: 'Accelerators & Demo Days', shortTitle: 'Accelerators' },
};

/**
 * Get panel title config for a given panel ID
 * @param panelId - Panel identifier
 * @param variant - Site variant (optional, defaults to checking Ireland first)
 * @returns Panel title config or undefined if not found
 */
export function getPanelTitleConfig(
  panelId: string,
  variant?: string
): PanelTitleConfig | undefined {
  // Check variant-specific config first
  if (variant === 'ireland' || IRELAND_PANEL_TITLES[panelId]) {
    const irelandConfig = IRELAND_PANEL_TITLES[panelId];
    if (irelandConfig) return irelandConfig;
  }

  // Fall back to default titles
  return DEFAULT_PANEL_TITLES[panelId];
}

/**
 * Format panel title with emoji and count
 * @param panelId - Panel identifier
 * @param count - Number of items (optional)
 * @param isMobile - Whether to use short title
 * @param variant - Site variant
 * @returns Formatted title string
 */
export function formatPanelTitle(
  panelId: string,
  count?: number,
  isMobile = false,
  variant?: string
): string {
  const config = getPanelTitleConfig(panelId, variant);
  if (!config) {
    // Fallback: capitalize panel ID
    const title = panelId.charAt(0).toUpperCase() + panelId.slice(1);
    return count !== undefined ? `${title} (${count})` : title;
  }

  const title = isMobile && config.shortTitle ? config.shortTitle : config.title;
  const formatted = `${config.emoji} ${title}`;
  return count !== undefined ? `${formatted} (${count})` : formatted;
}
