export interface PersonalPortfolioHolding {
  ticker: string;
  name: string;
  account: string;
  currency: string;
  weight_pct: number;
  gain_pct: number | null;
  priced: boolean;
}

export interface PersonalPortfolioRule {
  rule_id: string;
  name: string;
  ok: boolean;
  severity: string;
  message: string;
  detail_count?: number;
  detail?: string[];
}

export interface PersonalPortfolioCurrencyExposure {
  currency: string;
  weight_pct: number;
}

export interface PersonalPortfolioExport {
  schema_version: number;
  generated_at: string;
  source: string;
  detail: 'risk' | 'full';
  privacy: {
    exact_amounts: boolean;
    exact_quantities: boolean;
    intended_use: string;
  };
  summary: {
    holding_count: number;
    account_count: number;
    total_gain_pct: number | null;
    cached_prices: boolean;
  };
  accounts: Array<{
    account: string;
    holding_count: number;
    weight_pct: number;
  }>;
  currency: PersonalPortfolioCurrencyExposure[];
  holdings: PersonalPortfolioHolding[];
  risk_rules: PersonalPortfolioRule[];
}

export interface PersonalPortfolioTargetAllocation {
  label: string;
  key: string;
  target_pct: number;
  color?: string;
}

export interface PersonalPortfolioTargets {
  description?: string;
  updated_at?: string;
  allocations: PersonalPortfolioTargetAllocation[];
  ticker_map?: Record<string, string>;
  error?: string;
}

export interface IdeaRadarReviewHistoryEntry {
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastScore: number;
  lastStance?: 'watch' | 'research' | 'starter-size only' | 'avoid';
  scoreBand?: 'weak' | 'developing' | 'actionable' | 'strong';
  driverCluster?: string;
  thesisFamily?: string;
  scoreMix?: Array<{
    label: string;
    pct: number;
  }>;
  themeStrength?: {
    score: number;
    label: string;
  };
  shortTermConfirmation?: {
    score: number;
    label: string;
  };
  orderFlowRegime?: {
    score: number;
    label: string;
  };
  backtestConsistency?: {
    winRate: number;
    actionableSignals: number;
  };
}

export interface IdeaRadarReviewHistoryPayload {
  schema_version: number;
  updated_at: string | null;
  history: Record<string, IdeaRadarReviewHistoryEntry>;
}

export interface IdeaRadarEvaluationLogEntry {
  loggedAt: string;
  generatedAt: string;
  symbol: string;
  name: string;
  assetType: 'equity' | 'crypto';
  horizon: '10m' | '1h' | '1d' | '1w';
  stance: 'watch' | 'research' | 'starter-size only' | 'avoid';
  score: number;
  themeStrength?: { score: number; label: string } | null;
  shortTermConfirmation?: { score: number; label: string } | null;
  orderFlowRegime?: { score: number; label: string } | null;
  backtestConsistency?: { winRate: number | null; actionableSignals: number } | null;
  scoreMix?: Array<{ label: string; pct: number }>;
  stanceReason?: string;
  shiftSummary?: string;
  priceAtLog?: number | null;
  latestPrice?: number | null;
  latestReturnPct?: number | null;
  outcomeStatus?: 'pending' | 'positive' | 'negative' | 'flat' | 'stale';
  evaluatedAt?: string | null;
}

export interface IdeaRadarEvaluationLogPayload {
  schema_version: number;
  updated_at: string | null;
  entries: IdeaRadarEvaluationLogEntry[];
}

export interface PortfolioImpactAction {
  level: 'alert' | 'watch' | 'info';
  title: string;
  body: string;
}

export interface PortfolioImpactTheme {
  id: string;
  title: string;
  rationale: string;
}

export interface PortfolioImpactViewModel {
  generatedAt: string;
  summary: PersonalPortfolioExport['summary'];
  topHoldings: PersonalPortfolioHolding[];
  currencies: PersonalPortfolioCurrencyExposure[];
  actions: PortfolioImpactAction[];
  activeRules: PersonalPortfolioRule[];
  themes: PortfolioImpactTheme[];
}

const ENV = (() => {
  try {
    return import.meta.env ?? {};
  } catch {
    return {} as Record<string, string | undefined>;
  }
})();

const DEFAULT_AI_SYSTEM_PORTFOLIO_API_BASE_URL = 'http://127.0.0.1:8080';
const DEV_AI_SYSTEM_PORTFOLIO_API_BASE_URL = '/api/ai-system';
const SEMICONDUCTOR_TICKERS = new Set(['NVDA', 'AMD', 'TSM', 'ASML', 'SOXX', 'SMH', 'SOXL']);
const CRYPTO_TICKERS = new Set(['BTC', 'ETH', 'SOL', 'MSTR', 'COIN', 'IBIT', 'FBTC']);

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, '');
}

function normalizeTicker(value: string | undefined): string {
  return (value ?? '').trim().toUpperCase();
}

function dedupeThemes(themes: PortfolioImpactTheme[]): PortfolioImpactTheme[] {
  const seen = new Set<string>();
  return themes.filter((theme) => {
    if (seen.has(theme.id)) return false;
    seen.add(theme.id);
    return true;
  });
}

export function getPersonalPortfolioApiBaseUrl(): string {
  const configuredBaseUrl = ENV.VITE_AI_SYSTEM_PORTFOLIO_API_BASE_URL;
  if (configuredBaseUrl) return normalizeBaseUrl(configuredBaseUrl);
  if (ENV.DEV) return DEV_AI_SYSTEM_PORTFOLIO_API_BASE_URL;
  return normalizeBaseUrl(DEFAULT_AI_SYSTEM_PORTFOLIO_API_BASE_URL);
}

export function getPersonalPortfolioExportUrl(detail: 'risk' | 'full' = 'risk'): string {
  return `${getPersonalPortfolioApiBaseUrl()}/api/finance/portfolio-export?detail=${encodeURIComponent(detail)}`;
}

export function getPersonalPortfolioTargetsUrl(): string {
  return `${getPersonalPortfolioApiBaseUrl()}/api/finance/rebalance/targets`;
}

export function getIdeaRadarReviewHistoryUrl(): string {
  return `${getPersonalPortfolioApiBaseUrl()}/api/finance/idea-radar/review-history`;
}

export function getIdeaRadarEvaluationLogUrl(): string {
  return `${getPersonalPortfolioApiBaseUrl()}/api/finance/idea-radar/evaluation-log`;
}

export async function fetchPersonalPortfolioExport(
  detail: 'risk' | 'full' = 'risk',
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<PersonalPortfolioExport> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const response = await fetchImpl(getPersonalPortfolioExportUrl(detail), {
    headers: { Accept: 'application/json' },
    signal: options.signal,
  });

  if (!response.ok) {
    throw new Error(`personal portfolio export failed: ${response.status}`);
  }

  return response.json() as Promise<PersonalPortfolioExport>;
}

export async function fetchPersonalPortfolioTargets(
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<PersonalPortfolioTargets | null> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const response = await fetchImpl(getPersonalPortfolioTargetsUrl(), {
    headers: { Accept: 'application/json' },
    signal: options.signal,
  });

  if (!response.ok) {
    throw new Error(`personal portfolio targets failed: ${response.status}`);
  }

  const payload = await response.json() as PersonalPortfolioTargets;
  if (payload.error) return null;
  return payload;
}

export async function fetchIdeaRadarReviewHistory(
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<IdeaRadarReviewHistoryPayload | null> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const response = await fetchImpl(getIdeaRadarReviewHistoryUrl(), {
    headers: { Accept: 'application/json' },
    signal: options.signal,
  });

  if (!response.ok) {
    throw new Error(`idea radar review history failed: ${response.status}`);
  }

  return response.json() as Promise<IdeaRadarReviewHistoryPayload>;
}

export async function persistIdeaRadarReviewHistory(
  history: Record<string, IdeaRadarReviewHistoryEntry>,
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<IdeaRadarReviewHistoryPayload | null> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const response = await fetchImpl(getIdeaRadarReviewHistoryUrl(), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ history }),
    signal: options.signal,
  });

  if (!response.ok) {
    throw new Error(`idea radar review history save failed: ${response.status}`);
  }

  return response.json() as Promise<IdeaRadarReviewHistoryPayload>;
}

export async function fetchIdeaRadarEvaluationLog(
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<IdeaRadarEvaluationLogPayload | null> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const response = await fetchImpl(getIdeaRadarEvaluationLogUrl(), {
    headers: { Accept: 'application/json' },
    signal: options.signal,
  });

  if (!response.ok) {
    throw new Error(`idea radar evaluation log failed: ${response.status}`);
  }

  return response.json() as Promise<IdeaRadarEvaluationLogPayload>;
}

export async function persistIdeaRadarEvaluationLog(
  entries: IdeaRadarEvaluationLogEntry[],
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<IdeaRadarEvaluationLogPayload | null> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const response = await fetchImpl(getIdeaRadarEvaluationLogUrl(), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ entries }),
    signal: options.signal,
  });

  if (!response.ok) {
    throw new Error(`idea radar evaluation log save failed: ${response.status}`);
  }

  return response.json() as Promise<IdeaRadarEvaluationLogPayload>;
}

function isJapanese(): boolean {
  return typeof document !== 'undefined' && document?.documentElement?.lang === 'ja';
}

function buildThemeSignals(data: PersonalPortfolioExport): PortfolioImpactTheme[] {
  const ja = isJapanese();
  const topHoldings = data.holdings
    .slice()
    .sort((left, right) => right.weight_pct - left.weight_pct)
    .slice(0, 8);
  const tickers = new Set(topHoldings.map((holding) => normalizeTicker(holding.ticker)));
  const usdWeight = data.currency.find((entry) => entry.currency === 'USD')?.weight_pct ?? 0;
  const jpyWeight = data.currency.find((entry) => entry.currency === 'JPY')?.weight_pct ?? 0;
  const themes: PortfolioImpactTheme[] = [];

  if ([...tickers].some((ticker) => SEMICONDUCTOR_TICKERS.has(ticker))) {
    themes.push({
      id: 'semiconductors',
      title: ja ? '半導体感応度' : 'Semiconductor sensitivity',
      rationale: ja
        ? '台湾情勢、米国の輸出規制、ハイパースケーラーのAI設備投資、Nasdaqの勢いを注視。'
        : 'Monitor Taiwan, US export controls, hyperscaler AI capex, and Nasdaq momentum.',
    });
  }

  if ([...tickers].some((ticker) => CRYPTO_TICKERS.has(ticker))) {
    themes.push({
      id: 'crypto',
      title: ja ? 'クリプト リスクオン エクスポージャー' : 'Crypto risk-on exposure',
      rationale: ja
        ? 'BTCの流動性、ETFフロー、規制動向、リスクオン/リスクオフの転換を注視。'
        : 'Monitor BTC liquidity, ETF flows, regulation, and risk-on/off shifts.',
    });
  }

  if (usdWeight >= 35) {
    themes.push({
      id: 'usd',
      title: ja ? 'USD/JPYの為替換算リスク' : 'USD/JPY translation risk',
      rationale: ja
        ? `USDの比率は${usdWeight.toFixed(1)}%。${jpyWeight.toFixed(1)}%の円ベースに対し、Fed・日銀(BOJ)・USD/JPYの変動を注視。`
        : `USD weight is ${usdWeight.toFixed(1)}%. Monitor Fed, BOJ, and USD/JPY swings against the ${jpyWeight.toFixed(1)}% JPY base.`,
    });
  }

  if ((data.summary.total_gain_pct ?? 0) >= 20) {
    themes.push({
      id: 'protect-gains',
      title: ja ? '含み益の保護' : 'Protect unrealized gains',
      rationale: ja
        ? '総合損益が良好なほど、見直しの規律と集中度チェックの重要性が高まります。'
        : 'A strong total gain profile increases the value of review discipline and concentration checks.',
    });
  }

  return dedupeThemes(themes);
}

export function buildPortfolioImpactViewModel(data: PersonalPortfolioExport): PortfolioImpactViewModel {
  const ja = isJapanese();
  const sortedHoldings = data.holdings
    .slice()
    .sort((left, right) => right.weight_pct - left.weight_pct);
  const topHoldings = sortedHoldings.slice(0, 5);
  const activeRules = data.risk_rules.filter((rule) => !rule.ok);
  const currencies = data.currency.slice().sort((left, right) => right.weight_pct - left.weight_pct);
  const themes = buildThemeSignals(data);
  const actions: PortfolioImpactAction[] = [];

  for (const rule of activeRules.slice(0, 2)) {
    actions.push({
      level: rule.severity === 'alert' ? 'alert' : 'watch',
      title: rule.name || 'Risk rule triggered',
      body: rule.message || 'A portfolio rule needs review.',
    });
  }

  const leadHolding = topHoldings[0];
  if (leadHolding && leadHolding.weight_pct >= 25) {
    actions.push({
      level: 'watch',
      title: ja ? `${leadHolding.ticker} 集中リスク` : `${leadHolding.ticker} concentration`,
      body: ja
        ? `最大保有の比率は${leadHolding.weight_pct.toFixed(1)}%。リスク許容度と照合してください。`
        : `Top holding weight is ${leadHolding.weight_pct.toFixed(1)}%. Check against your risk tolerance.`,
    });
  }

  const usdWeight = currencies.find((entry) => entry.currency === 'USD')?.weight_pct ?? 0;
  if (usdWeight >= 50) {
    actions.push({
      level: 'info',
      title: ja ? 'USD比率が高水準' : 'High USD exposure',
      body: ja
        ? `USDは全体の${usdWeight.toFixed(1)}%。為替変動が円換算リターンに大きく影響します。`
        : `USD assets are ${usdWeight.toFixed(1)}% of the portfolio. FX moves materially affect JPY-translated returns.`,
    });
  }

  return {
    generatedAt: data.generated_at,
    summary: data.summary,
    topHoldings,
    currencies,
    actions: actions.slice(0, 3),
    activeRules,
    themes,
  };
}
