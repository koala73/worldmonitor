import { Panel } from './Panel';
import { escapeHtml, unsafeRawHtml } from '@/utils/sanitize';
import {
  loadBlocSnapshot,
  indexByIso,
  arZScore,
  isReacting,
  newsActiveCountries,
  blocIntensity,
  AR_ALERT_SIGMA,
  type BlocSnapshot,
  type BlocCountry,
} from '@/services/bloc-alignment';
import type { NewsItem } from '@/types';

const FLAGS: Record<string, string> = {
  JP: '🇯🇵', KR: '🇰🇷', TW: '🇹🇼', IN: '🇮🇳', HK: '🇭🇰', SG: '🇸🇬', MY: '🇲🇾',
  TH: '🇹🇭', ID: '🇮🇩', PH: '🇵🇭', VN: '🇻🇳', AU: '🇦🇺', NZ: '🇳🇿', DE: '🇩🇪',
  GB: '🇬🇧', FR: '🇫🇷', IT: '🇮🇹', ES: '🇪🇸', NL: '🇳🇱', CH: '🇨🇭', SE: '🇸🇪',
  BE: '🇧🇪', AT: '🇦🇹', IE: '🇮🇪', NO: '🇳🇴', DK: '🇩🇰', FI: '🇫🇮', PL: '🇵🇱',
  GR: '🇬🇷', TR: '🇹🇷', IL: '🇮🇱', SA: '🇸🇦', AE: '🇦🇪', QA: '🇶🇦', ZA: '🇿🇦',
  CA: '🇨🇦', MX: '🇲🇽', BR: '🇧🇷', CL: '🇨🇱', PE: '🇵🇪', CO: '🇨🇴', AR: '🇦🇷',
};

/**
 * USA vs CHINA — market relationship panel (fork-side, AMD-003).
 *
 * Left column is the structural read: which bloc each country's equity market
 * is coupled to over the past year. Right column is the event read: countries
 * whose market moved further than their own bloc betas explain, on a day the
 * feed is talking about them.
 */
export class BlocAlignmentPanel extends Panel {
  private snapshot: BlocSnapshot | null = null;
  private readonly getNews: () => NewsItem[];
  private loading = false;

  constructor(getNews: () => NewsItem[]) {
    super({
      id: 'bloc-alignment',
      title: 'Market Relationship',
      showCount: true,
      infoTooltip:
        'Which bloc each country\'s equity market moves with. Daily log returns over ' +
        'the past year are regressed on BOTH bloc legs at once, so each loading is ' +
        'conditional on the other — run separately, nearly everything reads "US" ' +
        'because US tech drives global risk appetite.\n\n' +
        'LEAN −1 = purely US-coupled, +1 = purely China-coupled. R² is how much of ' +
        'the country\'s variance the two legs jointly explain; a big lean on a low R² ' +
        'is noise, and the map fades it accordingly.\n\n' +
        'REACTING lists countries whose abnormal return (actual move minus what their ' +
        'betas predicted) broke ' + AR_ALERT_SIGMA + 'σ on a day the feed mentions them.\n\n' +
        'Country markets are proxied by US-listed single-country ETFs, so returns ' +
        'blend equity and FX moves. Co-movement is not causation.',
    });
    this.getNews = getNews;
  }

  public async refresh(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      if (!this.snapshot) this.showLoading('Loading bloc alignment…');
      const next = await loadBlocSnapshot();
      if (next) this.snapshot = next;
      this.render();
    } finally {
      this.loading = false;
    }
  }

  /** Cheap re-render when news arrives — the reacting set depends on it. */
  public onNewsUpdated(): void {
    if (this.snapshot) this.render();
  }

  public getSnapshot(): BlocSnapshot | null {
    return this.snapshot;
  }

  private render(): void {
    if (!this.snapshot) {
      this.setSafeContent(unsafeRawHtml(
        `<div style="padding:20px 14px;text-align:center;opacity:.7;font-size:12px">
           No bloc data yet — run <code>scripts/seed-bloc-markets.mjs</code>.
         </div>`,
        'legacy Panel.setContent() migration',
      ));
      return;
    }

    const rows = this.snapshot.countries;
    const byIso = indexByIso(this.snapshot);
    const active = newsActiveCountries(this.getNews());
    this.setCount(rows.length);

    const reacting = rows
      .filter((r) => isReacting(r.iso2, byIso, active))
      .sort((a, b) => Math.abs(arZScore(b)) - Math.abs(arZScore(a)));

    // Rank by the same quantity the map shades with, NOT by raw lean. Sorting
    // on lean alone puts Vietnam (lean −0.97 on an R² of 0.09 — essentially an
    // unexplained market) above Korea (−0.89 on R² 0.58), so the panel's
    // strongest-looking row is its least trustworthy one and the list openly
    // contradicts the map beside it.
    const byConfidence = (a: BlocCountry, b: BlocCountry) =>
      blocIntensity(b.lean, b.r2) - blocIntensity(a.lean, a.r2);
    const usSide = rows.filter((r) => r.lean < -0.05).sort(byConfidence).slice(0, 12);
    const cnSide = rows.filter((r) => r.lean > 0.05).sort(byConfidence).slice(0, 12);

    const asOf = new Date(this.snapshot.generatedAtMs).toLocaleDateString();

    this.setSafeContent(unsafeRawHtml(`
      <div class="bloc-panel">
        <div class="bloc-legs">
          <span class="bloc-leg bloc-leg-us">🇺🇸 US leg ${escapeHtml(this.snapshot.usLeg)}</span>
          <span class="bloc-leg bloc-leg-cn">🇨🇳 CN leg ${escapeHtml(this.snapshot.cnLeg)}</span>
          <span class="bloc-window">${this.snapshot.windowSessions} sessions · ${escapeHtml(asOf)}</span>
        </div>

        <div class="bloc-section-title">Reacting now
          <span class="bloc-hint">abnormal move &ge;${AR_ALERT_SIGMA}&sigma; + in the feed</span>
        </div>
        ${reacting.length === 0
          ? `<div class="bloc-empty">No country is moving beyond its bloc betas on a story right now.</div>`
          : `<div class="bloc-reacting">${reacting.slice(0, 8).map((r) => this.reactingRow(r)).join('')}</div>`}

        <div class="bloc-columns">
          <div class="bloc-col">
            <div class="bloc-section-title bloc-title-us">Coupled to US</div>
            ${usSide.map((r) => this.leanRow(r)).join('')}
          </div>
          <div class="bloc-col">
            <div class="bloc-section-title bloc-title-cn">Coupled to China</div>
            ${cnSide.length ? cnSide.map((r) => this.leanRow(r)).join('')
              : `<div class="bloc-empty">None above threshold.</div>`}
          </div>
        </div>
      </div>
    `, 'legacy Panel.setContent() migration'));
  }

  private leanRow(r: BlocCountry): string {
    const pct = Math.round(Math.min(1, Math.abs(r.lean) / 0.6) * 100);
    const side = r.lean < 0 ? 'us' : 'cn';
    return `
      <div class="bloc-row" title="β_US ${r.betaUs.toFixed(2)} · β_CN ${r.betaCn.toFixed(2)} · ${r.obs} sessions">
        <span class="bloc-flag">${FLAGS[r.iso2] ?? '🏳️'}</span>
        <span class="bloc-name">${escapeHtml(r.name)}</span>
        <span class="bloc-bar"><i class="bloc-bar-fill bloc-bar-${side}" style="width:${pct}%"></i></span>
        <span class="bloc-lean bloc-lean-${side}">${r.lean >= 0 ? '+' : ''}${r.lean.toFixed(2)}</span>
        <span class="bloc-r2" title="variance explained by the two legs">R²${r.r2.toFixed(2)}</span>
      </div>`;
  }

  private reactingRow(r: BlocCountry): string {
    const z = arZScore(r);
    const dir = z < 0 ? 'down' : 'up';
    return `
      <div class="bloc-react-row bloc-react-${dir}">
        <span class="bloc-flag">${FLAGS[r.iso2] ?? '🏳️'}</span>
        <span class="bloc-name">${escapeHtml(r.name)}</span>
        <span class="bloc-ar">${(r.lastAr * 100).toFixed(2)}%</span>
        <span class="bloc-z">${z >= 0 ? '+' : ''}${z.toFixed(1)}σ</span>
      </div>`;
  }
}
