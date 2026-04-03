/**
 * Intent detection for chat analyst action events.
 * Exported for unit testing; consumed by api/chat-analyst.ts.
 */

export interface AnalystActionEvent {
  type: string;
  label: string;
  prefill: string;
}

// Matches compound visual keywords to avoid false-positives on bare nouns
// (e.g. "UN Charter", "GDP", "chart a course"). Requires visual-specific
// compound phrases or unambiguous single terms like "dashboard".
export const VISUAL_INTENT_RE =
  /\b(chart(\s+\w+)?\s+(prices?|data|rates?|trends?|performance|comparison|history)|graph(\s+\w+)?\s+(prices?|data|rates?|trends?|performance)|plot(\s+\w+)?\s+(prices?|data|rates?|trends?|performance)|visuali[sz]e|(show|give|get|make|build)\s+(me\s+)?(a\s+)?(chart|graph|plot|dashboard|trend|visualization)|create\s+a\s+(chart|graph|dashboard|visualization)|price\s+(history|over\s+time|comparison|trend|chart)|compare\s+(prices?|rates?|data|performance)|dashboard|candlestick)\b/i;

export function buildActionEvents(query: string): AnalystActionEvent[] {
  if (!VISUAL_INTENT_RE.test(query)) return [];
  return [{ type: 'suggest-widget', label: 'Create chart widget', prefill: query }];
}
