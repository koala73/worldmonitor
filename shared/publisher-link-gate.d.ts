export declare function normalizeLinkHostname(hostname: unknown): string;
export declare function linkHostname(link: unknown): string;
export declare function isPublisherLink(link: unknown, expectedHosts: Iterable<string> | null | undefined): boolean;
export declare function feedPublisherHost(feedUrl: unknown): string;
