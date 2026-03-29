/**
 * Claude Agentic Intelligence Analyst
 *
 * Edge function that runs a multi-turn Claude tool-use agentic loop.
 * Claude can call tools to gather live intelligence data, then synthesizes
 * a comprehensive response.
 *
 * Tools available to Claude:
 *   - get_news_headlines   — GDELT top articles for a topic
 *   - get_risk_scores      — Country instability/risk scores (internal RPC)
 *   - get_market_summary   — Current commodity + equity quotes (internal RPC)
 *   - get_cyber_threats    — Live IOC feed from threat intel sources (internal RPC)
 */

import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { validateApiKey } from './_api-key.js';

export const config = { runtime: 'edge' };

// ── Constants ────────────────────────────────────────────────────────────────

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_API_VERSION = '2023-06-01';
/** Haiku is fast and cheap for multi-turn tool loops */
const AGENT_MODEL = 'claude-haiku-4-5';
/** Maximum agentic turns to prevent runaway costs (1 user msg + up to 4 tool loops) */
const MAX_TURNS = 5;
const UPSTREAM_TIMEOUT_MS = 25_000;
const GDELT_API = 'https://api.gdeltproject.org/api/v2/doc/doc';
const MAX_QUERY_LEN = 500;
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── Tool definitions exposed to Claude ───────────────────────────────────────

const TOOLS = [
  {
    name: 'get_news_headlines',
    description:
      'Fetch the latest news headlines for a specific geopolitical topic, region, or country. ' +
      'Returns up to 5 recent article titles and their publication dates. ' +
      'Use this to gather current situational awareness before answering.',
    input_schema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description:
            'The topic, region, or country to search news for. ' +
            'Examples: "Ukraine war", "China Taiwan", "cybersecurity breach", "oil prices", "North Korea".',
        },
      },
      required: ['topic'],
    },
  },
  {
    name: 'get_risk_scores',
    description:
      'Get current instability and geopolitical risk scores for one or more countries. ' +
      'Returns CII score (0-100, higher = more unstable), risk level, and recent event counts.',
    input_schema: {
      type: 'object',
      properties: {
        countries: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Array of ISO 3166-1 alpha-2 country codes to retrieve risk data for (max 5). ' +
            'Examples: ["RU", "UA", "CN", "IR", "KP"]',
        },
      },
      required: ['countries'],
    },
  },
  {
    name: 'get_market_summary',
    description:
      'Get current financial market data including major equity indices, key commodities ' +
      '(oil, gold, natural gas), and selected currency pairs. ' +
      'Use this to add economic and financial context to intelligence analysis.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_cyber_threats',
    description:
      'Retrieve the latest high-severity cyber threat indicators from global threat ' +
      'intelligence feeds (Feodo, URLhaus, ThreatFox, CISA KEV, AbuseIPDB). ' +
      'Returns up to 10 critical/high indicators with type and country attribution.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

// ── Tool implementations ──────────────────────────────────────────────────────

async function runTool(toolName, toolInput, baseUrl) {
  try {
    switch (toolName) {
      case 'get_news_headlines': {
        return await toolGetNewsHeadlines(toolInput.topic);
      }
      case 'get_risk_scores': {
        return await toolGetRiskScores(toolInput.countries, baseUrl);
      }
      case 'get_market_summary': {
        return await toolGetMarketSummary(baseUrl);
      }
      case 'get_cyber_threats': {
        return await toolGetCyberThreats(baseUrl);
      }
      default: {
        return { error: `Unknown tool: ${toolName}` };
      }
    }
  } catch (error) {
    return { error: `Tool execution failed: ${error instanceof Error ? error.message : 'unknown error'}` };
  }
}

async function toolGetNewsHeadlines(topic) {
  const safeQuery = String(topic || '').slice(0, 200).replace(/[^\w\s.,'-]/g, ' ').trim();
  if (!safeQuery) return { error: 'No topic provided' };

  const url = new URL(GDELT_API);
  url.searchParams.set('mode', 'ArtList');
  url.searchParams.set('maxrecords', '5');
  url.searchParams.set('query', safeQuery);
  url.searchParams.set('format', 'json');
  url.searchParams.set('timespan', '1d');
  url.searchParams.set('sort', 'DateDesc');

  const res = await fetch(url.toString(), {
    headers: { 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(12_000),
  });

  if (!res.ok) return { headlines: [], note: 'GDELT feed temporarily unavailable' };

  const data = await res.json();
  const articles = (data.articles || []).slice(0, 5);

  if (articles.length === 0) return { headlines: [], note: `No recent articles found for: ${safeQuery}` };

  return {
    topic: safeQuery,
    headlines: articles.map(a => ({
      title: String(a.title || '').slice(0, 200),
      source: String(a.domain || '').slice(0, 60),
      date: String(a.seendate || '').slice(0, 20),
    })),
  };
}

async function toolGetRiskScores(countries, baseUrl) {
  if (!Array.isArray(countries) || countries.length === 0) {
    return { error: 'countries array is required' };
  }

  const codes = countries.slice(0, 5).map(c => String(c).toUpperCase().slice(0, 2));
  const url = `${baseUrl}/api/intelligence/v1/get-risk-scores`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': CHROME_UA },
    body: JSON.stringify({ countryCodes: codes }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) return { scores: [], note: 'Risk scores temporarily unavailable' };

  const data = await res.json();
  return { scores: data.scores || data.riskScores || data || [] };
}

async function toolGetMarketSummary(baseUrl) {
  const url = `${baseUrl}/api/market/v1/list-commodity-quotes`;

  const res = await fetch(url, {
    headers: { 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) return { note: 'Market data temporarily unavailable' };

  const data = await res.json();
  return { commodities: (data.quotes || data.commodities || []).slice(0, 8) };
}

async function toolGetCyberThreats(baseUrl) {
  const url = `${baseUrl}/api/cyber/v1/list-iocs`;

  const res = await fetch(url, {
    headers: { 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) return { threats: [], note: 'Cyber threat feed temporarily unavailable' };

  const data = await res.json();
  const iocs = (data.iocs || data.threats || []);
  const critical = iocs
    .filter(i => i.severity === 'critical' || i.severity === 'high')
    .slice(0, 10)
    .map(i => ({
      type: i.type || 'unknown',
      severity: i.severity || 'high',
      country: i.country || null,
      source: i.source || 'unknown',
    }));

  return { threats: critical, totalCount: iocs.length };
}

// ── Agentic loop ─────────────────────────────────────────────────────────────

async function runAgentLoop(apiKey, userQuery, baseUrl) {
  const dateStr = new Date().toISOString().split('T')[0];
  const systemPrompt =
    `You are a senior intelligence analyst for World Monitor, a real-time OSINT dashboard. ` +
    `Current date: ${dateStr}. ` +
    `Use the provided tools to gather current, accurate data before answering. ` +
    `Always call at least one tool to ground your analysis in live data. ` +
    `After gathering data with tools, synthesize a concise, structured intelligence brief. ` +
    `Format your final answer with clear sections using ** bold ** headers. ` +
    `Be specific with facts, figures, and dates. Do not speculate beyond what the data supports. ` +
    `Keep your final response under 400 words.`;

  const messages = [{ role: 'user', content: userQuery }];

  const toolCallLog = [];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const body = JSON.stringify({
      model: AGENT_MODEL,
      system: systemPrompt,
      messages,
      tools: TOOLS,
      tool_choice: { type: 'auto' },
      max_tokens: turn < MAX_TURNS - 1 ? 1024 : 600,
      temperature: 0.2,
    });

    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_API_VERSION,
        'Content-Type': 'application/json',
        'User-Agent': CHROME_UA,
      },
      body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      const isRateLimit = res.status === 429;
      throw new Error(isRateLimit ? 'Claude API rate limited' : 'Claude API error');
    }

    const data = await res.json();

    // Append assistant message to conversation
    messages.push({ role: 'assistant', content: data.content });

    // Check stop reason
    if (data.stop_reason === 'end_turn' || !data.content?.some(b => b.type === 'tool_use')) {
      // Extract final text response
      const textBlock = data.content?.find(b => b.type === 'text');
      return {
        response: textBlock?.text?.trim() || '',
        toolCalls: toolCallLog,
        model: AGENT_MODEL,
        turns: turn + 1,
      };
    }

    // Execute all tool calls in this turn
    const toolResults = [];
    for (const block of data.content) {
      if (block.type !== 'tool_use') continue;

      const toolName = block.name;
      const toolInput = block.input || {};
      const toolUseId = block.id;

      toolCallLog.push({ tool: toolName, input: toolInput });

      const result = await runTool(toolName, toolInput, baseUrl);

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: JSON.stringify(result),
      });
    }

    // Add tool results as user message for next turn
    messages.push({ role: 'user', content: toolResults });
  }

  // Max turns reached — extract any text from last assistant message
  const lastAssistant = messages.filter(m => m.role === 'assistant').pop();
  const textBlock = Array.isArray(lastAssistant?.content)
    ? lastAssistant.content.find(b => b.type === 'text')
    : null;

  return {
    response: textBlock?.text?.trim() || 'Analysis incomplete — maximum tool call depth reached.',
    toolCalls: toolCallLog,
    model: AGENT_MODEL,
    turns: MAX_TURNS,
  };
}

// ── Edge handler ──────────────────────────────────────────────────────────────

export default async function handler(req) {
  const corsHeaders = getCorsHeaders(req, 'POST, OPTIONS');

  if (isDisallowedOrigin(req)) {
    return Response.json({ error: 'Origin not allowed' }, {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  // API key validation
  const authResult = validateApiKey(req);
  if (!authResult.valid) {
    return Response.json({ error: authResult.error || 'Unauthorized' }, {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  // Require Anthropic key
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Response.json({ error: 'Claude AI is not configured. Set ANTHROPIC_API_KEY to enable the agent.' }, {
      status: 503,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  // Parse and validate request body
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  const rawQuery = typeof body?.query === 'string' ? body.query.trim() : '';
  if (!rawQuery) {
    return Response.json({ error: 'query is required' }, {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
  // Sanitize: strip control chars and angle brackets (prevent prompt/log injection), then truncate
  const query = rawQuery.replace(/[\u0000-\u001F\u007F<>]/g, ' ').slice(0, MAX_QUERY_LEN);

  // Derive base URL for internal tool calls
  const requestUrl = new URL(req.url);
  const baseUrl = `${requestUrl.protocol}//${requestUrl.host}`;

  try {
    const result = await runAgentLoop(apiKey, query, baseUrl);
    return Response.json(result, {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const isRateLimit = message.includes('rate limit');
    return Response.json({ error: message }, {
      status: isRateLimit ? 429 : 502,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
}
