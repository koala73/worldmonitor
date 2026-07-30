export declare const CVE_PATTERN: RegExp;
export declare const APT_PATTERN: RegExp;
export declare const FIN_PATTERN: RegExp;
export declare const LEADER_NAMES: string[];
export declare const LEADER_PATTERNS: Array<{ name: string; pattern: RegExp }>;

export declare const ROLLING_WINDOW_MS: number;
export declare const BASELINE_WINDOW_MS: number;
export declare const MIN_TOKEN_LENGTH: number;
export declare const MIN_SPIKE_SOURCE_COUNT: number;
export declare const DEFAULT_MIN_SPIKE_COUNT: number;
export declare const DEFAULT_SPIKE_MULTIPLIER: number;

export interface TermCandidate {
  display: string;
  isEntity: boolean;
}

export interface SpikeDecisionInput {
  recentCount: number;
  baseline: number;
  minSpikeCount: number;
  spikeMultiplier: number;
}

export interface SpikeDecision {
  isSpike: boolean;
  multiplier: number;
}

export interface CorpusStory {
  title: string;
  lastSeenMs: number;
  sources?: string[];
}

export interface CorpusSpike {
  term: string;
  count: number;
  baseline: number;
  multiplier: number;
  windowMs: number;
  uniqueSources: number;
  sampleHeadlines: string[];
}

export declare function toTermKey(term: string): string;
export declare function asDisplayTerm(term: string): string;
export declare function isEntityShapedTerm(term: string): boolean;
export declare function extractEntities(text: string): string[];
export declare function stripSourceAttribution(title: string): string;
export declare function buildBaseTermCandidates(title: string): Map<string, TermCandidate>;
export declare function isLikelyProperNoun(term: string, headlines: Array<{ title: string }>): boolean;
export declare function evaluateSpikeDecision(input: SpikeDecisionInput): SpikeDecision;
export declare function computeKeywordSpikesFromStories(
  stories: CorpusStory[],
  opts: {
    nowMs: number;
    windowMs?: number;
    baselineDurationMs: number;
    minSpikeCount?: number;
    spikeMultiplier?: number;
    blockedTerms?: Set<string>;
    maxSampleHeadlines?: number;
  },
): CorpusSpike[];
