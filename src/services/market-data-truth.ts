/** Front-end labels for the exact provider statuses in the stock RPC contract. */

import type { ProviderStatus } from '@/generated/client/worldmonitor/market/v1/service_client';

export type ProviderStatusDisplay = {
  label: string;
  tone: 'success' | 'warning' | 'muted' | 'danger';
  isLive: boolean;
};

export const PROVIDER_STATUS_DISPLAY: Record<ProviderStatus, ProviderStatusDisplay> = {
  PROVIDER_STATUS_UNSPECIFIED: { label: '状态未声明', tone: 'danger', isLive: false },
  PROVIDER_STATUS_REALTIME_LICENSED: { label: '已授权实时', tone: 'success', isLive: true },
  PROVIDER_STATUS_DELAYED_15M: { label: '延迟约 15 分钟', tone: 'warning', isLive: false },
  PROVIDER_STATUS_DELAYED_UNVERIFIED: { label: '延迟未验证', tone: 'warning', isLive: false },
  PROVIDER_STATUS_END_OF_DAY: { label: '收盘数据', tone: 'muted', isLive: false },
  PROVIDER_STATUS_HISTORICAL_SNAPSHOT: { label: '历史快照', tone: 'muted', isLive: false },
  PROVIDER_STATUS_STALE: { label: '数据过期', tone: 'warning', isLive: false },
  PROVIDER_STATUS_DEGRADED: { label: '服务降级', tone: 'warning', isLive: false },
  PROVIDER_STATUS_NOT_CONFIGURED: { label: '数据源未配置', tone: 'muted', isLive: false },
  PROVIDER_STATUS_UNAVAILABLE: { label: '数据暂不可用', tone: 'danger', isLive: false },
  PROVIDER_STATUS_MARKET_CLOSED: { label: '市场已休市', tone: 'muted', isLive: false },
};

export function providerStatusDisplay(status: ProviderStatus): ProviderStatusDisplay {
  return PROVIDER_STATUS_DISPLAY[status];
}
