// ── Pipeline Types ────────────────────────────────────────────────────────

export interface NormalizedStory {
  id: string;              // SHA-256 hash of (source + url)
  title: string;           // Original headline, trimmed
  cleanTitle: string;      // Lowercase, stop-words removed
  source: string;          // Feed name
  sourceTier: number;      // 1-4 tier from feeds.ts SOURCE_TIERS
  url: string;             // Original article URL
  publishedAt: Date;       // From RSS pubDate
  ingestedAt: Date;        // When first seen
  region: string;          // From feed config
  category: string;        // Feed category
  keywords: string[];      // Top-5 keywords
  threatLevel: string;     // 'low' | 'medium' | 'high' | 'critical' | 'info'
  clusterId: string | null;
  imageUrl: string | null;
  lang: string;            // ISO language code
}

export interface StoryCluster {
  clusterId: string;
  primaryStoryId: string;
  primaryTitle: string;
  storyIds: string[];
  sourceCount: number;
  topSources: { name: string; tier: number; url: string }[];
  firstSeen: Date;
  lastUpdated: Date;
  region: string;
  categories: string[];
  mergedKeywords: string[];
  threatLevel: string;
  velocityScore: number;
}

export interface CachedNarration {
  clusterId: string;
  shortSummary: string;
  newsBrief: string;
  anchorNarration: string | null;
  generatedAt: Date;
  expiresAt: Date;
  sourceCountAtGen: number;
  provider: string;
  model: string;
  tokensUsed: number;
}

export interface AIProviderConfig {
  provider: string;     // 'openai' | 'groq' | 'openrouter' | 'ollama' | 'custom'
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
  validated: boolean;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// ── Settings Types ────────────────────────────────────────────────────────

export type ThemePreference = 'light' | 'dark' | 'system';
export type ViewMode = 'reader' | 'dashboard';
export type FontSize = 'small' | 'medium' | 'large';

export interface UserSettings {
  theme: ThemePreference;
  viewMode: ViewMode;
  fontSize: FontSize;
  autoNarrate: boolean;
  feedRefreshInterval: number;
  cacheDuration: number;
  clusteringSensitivity: number;
  maxAiTokens: number;
  debugMode: boolean;
  enabledCategories: string[];
}

export const DEFAULT_SETTINGS: UserSettings = {
  theme: 'dark',
  viewMode: 'reader',
  fontSize: 'medium',
  autoNarrate: true,
  feedRefreshInterval: 5,
  cacheDuration: 7,
  clusteringSensitivity: 0.6,
  maxAiTokens: 300,
  debugMode: false,
  enabledCategories: [],
};

// Provider base URLs
export const PROVIDER_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  ollama: 'http://localhost:11434/v1',
  together: 'https://api.together.xyz/v1',
  fireworks: 'https://api.fireworks.ai/inference/v1',
};
