/**
 * Country Intelligence Brief Endpoint
 * Generates AI-powered country situation briefs using AI4U
 * Redis cached (2h TTL) for cross-user deduplication
 */

import { getCachedJson, setCachedJson, hashString } from './_upstash-cache.js';
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { getAi4uApiKey, getAi4uModel, postAi4u } from './_ai4u.js';

export const config = {
  runtime: 'edge',
};

const MODEL = getAi4uModel('AI4U_COUNTRY_INTEL_MODEL', 'sonnet-4.5');
const CACHE_TTL_SECONDS = 7200; // 2 hours
const CACHE_VERSION = 'ci-v2';

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
    return new Response(JSON.stringify({ intel: null, fallback: true, skipped: true, reason: 'AI4U_API_KEY not configured' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
  if (contentLength > 51200) {
    return new Response(JSON.stringify({ error: 'Payload too large' }), {
      status: 413,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const { country, code, context } = await request.json();

    if (!country || !code) {
      return new Response(JSON.stringify({ error: 'country and code required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Cache key includes country code + context hash (context changes as data updates)
    const contextHash = context ? hashString(JSON.stringify(context)).slice(0, 8) : 'no-ctx';
    const cacheKey = `${CACHE_VERSION}:${code}:${contextHash}`;

    const cached = await getCachedJson(cacheKey);
    if (cached && typeof cached === 'object' && cached.brief) {
      console.log('[CountryIntel] Cache hit:', code);
      return new Response(JSON.stringify({ ...cached, cached: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=600' },
      });
    }

    // Build data context section
    const dataLines = [];
    if (context?.score != null) {
      const changeStr = context.change24h ? ` (${context.change24h > 0 ? '+' : ''}${context.change24h} in 24h)` : '';
      dataLines.push(`Instability Score: ${context.score}/100 (${context.level || 'unknown'}) — trend: ${context.trend || 'unknown'}${changeStr}`);
    }
    if (context?.components) {
      const c = context.components;
      dataLines.push(`Score Components: Unrest ${c.unrest ?? '?'}/100, Security ${c.security ?? '?'}/100, Information ${c.information ?? '?'}/100`);
    }
    if (context?.protests != null) dataLines.push(`Active protests in/near country (7d): ${context.protests}`);
    if (context?.militaryFlights != null) dataLines.push(`Military aircraft detected in/near country: ${context.militaryFlights}`);
    if (context?.militaryVessels != null) dataLines.push(`Military vessels detected in/near country: ${context.militaryVessels}`);
    if (context?.outages != null) dataLines.push(`Internet outages: ${context.outages}`);
    if (context?.earthquakes != null) dataLines.push(`Recent earthquakes: ${context.earthquakes}`);
    if (context?.stockIndex) dataLines.push(`Stock Market Index: ${context.stockIndex}`);
    if (context?.convergenceScore != null) {
      dataLines.push(`Signal convergence score: ${context.convergenceScore}/100 (multiple signal types detected: ${(context.signalTypes || []).join(', ')})`);
    }
    if (context?.regionalConvergence?.length > 0) {
      dataLines.push(`\nRegional convergence alerts:`);
      context.regionalConvergence.forEach(r => dataLines.push(`- ${r}`));
    }
    if (context?.headlines?.length > 0) {
      dataLines.push(`\nRecent headlines mentioning ${country} (${context.headlines.length} found):`);
      context.headlines.slice(0, 15).forEach((h, i) => dataLines.push(`${i + 1}. ${h}`));
    }

    const dataSection = dataLines.length > 0
      ? `\nCURRENT SENSOR DATA:\n${dataLines.join('\n')}`
      : '\nNo real-time sensor data available for this country.';

    const dateStr = new Date().toISOString().split('T')[0];

    const systemPrompt = `You are a senior intelligence analyst providing comprehensive country situation briefs. Current date: ${dateStr}. Donald Trump is the current US President (second term, inaugurated Jan 2025).

Write a thorough, data-driven intelligence brief for the requested country. Structure:

1. **Current Situation** — What is happening right now. Reference specific data: instability scores, protest counts, military presence, outages. Explain what the numbers mean in context.

2. **Military & Security Posture** — Analyze military activity in/near the country. What forces are present? What does the positioning suggest? What are foreign nations doing in this theater?

3. **Key Risk Factors** — What drives instability or stability. Connect the dots between different signals (protests + outages = potential crackdown? military buildup + diplomatic tensions = escalation risk?). Reference specific headlines.

4. **Regional Context** — How does this country's situation affect or relate to its neighbors and the broader region? Reference any convergence alerts.

5. **Outlook & Watch Items** — What to monitor in the near term. Be specific about indicators that would signal escalation or de-escalation.

Rules:
- Be specific and analytical. Reference the data provided (scores, counts, headlines, convergence).
- If data shows low activity, say so — don't manufacture threats.
- Connect signals: explain what combinations of data points suggest.
- 5-6 paragraphs, 300-400 words.
- No speculation beyond what the data supports.
- Use plain language, not jargon.
- If military assets are 0, don't speculate about military presence — say monitoring shows no current military activity.
- When referencing a specific headline from the numbered list, cite it as [N] where N is the headline number (e.g. "tensions escalated [3]"). Only cite headlines you directly reference.`;

    const userPrompt = `Country: ${country} (${code})${dataSection}`;

    const ai4uRes = await postAi4u('/chat/completions', apiKey, {
        model: MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.4,
        max_tokens: 900,
    });

    if (!ai4uRes.ok) {
      const errText = await ai4uRes.text();
      console.error('[CountryIntel] AI4U error:', ai4uRes.status, errText);
      return new Response(JSON.stringify({ error: 'AI service error', fallback: true }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const ai4uData = await ai4uRes.json();
    const brief = ai4uData.choices?.[0]?.message?.content || '';

    const result = {
      brief,
      country,
      code,
      model: MODEL,
      generatedAt: new Date().toISOString(),
    };

    if (brief) {
      await setCachedJson(cacheKey, result, CACHE_TTL_SECONDS);
    }

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=600' },
    });
  } catch (err) {
    console.error('[CountryIntel] Error:', err);
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
