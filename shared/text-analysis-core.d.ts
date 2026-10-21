export declare const SIMILARITY_THRESHOLD: number;
export declare const STOP_WORDS: Set<string>;
export declare const TOPIC_KEYWORDS: string[];
export declare const SUPPRESSED_TRENDING_TERMS: Set<string>;

export declare function tokenize(text: string): Set<string>;
export declare function jaccardSimilarity(a: Set<string>, b: Set<string>): number;
export declare function includesKeyword(text: string, keywords: string[]): boolean;
export declare function escapeRegex(value: string): string;
export declare function containsTopicKeyword(text: string, keyword: string): boolean;
