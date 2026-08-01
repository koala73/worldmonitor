import { Panel } from './Panel';
import { getChinaActivityNowcastData } from '@/services/china-activity-nowcast';
import { unsafeRawHtml } from '@/utils/sanitize';
import type { ChinaActivityNowcastResponse } from '../../shared/china-activity-nowcast';
import { renderChinaActivityNowcastView } from './china-activity-nowcast-view';

const STYLE_ID = 'china-activity-nowcast-panel-styles';

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .china-nowcast-view { display: grid; gap: 12px; color: var(--text-primary); }
    .china-nowcast-summary, .china-nowcast-official, .china-nowcast-method {
      border: 1px solid var(--border-color); background: color-mix(in srgb, var(--panel-bg) 88%, transparent);
    }
    .china-nowcast-summary {
      display: grid; grid-template-columns: minmax(0, 1fr) minmax(180px, .38fr);
      gap: 14px; align-items: center; padding: 14px;
      border-left: 3px solid var(--text-muted);
    }
    .china-nowcast-summary--agreement { border-left-color: var(--success-color, #45bd7d); }
    .china-nowcast-summary--proxy_leading_divergence,
    .china-nowcast-summary--official_leading_divergence { border-left-color: var(--warning-color, #e3a94f); }
    .china-nowcast-summary--mixed_signals { border-left-color: #8f7bd6; }
    .china-nowcast-summary--insufficient_data { border-left-color: var(--text-muted); }
    .china-nowcast-eyebrow, .china-nowcast-family {
      display: block; color: var(--text-muted); font-size: 10px; font-weight: 700;
      letter-spacing: .11em; text-transform: uppercase;
    }
    .china-nowcast-summary h3, .china-nowcast-official h4,
    .china-nowcast-contribution h4, .china-nowcast-method h4 { margin: 4px 0; }
    .china-nowcast-summary p, .china-nowcast-official p,
    .china-nowcast-contribution p, .china-nowcast-method p {
      margin: 5px 0; color: var(--text-secondary); line-height: 1.45;
    }
    .china-nowcast-confidence { display: grid; gap: 3px; padding: 10px; background: var(--surface-hover); }
    .china-nowcast-confidence > span {
      width: max-content; padding: 2px 7px; border: 1px solid currentColor;
      color: var(--text-secondary); font-size: 10px; text-transform: uppercase;
    }
    .china-nowcast-confidence small { color: var(--text-muted); line-height: 1.35; }
    .china-nowcast-official { padding: 12px 14px; }
    .china-nowcast-official dl, .china-nowcast-contribution dl { margin: 8px 0 0; }
    .china-nowcast-official dl { display: flex; flex-wrap: wrap; gap: 8px 18px; }
    .china-nowcast-official dl div, .china-nowcast-contribution dl div { min-width: 0; }
    .china-nowcast-official dt, .china-nowcast-contribution dt {
      color: var(--text-muted); font-size: 10px; text-transform: uppercase;
    }
    .china-nowcast-official dd, .china-nowcast-contribution dd {
      margin: 2px 0 0; overflow-wrap: anywhere; color: var(--text-secondary);
    }
    .china-nowcast-contributions {
      display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px;
    }
    .china-nowcast-contribution {
      min-width: 0; padding: 11px; border: 1px solid var(--border-color);
      background: var(--surface-bg, var(--panel-bg));
    }
    .china-nowcast-contribution--strengthening { border-top: 2px solid var(--success-color, #45bd7d); }
    .china-nowcast-contribution--weakening { border-top: 2px solid var(--danger-color, #df6969); }
    .china-nowcast-contribution--unchanged { border-top: 2px solid #8f7bd6; }
    .china-nowcast-contribution--excluded { border-top: 2px solid var(--text-muted); opacity: .86; }
    .china-nowcast-contribution__heading {
      display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: start;
    }
    .china-nowcast-contribution__state {
      max-width: 190px; color: var(--text-secondary); font-size: 11px; text-align: right;
    }
    .china-nowcast-contribution dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px 12px; }
    .china-nowcast-contribution a { color: var(--accent-color); }
    .china-nowcast-method summary {
      padding: 11px 13px; cursor: pointer; font-weight: 650; color: var(--text-secondary);
    }
    .china-nowcast-method__grid {
      display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 14px; padding: 0 13px 13px;
    }
    .china-nowcast-method ul { margin: 7px 0 0; padding-left: 18px; color: var(--text-secondary); }
    .china-nowcast-method li { margin: 4px 0; line-height: 1.4; }
    .china-nowcast-method li span { display: block; color: var(--text-muted); font-size: 11px; }
    @media (max-width: 720px) {
      .china-nowcast-summary, .china-nowcast-contributions,
      .china-nowcast-method__grid { grid-template-columns: minmax(0, 1fr); }
      .china-nowcast-contribution__heading { grid-template-columns: minmax(0, 1fr); }
      .china-nowcast-contribution__state { max-width: none; text-align: left; }
    }
  `;
  document.head.appendChild(style);
}

export class ChinaActivityNowcastPanel extends Panel {
  private response: ChinaActivityNowcastResponse | null = null;

  constructor() {
    super({
      id: 'china-activity-nowcast',
      title: 'China Activity Nowcast',
      className: 'panel-wide',
      defaultRowSpan: 2,
      infoTooltip: 'A deterministic directional comparison of revision-aware official activity and reviewed proxy families. Missing and stale inputs are excluded; this is not a replacement GDP estimate.',
    });
    injectStyles();
  }

  public async fetchData(): Promise<boolean> {
    this.showLoading();
    const response = await getChinaActivityNowcastData();
    this.setData(response);
    return response.state !== 'insufficient_data';
  }

  public setData(response: ChinaActivityNowcastResponse): void {
    this.response = response;
    this.render();
  }

  private render(): void {
    if (this.response === null) return;
    this.setSafeContent(unsafeRawHtml(
      renderChinaActivityNowcastView(this.response),
      'China activity nowcast renderer escapes every dynamic value before constructing markup',
    ));
  }
}
