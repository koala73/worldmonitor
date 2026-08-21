export const RESEARCH_WORKBENCH_EVENT = 'wm:open-investment-research';
export const RESEARCH_WORKBENCH_VERSION = 'investment-research-workbench/v1';

export type ResearchStepId =
  | 'world-macro'
  | 'sector'
  | 'company'
  | 'agent-research'
  | 'critic'
  | 'scenarios'
  | 'thesis-tracker';

export type EvidenceKind = 'filing' | 'company-ir' | 'market-data' | 'news' | 'dashboard' | 'assumption';
export type EvidenceReliability = 'primary' | 'secondary' | 'model-input' | 'assumption';
export type ThesisPillarStatus = 'confirming' | 'watch' | 'disconfirming' | 'untested';

export interface ResearchSource {
  id: string;
  title: string;
  publisher: string;
  url: string;
  asOf: string;
  kind: EvidenceKind;
  reliability: EvidenceReliability;
}

export interface ResearchFinding {
  id: string;
  label: 'fact' | 'management-claim' | 'assumption' | 'model-output' | 'pm-judgment';
  text: string;
  sourceIds: string[];
}

export interface ResearchStage {
  id: string;
  stepId: ResearchStepId;
  name: string;
  provider: 'World Monitor' | 'OpenBB' | 'FinRobot' | 'Custom' | 'Langflow';
  status: 'ready' | 'needs-live-data';
  findings: ResearchFinding[];
}

export interface ResearchScenario {
  id: 'bull' | 'base' | 'bear';
  title: string;
  probabilityLabel: string;
  summary: string;
  provesOrKills: string;
  sourceIds: string[];
}

export interface ThesisPillar {
  id: string;
  title: string;
  status: ThesisPillarStatus;
  test: string;
  nextEvidence: string;
  sourceIds: string[];
}

export interface InvestmentResearchReport {
  schema: typeof RESEARCH_WORKBENCH_VERSION;
  symbol: string;
  companyName: string;
  sector: string;
  asOf: string;
  sourceMode: 'fixture' | 'live';
  readiness: 'decision-grade' | 'conditional' | 'not-decision-grade';
  companyThesisStatus: 'strengthening' | 'intact' | 'watch' | 'impaired' | 'broken' | 'untested';
  securityThesisReadiness: 'ready' | 'conditional' | 're-underwrite' | 'not-decision-grade';
  action: 'add' | 'press' | 'hold' | 'trim' | 'exit' | 'hedge' | 'watchlist' | 'wait-for-proof' | 're-underwrite';
  pricedIn: string;
  variantWedge: string;
  stages: ResearchStage[];
  scenarios: ResearchScenario[];
  thesisPillars: ThesisPillar[];
  sources: ResearchSource[];
}

export interface ResearchWorkbenchAdapter {
  readonly name: string;
  run(symbol: string, signal?: AbortSignal): Promise<InvestmentResearchReport>;
}

export interface ResearchWorkbenchOptions {
  endpoint?: string;
  fetchImpl?: typeof fetch;
}

const ASTS_SOURCES: ResearchSource[] = [
  {
    id: 'ASTS-10Q-2026Q2',
    title: 'Quarterly Report for the period ended June 30, 2026',
    publisher: 'SEC / AST SpaceMobile',
    url: 'https://www.sec.gov/Archives/edgar/data/1780312/000119312526342550/asts-20260630.htm',
    asOf: '2026-08-10',
    kind: 'filing',
    reliability: 'primary',
  },
  {
    id: 'ASTS-8K-2026Q2',
    title: 'Current Report dated August 10, 2026',
    publisher: 'SEC / AST SpaceMobile',
    url: 'https://www.sec.gov/Archives/edgar/data/1780312/000119312526342540/asts-20260810.htm',
    asOf: '2026-08-10',
    kind: 'filing',
    reliability: 'primary',
  },
  {
    id: 'ASTS-IR',
    title: 'Investor relations and company updates',
    publisher: 'AST SpaceMobile',
    url: 'https://investors.ast-science.com/',
    asOf: '2026-08-10',
    kind: 'company-ir',
    reliability: 'primary',
  },
  {
    id: 'WM-MACRO-LIVE',
    title: 'World Monitor live macro and geopolitical signal set',
    publisher: 'World Monitor',
    url: 'https://finance.worldmonitor.app/dashboard',
    asOf: 'live',
    kind: 'dashboard',
    reliability: 'model-input',
  },
  {
    id: 'OPENBB-LIVE-GAP',
    title: 'Current price, consensus, estimates and comparable-company data required',
    publisher: 'OpenBB adapter',
    url: '',
    asOf: 'not-connected',
    kind: 'assumption',
    reliability: 'assumption',
  },
];

const ASTS_FIXTURE: InvestmentResearchReport = {
  schema: RESEARCH_WORKBENCH_VERSION,
  symbol: 'ASTS',
  companyName: 'AST SpaceMobile, Inc.',
  sector: 'Satellite communications / direct-to-device connectivity',
  asOf: '2026-08-10',
  sourceMode: 'fixture',
  readiness: 'not-decision-grade',
  companyThesisStatus: 'watch',
  securityThesisReadiness: 'not-decision-grade',
  action: 'wait-for-proof',
  pricedIn: 'Not assessed: the fixture deliberately omits a stale price, live consensus and positioning snapshot.',
  variantWedge: 'The research edge is execution evidence: launch cadence, regulatory clearance and service conversion must outrun capital intensity and financing risk.',
  stages: [
    {
      id: 'macro-regime',
      stepId: 'world-macro',
      name: 'World / macro signals',
      provider: 'World Monitor',
      status: 'ready',
      findings: [
        { id: 'macro-1', label: 'pm-judgment', text: 'Rates, risk appetite and geopolitical launch/supply-chain disruptions are the main transmission paths into a pre-scale satellite equity.', sourceIds: ['WM-MACRO-LIVE'] },
      ],
    },
    {
      id: 'sector-map',
      stepId: 'sector',
      name: 'Sector map',
      provider: 'Custom',
      status: 'ready',
      findings: [
        { id: 'sector-1', label: 'pm-judgment', text: 'Direct-to-device economics depend on spectrum access, operator distribution, constellation availability and service quality—not satellite count alone.', sourceIds: ['ASTS-10Q-2026Q2', 'ASTS-IR'] },
      ],
    },
    {
      id: 'company-map',
      stepId: 'company',
      name: 'Company operating model',
      provider: 'FinRobot',
      status: 'ready',
      findings: [
        { id: 'company-1', label: 'fact', text: 'The latest filing frames launch timing, satellite performance, regulatory approvals and commercialization timing as material execution dependencies.', sourceIds: ['ASTS-10Q-2026Q2'] },
      ],
    },
    {
      id: 'earnings-agent',
      stepId: 'agent-research',
      name: 'Earnings agent',
      provider: 'OpenBB',
      status: 'ready',
      findings: [
        { id: 'earnings-1', label: 'management-claim', text: 'Management states existing cash and cash equivalents should cover anticipated requirements for the next twelve months, while warning actual capital needs may differ.', sourceIds: ['ASTS-10Q-2026Q2'] },
      ],
    },
    {
      id: 'news-agent',
      stepId: 'agent-research',
      name: 'News agent',
      provider: 'Custom',
      status: 'ready',
      findings: [
        { id: 'news-1', label: 'assumption', text: 'Live news scoring is intentionally deferred to the configured orchestration endpoint; the local fixture links only primary company evidence.', sourceIds: ['ASTS-8K-2026Q2', 'ASTS-IR'] },
      ],
    },
    {
      id: 'valuation-agent',
      stepId: 'agent-research',
      name: 'Valuation agent',
      provider: 'OpenBB',
      status: 'needs-live-data',
      findings: [
        { id: 'valuation-1', label: 'assumption', text: 'Current price, diluted share count, consensus, peer definitions and scenario inputs are missing; no target price should be inferred.', sourceIds: ['OPENBB-LIVE-GAP'] },
      ],
    },
    {
      id: 'company-macro-agent',
      stepId: 'agent-research',
      name: 'Company macro agent',
      provider: 'World Monitor',
      status: 'ready',
      findings: [
        { id: 'company-macro-1', label: 'pm-judgment', text: 'Higher funding costs or risk-off conditions increase dilution sensitivity before recurring commercial cash generation is proven.', sourceIds: ['ASTS-10Q-2026Q2', 'WM-MACRO-LIVE'] },
      ],
    },
    {
      id: 'critic-agent',
      stepId: 'critic',
      name: 'Critic / red team',
      provider: 'Langflow',
      status: 'ready',
      findings: [
        { id: 'critic-1', label: 'pm-judgment', text: 'The strongest bear case is not that the technology never works; it is that commercial proof arrives later than capital consumption and market expectations allow.', sourceIds: ['ASTS-10Q-2026Q2'] },
      ],
    },
  ],
  scenarios: [
    { id: 'bull', title: 'Bull', probabilityLabel: 'Unscored', summary: 'Launch, deployment and regulatory evidence compounds into credible service conversion with manageable funding needs.', provesOrKills: 'Proved by repeatable service KPIs and disclosed commercial cash conversion.', sourceIds: ['ASTS-10Q-2026Q2', 'ASTS-IR'] },
    { id: 'base', title: 'Base', probabilityLabel: 'Unscored', summary: 'Technical progress continues, but commercialization remains staged and valuation stays highly sensitive to timing.', provesOrKills: 'Requires live estimates and price before the security thesis can be underwritten.', sourceIds: ['ASTS-10Q-2026Q2', 'OPENBB-LIVE-GAP'] },
    { id: 'bear', title: 'Bear', probabilityLabel: 'Unscored', summary: 'Launch, deployment, regulatory or service delays extend the pre-scale funding window and increase dilution risk.', provesOrKills: 'Triggered by repeated milestone slippage, weaker service evidence or financing on materially adverse terms.', sourceIds: ['ASTS-10Q-2026Q2'] },
  ],
  thesisPillars: [
    { id: 'constellation', title: 'Constellation execution', status: 'watch', test: 'Milestones translate into functioning, deployed capacity on the disclosed schedule.', nextEvidence: 'Next launch/deployment update and in-orbit performance disclosure.', sourceIds: ['ASTS-10Q-2026Q2', 'ASTS-IR'] },
    { id: 'commercialization', title: 'Commercial conversion', status: 'untested', test: 'Operator relationships convert into observable service usage and recurring economics.', nextEvidence: 'Service availability, subscriber/usage or revenue-quality disclosure.', sourceIds: ['ASTS-IR', 'ASTS-8K-2026Q2'] },
    { id: 'capital', title: 'Capital endurance', status: 'watch', test: 'Liquidity runway remains ahead of the commercialization proof window without punitive dilution.', nextEvidence: 'Next balance-sheet, cash-flow and financing update.', sourceIds: ['ASTS-10Q-2026Q2'] },
  ],
  sources: ASTS_SOURCES,
};

export function validateInvestmentResearchReport(report: InvestmentResearchReport): string[] {
  const errors: string[] = [];
  if (report.schema !== RESEARCH_WORKBENCH_VERSION) errors.push('Unsupported research report schema.');
  if (!report.symbol.trim()) errors.push('Missing symbol.');
  const sourceIds = new Set(report.sources.map((source) => source.id));
  if (sourceIds.size !== report.sources.length) errors.push('Source ids must be unique.');

  const referenced = [
    ...report.stages.flatMap((stage) => stage.findings.flatMap((finding) => finding.sourceIds)),
    ...report.scenarios.flatMap((scenario) => scenario.sourceIds),
    ...report.thesisPillars.flatMap((pillar) => pillar.sourceIds),
  ];
  for (const id of referenced) {
    if (!sourceIds.has(id)) errors.push(`Unknown source id: ${id}`);
  }
  return [...new Set(errors)];
}

export function getFixtureResearchReport(symbol: string): InvestmentResearchReport {
  const normalized = symbol.trim().toUpperCase();
  if (normalized !== 'ASTS') throw new Error(`No local fixture for ${normalized || 'empty symbol'}. Configure a research orchestration endpoint for additional companies.`);
  return structuredClone(ASTS_FIXTURE);
}

class FixtureResearchAdapter implements ResearchWorkbenchAdapter {
  readonly name = 'Local traceable fixture';

  async run(symbol: string): Promise<InvestmentResearchReport> {
    return getFixtureResearchReport(symbol);
  }
}

class HttpResearchAdapter implements ResearchWorkbenchAdapter {
  readonly name = 'Langflow research orchestration';

  constructor(
    private readonly endpoint: string,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async run(symbol: string, signal?: AbortSignal): Promise<InvestmentResearchReport> {
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schema: RESEARCH_WORKBENCH_VERSION,
        symbol: symbol.trim().toUpperCase(),
        workflow: ['world-macro', 'sector', 'company', ['earnings', 'news', 'valuation', 'macro'], 'critic', 'scenarios', 'thesis-tracker'],
        dataLayer: 'openbb',
      }),
      signal,
    });
    if (!response.ok) throw new Error(`Research orchestration failed (${response.status}).`);
    const report = await response.json() as InvestmentResearchReport;
    const errors = validateInvestmentResearchReport(report);
    if (errors.length > 0) throw new Error(errors.join(' '));
    return { ...report, sourceMode: 'live' };
  }
}

export function createResearchWorkbenchAdapter(options: ResearchWorkbenchOptions = {}): ResearchWorkbenchAdapter {
  const endpoint = options.endpoint?.trim();
  if (!endpoint) return new FixtureResearchAdapter();
  return new HttpResearchAdapter(endpoint, options.fetchImpl ?? ((...args) => globalThis.fetch(...args)));
}

export function dispatchInvestmentResearchOpen(symbol: string): void {
  window.dispatchEvent(new CustomEvent(RESEARCH_WORKBENCH_EVENT, {
    detail: { symbol: symbol.trim().toUpperCase() },
  }));
}
