// Stub: trending-keywords removed in REITs-only variant

export interface HeadlineInput {
  title: string;
  pubDate: Date;
  source: string;
  link: string;
}

export function ingestHeadlines(_items: HeadlineInput[]): void {
  // no-op in REITs-only mode
}
