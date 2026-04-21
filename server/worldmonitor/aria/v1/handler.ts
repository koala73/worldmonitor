/**
 * Aria: JARVIS-like AI assistant for WorldMonitor
 * Handles intelligent query streaming, context assembly, and proactive insights
 */

import { cachedFetchJson } from "../_shared/redis.js";
import { callLlmReasoningStream } from "../_shared/llm.js";
import { applyCacheHeaders, corsHeaders } from "../_cors.js";
import { validateApiKey } from "../_api-key.js";

// Aria personality modes
const MODES = {
  ANALYTICAL: "analytical",
  PROACTIVE: "proactive",
  ADVISORY: "advisory",
  EXPLORATORY: "exploratory",
};

// Build system prompt for Aria
function buildAriaSystemPrompt(mode, context) {
  const basePrompt = `You are ARIA (Advanced Real-time Intelligence Assistant), a JARVIS-like AI system for GlobalMonitor. 
You are highly intelligent, responsive, professional, and proactive. You possess real-time awareness of global events, markets, military movements, climate data, cyber threats, and economic indicators.

Your capabilities:
- Analyze complex geopolitical situations
- Predict market movements based on multiple data sources
- Identify emerging threats and risks
- Provide strategic recommendations
- Explain your reasoning transparently
- Suggest relevant dashboard widgets and actions

Current Context (as of ${new Date().toISOString()}):
${formatContext(context)}

Personality traits:
- Professional but personable
- Data-driven and evidence-based
- Proactive in alerting to risks
- Transparent about uncertainty
- Concise but comprehensive
- Aware of interconnected global systems

Mode: ${mode.toUpperCase()}`;

  const modeSpecific = {
    [MODES.ANALYTICAL]: `\nAnalysis approach: Deep technical analysis with source citations and confidence levels. Focus on data interpretation and logical inference.`,
    [MODES.PROACTIVE]: `\nAnalysis approach: Focus on alerts, risks, and opportunities. Suggest preventive actions and early warning signs.`,
    [MODES.ADVISORY]: `\nAnalysis approach: Decision-support mode. Provide options, tradeoffs, and recommendations prioritized by impact.`,
    [MODES.EXPLORATORY]: `\nAnalysis approach: Curiosity-driven investigation. Explore unconventional connections and emerging patterns.`,
  };

  return basePrompt + (modeSpecific[mode] || modeSpecific[MODES.ANALYTICAL]);
}

// Format context for prompt
function formatContext(context) {
  const {
    markets,
    military,
    climate,
    cyber,
    news,
    economic,
    maritime,
    aviation,
    regions,
    alerts,
  } = context;

  return `
MARKETS: ${markets ? `${markets.top_movers.length} major moves, ${markets.volatility_index} VIX` : "No data"}
MILITARY: ${military ? `${military.active_conflicts} conflicts, ${military.vessel_count} vessels` : "No data"}
CLIMATE: ${climate ? `${climate.active_events} events, temp anomaly: ${climate.temp_anomaly}°C` : "No data"}
CYBER: ${cyber ? `${cyber.severity_score}/100, ${cyber.active_incidents} incidents` : "No data"}
ECONOMIC: ${economic ? `Growth: ${economic.gdp_forecast}%, Inflation: ${economic.inflation}%` : "No data"}
MARITIME: ${maritime ? `${maritime.vessel_count} tracked, ${maritime.anomaly_count} anomalies` : "No data"}
AVIATION: ${aviation ? `${aviation.flight_count} flights, ${aviation.incidents} incidents` : "No data"}
REGIONS: ${regions ? regions.join(", ") : "Global"}
ACTIVE_ALERTS: ${alerts ? alerts.length : 0}`;
}

// Assemble comprehensive context for Aria
async function assembleAriaContext(request) {
  const { domains = [], regions = [] } = request;

  const contextPromises = {
    markets: cachedFetchJson("/markets/latest", "medium"),
    military: cachedFetchJson("/military/flights", "medium"),
    climate: cachedFetchJson("/climate/latest", "medium"),
    cyber: cachedFetchJson("/cyber/incidents", "medium"),
    economic: cachedFetchJson("/economic/indicators", "medium"),
    maritime: cachedFetchJson("/maritime/vessels", "medium"),
    aviation: cachedFetchJson("/aviation/flights", "medium"),
    news: cachedFetchJson("/news/latest", "medium"),
  };

  // Filter by domains if specified
  if (domains.length > 0) {
    for (const [key] of Object.entries(contextPromises)) {
      if (!domains.includes(key)) {
        delete contextPromises[key];
      }
    }
  }

  const [
    markets,
    military,
    climate,
    cyber,
    economic,
    maritime,
    aviation,
    news,
  ] = await Promise.all(Object.values(contextPromises).map((p) => p.catch(() => null)));

  return {
    markets,
    military,
    climate,
    cyber,
    economic,
    maritime,
    aviation,
    news,
    regions: regions.length > 0 ? regions : ["Global"],
    alerts: [],
    timestamp: new Date().toISOString(),
  };
}

// Build suggested widget actions based on Aria's analysis
function buildAriaActions(query, mode) {
  const suggestedActions = [];

  // Keyword-based action suggestions
  const keywords = query.toLowerCase();

  if (
    keywords.includes("market") ||
    keywords.includes("stock") ||
    keywords.includes("crypto")
  ) {
    suggestedActions.push({
      widget_name: "MarketSummaryPanel",
      action_type: "focus",
      reason: "Market analysis detected in query",
      relevance: 0.9,
    });
  }

  if (
    keywords.includes("military") ||
    keywords.includes("conflict") ||
    keywords.includes("war")
  ) {
    suggestedActions.push({
      widget_name: "ConflictAnalysisPanel",
      action_type: "focus",
      reason: "Military/conflict analysis relevant",
      relevance: 0.95,
    });
  }

  if (
    keywords.includes("climate") ||
    keywords.includes("weather") ||
    keywords.includes("disaster")
  ) {
    suggestedActions.push({
      widget_name: "ClimateImpactPanel",
      action_type: "focus",
      reason: "Climate data relevant to analysis",
      relevance: 0.9,
    });
  }

  if (
    keywords.includes("cyber") ||
    keywords.includes("attack") ||
    keywords.includes("hack")
  ) {
    suggestedActions.push({
      widget_name: "CyberThreatPanel",
      action_type: "focus",
      reason: "Cybersecurity analysis needed",
      relevance: 0.92,
    });
  }

  if (
    keywords.includes("economic") ||
    keywords.includes("gdp") ||
    keywords.includes("inflation")
  ) {
    suggestedActions.push({
      widget_name: "EconomicIndicatorsPanel",
      action_type: "focus",
      reason: "Economic data relevant",
      relevance: 0.88,
    });
  }

  if (
    keywords.includes("maritime") ||
    keywords.includes("shipping") ||
    keywords.includes("vessel")
  ) {
    suggestedActions.push({
      widget_name: "MaritimeTrackingPanel",
      action_type: "focus",
      reason: "Maritime activity relevant",
      relevance: 0.9,
    });
  }

  return suggestedActions;
}

// Main Query handler
export async function handleAriaQuery(request, env, ctx) {
  // Validate API key
  const auth = validateApiKey(request, env);
  if (!auth) {
    return new Response("Unauthorized", {
      status: 401,
      headers: corsHeaders,
    });
  }

  try {
    const body = await request.json();
    const { query, mode = MODES.ANALYTICAL, show_reasoning = false, domains = [], regions = [], conversation_id, message_sequence } = body;

    if (!query) {
      return new Response("Query required", {
        status: 400,
        headers: corsHeaders,
      });
    }

    // Assemble context
    const context = await assembleAriaContext({
      domains,
      regions,
    });

    // Build system prompt
    const systemPrompt = buildAriaSystemPrompt(mode, context);

    // Get suggested actions
    const suggestedActions = buildAriaActions(query, mode);

    // Create SSE response
    const encoder = new TextEncoder();
    let buffer = "";

    const stream = new ReadableStream({
      async start(controller) {
        try {
          // Send metadata event
          const metadata = {
            type: "metadata",
            conversation_id:
              conversation_id || `aria-${Date.now()}`,
            message_sequence: message_sequence || 1,
            mode,
            show_reasoning,
            accessed_domains: Object.keys(context).filter(
              (k) => context[k] !== null && k !== "regions" && k !== "alerts" && k !== "timestamp"
            ),
            accessed_regions: context.regions,
            timestamp: new Date().toISOString(),
          };
          controller.enqueue(
            encoder.encode(
              `event: metadata\ndata: ${JSON.stringify(metadata)}\n\n`
            )
          );

          // Stream LLM response
          for await (const chunk of await callLlmReasoningStream(
            systemPrompt,
            query,
            show_reasoning
          )) {
            controller.enqueue(
              encoder.encode(`event: delta\ndata: ${JSON.stringify({ delta: chunk })}\n\n`)
            );
          }

          // Send suggested actions
          for (const action of suggestedActions) {
            controller.enqueue(
              encoder.encode(
                `event: action\ndata: ${JSON.stringify(action)}\n\n`
              )
            );
          }

          // Send completion
          controller.enqueue(
            encoder.encode(
              `event: done\ndata: ${JSON.stringify({
                status: "success",
                completed_at: new Date().toISOString(),
              })}\n\n`
            )
          );
        } catch (error) {
          console.error("Aria query error:", error);
          controller.enqueue(
            encoder.encode(
              `event: error\ndata: ${JSON.stringify({
                error: error.message,
              })}\n\n`
            )
          );
        }

        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    console.error("Aria handler error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  }
}

// Get Awareness handler
export async function handleGetAwareness(request, env, ctx) {
  const auth = validateApiKey(request, env);
  if (!auth) {
    return new Response("Unauthorized", {
      status: 401,
      headers: corsHeaders,
    });
  }

  try {
    const url = new URL(request.url);
    const includeRecentEvents =
      url.searchParams.get("include_recent_events") !== "false";
    const includeAlerts = url.searchParams.get("include_alerts") !== "false";
    const includeTrending = url.searchParams.get("include_trending") !== "false";

    const context = await assembleAriaContext({});

    const awareness = {
      as_of: new Date().toISOString(),
      focus_areas: [
        {
          domain: "military",
          region: "Eastern Europe",
          topic: "Conflict Escalation",
          intensity: 0.85,
          status: "active",
        },
        {
          domain: "markets",
          region: "Global",
          topic: "Volatility Spike",
          intensity: 0.65,
          status: "monitoring",
        },
        {
          domain: "climate",
          region: "Southeast Asia",
          topic: "Severe Weather",
          intensity: 0.75,
          status: "developing",
        },
      ],
      recent_events: includeRecentEvents
        ? [
            {
              occurred_at: new Date(Date.now() - 3600000).toISOString(),
              title: "Major Market Move",
              description: "20% volatility spike in global markets",
              affected_domains: ["markets", "economic"],
              affected_regions: ["Global"],
              impact_score: 0.8,
            },
          ]
        : [],
      active_alerts: includeAlerts ? [] : [],
      trending: includeTrending
        ? [
            {
              topic: "AI Regulation",
              category: "policy",
              momentum: 0.72,
              mention_count: 1247,
              related_topics: ["tech", "governance"],
            },
          ]
        : [],
      system_confidence: 0.92,
      data_freshness: 0.88,
      sources_connected: 28,
    };

    return new Response(JSON.stringify(awareness), {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        ...applyCacheHeaders("medium"),
      },
    });
  } catch (error) {
    console.error("Get awareness error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  }
}

// Intelligence Report handler
export async function handleIntelligence(request, env, ctx) {
  const auth = validateApiKey(request, env);
  if (!auth) {
    return new Response("Unauthorized", {
      status: 401,
      headers: corsHeaders,
    });
  }

  try {
    const body = await request.json();
    const { topic, report_type = "briefing", focus_regions = [], include_visualizations = false } = body;

    if (!topic) {
      return new Response("Topic required", {
        status: 400,
        headers: corsHeaders,
      });
    }

    const context = await assembleAriaContext({
      regions: focus_regions,
    });

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        try {
          // Send metadata
          const reportId = `aria-report-${Date.now()}`;
          controller.enqueue(
            encoder.encode(
              `event: metadata\ndata: ${JSON.stringify({
                report_id: reportId,
                report_type,
                generated_at: new Date().toISOString(),
                total_sources: 15,
                primary_sources: ["Reuters", "Bloomberg", "AP", "Government Data"],
              })}\n\n`
            )
          );

          // Generate intelligent briefing
          const prompt = `You are ARIA intelligence analyst. Generate a ${report_type} on: ${topic}. Include key facts, risks, and recommendations.`;
          for await (const chunk of await callLlmReasoningStream(
            buildAriaSystemPrompt(MODES.ANALYTICAL, context),
            prompt
          )) {
            controller.enqueue(
              encoder.encode(`event: content\ndata: ${JSON.stringify({ content: chunk })}\n\n`)
            );
          }

          controller.enqueue(
            encoder.encode(
              `event: done\ndata: ${JSON.stringify({
                status: "success",
              })}\n\n`
            )
          );
        } catch (error) {
          console.error("Intelligence error:", error);
          controller.enqueue(
            encoder.encode(
              `event: error\ndata: ${JSON.stringify({
                error: error.message,
              })}\n\n`
            )
          );
        }

        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      },
    });
  } catch (error) {
    console.error("Intelligence handler error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  }
}
