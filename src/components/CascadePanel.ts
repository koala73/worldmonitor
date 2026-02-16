import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';
import { getCSSColor } from '@/utils';
import {
  buildDependencyGraph,
  calculateCascade,
  getGraphStats,
  clearGraphCache,
  type DependencyGraph,
} from '@/services/infrastructure-cascade';
import type { CascadeResult, CascadeImpactLevel, InfrastructureNode } from '@/types';

type NodeFilter = 'all' | 'cable' | 'pipeline' | 'port' | 'chokepoint';

export class CascadePanel extends Panel {
  private graph: DependencyGraph | null = null;
  private selectedNode: string | null = null;
  private cascadeResult: CascadeResult | null = null;
  private filter: NodeFilter = 'cable';
  private onSelectCallback: ((nodeId: string | null) => void) | null = null;

  constructor() {
    super({
      id: 'cascade',
      title: 'Infrastructure Cascade',
      showCount: true,
      trackActivity: true,
      infoTooltip: `<strong>Cascade Analysis</strong>
        Models infrastructure dependencies:
        <ul>
          <li>Subsea cables, pipelines, ports, chokepoints</li>
          <li>Select infrastructure to simulate failure</li>
          <li>Shows affected countries and capacity loss</li>
          <li>Identifies redundant routes</li>
        </ul>
        Data from TeleGeography and industry sources.`,
    });
    this.init();
  }

  private async init(): Promise<void> {
    this.showLoading();
    try {
      this.graph = buildDependencyGraph();
      const stats = getGraphStats();
      this.setCount(stats.nodes);
      this.render();
    } catch (error) {
      console.error('[CascadePanel] Init error:', error);
      this.showError('Failed to build dependency graph');
    }
  }

  private getImpactColor(level: CascadeImpactLevel): string {
    switch (level) {
      case 'critical': return getCSSColor('--semantic-critical');
      case 'high': return getCSSColor('--semantic-high');
      case 'medium': return getCSSColor('--semantic-elevated');
      case 'low': return getCSSColor('--semantic-normal');
    }
  }

  private getImpactEmoji(level: CascadeImpactLevel): string {
    switch (level) {
      case 'critical': return '🔴';
      case 'high': return '🟠';
      case 'medium': return '🟡';
      case 'low': return '🟢';
    }
  }

  private getNodeTypeEmoji(type: string): string {
    switch (type) {
      case 'cable': return '🔌';
      case 'pipeline': return '🛢️';
      case 'port': return '⚓';
      case 'chokepoint': return '🚢';
      case 'country': return '🏳️';
      default: return '📍';
    }
  }

  private getFilteredNodes(): InfrastructureNode[] {
    if (!this.graph) return [];
    const nodes: InfrastructureNode[] = [];
    for (const node of this.graph.nodes.values()) {
      if (this.filter === 'all' || node.type === this.filter) {
        if (node.type !== 'country') {
          nodes.push(node);
        }
      }
    }
    return nodes.sort((a, b) => a.name.localeCompare(b.name));
  }

  private renderSelector(): string {
    const nodes = this.getFilteredNodes();
    const filterButtons = ['cable', 'pipeline', 'port', 'chokepoint'].map(f =>
      `<button class="cascade-filter-btn ${this.filter === f ? 'active' : ''}" data-filter="${f}">
        ${this.getNodeTypeEmoji(f)} ${f.charAt(0).toUpperCase() + f.slice(1)}s
      </button>`
    ).join('');

    const nodeOptions = nodes.map(n =>
      `<option value="${escapeHtml(n.id)}" ${this.selectedNode === n.id ? 'selected' : ''}>
        ${escapeHtml(n.name)}
      </option>`
    ).join('');

    return `
      <div class="cascade-selector">
        <div class="cascade-filters">${filterButtons}</div>
        <select class="cascade-select" ${nodes.length === 0 ? 'disabled' : ''}>
          <option value="">Select ${this.filter}...</option>
          ${nodeOptions}
        </select>
        <button class="cascade-analyze-btn" ${!this.selectedNode ? 'disabled' : ''}>
          Analyze Impact
        </button>
      </div>
    `;
  }

  private renderCascadeResult(): string {
    if (!this.cascadeResult) return '';

    const { source, countriesAffected, redundancies } = this.cascadeResult;

    const countriesHtml = countriesAffected.length > 0
      ? countriesAffected.map(c => `
          <div class="cascade-country" style="border-left: 3px solid ${this.getImpactColor(c.impactLevel)}">
            <span class="cascade-emoji">${this.getImpactEmoji(c.impactLevel)}</span>
            <span class="cascade-country-name">${escapeHtml(c.countryName)}</span>
            <span class="cascade-impact">${c.impactLevel}</span>
            ${c.affectedCapacity > 0 ? `<span class="cascade-capacity">${Math.round(c.affectedCapacity * 100)}% capacity</span>` : ''}
          </div>
        `).join('')
      : '<div class="empty-state">No country impacts detected</div>';

    const redundanciesHtml = redundancies && redundancies.length > 0
      ? `
        <div class="cascade-section">
          <div class="cascade-section-title">Alternative Routes</div>
          ${redundancies.map(r => `
            <div class="cascade-redundancy">
              <span class="cascade-redundancy-name">${escapeHtml(r.name)}</span>
              <span class="cascade-redundancy-capacity">${Math.round(r.capacityShare * 100)}%</span>
            </div>
          `).join('')}
        </div>
      `
      : '';

    return `
      <div class="cascade-result">
        <div class="cascade-source">
          <span class="cascade-emoji">${this.getNodeTypeEmoji(source.type)}</span>
          <span class="cascade-source-name">${escapeHtml(source.name)}</span>
          <span class="cascade-source-type">${source.type}</span>
        </div>
        <div class="cascade-section">
          <div class="cascade-section-title">Countries Affected (${countriesAffected.length})</div>
          <div class="cascade-countries">${countriesHtml}</div>
        </div>
        ${redundanciesHtml}
      </div>
    `;
  }

  private render(): void {
    if (!this.graph) {
      this.showLoading();
      return;
    }

    const stats = getGraphStats();
    const statsHtml = `
      <div class="cascade-stats">
        <span>🔌 ${stats.cables}</span>
        <span>🛢️ ${stats.pipelines}</span>
        <span>⚓ ${stats.ports}</span>
        <span>🌊 ${stats.chokepoints}</span>
        <span>🏳️ ${stats.countries}</span>
        <span>📊 ${stats.edges} links</span>
      </div>
    `;

    this.content.innerHTML = `
      <div class="cascade-panel">
        ${statsHtml}
        ${this.renderSelector()}
        ${this.cascadeResult ? this.renderCascadeResult() : '<div class="cascade-hint">Select infrastructure to analyze cascade impact</div>'}
      </div>
    `;

    this.attachEventListeners();
  }

  private attachEventListeners(): void {
    const filterBtns = this.content.querySelectorAll('.cascade-filter-btn');
    filterBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        this.filter = btn.getAttribute('data-filter') as NodeFilter;
        this.selectedNode = null;
        this.cascadeResult = null;
        this.render();
      });
    });

    const select = this.content.querySelector('.cascade-select') as HTMLSelectElement;
    if (select) {
      select.addEventListener('change', () => {
        this.selectedNode = select.value || null;
        this.cascadeResult = null;
        if (this.onSelectCallback) {
          this.onSelectCallback(this.selectedNode);
        }
        this.render();
      });
    }

    const analyzeBtn = this.content.querySelector('.cascade-analyze-btn');
    if (analyzeBtn) {
      analyzeBtn.addEventListener('click', () => this.runAnalysis());
    }
  }

  private runAnalysis(): void {
    if (!this.selectedNode) return;

    this.cascadeResult = calculateCascade(this.selectedNode);
    this.render();

    if (this.onSelectCallback) {
      this.onSelectCallback(this.selectedNode);
    }
  }

  public selectNode(nodeId: string): void {
    this.selectedNode = nodeId;
    const nodeType = nodeId.split(':')[0] as NodeFilter;
    if (['cable', 'pipeline', 'port', 'chokepoint'].includes(nodeType)) {
      this.filter = nodeType;
    }
    this.runAnalysis();
  }

  public onSelect(callback: (nodeId: string | null) => void): void {
    this.onSelectCallback = callback;
  }

  public getSelectedNode(): string | null {
    return this.selectedNode;
  }

  public getCascadeResult(): CascadeResult | null {
    return this.cascadeResult;
  }

  public refresh(): void {
    clearGraphCache();
    this.graph = null;
    this.cascadeResult = null;
    this.init();
  }
}
