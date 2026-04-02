import { Panel } from './Panel';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { h, replaceChildren } from '@/utils/dom-utils';
import { sanitizeUrl } from '@/utils/sanitize';
import { MilitaryServiceClient } from '@/generated/client/worldmonitor/military/v1/service_client';
import type { DefensePatentFiling } from '@/generated/client/worldmonitor/military/v1/service_client';

type ViewMode = 'all' | 'H04B' | 'H01L' | 'F42B' | 'G06N' | 'C12N';

const CPC_LABELS: Record<string, string> = {
  H04B: 'Comms',
  H01L: 'Semiconductors',
  F42B: 'Ammunition',
  G06N: 'AI',
  C12N: 'Biotech',
};

const CPC_ICONS: Record<string, string> = {
  H04B: '📡',
  H01L: '💾',
  F42B: '💣',
  G06N: '🤖',
  C12N: '🧬',
};

const militaryClient = new MilitaryServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) });

export class DefensePatentsPanel extends Panel {
  private viewMode: ViewMode = 'all';
  private patents: DefensePatentFiling[] = [];
  private loading = true;
  private error: string | null = null;

  constructor() {
    super({
      id: 'defense-patents',
      title: 'R&D Signal',
      showCount: true,
      infoTooltip: 'Weekly defense and dual-use patent filings by Raytheon, Lockheed, Huawei, DARPA, and other strategic organizations. Categories: H04B (comms), H01L (semiconductors), F42B (ammunition), G06N (AI), C12N (biotech). Source: USPTO PatentsView.',
    });
    this.element.classList.add('panel-tall');
    void this.fetchPatents();
  }

  private async fetchPatents(): Promise<void> {
    this.loading = true;
    this.error = null;
    this.render();

    try {
      const data = await militaryClient.listDefensePatents({ cpcCode: '', assignee: '', limit: 100 });
      if (!this.element?.isConnected) return;
      this.patents = data.patents ?? [];
      this.setCount(data.total ?? this.patents.length);
      this.error = null;
    } catch (err) {
      if (this.isAbortError(err)) return;
      if (!this.element?.isConnected) return;
      this.error = 'Failed to load patent data.';
      console.error('[DefensePatents] Fetch error:', err);
    }
    this.loading = false;
    this.render();
  }

  protected render(): void {
    if (this.loading) {
      replaceChildren(this.content,
        h('div', { className: 'defense-patents-loading' },
          h('div', { className: 'loading-spinner' }),
          h('span', null, 'Loading R&D filings…'),
        ),
      );
      return;
    }

    if (this.error) {
      this.showError(this.error, () => this.refresh());
      return;
    }

    this.setErrorState(false);

    const tabs: [ViewMode, string][] = [
      ['all', 'All'],
      ...Object.entries(CPC_LABELS).map(([code, label]): [ViewMode, string] => [code as ViewMode, label]),
    ];

    const filtered = this.getFiltered();

    replaceChildren(this.content,
      h('div', { className: 'defense-patents-panel' },
        h('div', { className: 'panel-tabs' },
          ...tabs.map(([mode, label]) =>
            h('button', {
              className: `panel-tab ${this.viewMode === mode ? 'active' : ''}`,
              onClick: () => { this.viewMode = mode; this.render(); },
            }, label),
          ),
        ),
        h('div', { className: 'defense-patents-list' },
          ...(filtered.length > 0
            ? filtered.map(p => this.buildRow(p))
            : [h('div', { className: 'empty-state' }, 'No filings in this category.')]),
        ),
      ),
    );
  }

  private getFiltered(): DefensePatentFiling[] {
    if (this.viewMode === 'all') return this.patents.slice(0, 50);
    return this.patents.filter(p => p.cpcCode === this.viewMode).slice(0, 30);
  }

  private buildRow(p: DefensePatentFiling): HTMLElement {
    const date = p.date ? new Date(p.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
    const icon = CPC_ICONS[p.cpcCode] ?? '🔬';
    const safeUrl = sanitizeUrl(p.url || '');

    return h('div', { className: 'defense-patent-row' },
      h('div', { className: 'patent-icon', title: p.cpcDesc || p.cpcCode }, icon),
      h('div', { className: 'patent-body' },
        h('div', { className: 'patent-header' },
          h('span', { className: 'patent-assignee' }, p.assignee),
          safeUrl
            ? h('a', { href: safeUrl, target: '_blank', rel: 'noopener', className: 'patent-link', title: 'View on USPTO' }, '↗')
            : false,
        ),
        h('div', { className: 'patent-title' }, p.title),
        h('div', { className: 'patent-meta' },
          h('span', { className: `patent-cpc cpc-${p.cpcCode}` }, p.cpcDesc || p.cpcCode),
          date ? h('span', { className: 'patent-date' }, date) : false,
          p.patentId ? h('span', { className: 'patent-id' }, p.patentId) : false,
        ),
      ),
    );
  }

  public refresh(): void {
    void this.fetchPatents();
  }
}
