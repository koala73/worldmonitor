import { extractJson, validateDimensionScores, type DimensionScore } from '../../../../src/utils/ai-response';
import { trackUsage } from './spend-tracker';

const SONNET_MODEL = 'claude-sonnet-4-20250514';
const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';

interface PredictInput { scenario: string; evidence: string[]; timeframe: string; }
interface PredictOutput {
  dimensions: DimensionScore[]; overallProbability: number; confidence: string;
  timeframe: string; narrative: string;
  status: string; errorMessage: string; inputTokens: number; outputTokens: number;
}

const ERROR_RESULT: PredictOutput = {
  dimensions: [], overallProbability: 0, confidence: 'low', timeframe: '', narrative: '',
  status: 'error', errorMessage: '', inputTokens: 0, outputTokens: 0,
};

const JP360_SYSTEM_PROMPT = `You are a military intelligence analyst using the JP 3-60 Joint Targeting framework.
Score the scenario on 6 dimensions (0.0-1.0):
1. Military Readiness (20%) -- Force deployments, logistics, exercises
2. Political Will (25%) -- Leadership statements, domestic politics
3. Target Urgency (20%) -- Threat timelines, capability windows
4. Diplomatic Alternatives (15%) -- Negotiation status, sanctions
5. Allied Support (10%) -- Coalition readiness, basing agreements
6. Provocation Level (10%) -- Recent incidents, escalation patterns

Respond in JSON: {"dimensions":[{"name":"...","score":0.0-1.0,"weight":0.0-1.0,"reasoning":"..."}],"overall_probability":0.0-1.0,"confidence":"low|medium|high","timeframe":"...","narrative":"..."}`;

export async function handlePredict(input: PredictInput): Promise<PredictOutput> {
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) return { ...ERROR_RESULT, errorMessage: 'Claude API key not configured' };

  const userContent = input.evidence.length > 0
    ? `Scenario: ${input.scenario}\nTimeframe: ${input.timeframe}\n\nEvidence:\n${input.evidence.join('\n')}`
    : `Scenario: ${input.scenario}\nTimeframe: ${input.timeframe}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: SONNET_MODEL, max_tokens: 2048,
        system: JP360_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) return { ...ERROR_RESULT, errorMessage: `Claude API error: ${response.status}` };

    const data = await response.json() as any;
    const text = data.content?.[0]?.text ?? '';
    const parsed = extractJson<{
      dimensions: DimensionScore[];
      overall_probability: number;
      confidence: string;
      timeframe: string;
      narrative: string;
    }>(text);

    const validatedDimensions = validateDimensionScores(parsed.dimensions ?? []);

    const inputTokens = data.usage?.input_tokens ?? 0;
    const outputTokens = data.usage?.output_tokens ?? 0;
    trackUsage(inputTokens, outputTokens, 'sonnet');

    return {
      dimensions: validatedDimensions,
      overallProbability: Math.max(0, Math.min(1, parsed.overall_probability ?? 0)),
      confidence: parsed.confidence ?? 'low',
      timeframe: parsed.timeframe ?? '',
      narrative: parsed.narrative ?? '',
      status: 'ok', errorMessage: '',
      inputTokens, outputTokens,
    };
  } catch (err) {
    return { ...ERROR_RESULT, errorMessage: err instanceof Error ? err.message : 'Unknown error' };
  }
}
