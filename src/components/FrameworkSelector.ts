import {
  type AnalysisPanelId,
  loadFrameworkLibrary,
  getActiveFrameworkForPanel,
  setActiveFrameworkForPanel,
} from '../services/analysis-framework-store';
import { PanelGateReason } from '../services/panel-gating';
import type { Panel } from './Panel';

interface FrameworkSelectorOptions {
  panelId: AnalysisPanelId;
  isPremium: boolean;
  panel: Panel | null;
}

export class FrameworkSelector {
  readonly el: HTMLElement;
  private select: HTMLSelectElement | null = null;
  private panelId: AnalysisPanelId;

  constructor(opts: FrameworkSelectorOptions) {
    this.panelId = opts.panelId;

    if (opts.isPremium) {
      const select = document.createElement('select');
      select.className = 'framework-selector';
      this.select = select;

      this.populateOptions(select);
      select.value = getActiveFrameworkForPanel(opts.panelId)?.id ?? '';

      select.addEventListener('change', () => {
        setActiveFrameworkForPanel(opts.panelId, select.value || null);
      });

      if (opts.panelId === 'insights') {
        const wrap = document.createElement('span');
        wrap.className = 'framework-selector-wrap';
        const note = document.createElement('span');
        note.className = 'framework-selector-note';
        note.title = 'Applies to client-generated analysis only';
        note.textContent = '*';
        wrap.append(select, note);
        this.el = wrap;
      } else {
        this.el = select;
      }
    } else {
      const select = document.createElement('select');
      select.className = 'framework-selector framework-selector--locked';
      select.disabled = true;
      const defaultOpt = document.createElement('option');
      defaultOpt.value = '';
      defaultOpt.textContent = 'Default (Neutral)';
      select.appendChild(defaultOpt);

      const badge = document.createElement('span');
      badge.className = 'framework-selector-pro-badge';
      badge.textContent = 'PRO';

      const wrap = document.createElement('span');
      wrap.className = 'framework-selector-wrap';
      wrap.append(select, badge);
      if (opts.panel) {
        wrap.addEventListener('click', () => {
          opts.panel!.showGatedCta(PanelGateReason.FREE_TIER, () => {});
        });
      }
      this.el = wrap;
    }
  }

  private populateOptions(select: HTMLSelectElement): void {
    select.innerHTML = '';
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = 'Default (Neutral)';
    select.appendChild(defaultOpt);

    for (const fw of loadFrameworkLibrary()) {
      const opt = document.createElement('option');
      opt.value = fw.id;
      opt.textContent = fw.name;
      select.appendChild(opt);
    }
  }

  refresh(): void {
    if (!this.select) return;
    const current = this.select.value;
    this.populateOptions(this.select);
    this.select.value = getActiveFrameworkForPanel(this.panelId)?.id ?? current;
  }

  destroy(): void {
    // No async listeners to clean up; GC handles the rest
  }
}
