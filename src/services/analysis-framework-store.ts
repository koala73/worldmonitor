import { loadFromStorage, saveToStorage } from '@/utils';
import { hasPremiumAccess } from './panel-gating';

const LIBRARY_KEY = 'wm-analysis-frameworks';
const PANEL_KEY = 'wm-panel-frameworks';
const FRAMEWORK_CHANGED_EVENT = 'wm-framework-changed';
const MAX_IMPORTED = 20;
const MAX_INSTRUCTIONS_LEN = 2000;

export type AnalysisPanelId =
  | 'insights'
  | 'country-brief'
  | 'daily-market-brief'
  | 'deduction'
  | 'market-implications';

export interface AnalysisFramework {
  id: string;
  name: string;
  description: string;
  systemPromptAppend: string;
  isBuiltIn: boolean;
  createdAt: number;
}

export const BUILT_IN_FRAMEWORKS: AnalysisFramework[] = [
  {
    id: 'dalio-macro',
    name: 'Ray Dalio Macroeconomic Cycles',
    description: 'Debt cycles, wealth gaps, reserve currency dynamics',
    isBuiltIn: true,
    createdAt: 0,
    systemPromptAppend: `Analyze this situation through the lens of Ray Dalio's macroeconomic framework.
Structure your analysis around:
1. Debt cycle positioning: identify whether the relevant economy or market is in an early, middle, or late phase of the short-term debt cycle (5–8 years) and/or the long-term debt cycle (75–100 years). Note signs of deleveraging, reflation, or credit expansion.
2. Wealth and political gap: assess whether inequality trends are amplifying internal conflict, populist policy risk, or capital flight.
3. Reserve currency status: if relevant, evaluate threats to or dependence on the dominant reserve currency. Note any de-dollarisation dynamics or monetary cooperation shifts.
4. The three forces: separately weigh (a) productivity growth, (b) short-term debt cycle effects, and (c) long-term debt cycle effects as contributing factors to the current situation.
5. Root-cause diagnosis: prefer structural explanations over proximate ones. Ask: what machine is producing this outcome?
Close with: the most likely next arc of this cycle, and what classic Dalio playbook response (print, reform, restructure, or conflict) seems most probable.`,
  },
  {
    id: 'buffett-value',
    name: 'Warren Buffett Value & Risk',
    description: 'Durable moat, management quality, margin of safety',
    isBuiltIn: true,
    createdAt: 0,
    systemPromptAppend: `Analyze this situation through Warren Buffett's value investing and risk assessment framework.
Structure your analysis around:
1. Durable competitive advantage (moat): does the entity at the centre of this story possess a sustainable moat — cost leadership, network effects, switching costs, or intangible assets? Is that moat widening or eroding?
2. Management quality and capital allocation: are decision-makers behaving rationally with capital? Are they honest with stakeholders? Look for evidence of empire-building, accounting aggression, or genuine long-term orientation.
3. Margin of safety: what is the downside scenario, and how severe is it? Quantify the worst case before discussing the upside. Buffett thinks about permanent loss of capital first.
4. Circle of competence: flag explicitly if this situation involves dynamics that are structurally difficult to predict (novel technology, regulatory discretion, geopolitical escalation ladders). Note the epistemic limit.
5. Business economics: is this a business (or state) that earns a high return on capital without requiring continuous heavy reinvestment? Or does it consume capital to grow?
Close with: a plain-language verdict on whether this situation represents a durable value opportunity, a value trap, or a situation outside the circle of competence.`,
  },
  {
    id: 'geopolitical-equilibrium',
    name: 'Adversarial Geopolitical Equilibrium',
    description: 'Game theory, actor payoffs, power balance, credible commitments',
    isBuiltIn: true,
    createdAt: 0,
    systemPromptAppend: `Analyze this situation as an adversarial geopolitical equilibrium problem.
Structure your analysis around:
1. Actor map: identify the principal actors (states, factions, institutions, firms). For each, state their primary objective, their best alternative to agreement (BATNA), and their red lines.
2. Payoff structure: is this a zero-sum, positive-sum, or mixed-motive game? Identify whether cooperation is stable (enforceable commitments exist) or whether defection is the dominant strategy.
3. Equilibrium assessment: what is the current equilibrium? Is it stable (no actor benefits from unilateral deviation) or is it a fragile coordination point? Name the mechanism holding it in place.
4. Destabilisation vectors: list the top three shocks or moves that would break the current equilibrium. Who has the incentive and capability to trigger each?
5. Alliance mathematics: trace second-order effects — how do shifts in one bilateral relationship alter the payoffs in adjacent relationships? Apply balance-of-power logic.
6. Credibility and signalling: assess whether key commitments (deterrence postures, treaty obligations, sanctions threats) are credible. Cheap talk vs. costly signals.
Close with: the most likely equilibrium transition path and the leading indicator to watch.`,
  },
  {
    id: 'pmesii',
    name: 'PMESII-PT Analysis',
    description: 'Political, Military, Economic, Social, Infrastructure, Information, Physical, Time',
    isBuiltIn: true,
    createdAt: 0,
    systemPromptAppend: `Analyze this situation using the PMESII-PT operational environment framework used in military and strategic analysis.
Assess each dimension in turn:
- Political: governance legitimacy, leadership cohesion, succession risk, external interference in political processes.
- Military: hard power balance, force readiness and morale, doctrine and training quality, escalation thresholds, asymmetric capabilities (drones, cyber, proxy forces).
- Economic: GDP trajectory, fiscal health, sanctions exposure, supply chain dependencies, resource leverage points.
- Social: demographic trends, inter-communal tensions, public trust in institutions, diaspora influence, information environment health.
- Infrastructure: critical infrastructure vulnerabilities (energy, water, transport, communications), cyber attack surface, resilience of logistics networks.
- Information: narrative dominance, disinformation vectors, media freedom, strategic communications effectiveness.
- Physical environment: terrain, climate stress, resource geography, natural disaster exposure.
- Time: which actor benefits from delay vs. speed? Is time pressure increasing or decreasing for each side?
Close with: the two or three PMESII dimensions that are most decisive for the outcome, and the cross-dimensional interaction most likely to produce a non-linear effect.`,
  },
  {
    id: 'red-team',
    name: 'Red Team Devil\'s Advocate',
    description: 'Challenge consensus, steelman contrarian, surface hidden assumptions',
    isBuiltIn: true,
    createdAt: 0,
    systemPromptAppend: `Your role is to challenge the consensus narrative on this situation by applying red team analysis.
Structure your challenge as follows:
1. State the consensus view: in 2–3 sentences, articulate the mainstream interpretation of this situation as it would appear in a major financial paper or intelligence summary.
2. Steelman the opposite: construct the strongest possible case for the contrarian position. Do not use strawmen — find the best evidence and logic available for the alternative.
3. Hidden assumptions audit: list 3–5 assumptions embedded in the consensus view that are treated as given but are actually contestable. For each, describe what would happen if the assumption is wrong.
4. Worst-case scenario (tail risk): describe the plausible worst-case outcome that the consensus view is systematically underweighting. What would need to be true for this to materialise?
5. Who benefits from the current narrative: identify actors who have incentives to promote the consensus framing. Does the prevalence of a narrative correlate with the interests of those spreading it?
6. Early warning signals: what observable data points would indicate the contrarian scenario is beginning to unfold? List 2–3 specific, trackable signals.
Close with: a one-sentence devil's advocate verdict — what is the most important thing the consensus is probably wrong about?`,
  },
];

const _activeCache = new Map<AnalysisPanelId, AnalysisFramework | null>();

export function loadFrameworkLibrary(): AnalysisFramework[] {
  const imported = loadFromStorage<AnalysisFramework[]>(LIBRARY_KEY, []);
  return [...BUILT_IN_FRAMEWORKS, ...imported];
}

export function saveImportedFramework(fw: Omit<AnalysisFramework, 'isBuiltIn' | 'createdAt'>): void {
  const imported = loadFromStorage<AnalysisFramework[]>(LIBRARY_KEY, []);
  if (imported.length >= MAX_IMPORTED) {
    throw new Error(`Library is full (max ${MAX_IMPORTED} imported frameworks).`);
  }
  if (fw.systemPromptAppend.length > MAX_INSTRUCTIONS_LEN) {
    throw new Error(`Instructions exceed the ${MAX_INSTRUCTIONS_LEN}-character limit (${fw.systemPromptAppend.length} chars). Trim and retry.`);
  }
  const existing = loadFrameworkLibrary();
  if (existing.some(f => f.name === fw.name)) {
    throw new Error(`A framework named '${fw.name}' already exists. Rename the existing one first.`);
  }
  const newFw: AnalysisFramework = { ...fw, isBuiltIn: false, createdAt: Date.now() };
  saveToStorage(LIBRARY_KEY, [...imported, newFw]);
  _activeCache.clear();
}

export function deleteImportedFramework(id: string): void {
  if (BUILT_IN_FRAMEWORKS.some(f => f.id === id)) return;
  const imported = loadFromStorage<AnalysisFramework[]>(LIBRARY_KEY, []);
  saveToStorage(LIBRARY_KEY, imported.filter(f => f.id !== id));
  _activeCache.clear();
}

export function renameImportedFramework(id: string, name: string): void {
  if (BUILT_IN_FRAMEWORKS.some(f => f.id === id)) return;
  const imported = loadFromStorage<AnalysisFramework[]>(LIBRARY_KEY, []);
  saveToStorage(LIBRARY_KEY, imported.map(f => f.id === id ? { ...f, name } : f));
  _activeCache.clear();
}

export function getActiveFrameworkForPanel(panelId: AnalysisPanelId): AnalysisFramework | null {
  if (!hasPremiumAccess()) return null;
  if (_activeCache.has(panelId)) return _activeCache.get(panelId)!;
  const selections = loadFromStorage<Record<string, string | null>>(PANEL_KEY, {});
  const frameworkId = selections[panelId] ?? null;
  if (!frameworkId) { _activeCache.set(panelId, null); return null; }
  const result = loadFrameworkLibrary().find(f => f.id === frameworkId) ?? null;
  _activeCache.set(panelId, result);
  return result;
}

export function setActiveFrameworkForPanel(panelId: AnalysisPanelId, frameworkId: string | null): void {
  const selections = loadFromStorage<Record<string, string | null>>(PANEL_KEY, {});
  saveToStorage(PANEL_KEY, { ...selections, [panelId]: frameworkId });
  _activeCache.delete(panelId);
  window.dispatchEvent(new CustomEvent(FRAMEWORK_CHANGED_EVENT, {
    detail: { panelId, frameworkId },
  }));
}

export function subscribeFrameworkChange(
  panelId: AnalysisPanelId,
  cb: () => void,
): () => void {
  const listener = (e: Event) => {
    const evt = e as CustomEvent<{ panelId: AnalysisPanelId; frameworkId: string | null }>;
    if (evt.detail.panelId === panelId) cb();
  };
  window.addEventListener(FRAMEWORK_CHANGED_EVENT, listener);
  return () => window.removeEventListener(FRAMEWORK_CHANGED_EVENT, listener);
}

export { MAX_INSTRUCTIONS_LEN };
