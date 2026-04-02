import { Panel } from './Panel';
import { t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';
import { describeFreshness } from '@/services/persistent-cache';
import type { MarketImplicationCard, MarketImplicationsData, TransmissionNode } from '@/services/market-implications';
import { FrameworkSelector } from './FrameworkSelector';
import { hasPremiumAccess } from '@/services/panel-gating';

const DISCLAIMER = 'AI-generated trade signals for informational purposes only. Not investment advice. Always do your own research.';

function directionClass(dir: string): string {
  const d = dir.toUpperCase();
  if (d === 'LONG') return 'badge-bullish';
  if (d === 'SHORT') return 'badge-bearish';
  return 'badge-neutral';
}

function confidenceClass(conf: string): string {
  const c = conf.toUpperCase();
  if (c === 'HIGH') return 'badge-bullish';
  if (c === 'LOW') return 'badge-bearish';
  return 'badge-neutral';
}

function directionLabel(dir: string): string {
  const d = dir.toUpperCase();
  if (d === 'LONG') return 'LONG';
  if (d === 'SHORT') return 'SHORT';
  return 'HEDGE';
}

function renderChain(chain: TransmissionNode[] | undefined): string {
  if (!chain || chain.length === 0) return '';
  const id = Math.random().toString(36).slice(2, 8);
  const nodes = chain.map((n, i) => {
    const arrow = i < chain.length - 1
      ? ` <span style="color:var(--text-dim);margin:0 2px">&rarr;</span> `
      : '';
    return `<span class="chain-node" data-chain-id="${id}" data-node-idx="${i}" data-logic="${escapeHtml(n.logic)}"
      style="cursor:pointer;border-bottom:1px dotted var(--text-dim)">${escapeHtml(n.node)}</span>${arrow}`;
  }).join('');
  return `
    <div style="font-size:10px;color:var(--text-dim);margin-top:6px;line-height:1.8">
      <span style="text-transform:uppercase;letter-spacing:0.06em;opacity:0.6">Rationale:</span> ${nodes}
    </div>
    <div id="chain-logic-${id}" style="display:none;font-size:10px;color:var(--text-dim);font-style:italic;margin-top:2px;padding-left:4px"></div>
  `;
}

function renderCard(card: MarketImplicationCard): string {
  return `
    <div class="signal-card">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px">
        <span class="signal-badge ${directionClass(card.direction)}">${directionLabel(card.direction)}</span>
        <strong style="font-size:14px;letter-spacing:-0.02em">${escapeHtml(card.ticker)}</strong>
        ${card.name ? `<span style="font-size:11px;color:var(--text-dim)">${escapeHtml(card.name)}</span>` : ''}
        ${card.timeframe ? `<span class="signal-badge badge-neutral" style="font-family:var(--font-mono)">${escapeHtml(card.timeframe)}</span>` : ''}
        ${card.confidence ? `<span class="signal-badge ${confidenceClass(card.confidence)}">${escapeHtml(card.confidence)}</span>` : ''}
      </div>
      <div style="font-size:13px;font-weight:600;line-height:1.4;margin-bottom:6px">${escapeHtml(card.title)}</div>
      <div style="font-size:12px;line-height:1.55;color:var(--text-dim)">${escapeHtml(card.narrative)}</div>
      ${renderChain(card.transmissionChain)}
      ${card.driver ? `<div style="font-size:11px;color:var(--text-dim);margin-top:6px"><span style="text-transform:uppercase;letter-spacing:0.06em">Driver:</span> ${escapeHtml(card.driver)}</div>` : ''}
      ${card.riskCaveat ? `<div style="font-size:11px;color:var(--yellow);padding:6px 8px;border:1px solid color-mix(in srgb,var(--yellow) 30%,transparent);background:color-mix(in srgb,var(--yellow) 8%,transparent);margin-top:6px">${escapeHtml(card.riskCaveat)}</div>` : ''}
    </div>
  `;
}

export class MarketImplicationsPanel extends Panel {
  private fwSelector: FrameworkSelector;

  constructor() {
    super({
      id: 'market-implications',
      title: 'AI Market Implications',
      infoTooltip: t('components.marketImplications.infoTooltip'),
      premium: 'locked',
    });
    this.fwSelector = new FrameworkSelector({ panelId: 'market-implications', isPremium: hasPremiumAccess(), panel: this, note: 'Applies to next AI regeneration' });
    this.header.appendChild(this.fwSelector.el);

    this.content.addEventListener('click', (e) => {
      const node = (e.target as HTMLElement).closest('.chain-node') as HTMLElement | null;
      if (!node) return;
      const chainId = node.getAttribute('data-chain-id')!;
      const nodeIdx = node.getAttribute('data-node-idx')!;
      const logic = node.getAttribute('data-logic')!;
      const logicEl = this.content.querySelector(`#chain-logic-${chainId}`) as HTMLElement | null;
      if (!logicEl) return;
      const isOpen = logicEl.style.display !== 'none';
      const isSameNode = logicEl.getAttribute('data-open-idx') === nodeIdx;
      if (isOpen && isSameNode) {
        logicEl.style.display = 'none';
      } else {
        logicEl.textContent = logic;
        logicEl.setAttribute('data-open-idx', nodeIdx);
        logicEl.style.display = 'block';
      }
    });
  }

  override destroy(): void {
    this.fwSelector.destroy();
    super.destroy();
  }

  public renderImplications(data: MarketImplicationsData, source: 'live' | 'cached' = 'live'): void {
    if (data.degraded || data.cards.length === 0) {
      this.showUnavailable();
      return;
    }

    const freshness = data.generatedAt ? describeFreshness(new Date(data.generatedAt).getTime()) : '';
    this.setDataBadge(source, freshness || `${data.cards.length} signals`);
    this.resetRetryBackoff();

    const html = `
      <div style="display:flex;flex-direction:column;gap:10px">
        ${data.cards.map(renderCard).join('')}
        <div style="font-size:10px;color:var(--text-dim);padding:8px;border-top:1px solid var(--border);line-height:1.5;text-align:center">${escapeHtml(DISCLAIMER)}</div>
      </div>
    `;

    this.setContent(html);
  }

  public showUnavailable(message = 'AI market implications are generated after each forecast run. Check back shortly.'): void {
    this.setDataBadge('unavailable');
    const html = `
      <div style="font-size:12px;color:var(--text-dim);line-height:1.5;padding:16px 0;text-align:center">${escapeHtml(message)}</div>
    `;
    this.setContent(html);
  }
}
