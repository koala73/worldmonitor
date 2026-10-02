export interface DigestLike {
  categories?: Record<string, { items?: unknown[] } | null>;
}

export declare function countDigestItems(data: DigestLike): number;
export declare function isAcceptableDigest(data: DigestLike | null | undefined): boolean;
