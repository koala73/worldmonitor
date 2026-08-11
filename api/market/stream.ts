/**
 * Same-origin stock stream. This endpoint never accepts or exposes an upstream
 * provider key: the server-side relay owns Massive authentication.
 */

// @ts-expect-error JavaScript helper has no declaration file.
import { getCorsHeaders, isDisallowedOrigin } from '../_cors.js';
import {
  getSharedMarketStockStreamRelay,
  serializeMarketStreamEvent,
} from '../../server/worldmonitor/market/v1/market-stream-relay';
import { normalizeStockSymbol } from '../../server/worldmonitor/market/v1/stock-data-contract';

export const config = { runtime: 'nodejs' };

function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

export default function marketStream(req: Request): Response {
  const corsHeaders = getCorsHeaders(req, 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { ...corsHeaders, Allow: 'GET, OPTIONS' });
  if (isDisallowedOrigin(req)) return json({ error: 'origin_not_allowed' }, 403, corsHeaders);

  const url = new URL(req.url);
  let symbol: string;
  try {
    symbol = normalizeStockSymbol(url.searchParams.get('symbol') ?? '');
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'invalid symbol' }, 400, corsHeaders);
  }

  const relay = getSharedMarketStockStreamRelay();
  if (!relay.configured) {
    return json({
      symbol,
      provider: 'massive',
      providerStatus: 'PROVIDER_STATUS_NOT_CONFIGURED',
      message: 'MASSIVE_API_KEY is not configured. No stream or synthetic update was opened.',
    }, 503, corsHeaders);
  }
  if (!relay.realtimeEntitled) {
    return json({
      symbol,
      provider: 'massive',
      providerStatus: 'PROVIDER_STATUS_DELAYED_UNVERIFIED',
      message: 'Real-time display and redistribution entitlement is not confirmed; live streaming is intentionally disabled.',
    }, 409, corsHeaders);
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let abortHandler: (() => void) | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        unsubscribe?.();
        unsubscribe = null;
        if (abortHandler) req.signal.removeEventListener('abort', abortHandler);
        abortHandler = null;
        try { controller.close(); } catch { /* stream already closed */ }
      };
      abortHandler = close;
      req.signal.addEventListener('abort', abortHandler, { once: true });
      unsubscribe = relay.subscribe(symbol, event => controller.enqueue(encoder.encode(serializeMarketStreamEvent(event))));
      controller.enqueue(encoder.encode(`: market stream subscribed for ${symbol}\n\n`));
    },
    cancel() {
      unsubscribe?.();
      unsubscribe = null;
      if (abortHandler) req.signal.removeEventListener('abort', abortHandler);
      abortHandler = null;
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
      ...corsHeaders,
    },
  });
}
