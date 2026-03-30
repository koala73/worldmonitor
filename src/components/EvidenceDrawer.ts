import type { EvidencePack, EvidenceSource } from '@/services/evidence-pack';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';

interface EvidenceDrawerOptions {
  title?: string;
  subtitle?: string;
  evidence: EvidencePack;
}

export class EvidenceDrawer {
  private static overlay: HTMLElement | null = null;
  private static content: HTMLElement | null = null;
  private static bound = false;

  constructor() {
    EvidenceDrawer.ensureMounted();
  }

  public show(options: EvidenceDrawerOptions): void {
    EvidenceDrawer.ensureMounted();
    const overlay = EvidenceDrawer.overlay;
    const content = EvidenceDrawer.content;
    if (!overlay || !content) return;

    const safeSubtitle = options.subtitle ? `<div class="evidence-drawer-subtitle">${escapeHtml(options.subtitle)}</div>` : '';
    content.innerHTML = `
      <div class="evidence-drawer-kicker">Why we believe this</div>
      <div class="evidence-drawer-title">${escapeHtml(options.title ?? options.evidence.claim)}</div>
      ${safeSubtitle}
      <div class="evidence-drawer-status">
        <span class="evidence-drawer-pill evidence-drawer-pill-${escapeHtml(options.evidence.verdict)}">${escapeHtml(options.evidence.verdict)}</span>
        <span class="evidence-drawer-pill">${escapeHtml(options.evidence.actionThreshold)}</span>
        <span class="evidence-drawer-pill">${escapeHtml(options.evidence.freshness)}</span>
      </div>
      <div class="evidence-drawer-claim">${escapeHtml(options.evidence.claim)}</div>
      <div class="evidence-drawer-reason">${escapeHtml(options.evidence.confidenceReason)}</div>
      <div class="evidence-drawer-stats">
        <div class="evidence-drawer-stat">
          <span class="evidence-drawer-stat-label">Corroboration</span>
          <span class="evidence-drawer-stat-value">${options.evidence.corroborationCount}</span>
        </div>
        <div class="evidence-drawer-stat">
          <span class="evidence-drawer-stat-label">Trusted</span>
          <span class="evidence-drawer-stat-value">${options.evidence.trustedSourceCount}</span>
        </div>
        <div class="evidence-drawer-stat">
          <span class="evidence-drawer-stat-label">Diversity</span>
          <span class="evidence-drawer-stat-value">${options.evidence.sourceDiversity}</span>
        </div>
      </div>
      <div class="evidence-drawer-section">
        <div class="evidence-drawer-section-title">Supporting sources</div>
        ${this.renderSources(options.evidence.supportingSources, 'No supporting sources captured.')}
      </div>
      <div class="evidence-drawer-section">
        <div class="evidence-drawer-section-title">Conflicting sources</div>
        ${this.renderSources(options.evidence.conflictingSources, 'No direct conflicting sources logged.')}
      </div>
    `;

    overlay.classList.add('active');
  }

  public hide(): void {
    EvidenceDrawer.overlay?.classList.remove('active');
  }

  private renderSources(sources: EvidenceSource[], emptyMessage: string): string {
    if (sources.length === 0) {
      return `<div class="evidence-drawer-empty">${escapeHtml(emptyMessage)}</div>`;
    }

    return `
      <div class="evidence-drawer-source-list">
        ${sources.map((source) => {
          const safeUrl = source.url?.startsWith('https://') ? sanitizeUrl(source.url) : '';
          const name = safeUrl
            ? `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.name)}</a>`
            : escapeHtml(source.name);

          return `
            <div class="evidence-drawer-source">
              <div class="evidence-drawer-source-name">${name}</div>
              <div class="evidence-drawer-source-meta">
                <span>${escapeHtml(source.kind)}</span>
                <span>Tier ${source.tier}</span>
                <span>${escapeHtml(source.type)}</span>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  private static ensureMounted(): void {
    if (EvidenceDrawer.overlay && EvidenceDrawer.content) return;

    const overlay = document.createElement('div');
    overlay.className = 'evidence-drawer-overlay';
    overlay.innerHTML = `
      <div class="evidence-drawer">
        <div class="evidence-drawer-header">
          <span class="evidence-drawer-header-title">Why we believe this</span>
          <button class="evidence-drawer-close" type="button" aria-label="Close evidence drawer">×</button>
        </div>
        <div class="evidence-drawer-content"></div>
      </div>
    `;

    document.body.append(overlay);

    EvidenceDrawer.overlay = overlay;
    EvidenceDrawer.content = overlay.querySelector('.evidence-drawer-content');

    if (!EvidenceDrawer.bound) {
      overlay.addEventListener('click', (event) => {
        const target = event.target as HTMLElement;
        if (target.classList.contains('evidence-drawer-overlay') || target.classList.contains('evidence-drawer-close')) {
          overlay.classList.remove('active');
        }
      });
      EvidenceDrawer.bound = true;
    }
  }
}
