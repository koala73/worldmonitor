// Dynamic Meta Tags Service for World Monitor
// Updates OG tags and Twitter Cards for shared stories

interface StoryMeta {
  countryCode: string;
  countryName: string;
  ciiScore?: number;
  ciiLevel?: string;
  trend?: string;
  type: 'ciianalysis' | 'crisisalert' | 'dailybrief' | 'marketfocus';
}

const BASE_URL = 'https://worldmonitor.app';
const DEFAULT_IMAGE = 'https://worldmonitor.app/favico/og-image.png';

export function updateMetaTagsForStory(meta: StoryMeta): void {
  const { countryCode, countryName, ciiScore, ciiLevel, trend, type } = meta;
  
  // Generate dynamic content
  const title = `${countryName} Intelligence Brief | World Monitor`;
  const description = generateDescription(ciiScore, ciiLevel, trend, type, countryName);
  const storyUrl = `${BASE_URL}/api/story?c=${countryCode}&t=${type}`;
  let imageUrl = `${BASE_URL}/api/og-story?c=${countryCode}&t=${type}`;
  if (ciiScore !== undefined) imageUrl += `&s=${ciiScore}`;
  if (ciiLevel) imageUrl += `&l=${ciiLevel}`;
  
  // Update standard meta tags
  setMetaTag('title', title);
  setMetaTag('description', description);
  setCanonicalLink(storyUrl);
  
  // Update Open Graph
  setMetaTag('og:title', title);
  setMetaTag('og:description', description);
  setMetaTag('og:url', storyUrl);
  setMetaTag('og:image', imageUrl);
  
  // Update Twitter Cards
  setMetaTag('twitter:title', title);
  setMetaTag('twitter:description', description);
  setMetaTag('twitter:url', storyUrl);
  setMetaTag('twitter:image', imageUrl);
  
  // Store in session for og-image API
  sessionStorage.setItem('storyMeta', JSON.stringify(meta));
  
  console.log('[MetaTags] Updated for story:', countryName);
}

export function resetMetaTags(): void {
  const defaultTitle = 'World Monitor - Global Situation with AI Insights';
  const defaultDesc = 'AI-powered real-time global intelligence dashboard with live news, markets, military tracking, and geopolitical data.';
  
  setMetaTag('title', defaultTitle);
  setMetaTag('description', defaultDesc);
  setCanonicalLink(BASE_URL);
  setMetaTag('og:title', defaultTitle);
  setMetaTag('og:description', defaultDesc);
  setMetaTag('og:url', BASE_URL);
  setMetaTag('og:image', DEFAULT_IMAGE);
  setMetaTag('twitter:title', defaultTitle);
  setMetaTag('twitter:description', defaultDesc);
  setMetaTag('twitter:url', BASE_URL);
  setMetaTag('twitter:image', DEFAULT_IMAGE);
  
  sessionStorage.removeItem('storyMeta');
  console.log('[MetaTags] Reset to defaults');
}

function generateDescription(
  score?: number,
  level?: string,
  trend?: string,
  type?: string,
  countryName?: string
): string {
  const parts: string[] = [];
  
  if (score !== undefined && level) {
    parts.push(`${countryName} has an instability score of ${score}/100 (${level})`);
  }
  
  if (trend) {
    const trendText = trend === 'rising' ? 'trending upward' : trend === 'falling' ? 'trending downward' : 'stable';
    parts.push(`Risk is ${trendText}`);
  }
  
  const typeDescriptions: Record<string, string> = {
    ciianalysis: 'Full intelligence analysis with military posture and prediction markets',
    crisisalert: 'Crisis-focused briefing with convergence alerts',
    dailybrief: 'AI-synthesized daily briefing of top stories',
    marketfocus: 'Prediction market probabilities and market-moving events',
  };
  
  if (type && typeDescriptions[type]) {
    parts.push(typeDescriptions[type]);
  }
  
  return `World Monitor ${parts.join('. ')}. Free, open-source geopolitical intelligence.`;
}

function setMetaTag(property: string, content: string): void {
  // Remove existing tag
  const existing = document.querySelector(`meta[property="${property}"], meta[name="${property}"]`);
  if (existing) existing.remove();
  
  // Create new tag
  const meta = document.createElement('meta');
  if (property.startsWith('og:') || property.startsWith('twitter:')) {
    meta.setAttribute('property', property);
  } else {
    meta.setAttribute('name', property);
  }
  meta.setAttribute('content', content);
  document.head.appendChild(meta);
}

function setCanonicalLink(href: string): void {
  let link = document.querySelector('link[rel="canonical"]') as HTMLLinkElement;
  if (!link) {
    link = document.createElement('link');
    link.setAttribute('rel', 'canonical');
    document.head.appendChild(link);
  }
  link.setAttribute('href', href);
}

// Parse URL params for story pages
export function parseStoryParams(url: URL): StoryMeta | null {
  const countryCode = url.searchParams.get('c');
  const type = url.searchParams.get('t') || 'ciianalysis';

  if (!countryCode || !/^[A-Z]{2,3}$/i.test(countryCode)) return null;

  const validTypes: StoryMeta['type'][] = ['ciianalysis', 'crisisalert', 'dailybrief', 'marketfocus'];
  const safeType: StoryMeta['type'] = validTypes.includes(type as StoryMeta['type'])
    ? (type as StoryMeta['type'])
    : 'ciianalysis';
  
  // Get country name from mapping (would normally come from data)
  const countryNames: Record<string, string> = {
    UA: 'Ukraine', RU: 'Russia', CN: 'China', US: 'United States',
    IR: 'Iran', IL: 'Israel', TW: 'Taiwan', KP: 'North Korea',
    SA: 'Saudi Arabia', TR: 'Turkey', PL: 'Poland', DE: 'Germany',
    FR: 'France', GB: 'United Kingdom', IN: 'India', PK: 'Pakistan',
    SY: 'Syria', YE: 'Yemen', MM: 'Myanmar', VE: 'Venezuela',
  };
  
  return {
    countryCode: countryCode.toUpperCase(),
    countryName: countryNames[countryCode.toUpperCase()] || countryCode.toUpperCase(),
    type: safeType,
  };
}

// Initialize on page load
export function initMetaTags(): void {
  const url = new URL(window.location.href);
  
  if (url.pathname === '/story' || url.searchParams.has('c')) {
    const params = parseStoryParams(url);
    if (params) {
      updateMetaTagsForStory(params);
    }
  } else {
    resetMetaTags();
  }
}
