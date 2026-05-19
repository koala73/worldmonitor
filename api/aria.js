/**
 * ARIA Query Endpoint
 * Vercel Edge Function for JARVIS-like intelligent analysis
 */

import { corsHeaders } from "../_cors.js";
import { validateApiKey } from "../_api-key.js";
import { handleAriaQuery, handleGetAwareness, handleIntelligence } from "../../server/worldmonitor/aria/v1/handler.ts";

export default async function handler(request, env) {
  // Handle CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(request.url);

    if (url.pathname === "/api/aria/query" && request.method === "POST") {
      return handleAriaQuery(request, env, null);
    }

    if (url.pathname === "/api/aria/awareness" && request.method === "GET") {
      return handleGetAwareness(request, env, null);
    }

    if (url.pathname === "/api/aria/intelligence" && request.method === "POST") {
      return handleIntelligence(request, env, null);
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  } catch (error) {
    console.error("Aria endpoint error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}
