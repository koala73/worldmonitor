import { extractJson } from '../../../../src/utils/ai-response';
import { trackUsage } from './spend-tracker';

const SONNET_MODEL = 'claude-sonnet-4-20250514';
const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';

interface AnalyzeInput { query: string; contextData: string[]; region: string; }
interface AnalyzeOutput {
  analysis: string; keyFindings: string[]; riskLevel: string;
  status: string; errorMessage: string; inputTokens: number; outputTokens: number;
}

const ERROR_RESULT: AnalyzeOutput = {
  analysis: '', keyFindings: [], riskLevel: '',
  status: 'error', errorMessage: '', inputTokens: 0, outputTokens: 0,
};

export async function handleAnalyze(input: AnalyzeInput): Promise<AnalyzeOutput> {
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) return { ...ERROR_RESULT, errorMessage: 'Claude API key not configured' };

  const systemPrompt = `You are a senior geopolitical analyst. Provide deep analysis of the given query with supporting evidence.${input.region ? ` Focus on the ${input.region} region.` : ''} Consider historical patterns, current dynamics, and potential trajectories. Respond in JSON: {"analysis":"...","key_findings":["..."],"risk_level":"low|medium|high|critical"}`;

  const userContent = input.contextData.length > 0
    ? `Query: ${input.query}\n\nContext:\n${input.contextData.join('\n')}`
    : input.query;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: SONNET_MODEL, max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) return { ...ERROR_RESULT, errorMessage: `Claude API error: ${response.status}` };

    const data = await response.json() as any;
    const text = data.content?.[0]?.text ?? '';
    const parsed = extractJson<{ analysis: string; key_findings: string[]; risk_level: string }>(text);

    const inputTokens = data.usage?.input_tokens ?? 0;
    const outputTokens = data.usage?.output_tokens ?? 0;
    trackUsage(inputTokens, outputTokens, 'sonnet');

    return {
      analysis: parsed.analysis ?? '', keyFindings: parsed.key_findings ?? [], riskLevel: parsed.risk_level ?? '',
      status: 'ok', errorMessage: '',
      inputTokens, outputTokens,
    };
  } catch (err) {
    return { ...ERROR_RESULT, errorMessage: err instanceof Error ? err.message : 'Unknown error' };
  }
}
