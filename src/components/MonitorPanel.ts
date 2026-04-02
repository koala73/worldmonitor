import { Panel } from './Panel';
import { track } from '@/services/analytics';
import type { BreakingAlert } from '@/services/breaking-news-alerts';
import {
  FREE_MONITOR_LIMIT,
  evaluateMonitorMatches,
  hasMonitorProAccess,
  mergeMonitorEdits,
  monitorUsesProFeatures,
  normalizeMonitor,
  normalizeMonitors,
  type MonitorFeedInput,
  type MonitorMatch,
} from '@/services/monitors';
import { t } from '@/services/i18n';
import type { Monitor, MonitorMatchMode, MonitorSourceKind } from '@/types';
import { MONITOR_COLORS } from '@/config';
import { formatTime, getCSSColor } from '@/utils';
import { sanitizeUrl } from '@/utils/sanitize';
import { h, replaceChildren, clearChildren } from '@/utils/dom-utils';

const SOURCE_ORDER: MonitorSourceKind[] = ['news', 'breaking', 'advisories', 'cross-source'];

const SOURCE_LABELS: Record<MonitorSourceKind, string> = {
  news: 'News',
  breaking: 'Breaking',
  advisories: 'Advisories',
  'cross-source': 'Cross-source',
};

const SEVERITY_COLORS: Record<string, string> = {
  critical: 'var(--semantic-critical)',
  high: 'var(--semantic-high)',
  medium: 'var(--semantic-elevated)',
  low: 'var(--semantic-normal)',
  info: 'var(--text-dim)',
};

function parseKeywords(value: string): string[] {
  return value
    .split(/[\n,]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function isProOnlySource(source: MonitorSourceKind): boolean {
  return source === 'advisories' || source === 'cross-source';
}

function sourceKindLabel(kind: MonitorMatch['sourceKind']): string {
  return kind === 'cross-source' ? SOURCE_LABELS['cross-source'] : SOURCE_LABELS[kind];
}

export class MonitorPanel extends Panel {
  private monitors: Monitor[] = [];
  private onMonitorsChange?: (monitors: Monitor[]) => void;
  private feed: MonitorFeedInput = { news: [] };
  private breakingAlerts: BreakingAlert[] = [];
  private lastMatchIds = new Set<string>();
  private statusEl: HTMLElement | null = null;
  private monitorsListEl: HTMLElement | null = null;
  private resultsEl: HTMLElement | null = null;
  private nameInput: HTMLInputElement | null = null;
  private includeInput: HTMLInputElement | null = null;
  private excludeInput: HTMLInputElement | null = null;
  private modeSelect: HTMLSelectElement | null = null;
  private addBtn: HTMLButtonElement | null = null;
  private cancelBtn: HTMLButtonElement | null = null;
  private sourceInputs = new Map<MonitorSourceKind, HTMLInputElement>();
  private readonly boundOnBreakingAlert: (e: Event) => void;
  private editingMonitorId: string | null = null;

  constructor(initialMonitors: Monitor[] = []) {
    super({
      id: 'monitors',
      title: t('panels.monitors'),
      infoTooltip: 'Build local monitoring rules over live news, breaking events, security advisories, and cross-source escalation signals.',
    });
    this.monitors = normalizeMonitors(initialMonitors);
    this.boundOnBreakingAlert = (e: Event) => {
      const detail = (e as CustomEvent<BreakingAlert>).detail;
      if (!detail?.id) return;
      const idx = this.breakingAlerts.findIndex((alert) => alert.id === detail.id);
      if (idx >= 0) {
        this.breakingAlerts[idx] = detail;
      } else {
        this.breakingAlerts.unshift(detail);
        this.breakingAlerts = this.breakingAlerts.slice(0, 50);
      }
      this.refreshResults();
    };
    document.addEventListener('wm:breaking-news', this.boundOnBreakingAlert);
    this.renderInput();
  }

  private renderInput(): void {
    clearChildren(this.content);

    this.nameInput = h('input', {
      type: 'text',
      className: 'monitor-input',
      placeholder: t('components.monitor.namePlaceholder'),
    }) as HTMLInputElement;

    this.includeInput = h('input', {
      type: 'text',
      className: 'monitor-input',
      placeholder: t('components.monitor.placeholder'),
      onKeypress: (e: Event) => {
        if ((e as KeyboardEvent).key === 'Enter') this.addMonitor();
      },
    }) as HTMLInputElement;

    this.excludeInput = h('input', {
      type: 'text',
      className: 'monitor-input',
      placeholder: t('components.monitor.excludePlaceholder'),
      onKeypress: (e: Event) => {
        if ((e as KeyboardEvent).key === 'Enter') this.addMonitor();
      },
    }) as HTMLInputElement;

    this.modeSelect = h('select', { className: 'unified-settings-select' },
      h('option', { value: 'any' }, t('components.monitor.modeAny')),
      h('option', { value: 'all' }, t('components.monitor.modeAll')),
    ) as HTMLSelectElement;

    const sourceToggles = h('div', {
      style: 'display:flex;flex-wrap:wrap;gap:8px;margin-top:8px',
    });
    this.sourceInputs.clear();
    for (const source of SOURCE_ORDER) {
      const input = h('input', {
        type: 'checkbox',
        checked: source === 'news' || source === 'breaking',
      }) as HTMLInputElement;
      this.sourceInputs.set(source, input);
      const badge = isProOnlySource(source)
        ? h('span', {
          style: 'font-size:9px;padding:1px 4px;border:1px solid rgba(255,255,255,0.14);border-radius:999px;color:var(--text-dim);font-family:var(--font-mono);letter-spacing:0.04em',
        }, 'PRO')
        : null;
      const label = h('label', {
        style: 'display:inline-flex;align-items:center;gap:6px;padding:5px 8px;border:1px solid var(--border);border-radius:999px;font-size:11px;color:var(--text);cursor:pointer',
      }, input, SOURCE_LABELS[source], badge);
      sourceToggles.appendChild(label);
    }

    this.addBtn = h('button', {
      className: 'monitor-add-btn',
      onClick: () => this.addMonitor(),
    }, t('components.monitor.add')) as HTMLButtonElement;

    this.cancelBtn = h('button', {
      className: 'monitor-add-btn',
      style: 'display:none;background:transparent;border:1px solid var(--border);color:var(--text-dim)',
      onClick: () => this.cancelEdit(),
    }, t('common.cancel')) as HTMLButtonElement;

    this.statusEl = h('div', {
      style: 'color:var(--text-dim);font-size:11px;line-height:1.5;margin-top:8px',
    });

    const composer = h('div', {
      className: 'monitor-input-container',
      style: 'display:flex;flex-direction:column;gap:8px',
    },
    this.nameInput,
    this.includeInput,
    this.excludeInput,
    h('div', {
      style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap',
    },
    h('span', {
      style: 'font-size:11px;color:var(--text-dim);min-width:56px',
    }, t('components.monitor.ruleMode')),
    this.modeSelect,
    this.addBtn,
    this.cancelBtn,
    ),
    h('div', {
      style: 'font-size:11px;color:var(--text-dim);margin-top:2px',
    }, t('components.monitor.sources')),
    sourceToggles,
    this.statusEl,
    );

    this.monitorsListEl = h('div', {
      style: 'display:flex;flex-direction:column;gap:8px;margin-top:12px',
    });
    this.resultsEl = h('div', { style: 'margin-top:12px' });

    this.content.appendChild(composer);
    this.content.appendChild(this.monitorsListEl);
    this.content.appendChild(this.resultsEl);

    this.applyComposerAccessState();
    this.renderMonitorsList();
    this.refreshResults();
  }

  private applyComposerAccessState(): void {
    const proAccess = hasMonitorProAccess();
    if (this.excludeInput) {
      this.excludeInput.disabled = !proAccess;
      this.excludeInput.title = proAccess ? '' : t('components.monitor.lockedAdvanced');
    }
    for (const [source, input] of this.sourceInputs) {
      if (!isProOnlySource(source)) continue;
      input.disabled = !proAccess;
      input.title = proAccess ? '' : t('components.monitor.lockedAdvanced');
      if (!proAccess) input.checked = false;
    }
    this.setComposerStatus(
      t('components.monitor.freeLimit', { count: String(FREE_MONITOR_LIMIT) }),
      'info',
    );
  }

  private setComposerStatus(message: string, tone: 'info' | 'warn' = 'info'): void {
    if (!this.statusEl) return;
    this.statusEl.textContent = message;
    this.statusEl.style.color = tone === 'warn' ? getCSSColor('--semantic-elevated') : 'var(--text-dim)';
  }

  private selectedSources(fallbackWhenEmpty = true): MonitorSourceKind[] {
    const out: MonitorSourceKind[] = [];
    for (const [source, input] of this.sourceInputs) {
      if (input.checked) out.push(source);
    }
    return out.length > 0 || !fallbackWhenEmpty ? out : ['news'];
  }

  private addMonitor(): void {
    const includeKeywords = parseKeywords(this.includeInput?.value || '');
    if (includeKeywords.length === 0) return;

    const proAccess = hasMonitorProAccess();
    if (!proAccess && this.monitors.length >= FREE_MONITOR_LIMIT) {
      track('gate-hit', { feature: 'monitor-limit' });
      this.setComposerStatus(t('components.monitor.limitReached', { count: String(FREE_MONITOR_LIMIT) }), 'warn');
      return;
    }

    const excludeKeywords = parseKeywords(this.excludeInput?.value || '');
    const existing = this.editingMonitorId
      ? this.monitors.find((item) => item.id === this.editingMonitorId)
      : undefined;
    const preserveLockedFields = Boolean(existing && !proAccess && monitorUsesProFeatures(existing));
    const sources = this.selectedSources(!preserveLockedFields);
    const hasAdvancedRule = excludeKeywords.length > 0 || sources.some((source) => isProOnlySource(source));
    if (!proAccess && hasAdvancedRule) {
      track('gate-hit', { feature: 'monitor-advanced-rules' });
      this.setComposerStatus(t('components.monitor.lockedAdvanced'), 'warn');
      return;
    }

    const draftMonitor: Monitor = {
      id: '',
      name: this.nameInput?.value.trim() || undefined,
      keywords: includeKeywords,
      includeKeywords,
      excludeKeywords,
      color: MONITOR_COLORS[this.monitors.length % MONITOR_COLORS.length] ?? getCSSColor('--status-live'),
      matchMode: (this.modeSelect?.value === 'all' ? 'all' : 'any') as MonitorMatchMode,
      sources,
    };

    if (this.editingMonitorId) {
      const idx = this.monitors.findIndex((item) => item.id === this.editingMonitorId);
      if (idx >= 0) {
        const existing = this.monitors[idx]!;
        const nextMonitor = preserveLockedFields
          ? mergeMonitorEdits(existing, draftMonitor, false)
          : draftMonitor;
        this.monitors[idx] = normalizeMonitor({
          ...existing,
          ...nextMonitor,
          id: existing.id,
          color: existing.color,
          createdAt: existing.createdAt,
        }, idx);
      }
    } else {
      this.monitors.push(normalizeMonitor(draftMonitor, this.monitors.length));
    }

    this.resetComposer();
    this.setComposerStatus(t('components.monitor.freeLimit', { count: String(FREE_MONITOR_LIMIT) }), 'info');
    this.renderMonitorsList();
    this.refreshResults();
    this.onMonitorsChange?.(this.monitors);
  }

  public removeMonitor(id: string): void {
    this.monitors = this.monitors.filter((monitor) => monitor.id !== id);
    if (this.editingMonitorId === id) this.resetComposer();
    this.renderMonitorsList();
    this.refreshResults();
    this.onMonitorsChange?.(this.monitors);
  }

  private startEdit(id: string): void {
    const monitor = this.monitors.find((item) => item.id === id);
    if (!monitor) return;
    const proAccess = hasMonitorProAccess();
    this.editingMonitorId = id;
    if (this.nameInput) this.nameInput.value = monitor.name || '';
    if (this.includeInput) this.includeInput.value = (monitor.includeKeywords ?? monitor.keywords).join(', ');
    if (this.excludeInput) {
      this.excludeInput.value = proAccess ? (monitor.excludeKeywords ?? []).join(', ') : '';
    }
    if (this.modeSelect) this.modeSelect.value = monitor.matchMode === 'all' ? 'all' : 'any';
    for (const [source, input] of this.sourceInputs) {
      const selected = (monitor.sources ?? ['news']).includes(source);
      input.checked = proAccess ? selected : (selected && !isProOnlySource(source));
    }
    if (this.addBtn) this.addBtn.textContent = t('components.monitor.save');
    if (this.cancelBtn) this.cancelBtn.style.display = 'inline-flex';
    if (!proAccess && monitorUsesProFeatures(monitor)) {
      this.setComposerStatus(t('components.monitor.lockedRule'), 'warn');
    } else {
      this.setComposerStatus(t('components.monitor.editing'), 'info');
    }
  }

  private cancelEdit(): void {
    this.resetComposer();
    this.setComposerStatus(t('components.monitor.freeLimit', { count: String(FREE_MONITOR_LIMIT) }), 'info');
  }

  private resetComposer(): void {
    this.editingMonitorId = null;
    if (this.nameInput) this.nameInput.value = '';
    if (this.includeInput) this.includeInput.value = '';
    if (this.excludeInput) this.excludeInput.value = '';
    if (this.modeSelect) this.modeSelect.value = 'any';
    for (const [source, input] of this.sourceInputs) {
      input.checked = source === 'news' || source === 'breaking';
    }
    if (this.addBtn) this.addBtn.textContent = t('components.monitor.add');
    if (this.cancelBtn) this.cancelBtn.style.display = 'none';
  }

  private renderMonitorCard(monitor: Monitor): HTMLElement {
    const metaBits: string[] = [];
    if (monitor.matchMode === 'all') metaBits.push(t('components.monitor.modeAll'));
    if ((monitor.excludeKeywords?.length ?? 0) > 0) metaBits.push(`exclude: ${monitor.excludeKeywords?.join(', ')}`);

    const sources = monitor.sources ?? ['news'];
    const sourceRow = h('div', {
      style: 'display:flex;flex-wrap:wrap;gap:6px;margin-top:8px',
    },
    ...sources.map((source) =>
      h('span', {
        style: 'font-size:10px;padding:2px 6px;border:1px solid var(--border);border-radius:999px;color:var(--text-dim);font-family:var(--font-mono);letter-spacing:0.04em',
      }, SOURCE_LABELS[source]),
    ));

    const lockedNote = monitorUsesProFeatures(monitor) && !hasMonitorProAccess()
      ? h('div', {
        style: 'margin-top:8px;font-size:11px;color:var(--semantic-elevated)',
      }, t('components.monitor.lockedRule'))
      : null;

    return h('div', {
      style: `border:1px solid var(--border);border-left:3px solid ${monitor.color};padding:10px 12px;border-radius:10px;background:rgba(255,255,255,0.02)`,
    },
    h('div', {
      style: 'display:flex;justify-content:space-between;gap:8px;align-items:flex-start',
    },
    h('div', {},
    h('div', {
      style: 'font-size:13px;font-weight:600;color:var(--text)',
    }, monitor.name || t('panels.monitors')),
    h('div', {
      style: 'margin-top:4px;font-size:11px;color:var(--text-dim);line-height:1.5',
    }, (monitor.includeKeywords ?? monitor.keywords).join(', ')),
    metaBits.length > 0
      ? h('div', {
        style: 'margin-top:4px;font-size:10px;color:var(--text-dim)',
      }, metaBits.join(' · '))
      : null,
    ),
    h('div', {
      style: 'display:flex;align-items:center;gap:8px',
    },
    h('button', {
      className: 'icon-btn',
      title: t('components.monitor.edit'),
      'aria-label': t('components.monitor.edit'),
      onClick: () => this.startEdit(monitor.id),
    }, t('components.monitor.edit')),
    h('button', {
      className: 'monitor-tag-remove',
      title: t('components.monitor.remove'),
      'aria-label': t('components.monitor.remove'),
      onClick: () => this.removeMonitor(monitor.id),
    }, '×'),
    ),
    ),
    sourceRow,
    lockedNote,
    );
  }

  private renderMonitorsList(): void {
    if (!this.monitorsListEl) return;
    if (this.monitors.length === 0) {
      replaceChildren(this.monitorsListEl,
        h('div', {
          style: 'color:var(--text-dim);font-size:11px;line-height:1.5;padding:8px 0',
        }, t('components.monitor.addKeywords')),
      );
      return;
    }

    replaceChildren(this.monitorsListEl,
      ...this.monitors.map((monitor) => this.renderMonitorCard(monitor)),
    );
  }

  public renderResults(feed: MonitorFeedInput): void {
    this.feed = {
      news: feed.news ?? [],
      advisories: feed.advisories ?? [],
      crossSourceSignals: feed.crossSourceSignals ?? [],
      breakingAlerts: this.breakingAlerts,
    };
    this.refreshResults();
  }

  private renderMatchCard(match: MonitorMatch): HTMLElement {
    const severityColor = match.severity ? (SEVERITY_COLORS[match.severity] || 'var(--text-dim)') : 'var(--text-dim)';
    const titleNode = match.link
      ? h('a', {
        className: 'item-title',
        href: sanitizeUrl(match.link),
        target: '_blank',
        rel: 'noopener',
      }, match.title)
      : h('div', { className: 'item-title' }, match.title);

    return h('div', {
      className: 'item',
      style: `border-left:2px solid ${match.monitorColor};padding-left:8px;margin-left:-8px`,
    },
    h('div', {
      style: 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:4px',
    },
    h('span', { className: 'item-source' }, match.monitorName),
    h('span', {
      style: 'font-size:10px;padding:1px 6px;border:1px solid var(--border);border-radius:999px;color:var(--text-dim);font-family:var(--font-mono);letter-spacing:0.04em',
    }, sourceKindLabel(match.sourceKind)),
    match.severity
      ? h('span', {
        style: `font-size:10px;padding:1px 6px;border-radius:999px;background:${severityColor};color:#fff;font-family:var(--font-mono);letter-spacing:0.04em`,
      }, match.severity.toUpperCase())
      : null,
    ),
    titleNode,
    h('div', {
      style: 'margin-top:4px;font-size:11px;color:var(--text-dim);line-height:1.5',
    }, [match.subtitle, match.summary].filter(Boolean).join(' · ')),
    h('div', {
      style: 'margin-top:4px;font-size:10px;color:var(--text-dim);display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap',
    },
    h('span', {}, t('components.monitor.matchedTerms', { terms: match.matchedTerms.join(', ') })),
    h('span', { className: 'item-time' }, formatTime(new Date(match.timestamp))),
    ),
    );
  }

  private refreshResults(): void {
    if (!this.resultsEl) return;

    const matches = evaluateMonitorMatches(this.monitors, {
      ...this.feed,
      breakingAlerts: this.breakingAlerts,
    });

    const nextMatchIds = new Set(matches.map((match) => `${match.monitorId}:${match.sourceKind}:${match.id}`));
    if (this.lastMatchIds.size > 0) {
      let newCount = 0;
      for (const id of nextMatchIds) {
        if (!this.lastMatchIds.has(id)) newCount++;
      }
      if (newCount > 0) this.setNewBadge(newCount);
    }
    this.lastMatchIds = nextMatchIds;

    if (this.monitors.length === 0) {
      replaceChildren(this.resultsEl,
        h('div', { style: 'color: var(--text-dim); font-size: 10px; margin-top: 12px;' },
          t('components.monitor.addKeywords'),
        ),
      );
      return;
    }

    if (matches.length === 0) {
      replaceChildren(this.resultsEl,
        h('div', { style: 'color: var(--text-dim); font-size: 10px; margin-top: 12px;' },
          this.feed.news.length > 0
            ? t('components.monitor.noMatches', { count: String(this.feed.news.length) })
            : t('components.monitor.noFeedMatches'),
        ),
      );
      return;
    }

    const countText = matches.length > 12
      ? t('components.monitor.showingMatches', { count: '12', total: String(matches.length) })
      : `${matches.length} ${matches.length === 1 ? t('components.monitor.match') : t('components.monitor.matches')}`;

    replaceChildren(this.resultsEl,
      h('div', {
        style: 'color: var(--text-dim); font-size: 10px; margin: 12px 0 8px;',
      }, `${t('components.monitor.resultsTitle')} · ${countText}`),
      ...matches.slice(0, 12).map((match) => this.renderMatchCard(match)),
    );
  }

  public onChanged(callback: (monitors: Monitor[]) => void): void {
    this.onMonitorsChange = callback;
  }

  public getMonitors(): Monitor[] {
    return [...this.monitors];
  }

  public setMonitors(monitors: Monitor[]): void {
    this.monitors = normalizeMonitors(monitors);
    this.renderMonitorsList();
    this.refreshResults();
  }

  public override destroy(): void {
    document.removeEventListener('wm:breaking-news', this.boundOnBreakingAlert);
    super.destroy();
  }
}
