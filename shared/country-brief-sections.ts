export const BRIEF_TOPICS = {
  overview: 'Overview',
  all: 'All sections',
  resilience: 'Resilience',
  security: 'Security',
  economy: 'Economy & trade',
  resources: 'Resources & infrastructure',
  society: 'Society',
  sources: 'Sources',
} as const;

export type BriefTopic = keyof typeof BRIEF_TOPICS;
export type BriefSectionState = 'loading' | 'ready' | 'unavailable' | 'locked';

export const BRIEF_SECTIONS = {
  assessment: ['overview', 'sources'],
  facts: ['overview', 'society'],
  factors: ['overview', 'resilience'],
  demographics: ['society', 'resilience'],
  food: ['resources', 'resilience'],
  energy: ['resources', 'resilience'],
  maritime: ['resources', 'economy'],
  trade: ['economy'],
  commodities: ['resources', 'economy'],
  scenario: ['economy'],
  products: ['economy'],
  debt: ['economy'],
  sanctions: ['security'],
  flows: ['economy'],
  tariffs: ['economy'],
  signals: ['security'],
  timeline: ['security'],
  news: ['overview', 'security', 'sources'],
  military: ['security'],
  infrastructure: ['resources', 'security'],
  economic: ['economy'],
  housing: ['economy'],
  markets: ['economy'],
  china: ['overview', 'economy', 'security'],
} as const satisfies Record<string, readonly BriefTopic[]>;

export type BriefSectionId = keyof typeof BRIEF_SECTIONS;
