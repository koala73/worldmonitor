import type { AnalystContext } from './chat-analyst-context';

const DOMAIN_EMPHASIS: Record<string, string> = {
  market: 'Emphasise market signals, trade implications, price action, and economic indicators.',
  geo: 'Emphasise geopolitical developments, country risk, territorial disputes, and diplomatic events.',
  military: 'Emphasise force posture, conflict escalation, weapons systems, and military operations.',
  economic: 'Emphasise macroeconomic signals, monetary policy, inflation, supply chains, and fiscal trends.',
};

export function buildAnalystSystemPrompt(ctx: AnalystContext, domainFocus?: string): string {
  const emphasis = (domainFocus && domainFocus !== 'all')
    ? (DOMAIN_EMPHASIS[domainFocus] ?? '')
    : '';

  const contextSections: string[] = [];

  if (ctx.worldBrief) contextSections.push(`## Current Situation\n${ctx.worldBrief}`);
  if (ctx.riskScores) contextSections.push(`## ${ctx.riskScores}`);
  if (ctx.marketImplications) contextSections.push(`## ${ctx.marketImplications}`);
  if (ctx.forecasts) contextSections.push(`## ${ctx.forecasts}`);
  if (ctx.marketData) contextSections.push(`## ${ctx.marketData}`);
  if (ctx.macroSignals) contextSections.push(`## ${ctx.macroSignals}`);
  if (ctx.predictionMarkets) contextSections.push(`## ${ctx.predictionMarkets}`);
  if (ctx.countryBrief) contextSections.push(`## ${ctx.countryBrief}`);

  const liveContext = contextSections.length > 0
    ? contextSections.join('\n\n')
    : '(No live data available — base your response on general knowledge and note this limitation.)';

  return `You are a senior intelligence analyst providing live situational awareness as of ${ctx.timestamp}.
Respond in structured prose. Lead with the key insight. Keep responses under 250 words unless more depth is explicitly requested.
Use SITUATION / ANALYSIS / WATCH format for geopolitical queries.
For market queries use SIGNAL / THESIS / RISK.
Never speculate beyond what the data supports. Acknowledge uncertainty explicitly.
Do not cite data sources by name. Do not mention AI, models, or providers.
${emphasis ? `\n${emphasis}\n` : ''}
--- LIVE CONTEXT ---
${liveContext}
--- END CONTEXT ---`;
}
