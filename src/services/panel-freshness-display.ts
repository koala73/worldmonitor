import { t } from '@/services/i18n';
import type { FreshnessStatus, PanelFreshnessSource, PanelFreshnessSummary } from '@/services/data-freshness';

export interface PanelFreshnessDisplay {
  label: string;
  title: string;
  ariaLabel: string;
}

const STATUS_KEYS: Record<FreshnessStatus, { key: string; fallback: string }> = {
  fresh: { key: 'fresh', fallback: 'Fresh' },
  stale: { key: 'stale', fallback: 'Stale' },
  very_stale: { key: 'veryStale', fallback: 'Very stale' },
  no_data: { key: 'noData', fallback: 'No data' },
  disabled: { key: 'disabled', fallback: 'Disabled' },
  error: { key: 'error', fallback: 'Error' },
};

function tx(key: string, fallback: string, options: Record<string, unknown> = {}): string {
  return t(key, { defaultValue: fallback, ...options }) || fallback;
}

function statusLabel(status: FreshnessStatus): string {
  const entry = STATUS_KEYS[status];
  return tx(`components.panelFreshness.status.${entry.key}`, entry.fallback);
}

function formatTimeSince(date: Date | null): string {
  if (!date) return tx('components.panelFreshness.time.never', 'never');

  const ms = Math.max(0, Date.now() - date.getTime());
  if (ms < 60_000) return tx('components.panelFreshness.time.justNow', 'just now');
  if (ms < 3_600_000) {
    return tx('components.panelFreshness.time.minutesAgo', '{{count}}m ago', {
      count: Math.floor(ms / 60_000),
    });
  }
  if (ms < 86_400_000) {
    return tx('components.panelFreshness.time.hoursAgo', '{{count}}h ago', {
      count: Math.floor(ms / 3_600_000),
    });
  }
  return tx('components.panelFreshness.time.daysAgo', '{{count}}d ago', {
    count: Math.floor(ms / 86_400_000),
  });
}

function formatCompactAge(date: Date | null): string {
  if (!date) return '';
  const ms = Math.max(0, Date.now() - date.getTime());
  if (ms < 60_000) return tx('components.panelFreshness.time.compactNow', 'now');
  if (ms < 3_600_000) {
    return tx('components.panelFreshness.time.compactMinutes', '{{count}}m', {
      count: Math.floor(ms / 60_000),
    });
  }
  if (ms < 86_400_000) {
    return tx('components.panelFreshness.time.compactHours', '{{count}}h', {
      count: Math.floor(ms / 3_600_000),
    });
  }
  return tx('components.panelFreshness.time.compactDays', '{{count}}d', {
    count: Math.floor(ms / 86_400_000),
  });
}

function formatHealthStatus(status: string): string | null {
  switch (status) {
    case 'OK':
      return null;
    case 'COVERAGE_PARTIAL':
      return tx('components.panelFreshness.health.partialCoverage', 'partial coverage');
    case 'STALE_CONTENT':
      return tx('components.panelFreshness.health.contentStale', 'content stale');
    case 'STALE_SEED':
      return tx('components.panelFreshness.health.seedStale', 'seed stale');
    case 'EMPTY':
    case 'EMPTY_DATA':
    case 'EMPTY_ON_DEMAND':
      return tx('components.panelFreshness.health.noSourceData', 'no source data');
    case 'SEED_ERROR':
      return tx('components.panelFreshness.health.sourceErrorReported', 'source error reported');
    case 'REDIS_DOWN':
      return tx('components.panelFreshness.health.freshnessStoreUnavailable', 'freshness store unavailable');
    case 'REDIS_PARTIAL':
      return tx('components.panelFreshness.health.freshnessStoreDegraded', 'freshness store degraded');
    default:
      return null;
  }
}

function formatHealthDetail(source: PanelFreshnessSource): string | null {
  if (source.lastError) {
    return formatHealthStatus(source.lastError)
      ?? tx('components.panelFreshness.health.sourceErrorReported', 'source error reported');
  }
  if (source.healthStatus) {
    return formatHealthStatus(source.healthStatus);
  }
  return null;
}

function formatSourceDetail(source: PanelFreshnessSource): string {
  const update = source.lastUpdate
    ? tx('components.panelFreshness.lastUpdated', 'last updated {{time}}', {
      time: formatTimeSince(source.lastUpdate),
    })
    : tx('components.panelFreshness.neverUpdated', 'never updated');
  const detail = formatHealthDetail(source);
  if (detail) {
    return tx('components.panelFreshness.sourceDetailWithHealth', '{{name}}: {{status}}, {{update}}, {{detail}}', {
      name: source.name,
      status: statusLabel(source.status),
      update,
      detail,
    });
  }
  return tx('components.panelFreshness.sourceDetail', '{{name}}: {{status}}, {{update}}', {
    name: source.name,
    status: statusLabel(source.status),
    update,
  });
}

export function formatPanelFreshnessDisplay(summary: PanelFreshnessSummary): PanelFreshnessDisplay {
  const status = statusLabel(summary.status);
  const age = summary.status === 'fresh' || summary.status === 'stale' || summary.status === 'very_stale'
    ? formatCompactAge(summary.labelUpdate)
    : '';
  const label = age
    ? tx('components.panelFreshness.labelWithAge', '{{status}} {{age}}', { status, age })
    : status;
  const sources = summary.sources.map(formatSourceDetail).join('; ');
  const title = tx('components.panelFreshness.title', 'Data freshness: {{status}}. {{sources}}', {
    status,
    sources,
  });
  return { label, title, ariaLabel: title };
}
