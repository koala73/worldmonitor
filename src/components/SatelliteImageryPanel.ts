import { Panel } from './Panel';
import type { ImageryScene } from '@/generated/server/worldmonitor/imagery/v1/service_server';
import { escapeHtml } from '@/utils/sanitize';

export class SatelliteImageryPanel extends Panel {
  private scenes: ImageryScene[] = [];
  private onSearchArea: (() => void) | null = null;
  constructor() {
    super({
      id: 'satellite-imagery',
      title: 'Satellite Imagery',
      showCount: true,
      trackActivity: true,
      infoTooltip: 'Recent satellite imagery footprints from SAR and optical sensors',
    });
    this.showLoading('Scanning imagery catalog...');
    this.element.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('.imagery-search-btn');
      if (btn) this.onSearchArea?.();
    });
    this.element.addEventListener('error', (e) => {
      const img = e.target as HTMLElement;
      if (img.tagName === 'IMG') img.style.display = 'none';
    }, true);
  }

  public setOnSearchArea(cb: () => void): void {
    this.onSearchArea = cb;
  }

  public update(scenes: ImageryScene[]): void {
    this.scenes = scenes;
    this.setCount(scenes.length);
    this.render();
  }

  private render(): void {
    if (this.scenes.length === 0) {
      this.setContent(`<div class="panel-empty">No imagery scenes in view</div>`);
      return;
    }

    const rows = this.scenes.slice(0, 20).map(s => {
      const dt = s.datetime ? new Date(s.datetime).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
      const preview = s.previewUrl
        ? `<img src="${escapeHtml(s.previewUrl)}" alt="" style="width:40px;height:40px;object-fit:cover;border-radius:2px;margin-right:6px;vertical-align:middle;" loading="lazy">`
        : '';
      return `<div class="imagery-row" style="display:flex;align-items:center;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.05);">
        ${preview}
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;font-size:11px;color:#00b4ff;">${escapeHtml(s.satellite)}</div>
          <div style="font-size:10px;opacity:.7;">${escapeHtml(dt)} · ${s.resolutionM}m · ${escapeHtml(s.mode)}</div>
        </div>
      </div>`;
    }).join('');

    const searchBtn = this.onSearchArea
      ? `<button class="imagery-search-btn" style="width:100%;margin-top:8px;padding:6px;background:rgba(0,180,255,0.15);border:1px solid rgba(0,180,255,0.3);border-radius:3px;color:#00b4ff;cursor:pointer;font-size:11px;">Search this area</button>`
      : '';

    this.setContent(`
      <div class="imagery-panel-content">
        ${rows}
        <div class="imagery-footer" style="margin-top:4px;font-size:10px;opacity:.5;">
          ${this.scenes.length} scene${this.scenes.length !== 1 ? 's' : ''} found
        </div>
        ${searchBtn}
      </div>
    `);
  }
}
