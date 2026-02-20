import type {
  ServerContext,
  SummarizeHeadlinesRequest,
  SummarizeHeadlinesResponse,
} from '../../../../../src/generated/server/worldmonitor/news/v1/service_server';

export async function summarizeHeadlines(
  _ctx: ServerContext,
  _req: SummarizeHeadlinesRequest,
): Promise<SummarizeHeadlinesResponse> {
  // This RPC is called by the service module for server-side summarization.
  // The client still has a browser T5 fallback if both providers fail.
  // The request doesn't carry headlines directly -- they come from the client.
  // For now, return empty (summarization stays client-side calling existing edge functions).
  // TODO: Once headline relay is implemented, consolidate here.
  return { summary: undefined };
}
