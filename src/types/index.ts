export type PropagandaRisk = 'low' | 'medium' | 'high';

export interface Feed {
  name: string;
  url: string | Record<string, string>;
  type?: string;
  region?: string;
  propagandaRisk?: PropagandaRisk;
  stateAffiliated?: string;
  lang?: string;
}

export type { ThreatClassification, ThreatLevel, EventCategory } from '@/ingestion/threat-classifier';

export interface NewsItem {
  source: string;
  title: string;
  link: string;
  pubDate: Date;
  isAlert: boolean;
  tier?: number;
  threat?: import('@/ingestion/threat-classifier').ThreatClassification;
  imageUrl?: string;
  lang?: string;
}

// Re-export pipeline types
export type {
  NormalizedStory,
  StoryCluster,
  CachedNarration,
  AIProviderConfig,
  ChatMessage,
  ThemePreference,
  ViewMode,
  FontSize,
  UserSettings,
} from './news-reader';

export { DEFAULT_SETTINGS, PROVIDER_URLS } from './news-reader';
