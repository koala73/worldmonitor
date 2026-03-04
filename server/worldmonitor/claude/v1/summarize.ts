import { extractJson } from '../../../../src/utils/ai-response';
import { trackUsage } from './spend-tracker';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';

interface SummarizeInput { headlines: string[]; region: string; language: string; variant: string; }
interface SummarizeOutput {
  summary: string; keyPoints: string[]; sentiment: string; provider: string;
  status: string; errorMessage: string; inputTokens: number; outputTokens: number;
}

const ERROR_RESULT: SummarizeOutput = {
  summary: '', keyPoints: [], sentiment: '', provider: 'claude',
  status: 'error', errorMessage: '', inputTokens: 0, outputTokens: 0,
};

export async function handleSummarize(input: SummarizeInput): Promise<SummarizeOutput> {
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) return { ...ERROR_RESULT, errorMessage: 'Claude API key not configured' };

  const systemPrompt = `You are a concise news analyst. Summarize these headlines into a brief situational overview (2-3 paragraphs). Focus on geopolitical significance.${input.region ? ` Region focus: ${input.region}.` : ''} Language: ${input.language || 'en'}. Respond in JSON: {"summary":"...","key_points":["..."],"sentiment":"positive|negative|neutral|mixed"}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: HAIKU_MODEL, max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: input.headlines.join('\n') }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) return { ...ERROR_RESULT, errorMessage: `Claude API error: ${response.status}` };

    const data = await response.json() as any;
    const text = data.content?.[0]?.text ?? '';
    const parsed = extractJson<{ summary: string; key_points: string[]; sentiment: string }>(text);

    const inputTokens = data.usage?.input_tokens ?? 0;
    const outputTokens = data.usage?.output_tokens ?? 0;
    trackUsage(inputTokens, outputTokens, 'haiku');

    return {
      summary: parsed.summary ?? '', keyPoints: parsed.key_points ?? [], sentiment: parsed.sentiment ?? '',
      provider: 'claude', status: 'ok', errorMessage: '',
      inputTokens, outputTokens,
    };
  } catch (err) {
    return { ...ERROR_RESULT, errorMessage: err instanceof Error ? err.message : 'Unknown error' };
  }
}
