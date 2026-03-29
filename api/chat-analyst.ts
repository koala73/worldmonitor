/**
 * Streaming chat analyst edge function — Pro only.
 *
 * POST /api/chat-analyst
 * Body: { history: {role,content}[], query: string, domainFocus?: string, geoContext?: string }
 *
 * Returns text/event-stream SSE:
 *   data: {"delta":"..."}   — one per content token
 *   data: {"done":true}     — terminal event
 *   data: {"error":"..."}   — on auth/llm failure
 */

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders } from './_cors.js';
import { isCallerPremium } from '../server/_shared/premium-check';
import { assembleAnalystContext } from '../server/worldmonitor/intelligence/v1/chat-analyst-context';
import { buildAnalystSystemPrompt } from '../server/worldmonitor/intelligence/v1/chat-analyst-prompt';
import { callLlmReasoningStream } from '../server/_shared/llm';
import { sanitizeForPrompt } from '../server/_shared/llm-sanitize.js';

const MAX_QUERY_LEN = 500;
const MAX_HISTORY_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 800;
const MAX_GEO_LEN = 2;

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatAnalystRequestBody {
  history?: unknown[];
  query?: unknown;
  domainFocus?: unknown;
  geoContext?: unknown;
}

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

function sseError(message: string, cors: Record<string, string>): Response {
  const enc = new TextEncoder();
  const body = enc.encode(`data: ${JSON.stringify({ error: message })}\n\n`);
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store',
      'X-Accel-Buffering': 'no',
      ...cors,
    },
  });
}

export default async function handler(req: Request): Promise<Response> {
  const corsHeaders = getCorsHeaders(req) as Record<string, string>;

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-WorldMonitor-Key',
      },
    });
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405, corsHeaders);
  }

  const isPremium = await isCallerPremium(req);
  if (!isPremium) {
    return json({ error: 'Pro subscription required' }, 403, corsHeaders);
  }

  let body: ChatAnalystRequestBody;
  try {
    body = (await req.json()) as ChatAnalystRequestBody;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400, corsHeaders);
  }

  const rawQuery = typeof body.query === 'string' ? body.query.trim().slice(0, MAX_QUERY_LEN) : '';
  if (!rawQuery) return json({ error: 'query is required' }, 400, corsHeaders);

  const query = sanitizeForPrompt(rawQuery);
  if (!query) return json({ error: 'query is required' }, 400, corsHeaders);

  const domainFocus = typeof body.domainFocus === 'string' ? body.domainFocus.trim() : 'all';
  const geoContext = typeof body.geoContext === 'string'
    ? body.geoContext.trim().toUpperCase().slice(0, MAX_GEO_LEN)
    : undefined;

  const rawHistory = Array.isArray(body.history) ? body.history : [];
  const history: ChatMessage[] = rawHistory
    .filter((m): m is ChatMessage => {
      if (!m || typeof m !== 'object') return false;
      const msg = m as Record<string, unknown>;
      return (msg.role === 'user' || msg.role === 'assistant') && typeof msg.content === 'string';
    })
    .slice(-MAX_HISTORY_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS) }));

  const context = await assembleAnalystContext(geoContext, domainFocus);
  const systemPrompt = buildAnalystSystemPrompt(context, domainFocus);

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: query },
  ];

  const stream = callLlmReasoningStream({
    messages,
    maxTokens: 600,
    temperature: 0.35,
    timeoutMs: 90_000,
  });

  if (!stream) {
    return sseError('llm_unavailable', corsHeaders);
  }

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store',
      'X-Accel-Buffering': 'no',
      ...corsHeaders,
    },
  });
}
