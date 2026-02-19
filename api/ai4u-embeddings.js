import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { getAi4uApiKey, postAi4u } from './_ai4u.js';

export const config = {
  runtime: 'edge',
};

const MODEL = String(process.env.AI4U_EMBEDDING_MODEL || 'text-embedding-005').trim() || 'text-embedding-005';

function normalizeInputs(payload) {
  if (Array.isArray(payload?.texts)) {
    return payload.texts.filter((text) => typeof text === 'string' && text.trim().length > 0);
  }

  if (Array.isArray(payload?.input)) {
    return payload.input.filter((text) => typeof text === 'string' && text.trim().length > 0);
  }

  if (typeof payload?.input === 'string' && payload.input.trim().length > 0) {
    return [payload.input.trim()];
  }

  return [];
}

export default async function handler(request) {
  const corsHeaders = getCorsHeaders(request, 'POST, OPTIONS');

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (isDisallowedOrigin(request)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const apiKey = getAi4uApiKey();
  if (!apiKey) {
    return new Response(JSON.stringify({ fallback: true, skipped: true, reason: 'AI4U_API_KEY not configured', embeddings: [] }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
  if (contentLength > 51200) {
    return new Response(JSON.stringify({ error: 'Payload too large' }), {
      status: 413,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await request.json();
    const texts = normalizeInputs(body).slice(0, 32);

    if (texts.length === 0) {
      return new Response(JSON.stringify({ error: 'input or texts required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const response = await postAi4u('/embeddings', apiKey, {
      model: MODEL,
      input: texts,
      encoding_format: 'float',
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[AI4U Embeddings] API error:', response.status, errorText);
      return new Response(JSON.stringify({ fallback: true, error: 'AI4U embeddings API error' }), {
        status: response.status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const data = await response.json();
    const embeddings = Array.isArray(data?.data)
      ? data.data.map((entry) => Array.isArray(entry?.embedding) ? entry.embedding : null).filter(Boolean)
      : [];

    if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
      return new Response(JSON.stringify({ fallback: true, error: 'Invalid embedding response shape' }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({
      embeddings,
      model: data?.model || MODEL,
      provider: 'ai4u',
      fallback: false,
    }), {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=120',
      },
    });
  } catch (error) {
    console.error('[AI4U Embeddings] Error:', error);
    return new Response(JSON.stringify({ fallback: true, error: error.message || 'Unknown error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}
