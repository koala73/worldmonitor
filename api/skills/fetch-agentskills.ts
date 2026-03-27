export const config = { runtime: 'edge' };

// @ts-expect-error -- JS module, no declaration file
import { getCorsHeaders } from '../_cors.js';

export default async function handler(req: Request): Promise<Response> {
  const corsHeaders = getCorsHeaders(req) as Record<string, string>;

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...corsHeaders } });
  }

  if (req.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405, headers: corsHeaders });
  }

  // Simple IP-based rate limiting (10/hour) using cf-connecting-ip header first
  const ip = req.headers.get('cf-connecting-ip') ?? req.headers.get('x-forwarded-for') ?? 'unknown';
  // Note: stateless edge -- implement rate limiting via KV or accept best-effort for now.
  // For phase 1, log the IP and rely on Vercel rate limiting rules for abuse prevention.
  void ip;

  let body: { url?: string; id?: string };
  try {
    body = await req.json() as { url?: string; id?: string };
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400, headers: corsHeaders });
  }

  const rawUrl = body.url ?? (body.id ? `https://agentskills.io/skills/${body.id}` : null);
  if (!rawUrl) {
    return Response.json({ error: 'Provide url or id' }, { status: 400, headers: corsHeaders });
  }

  let skillUrl: URL;
  try {
    skillUrl = new URL(rawUrl);
  } catch {
    return Response.json({ error: 'Invalid URL' }, { status: 400, headers: corsHeaders });
  }

  // Use exact match or subdomain check — endsWith alone is bypassable by 'evilagentskills.io'
  const h = skillUrl.hostname;
  if (h !== 'agentskills.io' && !h.endsWith('.agentskills.io')) {
    return Response.json({ error: 'Only agentskills.io URLs are supported.' }, { status: 400, headers: corsHeaders });
  }

  let skillData: Record<string, unknown>;
  try {
    const res = await fetch(skillUrl.toString(), {
      headers: { 'Accept': 'application/json', 'User-Agent': 'WorldMonitor/1.0' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return Response.json({ error: 'Could not reach agentskills.io. Check your connection.' }, { status: 502, headers: corsHeaders });
    }
    skillData = await res.json() as Record<string, unknown>;
  } catch {
    return Response.json({ error: 'Could not reach agentskills.io. Check your connection.' }, { status: 502, headers: corsHeaders });
  }

  const instructions = typeof skillData.instructions === 'string' ? skillData.instructions : null;
  if (!instructions) {
    return Response.json({ error: "This skill has no instructions — it may use tools only (not supported in phase 1)." }, { status: 422, headers: corsHeaders });
  }

  const MAX_LEN = 2000;
  const truncated = instructions.length > MAX_LEN;
  const name = typeof skillData.name === 'string' ? skillData.name : 'Imported Skill';
  const description = typeof skillData.description === 'string' ? skillData.description : '';

  return Response.json({
    name,
    description,
    instructions: truncated ? instructions.slice(0, MAX_LEN) : instructions,
    truncated,
  }, { headers: corsHeaders });
}
