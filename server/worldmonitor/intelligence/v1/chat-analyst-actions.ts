/**
 * Intent detection for chat analyst action events.
 * Exported for unit testing; consumed by api/chat-analyst.ts.
 */

import { parseAgentBusAction, type AgentBusAction } from '../../../../shared/agent-bus-actions';

// Matches compound visual keywords to avoid false-positives on bare nouns
// (e.g. "UN Charter", "GDP", "chart a course"). Requires visual-specific
// compound phrases or unambiguous single terms like "dashboard".
export const VISUAL_INTENT_RE =
  /\b(chart(\s+\w+)?\s+(prices?|data|rates?|trends?|performance|comparison|history)|graph(\s+\w+)?\s+(prices?|data|rates?|trends?|performance)|plot(\s+\w+)?\s+(prices?|data|rates?|trends?|performance)|visuali[sz]e|(show|give|get|make|build)\s+(me\s+)?(a\s+)?(chart|graph|plot|dashboard|trend|visualization)|create\s+a\s+(chart|graph|dashboard|visualization)|price\s+(history|over\s+time|comparison|trend|chart)|compare\s+(prices?|rates?|data|performance)|dashboard|candlestick)\b/i;

interface PanelIntent {
  panelId: string;
  label: string;
  pattern: RegExp;
}

const OPEN_PANEL_RE = /\b(open|show|focus|pull\s+up|go\s+to|bring\s+up)\b/i;

const PANEL_INTENTS: PanelIntent[] = [
  { panelId: 'strategic-risk', label: 'Open Strategic Risk', pattern: /\b(strategic\s+risk|risk\s+panel)\b/i },
  { panelId: 'forecast', label: 'Open Forecasts', pattern: /\b(forecasts?|prediction\s+markets?|outlook)\b/i },
  { panelId: 'cii', label: 'Open CII', pattern: /\b(cii|country\s+instability|instability\s+index)\b/i },
  { panelId: 'markets', label: 'Open Markets', pattern: /\b(markets?|commodit(?:y|ies)|macro|finance)\b/i },
  { panelId: 'deduction', label: 'Open Deduction', pattern: /\b(deduction|reasoning|hypothesis)\b/i },
  { panelId: 'regional-intelligence', label: 'Open Regional Intelligence', pattern: /\b(regional\s+intelligence|regional\s+brief)\b/i },
];

const VIEW_INTENTS = [
  { view: 'global', label: 'Show global map', pattern: /\b(global|world(?:wide)?)\b/i },
  { view: 'america', label: 'Show Americas', pattern: /\b[Aa]mericas?\b|\b[Uu]nited\s+[Ss]tates\b|\b[Uu][Ss][Aa]\b|\bUS\b|\b[Uu]\.[Ss]\.?(?![A-Za-z])/ },
  { view: 'mena', label: 'Show MENA', pattern: /\b(mena|middle\s+east|north\s+africa|gulf)\b/i },
  { view: 'eu', label: 'Show Europe', pattern: /\b(europe|european\s+union|eu)\b/i },
  { view: 'asia', label: 'Show Asia', pattern: /\b(asia|indo-?pacific|china|taiwan|korea|japan)\b/i },
  { view: 'latam', label: 'Show Latin America', pattern: /\b(latam|latin\s+america|south\s+america)\b/i },
  { view: 'africa', label: 'Show Africa', pattern: /\b(africa|sub-?saharan)\b/i },
  { view: 'oceania', label: 'Show Oceania', pattern: /\b(oceania|australia|new\s+zealand|pacific)\b/i },
] as const;

const MAP_VIEW_RE = /\b(show|fly|zoom|pan|move|focus|center)\b.*\b(map|view|globe|region|area)\b|\b(map|view|globe)\b.*\b(show|fly|zoom|pan|move|focus|center)\b/i;

function validatedAction(input: unknown): AgentBusAction | null {
  const parsed = parseAgentBusAction(input);
  return parsed.ok ? parsed.action : null;
}

function buildOpenPanelAction(query: string): AgentBusAction | null {
  if (!OPEN_PANEL_RE.test(query)) return null;
  const intent = PANEL_INTENTS.find((candidate) => candidate.pattern.test(query));
  if (!intent) return null;
  return validatedAction({
    type: 'open_panel',
    label: intent.label,
    panelId: intent.panelId,
    reason: 'Analyst inferred an explicit panel focus request.',
  });
}

function buildSetViewAction(query: string): AgentBusAction | null {
  if (!MAP_VIEW_RE.test(query)) return null;
  const intent = VIEW_INTENTS.find((candidate) => candidate.pattern.test(query));
  if (!intent) return null;
  return validatedAction({
    type: 'set_view',
    label: intent.label,
    view: intent.view,
    reason: 'Analyst inferred an explicit map view request.',
  });
}

function buildSuggestWidgetAction(query: string): AgentBusAction | null {
  if (!VISUAL_INTENT_RE.test(query)) return null;
  return validatedAction({ type: 'suggest-widget', label: 'Create chart widget', prefill: query });
}

export function buildActionEvents(query: string): AgentBusAction[] {
  return [
    buildOpenPanelAction(query),
    buildSetViewAction(query),
    buildSuggestWidgetAction(query),
  ].filter((action): action is AgentBusAction => action !== null);
}
