import { SITE_VARIANT } from '@/config/variant';
import { VARIANT_META } from '@/config/variant-meta';

interface StoryMeta {
  countryCode: string;
  countryName: string;
  ciiScore?: number;
  ciiLevel?: string;
  trend?: string;
  type: 'ciianalysis' | 'crisisalert' | 'dailybrief' | 'marketfocus';
}

const variantMeta = VARIANT_META[SITE_VARIANT] ?? VARIANT_META.full;
const BASE_URL = variantMeta.url.replace(/\/$/, '');
const DEFAULT_IMAGE = `${BASE_URL}/favico/${SITE_VARIANT === 'full' ? '' : SITE_VARIANT + '/'}og-image.png`;

export function updateMetaTagsForStory(meta: StoryMeta): void {
  const { countryCode, countryName, ciiScore, ciiLevel, trend, type } = meta;

  const title = `${countryName} Intelligence Brief | ${variantMeta.siteName}`;
  const description = generateDescription(ciiScore, ciiLevel, trend, type, countryName);
  const storyUrl = `${BASE_URL}/api/story?c=${countryCode}&t=${type}`;
  let imageUrl = `${BASE_URL}/api/og-story?c=${countryCode}&t=${type}`;
  if (ciiScore !== undefined) imageUrl += `&s=${ciiScore}`;
  if (ciiLevel) imageUrl += `&l=${ciiLevel}`;

  setMetaTag('title', title);
  setMetaTag('description', description);
  setCanonicalLink(storyUrl);

  setMetaTag('og:title', title);
  setMetaTag('og:description', description);
  setMetaTag('og:url', storyUrl);
  setMetaTag('og:image', imageUrl);

  setMetaTag('twitter:title', title);
  setMetaTag('twitter:description', description);
  setMetaTag('twitter:url', storyUrl);
  setMetaTag('twitter:image', imageUrl);

  sessionStorage.setItem('storyMeta', JSON.stringify(meta));
}

export function resetMetaTags(): void {
  document.title = variantMeta.title;

  setMetaTag('title', variantMeta.title);
  setMetaTag('description', variantMeta.description);
  setCanonicalLink(BASE_URL + '/');
  setMetaTag('og:title', variantMeta.title);
  setMetaTag('og:description', variantMeta.description);
  setMetaTag('og:url', BASE_URL + '/');
  setMetaTag('og:image', DEFAULT_IMAGE);
  setMetaTag('twitter:title', variantMeta.title);
  setMetaTag('twitter:description', variantMeta.description);
  setMetaTag('twitter:url', BASE_URL + '/');
  setMetaTag('twitter:image', DEFAULT_IMAGE);

  sessionStorage.removeItem('storyMeta');
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

  return `${variantMeta.siteName} ${parts.join('. ')}. Free, open-source geopolitical intelligence.`;
}

function setMetaTag(property: string, content: string): void {
  const existing = document.querySelector(`meta[property="${property}"], meta[name="${property}"]`);
  if (existing) existing.remove();

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

export function parseStoryParams(url: URL): StoryMeta | null {
  const countryCode = url.searchParams.get('c');
  const type = url.searchParams.get('t') || 'ciianalysis';

  if (!countryCode || !/^[A-Z]{2,3}$/i.test(countryCode)) return null;

  const validTypes: StoryMeta['type'][] = ['ciianalysis', 'crisisalert', 'dailybrief', 'marketfocus'];
  const safeType: StoryMeta['type'] = validTypes.includes(type as StoryMeta['type'])
    ? (type as StoryMeta['type'])
    : 'ciianalysis';

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
