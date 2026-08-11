import { getSecretState, type RuntimeSecretKey } from '@/services/runtime-config';
import { h } from '@/utils/dom-utils';

export interface ProviderReadinessSpec {
  provider: string;
  requiredSecrets: readonly RuntimeSecretKey[];
  manualAction: string;
}

function readinessState(requiredSecrets: readonly RuntimeSecretKey[]): string {
  if (requiredSecrets.length === 0) return '等待服务端返回带时间戳的观测记录';
  return requiredSecrets.every((key) => getSecretState(key).valid)
    ? '已配置；仍需收到带来源与观测时间的记录后才可标为“观测”'
    : '未配置';
}

/**
 * Persistent, value-free operator notice for a provider-dependent panel. It
 * deliberately exposes only configuration state, never a secret or a claim
 * that an enabled map layer is live.
 */
export function buildProviderReadinessNotice(
  heading: string,
  providers: readonly ProviderReadinessSpec[],
): HTMLElement {
  return h('section', {
    className: 'provider-readiness-notice',
    role: 'status',
    style: 'margin:0 0 8px;padding:8px;border:1px solid rgba(255,184,77,.36);border-radius:6px;background:rgba(255,184,77,.08);font-size:calc(10px * var(--wm-panel-effective-scale, 1));line-height:1.45;',
  },
  h('strong', {}, heading),
  h('div', { style: 'opacity:.78;margin:3px 0 5px;' }, '状态不等于实时：只有 Provider、来源与观测时间齐全的返回记录才会显示为观测。'),
  ...providers.map((entry) => h('div', { style: 'margin-top:4px;' },
    h('div', {}, `${entry.provider}：${readinessState(entry.requiredSecrets)}`),
    h('div', { style: 'opacity:.72;' }, `新鲜度：当前面板没有可验证的实时观测时间。操作：${entry.manualAction}`),
  )));
}
