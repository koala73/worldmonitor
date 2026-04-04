import type { AnalystContext } from './chat-analyst-context';

const DOMAIN_EMPHASIS: Record<string, string> = {
  market: 'Emphasise market signals, trade implications, price action, and economic indicators.',
  geo: 'Emphasise geopolitical developments, country risk, territorial disputes, and diplomatic events.',
  military: 'Emphasise force posture, conflict escalation, weapons systems, and military operations.',
  economic: 'Emphasise macroeconomic signals, monetary policy, inflation, supply chains, and fiscal trends.',
};

/** Context fields included per domain. 'all' includes everything. */
const DOMAIN_SECTIONS: Record<string, Set<string>> = {
  market:   new Set(['relevantArticles', 'marketData', 'macroSignals', 'marketImplications', 'predictionMarkets', 'forecasts', 'liveHeadlines']),
  geo:      new Set(['relevantArticles', 'worldBrief', 'riskScores', 'forecasts', 'predictionMarkets', 'countryBrief', 'energyExposure', 'liveHeadlines']),
  military: new Set(['relevantArticles', 'worldBrief', 'riskScores', 'forecasts', 'countryBrief', 'liveHeadlines']),
  economic: new Set(['relevantArticles', 'marketData', 'macroSignals', 'marketImplications', 'riskScores', 'energyExposure', 'liveHeadlines']),
};

export function buildAnalystSystemPrompt(ctx: AnalystContext, domainFocus?: string): string {
  const emphasis = (domainFocus && domainFocus !== 'all')
    ? (DOMAIN_EMPHASIS[domainFocus] ?? '')
    : '';

  const allowed = (domainFocus && domainFocus !== 'all' && DOMAIN_SECTIONS[domainFocus])
    ? DOMAIN_SECTIONS[domainFocus]
    : null; // null = include all

  const include = (field: string) => allowed === null || allowed.has(field);

  const contextSections: string[] = [];

  if (ctx.relevantArticles && include('relevantArticles'))
    contextSections.push(`## Matched News Articles\n${ctx.relevantArticles}`);
  if (ctx.worldBrief && include('worldBrief'))
    contextSections.push(`## Current Situation\n${ctx.worldBrief}`);
  if (ctx.riskScores && include('riskScores'))
    contextSections.push(`## ${ctx.riskScores}`);
  if (ctx.marketImplications && include('marketImplications'))
    contextSections.push(`## ${ctx.marketImplications}`);
  if (ctx.forecasts && include('forecasts'))
    contextSections.push(`## ${ctx.forecasts}`);
  if (ctx.marketData && include('marketData'))
    contextSections.push(`## ${ctx.marketData}`);
  if (ctx.macroSignals && include('macroSignals'))
    contextSections.push(`## ${ctx.macroSignals}`);
  if (ctx.energyExposure && include('energyExposure'))
    contextSections.push(`## Energy Exposure\n${ctx.energyExposure}`);
  if (ctx.predictionMarkets && include('predictionMarkets'))
    contextSections.push(`## ${ctx.predictionMarkets}`);
  if (ctx.countryBrief && include('countryBrief'))
    contextSections.push(`## ${ctx.countryBrief}`);
  if (ctx.liveHeadlines && include('liveHeadlines'))
    contextSections.push(`## ${ctx.liveHeadlines}`);

  const liveContext = contextSections.length > 0
    ? contextSections.join('\n\n')
    : '(No live context available. Acknowledge this limitation explicitly. Do not present inference or training knowledge as current intelligence.)';

  return `You are a senior intelligence analyst providing live situational awareness as of ${ctx.timestamp}.
Respond in structured prose. Lead with the key insight. Keep responses under 350 words unless more depth is explicitly requested.
Use ** bold ** section headers. Cite specific figures and dates from the context where available.
Use SITUATION / ANALYSIS / WATCH format for geopolitical queries.
For market queries use SIGNAL / THESIS / RISK.
Never speculate beyond what the data supports. Acknowledge uncertainty explicitly.
Do not cite data sources by name. Do not mention AI, models, or providers.
${ctx.relevantArticles ? 'When "Matched News Articles" appear in context, treat them as the primary factual basis for your response. Cite them before forecast probabilities or risk scores.\n' : ''}\
${emphasis ? `\n${emphasis}\n` : ''}
--- LIVE CONTEXT ---
${liveContext}
--- END CONTEXT ---`;
}
