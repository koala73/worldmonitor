// Shared concierge routing used by the A2A endpoint (api/a2a.ts) and the
// NLWeb /ask endpoint (api/ask.ts). Deliberately not NLU — a transparent
// token-overlap score over the same names + descriptions tools/list
// publishes anonymously. Name hits outweigh description hits so
// "chokepoint status" lands on get_chokepoint_status, not on every tool
// whose prose mentions shipping.
//
// Kept as a route-less helper (underscore prefix, like api/_crypto.js) so
// neither endpoint's cold-start depends on the OTHER endpoint's module-level
// guards (Greptile review on #4838).

import { TOOL_REGISTRY } from './mcp/registry/index';

const QUERY_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'what', 'which', 'who', 'how', 'where', 'when',
  'need', 'want', 'give', 'gives', 'get', 'show', 'find', 'tool', 'tools',
  'data', 'live', 'about', 'from', 'that', 'this', 'can', 'you', 'your',
  'right', 'now', 'best', 'please', 'worldmonitor', 'world', 'monitor',
]);

function tokenize(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 3 && !QUERY_STOPWORDS.has(t)),
    ),
  ];
}

export interface ToolSuggestion {
  name: string;
  description: string;
  score: number;
}

export function suggestTools(query: string, limit = 5): ToolSuggestion[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];
  const scored: ToolSuggestion[] = [];
  for (const tool of TOOL_REGISTRY) {
    const nameTokens = new Set(tool.name.toLowerCase().split(/[^a-z0-9]+/));
    const descTokens = new Set(tokenize(tool.description));
    let score = 0;
    for (const token of tokens) {
      if (nameTokens.has(token)) score += 3;
      else if (descTokens.has(token)) score += 1;
    }
    if (score > 0) scored.push({ name: tool.name, description: tool.description, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit);
}
