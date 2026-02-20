import type {
  ServerContext,
  SummarizeHeadlinesRequest,
  SummarizeHeadlinesResponse,
} from '../../../../src/generated/server/worldmonitor/news/v1/service_server';

export async function summarizeHeadlines(
  _ctx: ServerContext,
  _req: SummarizeHeadlinesRequest,
): Promise<SummarizeHeadlinesResponse> {
  // Headlines summarization is handled client-side or via SummarizeArticle RPC.
  // TODO: Implement when headline relay is built.
  throw new Error('UNIMPLEMENTED: SummarizeHeadlines — use SummarizeArticle RPC instead');
}
