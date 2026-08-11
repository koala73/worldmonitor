/**
 * Provider Operations is a deliberately narrow operational-control contract.
 *
 * It never reads a secret value, sends a request by itself, or converts a
 * dashboard callback into a claim that an upstream Provider succeeded. A
 * server/sidecar may register a bounded executor later; until then every
 * action is a visible no-op/re-evaluation with an audit event.
 */

import {
  getSecretState,
  isFeatureEnabled,
  subscribeRuntimeConfig,
  type RuntimeFeatureId,
  type RuntimeSecretKey,
} from './runtime-config';
import { isDesktopRuntime } from './runtime';

export const SELF_HOSTED_MODE_ENV = 'SELF_HOSTED_MODE';

export type ProviderOperationId =
  | 'market-rest-gap-repair'
  | 'market-minute-stream'
  | 'news-ingest'
  | 'news-analysis-layer1'
  | 'ais-relay'
  | 'portwatch-batch'
  | 'comtrade-batch'
  | 'china-customs-import'
  | 'model-evaluation';

export type ProviderOperationReadiness =
  | 'NOT_CONFIGURED'
  | 'CONFIG_INVALID'
  | 'SERVER_MANAGED_UNKNOWN'
  | 'READY_TO_ATTEMPT';

export type ProviderOperationOutcome =
  | 'IDLE'
  | 'RUNNING'
  | 'SUCCESS'
  | 'FAILURE'
  | 'RATE_LIMITED'
  | 'LOCKED'
  | 'NO_EXECUTOR'
  | 'NOT_CONFIGURED';

export type ProviderOperationDefinition = {
  id: ProviderOperationId;
  title: string;
  provider: string;
  purpose: string;
  cadence: string;
  idempotencyScope: string;
  lockScope: string;
  minimumRetryIntervalMs: number;
  requiredFeatures: readonly RuntimeFeatureId[];
  requiredSecrets: readonly RuntimeSecretKey[];
  /** Any one complete set permits an attempt; alternatives must never be
   * treated as an all-keys requirement. */
  credentialAlternatives?: readonly (readonly RuntimeSecretKey[])[];
  queueKind?: 'NEWS_ANALYSIS' | 'IMPORT' | 'STREAM';
  safetyBoundary: string;
};

export const PROVIDER_OPERATIONS: readonly ProviderOperationDefinition[] = [
  {
    id: 'market-rest-gap-repair',
    title: '股票 REST 缺口修复',
    provider: 'Massive / 已配置市场适配器',
    purpose: '交易日收盘后对比已验证的 symbol-specific bars；不把报价补写成 OHLC。',
    cadence: '收盘后日对账；需要时由受控任务补缺。',
    idempotencyScope: 'symbol + interval + requested range + provider revision',
    lockScope: 'market-bars:{symbol}:{interval}',
    minimumRetryIntervalMs: 15_000,
    requiredFeatures: ['finnhubMarkets'],
    requiredSecrets: ['FINNHUB_API_KEY'],
    safetyBoundary: '只保留来源、symbol 与时间均通过验证的 bars；失败不会用空数组覆盖最后一次成功数据。',
  },
  {
    id: 'market-minute-stream',
    title: '分钟 K 线流与 REST 补缺',
    provider: 'Massive WebSocket relay',
    purpose: '为已获展示/再分发授权的 symbol 维护分钟流，并以 REST 补缺。',
    cadence: '交易时段持续连接；断线退避，收盘后日对账。',
    idempotencyScope: 'symbol + minute bucket + provider sequence',
    lockScope: 'market-stream:{symbol}',
    minimumRetryIntervalMs: 15_000,
    requiredFeatures: ['finnhubMarkets'],
    requiredSecrets: ['FINNHUB_API_KEY'],
    safetyBoundary: '没有商业展示/再分发确认时不得标为实时，也不得启动浏览器直连。',
  },
  {
    id: 'news-ingest',
    title: '公司新闻增量采集',
    provider: 'Exa / Brave / SerpAPI / RSS fallback',
    purpose: '增量拉取、去重并保留来源 URL 与发布时间；与分析队列分离。',
    cadence: '增量轮询；Provider 速率限制和退避由服务端执行。',
    idempotencyScope: 'provider + canonical URL + publishedAt',
    lockScope: 'news-ingest:{provider}:{symbol}',
    minimumRetryIntervalMs: 30_000,
    requiredFeatures: ['stockNewsSearchExa', 'stockNewsSearchBrave', 'stockNewsSearchSerpApi'],
    requiredSecrets: ['EXA_API_KEYS', 'BRAVE_API_KEYS', 'SERPAPI_API_KEYS'],
    credentialAlternatives: [['EXA_API_KEYS'], ['BRAVE_API_KEYS'], ['SERPAPI_API_KEYS']],
    queueKind: 'IMPORT',
    safetyBoundary: '相关性、情绪或发布时间均不构成价格因果证明。',
  },
  {
    id: 'news-analysis-layer1',
    title: '新闻分析 Layer 1',
    provider: '受配置模型 Provider',
    purpose: '批处理已去重新闻；模型版本、生成时间与样本数必须随结果保存。',
    cadence: '批量任务；Layer 2 仅按需运行且可缓存。',
    idempotencyScope: 'article id + model version + prompt version',
    lockScope: 'news-analysis:{articleId}:{modelVersion}',
    minimumRetryIntervalMs: 30_000,
    requiredFeatures: ['aiOllama', 'aiGroq', 'aiOpenRouter'],
    requiredSecrets: ['OLLAMA_API_URL', 'OLLAMA_MODEL', 'GROQ_API_KEY', 'OPENROUTER_API_KEY'],
    credentialAlternatives: [['OLLAMA_API_URL', 'OLLAMA_MODEL'], ['GROQ_API_KEY'], ['OPENROUTER_API_KEY']],
    queueKind: 'NEWS_ANALYSIS',
    safetyBoundary: '模型输出是具版本的分析，不是事实或新闻导致价格变化的证明。',
  },
  {
    id: 'ais-relay',
    title: 'AIS Relay 连接与快照',
    provider: 'AISStream relay',
    purpose: '维护受认证 relay，记录消息和符合范围/时间规则的船舶快照。',
    cadence: '长连接；现有 60 秒/5 分钟快照契约保持不变。',
    idempotencyScope: 'MMSI + observedAt + selected bounding box',
    lockScope: 'ais-relay:{boundingBox}',
    minimumRetryIntervalMs: 30_000,
    requiredFeatures: ['aisRelay'],
    requiredSecrets: ['WS_RELAY_URL', 'AISSTREAM_API_KEY'],
    queueKind: 'STREAM',
    safetyBoundary: 'AIS 只能证明自报字段；不得推断货物、产地、买家、目的港、ETA 或提单。',
  },
  {
    id: 'portwatch-batch',
    title: 'PortWatch 批次导入',
    provider: 'IMF PortWatch',
    purpose: '按发布节奏摄取并保留数据集日期、范围和方法。',
    cadence: '仅在 Provider 发布节奏触发，不冒充实时船位。',
    idempotencyScope: 'dataset release + port + period',
    lockScope: 'portwatch:{release}',
    minimumRetryIntervalMs: 60_000,
    requiredFeatures: ['supplyChain'],
    requiredSecrets: ['FRED_API_KEY'],
    queueKind: 'IMPORT',
    safetyBoundary: '港口活动聚合不等于 AIS、到港、货物或提单事实。',
  },
  {
    id: 'comtrade-batch',
    title: 'UN Comtrade 批次导入',
    provider: 'UN Comtrade',
    purpose: '摄取按期发布的国家/HS 聚合贸易记录。',
    cadence: '按月或 Provider 发布节奏。',
    idempotencyScope: 'reporter + partner + HS + period + release',
    lockScope: 'comtrade:{reporter}:{period}',
    minimumRetryIntervalMs: 60_000,
    requiredFeatures: [],
    requiredSecrets: [],
    queueKind: 'IMPORT',
    safetyBoundary: '未接入授权数据前不显示数值；聚合贸易不能定位到工厂、港口、船舶或集装箱。',
  },
  {
    id: 'china-customs-import',
    title: '中国海关合规文件导入',
    provider: '用户合法取得的中国海关数据',
    purpose: '导入带发布日期、范围、HS、期间和再分发权限的合规批次。',
    cadence: '仅在官方/许可发布后，由本地管理员导入。',
    idempotencyScope: 'file checksum + publication date + scope',
    lockScope: 'china-customs:{checksum}',
    minimumRetryIntervalMs: 60_000,
    requiredFeatures: [],
    requiredSecrets: [],
    queueKind: 'IMPORT',
    safetyBoundary: '禁止抓取或推断为官方数据；导入聚合也不授予舱单级结论。',
  },
  {
    id: 'model-evaluation',
    title: '模型版本与回测记录',
    provider: '受配置模型 Provider',
    purpose: '记录版本、训练/生成时间、样本量及可复现回测指标。',
    cadence: '模型或评估数据版本变化后；不以展示刷新代替评估。',
    idempotencyScope: 'model version + dataset version + evaluation revision',
    lockScope: 'model-evaluation:{modelVersion}:{datasetVersion}',
    minimumRetryIntervalMs: 60_000,
    requiredFeatures: ['aiOllama', 'aiGroq', 'aiOpenRouter'],
    requiredSecrets: ['OLLAMA_API_URL', 'OLLAMA_MODEL', 'GROQ_API_KEY', 'OPENROUTER_API_KEY'],
    credentialAlternatives: [['OLLAMA_API_URL', 'OLLAMA_MODEL'], ['GROQ_API_KEY'], ['OPENROUTER_API_KEY']],
    safetyBoundary: '没有版本、样本、时间和回测证据时，不显示模型质量或训练完成声明。',
  },
] as const;

export type ProviderOperationTelemetry = {
  lastExecutorSuccessAt?: number;
  lastExecutorFailureAt?: number;
  lastSchedulerCompletionAt?: number;
  consecutiveFailures: number;
  rateLimitedUntil?: number;
  quotaRemaining?: number;
  queueDepth?: number;
  deadLetterDepth?: number;
  messagesObserved?: number;
  vesselsObserved?: number;
  lastOutcome: ProviderOperationOutcome;
  lastMessage?: string;
};

export type ProviderOperationAuditEvent = {
  at: number;
  operationId: ProviderOperationId;
  outcome: ProviderOperationOutcome;
  actor: 'scheduler' | 'operator' | 'executor';
  message: string;
};

export type ProviderOperationRunResult = {
  outcome: 'success' | 'failure' | 'rate_limited';
  message: string;
  rateLimitedUntil?: number;
  quotaRemaining?: number;
  queueDepth?: number;
  deadLetterDepth?: number;
  messagesObserved?: number;
  vesselsObserved?: number;
};

export type ProviderOperationSnapshot = ProviderOperationDefinition & {
  readiness: ProviderOperationReadiness;
  telemetry: Readonly<ProviderOperationTelemetry>;
  executorRegistered: boolean;
};

type SecretStatus = { present: boolean; valid: boolean };
type OperationExecutor = () => Promise<ProviderOperationRunResult>;

const telemetry = new Map<ProviderOperationId, ProviderOperationTelemetry>();
const executors = new Map<ProviderOperationId, OperationExecutor>();
const inFlight = new Set<ProviderOperationId>();
const auditEvents: ProviderOperationAuditEvent[] = [];
const listeners = new Set<() => void>();
const MAX_AUDIT_EVENTS = 100;

function notify(): void {
  for (const listener of listeners) listener();
}

function operationFor(id: ProviderOperationId): ProviderOperationDefinition {
  const operation = PROVIDER_OPERATIONS.find((candidate) => candidate.id === id);
  if (!operation) throw new Error(`Unknown provider operation: ${id}`);
  return operation;
}

function getTelemetry(id: ProviderOperationId): ProviderOperationTelemetry {
  let current = telemetry.get(id);
  if (!current) {
    current = { consecutiveFailures: 0, lastOutcome: 'IDLE' };
    telemetry.set(id, current);
  }
  return current;
}

function appendAudit(event: ProviderOperationAuditEvent): void {
  auditEvents.unshift(event);
  if (auditEvents.length > MAX_AUDIT_EVENTS) auditEvents.length = MAX_AUDIT_EVENTS;
}

function noSecretMessage(message: string): string {
  // An executor receives no key material from this module. Still prevent a
  // future careless executor from placing an obvious bearer/API-key value in
  // the operator-visible audit trail.
  return message
    .replace(/(Bearer\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/([A-Z0-9_]*(?:KEY|TOKEN|SECRET)[A-Z0-9_]*\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}

function currentSecretStatuses(): ReadonlyMap<RuntimeSecretKey, SecretStatus> {
  const statuses = new Map<RuntimeSecretKey, SecretStatus>();
  for (const operation of PROVIDER_OPERATIONS) {
    for (const key of operation.requiredSecrets) {
      if (!statuses.has(key)) {
        const state = getSecretState(key);
        statuses.set(key, { present: state.present, valid: state.valid });
      }
    }
  }
  return statuses;
}

export function evaluateProviderOperationReadiness(
  operation: ProviderOperationDefinition,
  options: {
    desktop: boolean;
    secretStatuses: ReadonlyMap<RuntimeSecretKey, SecretStatus>;
    featureEnabled?: (feature: RuntimeFeatureId) => boolean;
  },
): ProviderOperationReadiness {
  if (!options.desktop) return 'SERVER_MANAGED_UNKNOWN';
  const featureEnabled = options.featureEnabled ?? (() => true);
  if (operation.requiredFeatures.length > 0 && !operation.requiredFeatures.some(featureEnabled)) {
    return 'NOT_CONFIGURED';
  }
  if (operation.requiredSecrets.length === 0) return executors.has(operation.id) ? 'READY_TO_ATTEMPT' : 'NOT_CONFIGURED';
  const credentialSets = operation.credentialAlternatives ?? [operation.requiredSecrets];
  const statesBySet = credentialSets.map((keys) => keys.map(key => options.secretStatuses.get(key) ?? { present: false, valid: false }));
  if (statesBySet.some(states => states.every(state => state.valid))) return 'READY_TO_ATTEMPT';
  // A malformed value is visible only when it belongs to the sole supported
  // credential set. With alternative Providers, an absent alternative is an
  // expected disabled state rather than a reason to call every option invalid.
  if (credentialSets.length === 1 && statesBySet[0]?.some(state => state.present && !state.valid)) {
    return 'CONFIG_INVALID';
  }
  return 'NOT_CONFIGURED';
}

export function getProviderOperationsSnapshot(): ProviderOperationSnapshot[] {
  const secretStatuses = currentSecretStatuses();
  const desktop = isDesktopRuntime();
  return PROVIDER_OPERATIONS.map((operation) => ({
    ...operation,
    readiness: evaluateProviderOperationReadiness(operation, {
      desktop,
      secretStatuses,
      featureEnabled: isFeatureEnabled,
    }),
    telemetry: { ...getTelemetry(operation.id) },
    executorRegistered: executors.has(operation.id),
  }));
}

export function getProviderOperationAuditEvents(): readonly ProviderOperationAuditEvent[] {
  return auditEvents.map(event => ({ ...event }));
}

export function subscribeProviderOperations(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isSelfHostedMode(): boolean {
  try {
    // This is deliberately a non-secret public mode bit. The sidecar enforces
    // the server-only SELF_HOSTED_MODE equivalent before it chooses fallback.
    return import.meta.env.VITE_SELF_HOSTED_MODE === 'true';
  } catch {
    return false;
  }
}

export function registerProviderOperationExecutor(id: ProviderOperationId, executor: OperationExecutor): () => void {
  executors.set(id, executor);
  notify();
  return () => {
    if (executors.get(id) === executor) {
      executors.delete(id);
      notify();
    }
  };
}

export async function retryProviderOperation(id: ProviderOperationId, now = Date.now()): Promise<ProviderOperationOutcome> {
  const operation = operationFor(id);
  const current = getTelemetry(id);
  const readiness = getProviderOperationsSnapshot().find(item => item.id === id)?.readiness ?? 'NOT_CONFIGURED';
  if (readiness !== 'READY_TO_ATTEMPT') {
    current.lastOutcome = 'NOT_CONFIGURED';
    current.lastMessage = `Safe retry not executed: readiness is ${readiness}.`;
    appendAudit({ at: now, operationId: id, outcome: 'NOT_CONFIGURED', actor: 'operator', message: current.lastMessage });
    notify();
    return 'NOT_CONFIGURED';
  }
  if (inFlight.has(id)) {
    current.lastOutcome = 'LOCKED';
    current.lastMessage = `Safe retry not executed: ${operation.lockScope} is already locked.`;
    appendAudit({ at: now, operationId: id, outcome: 'LOCKED', actor: 'operator', message: current.lastMessage });
    notify();
    return 'LOCKED';
  }
  if (current.rateLimitedUntil && current.rateLimitedUntil > now) {
    current.lastOutcome = 'RATE_LIMITED';
    current.lastMessage = 'Safe retry not executed: the recorded rate-limit window is still active.';
    appendAudit({ at: now, operationId: id, outcome: 'RATE_LIMITED', actor: 'operator', message: current.lastMessage });
    notify();
    return 'RATE_LIMITED';
  }
  const lastAttemptAt = Math.max(current.lastExecutorSuccessAt ?? 0, current.lastExecutorFailureAt ?? 0);
  if (lastAttemptAt && now - lastAttemptAt < operation.minimumRetryIntervalMs) {
    current.lastOutcome = 'LOCKED';
    current.lastMessage = `Safe retry not executed: minimum retry interval is ${operation.minimumRetryIntervalMs}ms.`;
    appendAudit({ at: now, operationId: id, outcome: 'LOCKED', actor: 'operator', message: current.lastMessage });
    notify();
    return 'LOCKED';
  }
  const executor = executors.get(id);
  if (!executor) {
    current.lastOutcome = 'NO_EXECUTOR';
    current.lastMessage = 'Configuration was re-evaluated. No local/server executor is registered, so no Provider request was sent.';
    appendAudit({ at: now, operationId: id, outcome: 'NO_EXECUTOR', actor: 'operator', message: current.lastMessage });
    notify();
    return 'NO_EXECUTOR';
  }

  inFlight.add(id);
  current.lastOutcome = 'RUNNING';
  current.lastMessage = 'Bounded executor started.';
  appendAudit({ at: now, operationId: id, outcome: 'RUNNING', actor: 'operator', message: current.lastMessage });
  notify();
  try {
    const result = await executor();
    const message = noSecretMessage(result.message);
    current.rateLimitedUntil = result.rateLimitedUntil;
    current.quotaRemaining = result.quotaRemaining;
    current.queueDepth = result.queueDepth;
    current.deadLetterDepth = result.deadLetterDepth;
    current.messagesObserved = result.messagesObserved;
    current.vesselsObserved = result.vesselsObserved;
    if (result.outcome === 'success') {
      current.lastExecutorSuccessAt = now;
      current.consecutiveFailures = 0;
      current.lastOutcome = 'SUCCESS';
    } else if (result.outcome === 'rate_limited') {
      current.lastExecutorFailureAt = now;
      current.consecutiveFailures += 1;
      current.lastOutcome = 'RATE_LIMITED';
    } else {
      current.lastExecutorFailureAt = now;
      current.consecutiveFailures += 1;
      current.lastOutcome = 'FAILURE';
    }
    current.lastMessage = message;
    appendAudit({ at: now, operationId: id, outcome: current.lastOutcome, actor: 'executor', message });
    return current.lastOutcome;
  } catch (error) {
    current.lastExecutorFailureAt = now;
    current.consecutiveFailures += 1;
    current.lastOutcome = 'FAILURE';
    current.lastMessage = noSecretMessage(error instanceof Error ? error.message : 'Executor failed without a readable error.');
    appendAudit({ at: now, operationId: id, outcome: 'FAILURE', actor: 'executor', message: current.lastMessage });
    return 'FAILURE';
  } finally {
    inFlight.delete(id);
    notify();
  }
}

const REFRESH_OPERATION_MAP: Partial<Record<string, ProviderOperationId>> = {
  markets: 'market-rest-gap-repair',
  news: 'news-ingest',
  ais: 'ais-relay',
  supplyChain: 'portwatch-batch',
  'stock-analysis': 'news-analysis-layer1',
  'daily-market-brief': 'news-analysis-layer1',
};

/** Records the dashboard task outcome without claiming it is a Provider success. */
export function recordScheduledRefreshOutcome(name: string, success: boolean, now = Date.now()): void {
  const id = REFRESH_OPERATION_MAP[name];
  if (!id) return;
  const current = getTelemetry(id);
  current.lastSchedulerCompletionAt = now;
  const outcome: ProviderOperationOutcome = success ? 'SUCCESS' : 'FAILURE';
  current.lastOutcome = outcome;
  current.lastMessage = success
    ? `Dashboard refresh callback '${name}' completed; Provider result remains separately observable.`
    : `Dashboard refresh callback '${name}' returned failure; prior data remains intact until its owner replaces it.`;
  appendAudit({ at: now, operationId: id, outcome, actor: 'scheduler', message: current.lastMessage });
  notify();
}

// Runtime-config changes affect readiness but cannot expose secrets. A single
// module-level subscription keeps the native control center live when a trusted
// desktop settings window changes vault presence.
subscribeRuntimeConfig(notify);

/** Test-only reset; never exported from the public service barrel. */
export function __resetProviderOperationsForTests(): void {
  telemetry.clear();
  executors.clear();
  inFlight.clear();
  auditEvents.length = 0;
  notify();
}
