/**
 * News results for ChatGPT (see host-policy.ts).
 *
 * OpenAI's review rejected the app for summarizing or aggregating news from
 * third-party publishers. WorldMonitor reads headlines from RSS; summaries
 * are an opt-in action, not the default. For ChatGPT the summary tools are
 * hidden (CHATGPT_HIDDEN_TOOLS) and this module reduces every news result to
 * pointers: title, publisher, link and time stay; article snippets, LLM
 * briefs built from headlines and publisher body text go.
 *
 * Each rule names the tool and the keys it removes anywhere in the result.
 * Keys are removed, not emptied, unless the output schema requires them:
 * intel-history records require `summary`, documented as empty when the
 * producer had none, so it becomes ''.
 */

const REMOVED_KEYS: Readonly<Record<string, readonly string[]>> = {
  // LLM world brief composed from headlines, its source list, and RSS leads.
  get_news_intelligence: ['worldBrief', 'briefStoryLines', 'worldBriefSources', 'briefProvider', 'briefModel', 'snippet', 'image'],
  // RSS description of each headline.
  open_news_dashboard: ['snippet'],
  get_news_clusters: ['snippet'],
  // USNI News fleet-tracker body text.
  get_country_brief_section: ['activityDescription'],
  // LLM summary of recent headlines for the symbol.
  get_stock_research: ['newsSummary'],
};

// Records that carry a third-party `summary` next to their `sourceUrl`.
const BLANKED_RECORD_SUMMARY_TOOLS: ReadonlySet<string> = new Set([
  'search_intel_history',
  'get_intel_timeline',
  'get_similar_events',
]);

/** Tools whose ChatGPT results this module changes. */
export const CHATGPT_POINTER_ONLY_TOOLS: ReadonlySet<string> = new Set([
  ...Object.keys(REMOVED_KEYS),
  ...BLANKED_RECORD_SUMMARY_TOOLS,
]);

function rewrite(value: unknown, removed: ReadonlySet<string>, blankRecordSummary: boolean): unknown {
  if (Array.isArray(value)) return value.map((item) => rewrite(item, removed, blankRecordSummary));
  if (!value || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const isRecord = blankRecordSummary && 'sourceUrl' in source && typeof source.summary === 'string';
  for (const [key, child] of Object.entries(source)) {
    if (removed.has(key)) continue;
    out[key] = isRecord && key === 'summary' ? '' : rewrite(child, removed, blankRecordSummary);
  }
  return out;
}

/**
 * The result ChatGPT receives for `toolName`. Results of other tools are
 * returned unchanged (same reference).
 */
export function pointerOnlyNewsResult(toolName: string, result: unknown): unknown {
  if (!CHATGPT_POINTER_ONLY_TOOLS.has(toolName)) return result;
  const removed = new Set(REMOVED_KEYS[toolName] ?? []);
  const rewritten = rewrite(result, removed, BLANKED_RECORD_SUMMARY_TOOLS.has(toolName));
  // The news dashboard view hides its summarize and translate controls when
  // the host cannot call analyze_news_headlines.
  if (toolName === 'open_news_dashboard' && rewritten && typeof rewritten === 'object' && !Array.isArray(rewritten)) {
    (rewritten as Record<string, unknown>).headlineAnalysis = false;
  }
  return rewritten;
}
