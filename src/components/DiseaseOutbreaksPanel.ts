import { Panel } from './Panel';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';
import { fetchDiseaseOutbreaks, type DiseaseOutbreakItem } from '@/services/disease-outbreaks';

function alertColor(level: string): string {
  if (level === 'alert') return '#e74c3c';
  if (level === 'warning') return '#e67e22';
  return '#f1c40f';
}

function alertLabel(level: string): string {
  if (level === 'alert') return 'ALERT';
  if (level === 'warning') return 'WARNING';
  return 'WATCH';
}

function relativeTime(ms: number): string {
  if (!ms) return '';
  const diff = Date.now() - ms;
  const h = Math.floor(diff / 3600000);
  if (h < 1) return 'just now';
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export class DiseaseOutbreaksPanel extends Panel {
  private _outbreaks: DiseaseOutbreakItem[] = [];
  private _hasData = false;
  private _filter: string = '';

  constructor() {
    super({ id: 'disease-outbreaks', title: 'Disease Outbreaks', showCount: false });
    this.content.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-filter]');
      if (btn) {
        this._filter = btn.dataset.filter === this._filter ? '' : (btn.dataset.filter ?? '');
        this._render();
      }
    });
    this.content.addEventListener('input', (e) => {
      const inp = e.target as HTMLInputElement;
      if (inp.dataset.role === 'search') {
        this._filter = inp.value.trim().toLowerCase();
        this._render();
      }
    });
  }

  public async fetchData(): Promise<boolean> {
    this.showLoading();
    try {
      const data = await fetchDiseaseOutbreaks();
      if (!data.outbreaks?.length) {
        if (!this._hasData) this.showError('No outbreak data available', () => void this.fetchData());
        return false;
      }
      this._outbreaks = [...data.outbreaks].sort((a, b) => {
        const levelOrder = { alert: 0, warning: 1, watch: 2 };
        const la = levelOrder[a.alertLevel as keyof typeof levelOrder] ?? 3;
        const lb = levelOrder[b.alertLevel as keyof typeof levelOrder] ?? 3;
        if (la !== lb) return la - lb;
        return (b.publishedAt ?? 0) - (a.publishedAt ?? 0);
      });
      this._hasData = true;
      this._render();
      return true;
    } catch (e) {
      if (!this._hasData) this.showError(e instanceof Error ? e.message : 'Failed to load', () => void this.fetchData());
      return false;
    }
  }

  public updateData(outbreaks: DiseaseOutbreakItem[]): void {
    this._outbreaks = [...outbreaks].sort((a, b) => {
      const levelOrder = { alert: 0, warning: 1, watch: 2 };
      const la = levelOrder[a.alertLevel as keyof typeof levelOrder] ?? 3;
      const lb = levelOrder[b.alertLevel as keyof typeof levelOrder] ?? 3;
      if (la !== lb) return la - lb;
      return (b.publishedAt ?? 0) - (a.publishedAt ?? 0);
    });
    this._hasData = this._outbreaks.length > 0;
    if (this._hasData) this._render();
  }

  private _render(): void {
    const counts = { alert: 0, warning: 0, watch: 0 };
    for (const o of this._outbreaks) {
      const k = o.alertLevel as keyof typeof counts;
      if (k in counts) counts[k]++;
    }

    const alertLevels = new Set(['alert', 'warning', 'watch']);
    const filtered = this._filter
      ? alertLevels.has(this._filter)
        ? this._outbreaks.filter(o => o.alertLevel === this._filter)
        : this._outbreaks.filter(o =>
            o.disease.toLowerCase().includes(this._filter) ||
            o.location.toLowerCase().includes(this._filter) ||
            o.countryCode?.toLowerCase().includes(this._filter)
          )
      : this._outbreaks;

    const filterBar = `<div style="display:flex;gap:4px;margin-bottom:8px;flex-wrap:wrap;align-items:center">
      ${counts.alert > 0 ? `<button data-filter="alert" style="font-size:10px;padding:2px 8px;border-radius:10px;border:1px solid rgba(231,76,60,0.4);background:${this._filter === 'alert' ? 'rgba(231,76,60,0.2)' : 'transparent'};color:#e74c3c;cursor:pointer">${counts.alert} Alert</button>` : ''}
      ${counts.warning > 0 ? `<button data-filter="warning" style="font-size:10px;padding:2px 8px;border-radius:10px;border:1px solid rgba(230,126,34,0.4);background:${this._filter === 'warning' ? 'rgba(230,126,34,0.2)' : 'transparent'};color:#e67e22;cursor:pointer">${counts.warning} Warning</button>` : ''}
      ${counts.watch > 0 ? `<button data-filter="watch" style="font-size:10px;padding:2px 8px;border-radius:10px;border:1px solid rgba(241,196,15,0.4);background:${this._filter === 'watch' ? 'rgba(241,196,15,0.2)' : 'transparent'};color:#f1c40f;cursor:pointer">${counts.watch} Watch</button>` : ''}
    </div>`;

    const rows = filtered.map(o => {
      const color = alertColor(o.alertLevel);
      const label = alertLabel(o.alertLevel);
      const age = relativeTime(o.publishedAt);
      const sourceLink = o.sourceUrl
        ? `<a href="${escapeHtml(sanitizeUrl(o.sourceUrl))}" target="_blank" rel="noopener noreferrer" style="color:var(--accent-primary);text-decoration:none;font-size:9px">${escapeHtml(o.sourceName || 'Source')}</a>`
        : (o.sourceName ? `<span style="font-size:9px;color:var(--text-dim)">${escapeHtml(o.sourceName)}</span>` : '');

      return `<div style="border-bottom:1px solid var(--border);padding:8px 0">
        <div style="display:flex;align-items:flex-start;gap:6px">
          <span style="flex-shrink:0;font-size:9px;font-weight:700;padding:2px 5px;border-radius:3px;background:${color}22;color:${color};margin-top:1px">${label}</span>
          <div style="flex:1;min-width:0">
            <div style="font-size:12px;font-weight:600;color:var(--text);line-height:1.3">${escapeHtml(o.disease)}</div>
            <div style="font-size:11px;color:var(--text-dim);margin-top:2px">${escapeHtml(o.location)}</div>
            ${o.summary ? `<div style="font-size:10px;color:var(--text-dim);margin-top:3px;line-height:1.4">${escapeHtml(o.summary.slice(0, 120))}${o.summary.length > 120 ? '…' : ''}</div>` : ''}
            <div style="display:flex;gap:8px;margin-top:4px;align-items:center">
              ${sourceLink}
              ${age ? `<span style="font-size:9px;color:var(--text-dim)">${escapeHtml(age)}</span>` : ''}
            </div>
          </div>
        </div>
      </div>`;
    }).join('');

    const empty = filtered.length === 0
      ? `<div style="padding:16px;text-align:center;color:var(--text-dim);font-size:12px">No outbreaks match filter</div>`
      : '';

    this.setContent(`
      ${filterBar}
      <div style="overflow-y:auto;max-height:420px">
        ${rows || empty}
      </div>
      <div style="margin-top:6px;font-size:9px;color:var(--text-dim)">WHO · ProMED · HealthMap</div>
    `);
  }
}
