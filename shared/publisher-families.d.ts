export interface PublisherFamily {
  publisher: string;
  labels: string[];
}

export declare const PUBLISHER_FAMILIES: Readonly<Record<string, PublisherFamily>>;
export declare const MIN_CORROBORATING_PUBLISHERS: number;

export declare function publisherFamilyFor(label: unknown): string;
export declare function publisherFamiliesFor(labels: unknown): Set<string>;
export declare function countPublisherFamilies(labels: unknown): number;
export declare function publisherNameForFamily(familyId: unknown): string;
