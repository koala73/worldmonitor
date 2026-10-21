// Declaration file for brief-dedup-jaccard.mjs so TS callers don't need
// `// @ts-expect-error`. Hand-written, same as
// scripts/_simulation-queue-constants.d.mts.
//
// The module is dependency-free, which is why server/_shared/intel-history-
// client.ts can import `stripSourceSuffix` from it on the Vercel Edge runtime:
// the outlet allow-list has to stay single-sourced with the seed writer's
// normalization or query and stored vectors drift apart.

/** A story as the dedup path handles it (input to the clustering helpers). */
export interface JaccardStory {
  title: string;
  currentScore: number;
  mentionCount: number;
  hash: string;
}

/** A cluster representative: the input story plus its merged-hash trail. */
export interface JaccardClusterRepresentative extends JaccardStory {
  mergedHashes: string[];
}

export function stripSourceSuffix(title: string): string;
export function extractTitleWords(title: string): Set<string>;
export function jaccardSimilarity(setA: Set<string>, setB: Set<string>): number;
export function materializeCluster(items: JaccardStory[]): JaccardClusterRepresentative;
export function deduplicateStoriesJaccard(stories: JaccardStory[]): JaccardClusterRepresentative[];
