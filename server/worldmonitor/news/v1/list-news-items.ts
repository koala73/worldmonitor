import type {
  ServerContext,
  ListNewsItemsRequest,
  ListNewsItemsResponse,
} from '../../../../src/generated/server/worldmonitor/news/v1/service_server';

export async function listNewsItems(
  _ctx: ServerContext,
  _req: ListNewsItemsRequest,
): Promise<ListNewsItemsResponse> {
  // RSS feed parsing requires DOMParser (browser-only).
  // Client-side rss.ts continues to handle this via proxy URLs.
  throw new Error('UNIMPLEMENTED: ListNewsItems — RSS parsing is client-side only');
}
