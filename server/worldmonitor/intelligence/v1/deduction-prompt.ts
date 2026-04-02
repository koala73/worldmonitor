interface PromptContextParts {
  primaryContext: string;
  recentNews: string[];
}

export type DeductionMode = 'brief' | 'forecast';

const BRIEF_MODE_PATTERNS = [
  /\b2-3 sentences?\b/i,
  /\bbrief\b/i,
  /\bconvergence pattern\b/i,
  /\bassess likelihood and potential implications\b/i,
];

function normalizeWhitespace(input: string): string {
  return input.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function trimList(items: string[], maxItems: number, maxChars: number): string[] {
  const out: string[] = [];
  let total = 0;
  for (const item of items) {
    if (out.length >= maxItems) break;
    const next = item.trim();
    if (!next) continue;
    if (total > 0 && total + next.length + 1 > maxChars) break;
    out.push(next);
    total += next.length + 1;
  }
  return out;
}

export function inferDeductionMode(query: string): DeductionMode {
  return BRIEF_MODE_PATTERNS.some((pattern) => pattern.test(query)) ? 'brief' : 'forecast';
}

export function splitDeductionContext(geoContext: string): PromptContextParts {
  const normalized = normalizeWhitespace(geoContext);
  if (!normalized) {
    return { primaryContext: '', recentNews: [] };
  }

  const headerMatch = /(?:^|\n\n)(Recent News[^\n]*)/.exec(normalized);
  if (!headerMatch) {
    return { primaryContext: normalized, recentNews: [] };
  }

  const primaryContext = normalized.slice(0, headerMatch.index).trim();
  const afterHeader = normalized.slice(headerMatch.index + headerMatch[0].length);
  const newsBlock = afterHeader.split('\n').filter(Boolean);
  const recentNews = trimList(
    newsBlock
      .map((line) => line.replace(/^\s*[-*]\s*/, '').trim())
      .filter(Boolean),
    10,
    1400,
  );

  return { primaryContext, recentNews };
}

export function inferProviderLabel(apiUrl: string): string {
  try {
    const host = new URL(apiUrl).hostname.toLowerCase();
    if (host.includes('groq')) return 'groq';
    if (host.includes('openrouter')) return 'openrouter';
    if (host.includes('ollama')) return 'ollama';
    if (host.includes('openai')) return 'openai-compatible';
    return host.replace(/^api\./, '') || 'custom';
  } catch {
    return 'custom';
  }
}

function buildSharedEvidencePrompt(primaryContext: string, recentNews: string[]): string {
  const parts: string[] = [];
  if (primaryContext) {
    parts.push(`Context:\n${primaryContext}`);
  }
  if (recentNews.length > 0) {
    parts.push(`Recent News Signals:\n${recentNews.map((line) => `- ${line}`).join('\n')}`);
  }
  if (parts.length === 0) {
    parts.push('Context:\nNo additional context was provided.');
  }
  return parts.join('\n\n');
}

export function buildDeductionPrompt(input: {
  query: string;
  geoContext: string;
  predictionContext?: string;
  now?: Date;
}): { mode: DeductionMode; systemPrompt: string; userPrompt: string } {
  const now = input.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const mode = inferDeductionMode(input.query);
  const { primaryContext, recentNews } = splitDeductionContext(input.geoContext);
  const evidence = buildSharedEvidencePrompt(primaryContext, recentNews);

  const predictionBlock = input.predictionContext
    ? `\n\n${input.predictionContext}`
    : '';

  if (mode === 'brief') {
    return {
      mode,
      systemPrompt: `You are a concise forecasting analyst.
Today is ${today} UTC.
Use only the supplied evidence plus durable background knowledge.
Do not invent current facts that are not supported by the evidence.
Return plain text in exactly 2 or 3 sentences.
- Sentence 1: core assessment and rough likelihood.
- Sentence 2: primary drivers or constraints.
- Optional sentence 3: the most important trigger to watch next.
No markdown, no bullets, no headings, no preamble.`,
      userPrompt: `Question:\n${input.query}\n\n${evidence}${predictionBlock}`,
    };
  }

  return {
    mode,
    systemPrompt: `You are a senior geopolitical and market forecaster.
Today is ${today} UTC.
Your job is to produce a grounded near-term forecast from the supplied evidence.
Rules:
- Separate observed facts from forecasted outcomes.
- Prefer the freshest and most specific evidence.
- If evidence is thin or conflicting, say so explicitly.
- Use rough probability ranges, not false precision.
- Do not use AI preambles.
- Keep the answer concise but structured.

Return Markdown with exactly these sections in this order:
**Bottom line**
**What we know**
**Most likely path (next 24-72h)**
**Alternative paths**
**Key drivers**
**Signals to watch**
**Confidence**

Formatting rules:
- Use short bullets under each section where useful.
- In "Alternative paths", include 2 alternatives with rough likelihood bands.
- In "Confidence", state High, Medium, or Low and explain why.
- Ground claims in the supplied evidence by naming sources, dates, locations, or signal types when possible.`,
    userPrompt: `Question:\n${input.query}\n\n${evidence}${predictionBlock}`,
  };
}

export function postProcessDeductionOutput(raw: string, mode: DeductionMode): string {
  const cleaned = normalizeWhitespace(
    raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*/gi, ''),
  );
  if (mode === 'brief') {
    return cleaned.replace(/\s+/g, ' ').trim();
  }
  return cleaned;
}
