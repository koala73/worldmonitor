// Positive content classifier for the happy variant
// Mirrors the pattern in threat-classifier.ts but for positive news categorization

export type { HappyContentCategory } from '@/types';
import type { HappyContentCategory } from '@/types';

export const HAPPY_CATEGORY_LABELS: Record<HappyContentCategory, string> = {
  'science-health': 'Science & Health',
  'nature-wildlife': 'Nature & Wildlife',
  'humanity-kindness': 'Humanity & Kindness',
  'innovation-tech': 'Innovation & Tech',
  'climate-wins': 'Climate Wins',
  'culture-community': 'Culture & Community',
};

export const HAPPY_CATEGORY_ALL: HappyContentCategory[] = [
  'science-health',
  'nature-wildlife',
  'humanity-kindness',
  'innovation-tech',
  'climate-wins',
  'culture-community',
];

// Source-based pre-classification: feed name -> category
// Checked before keyword scan for GNN category feeds
const SOURCE_CATEGORY_MAP: Record<string, HappyContentCategory> = {
  'GNN Science': 'science-health',
  'GNN Health': 'science-health',
  'GNN Animals': 'nature-wildlife',
  'GNN Heroes': 'humanity-kindness',
};

// Priority-ordered keyword classification tuples
// Most specific keywords first to avoid mis-classification
// (e.g., "endangered species" should match nature before generic "technology")
const CATEGORY_KEYWORDS: Array<[string, HappyContentCategory]> = [
  // Science & Health (most specific first)
  ['clinical trial', 'science-health'],
  ['study finds', 'science-health'],
  ['researchers', 'science-health'],
  ['scientists', 'science-health'],
  ['breakthrough', 'science-health'],
  ['discovery', 'science-health'],
  ['cure', 'science-health'],
  ['vaccine', 'science-health'],
  ['treatment', 'science-health'],
  ['medical', 'science-health'],
  ['therapy', 'science-health'],
  ['cancer', 'science-health'],
  ['disease', 'science-health'],

  // Nature & Wildlife
  ['endangered species', 'nature-wildlife'],
  ['conservation', 'nature-wildlife'],
  ['wildlife', 'nature-wildlife'],
  ['species', 'nature-wildlife'],
  ['marine', 'nature-wildlife'],
  ['reef', 'nature-wildlife'],
  ['forest', 'nature-wildlife'],
  ['whale', 'nature-wildlife'],
  ['bird', 'nature-wildlife'],
  ['animal', 'nature-wildlife'],

  // Climate Wins (before innovation so "solar" matches climate, not tech)
  ['renewable', 'climate-wins'],
  ['solar', 'climate-wins'],
  ['wind energy', 'climate-wins'],
  ['wind farm', 'climate-wins'],
  ['electric vehicle', 'climate-wins'],
  ['emissions', 'climate-wins'],
  ['carbon', 'climate-wins'],
  ['clean energy', 'climate-wins'],
  ['climate', 'climate-wins'],
  ['green hydrogen', 'climate-wins'],

  // Innovation & Tech
  ['robot', 'innovation-tech'],
  ['technology', 'innovation-tech'],
  ['startup', 'innovation-tech'],
  ['invention', 'innovation-tech'],
  ['innovation', 'innovation-tech'],
  ['engineering', 'innovation-tech'],
  ['3d print', 'innovation-tech'],
  ['artificial intelligence', 'innovation-tech'],
  [' ai ', 'innovation-tech'],

  // Humanity & Kindness
  ['volunteer', 'humanity-kindness'],
  ['donated', 'humanity-kindness'],
  ['charity', 'humanity-kindness'],
  ['rescued', 'humanity-kindness'],
  ['hero', 'humanity-kindness'],
  ['kindness', 'humanity-kindness'],
  ['helping', 'humanity-kindness'],
  ['community', 'humanity-kindness'],

  // Culture & Community
  [' art ', 'culture-community'],
  ['music', 'culture-community'],
  ['festival', 'culture-community'],
  ['cultural', 'culture-community'],
  ['education', 'culture-community'],
  ['school', 'culture-community'],
  ['library', 'culture-community'],
  ['museum', 'culture-community'],
];

/**
 * Classify a positive news story by its title using keyword matching.
 * Returns the first matching category, or 'humanity-kindness' as default
 * (safe default for curated positive sources).
 */
export function classifyPositiveContent(title: string): HappyContentCategory {
  // Pad with spaces so space-delimited keywords (e.g. ' ai ') match at boundaries
  const lower = ` ${title.toLowerCase()} `;
  for (const [keyword, category] of CATEGORY_KEYWORDS) {
    if (lower.includes(keyword)) return category;
  }
  return 'humanity-kindness'; // default for curated positive sources
}

/**
 * Classify a news item using source-based pre-mapping (fast path)
 * then falling back to keyword classification (slow path).
 */
export function classifyNewsItem(source: string, title: string): HappyContentCategory {
  // Fast path: source name maps directly to a category
  const sourceCategory = SOURCE_CATEGORY_MAP[source];
  if (sourceCategory) return sourceCategory;
  // Slow path: keyword classification from title
  return classifyPositiveContent(title);
}
