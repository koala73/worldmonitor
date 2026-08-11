/**
 * Native Provider Operations workspace. This surface intentionally receives no
 * credentials and makes no direct external request. It only observes the
 * protected runtime configuration and bounded executor telemetry.
 */

import { PRIMARY_BRAND } from '@/config/brand';
import { stockWorkspaceUrl } from '@/features/pokieticker/stock-workspace-route';
import {
  SELF_HOSTED_MODE_ENV,
  getProviderOperationAuditEvents,
  getProviderOperationsSnapshot,
  isSelfHostedMode,
  retryProviderOperation,
  subscribeProviderOperations,
  type ProviderOperationOutcome,
  type ProviderOperationReadiness,
} from '@/services/provider-operations';
import './provider-operations.css';

const READINESS_COPY: Record<ProviderOperationReadiness, string> = {
  NOT_CONFIGURED: '未配置',
  CONFIG_INVALID: '配置格式无效',
  SERVER_MANAGED_UNKNOWN: '服务器端状态不可观测',
  READY_TO_ATTEMPT: '可尝试（尚非 Provider 成功）',
};

const OUTCOME_COPY: Record<ProviderOperationOutcome, string> = {
  IDLE: '尚无运行记录',
  RUNNING: '正在运行',
  SUCCESS: '成功',
  FAILURE: '失败',
  RATE_LIMITED: '受速率限制',
  LOCKED: '锁定/退避中',
  NO_EXECUTOR: '没有已绑定执行器',
  NOT_CONFIGURED: '未配置',
};

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatUtc(timestamp: number | undefined): string {
  if (!timestamp || !Number.isFinite(timestamp)) return '未观测';
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium', timeStyle: 'medium', timeZone: 'UTC',
  }).format(new Date(timestamp)) + ' UTC';
}

function operationCard(operation: ReturnType<typeof getProviderOperationsSnapshot>[number], onRetry: () => void): HTMLElement {
  const card = element('article', 'provider-operations__card');
  card.dataset.operationId = operation.id;
  const header = element('header', 'provider-operations__card-header');
  const title = element('div');
  title.append(element('h2', 'provider-operations__card-title', operation.title));
  title.append(element('p', 'provider-operations__provider', operation.provider));
  const status = element(
    'span',
    `provider-operations__pill provider-operations__pill--${operation.readiness.toLowerCase()}`,
    READINESS_COPY[operation.readiness],
  );
  header.append(title, status);
  card.append(header);

  card.append(element('p', 'provider-operations__purpose', operation.purpose));
  const metadata = element('dl', 'provider-operations__metadata');
  const values: Array<[string, string]> = [
    ['计划', operation.cadence],
    ['幂等键', operation.idempotencyScope],
    ['锁', operation.lockScope],
    ['执行器', operation.executorRegistered ? '已注册（仍需可观察的结果）' : '未注册；按钮不会发起 Provider 请求'],
    ['最近执行器成功', formatUtc(operation.telemetry.lastExecutorSuccessAt)],
    ['最近执行器失败', formatUtc(operation.telemetry.lastExecutorFailureAt)],
    ['最近仪表盘回调', formatUtc(operation.telemetry.lastSchedulerCompletionAt)],
    ['连续失败', String(operation.telemetry.consecutiveFailures)],
    ['速率限制至', formatUtc(operation.telemetry.rateLimitedUntil)],
    ['Quota 剩余', operation.telemetry.quotaRemaining === undefined ? '未观测' : String(operation.telemetry.quotaRemaining)],
  ];
  if (operation.queueKind) {
    values.push(
      ['队列', `${operation.queueKind}: ${operation.telemetry.queueDepth ?? '未观测'}`],
      ['死信队列', operation.telemetry.deadLetterDepth === undefined ? '未观测' : String(operation.telemetry.deadLetterDepth)],
    );
  }
  if (operation.id === 'ais-relay') {
    values.push(
      ['Relay 消息', operation.telemetry.messagesObserved === undefined ? '未观测' : String(operation.telemetry.messagesObserved)],
      ['验证后船舶数', operation.telemetry.vesselsObserved === undefined ? '未观测' : String(operation.telemetry.vesselsObserved)],
    );
  }
  for (const [label, value] of values) {
    const dt = element('dt', undefined, label);
    const dd = element('dd', undefined, value);
    metadata.append(dt, dd);
  }
  card.append(metadata);
  const safety = element('p', 'provider-operations__safety', `边界：${operation.safetyBoundary}`);
  card.append(safety);
  const last = element('p', 'provider-operations__last', `最近结果：${OUTCOME_COPY[operation.telemetry.lastOutcome]}${operation.telemetry.lastMessage ? ` — ${operation.telemetry.lastMessage}` : ''}`);
  card.append(last);
  const retry = element('button', 'provider-operations__retry', '安全重试 / 重新检查');
  retry.type = 'button';
  retry.addEventListener('click', onRetry);
  card.append(retry);
  return card;
}

export function initProviderOperationsWorkspace(rootId = 'app'): void {
  const root = document.getElementById(rootId);
  if (!root) throw new Error(`Provider operations root #${rootId} was not found.`);
  root.replaceChildren();
  root.className = 'provider-operations';

  const render = (): void => {
    const operations = getProviderOperationsSnapshot();
    const shell = element('main', 'provider-operations__shell');
    const header = element('header', 'provider-operations__header');
    const brand = element('div');
    brand.append(element('p', 'provider-operations__eyebrow', PRIMARY_BRAND));
    brand.append(element('h1', 'provider-operations__title', 'Provider 统一控制中心'));
    brand.append(element('p', 'provider-operations__subtitle', '只呈现配置存在性和可验证的运行遥测；不读取、显示、散列或传递任何密钥。'));
    const links = element('nav', 'provider-operations__links');
    const dashboard = element('a', undefined, '返回仪表盘');
    dashboard.href = '/dashboard';
    const stocks = element('a', undefined, '股票工作区');
    stocks.href = stockWorkspaceUrl('AAPL');
    links.append(dashboard, stocks);
    header.append(brand, links);
    shell.append(header);

    const mode = element('section', 'provider-operations__mode');
    const selfHosted = isSelfHostedMode();
    mode.append(element('h2', undefined, selfHosted ? '自托管安全模式' : '默认部署模式'));
    mode.append(element(
      'p',
      undefined,
      selfHosted
        ? `${SELF_HOSTED_MODE_ENV}=true。Sidecar 必须要求 LOCAL_API_TOKEN，并会禁用到 worldmonitor.app 的云回退；仅可使用本实例的 Provider、数据库和受控执行器。`
        : '默认部署保留既有权限路径。浏览器不会把服务器密钥或服务端健康情况伪装成可见；“服务器端状态不可观测”不是“已连通”。',
    ));
    shell.append(mode);

    const security = element('section', 'provider-operations__security');
    security.append(element('strong', undefined, '密钥安全：'));
    security.append(document.createTextNode('此页只读保护配置的存在性。桌面 vault 不将值、尾字符或可离线猜测的指纹返还给浏览器；请勿把密钥、密码、Cookie、令牌、账单或 CAPTCHA 写入聊天、截图或 Git。'));
    shell.append(security);

    const grid = element('section', 'provider-operations__grid');
    for (const operation of operations) {
      grid.append(operationCard(operation, () => { void retryProviderOperation(operation.id); }));
    }
    shell.append(grid);

    const audit = element('section', 'provider-operations__audit');
    audit.append(element('h2', undefined, '审计日志（本会话，已脱敏）'));
    const auditEvents = getProviderOperationAuditEvents();
    if (!auditEvents.length) {
      audit.append(element('p', undefined, '尚无操作。安全重试会先记录它是否真的调用了已注册的执行器。'));
    } else {
      const list = element('ol', 'provider-operations__audit-list');
      for (const event of auditEvents) {
        list.append(element('li', undefined, `${formatUtc(event.at)} · ${event.operationId} · ${OUTCOME_COPY[event.outcome]} · ${event.actor}：${event.message}`));
      }
      audit.append(list);
    }
    shell.append(audit);
    root.replaceChildren(shell);
  };

  const unsubscribe = subscribeProviderOperations(render);
  window.addEventListener('pagehide', unsubscribe, { once: true });
  render();
}
