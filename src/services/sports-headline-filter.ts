import type { NewsItem } from '@/types';

const SPORTS_SIGNAL_TERMS = [
  'sport',
  'sports',
  'football',
  'soccer',
  'basketball',
  'baseball',
  'tennis',
  'golf',
  'cricket',
  'rugby',
  'hockey',
  'mma',
  'ufc',
  'boxing',
  'wrestling',
  'formula 1',
  'f1',
  'nascar',
  'motorsport',
  'nba',
  'nfl',
  'nhl',
  'mlb',
  'team',
  'player',
  'coach',
  'fixture',
  'match',
  'standings',
  'playoff',
  'playoffs',
  'tournament',
  'transfer',
  'goal',
  'score',
  'grand prix',
  'world cup',
  'champions league',
  'olympic',
];

const POLITICAL_NOISE_TERMS = [
  'politics',
  'political',
  'election',
  'elections',
  'campaign',
  'vote',
  'voter',
  'government',
  'parliament',
  'congress',
  'senate',
  'white house',
  'prime minister',
  'president',
  'cabinet',
  'policy',
  'diplomatic',
  'diplomacy',
  'ceasefire',
  'tariff',
  'sanctions',
];

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function containsAnyKeyword(text: string, keywords: string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword));
}

export function isOffTopicSportsPoliticalHeadline(item: Pick<NewsItem, 'title' | 'source'>): boolean {
  const normalizedSourceAndTitle = normalizeText(`${item.source} ${item.title}`);
  const normalizedTitle = normalizeText(item.title);
  const hasPoliticalSignal = containsAnyKeyword(normalizedSourceAndTitle, POLITICAL_NOISE_TERMS);
  if (!hasPoliticalSignal) return false;

  const hasSportsSignal = containsAnyKeyword(normalizedTitle, SPORTS_SIGNAL_TERMS);
  return !hasSportsSignal;
}

export function filterSportsHeadlineNoise(items: NewsItem[]): NewsItem[] {
  return items.filter((item) => !isOffTopicSportsPoliticalHeadline(item));
}
