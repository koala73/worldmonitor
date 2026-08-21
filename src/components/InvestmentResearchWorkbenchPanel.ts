import { Panel } from './Panel';
import {
  createResearchWorkbenchAdapter,
  RESEARCH_WORKBENCH_EVENT,
  type InvestmentResearchReport,
  type ResearchScenario,
  type ResearchSource,
  type ResearchStepId,
  type ThesisPillarStatus,
} from '@/services/investment-research-workbench';
import { escapeHtml, sanitizeUrl, unsafeRawHtml } from '@/utils/sanitize';

const STEPS: Array<{ id: ResearchStepId; label: string }> = [
  { id: 'world-macro', label: 'World / Macro' },
  { id: 'sector', label: 'Sector' },
  { id: 'company', label: 'Company' },
  { id: 'agent-research', label: 'Agents' },
  { id: 'critic', label: 'Critic' },
  { id: 'scenarios', label: 'Bull / Base / Bear' },
  { id: 'thesis-tracker', label: 'Thesis Tracker' },
];

const STATUS_ORDER: ThesisPillarStatus[] = ['untested', 'confirming', 'watch', 'disconfirming'];
const STATUS_LABELS: Record<ThesisPillarStatus, string> = {
  untested: 'Untested',
  confirming: 'Confirming',
  watch: 'Watch',
  disconfirming: 'Disconfirming',
};

function sourceMap(report: InvestmentResearchReport): Map<string, ResearchSource> {
  return new Map(report.sources.map((source) => [source.id, source]));
}

function renderSourceChips(ids: string[], sources: Map<string, ResearchSource>): string {
  return ids.map((id) => {
    const source = sources.get(id);
    if (!source) return '';
    const url = sanitizeUrl(source.url);
    const title = escapeHtml(`${source.publisher} · ${source.asOf} · ${source.reliability}`);
    return url
      ? `<a class="irw-source-chip" href="${url}" target="_blank" rel="noopener noreferrer" title="${title}">${escapeHtml(source.id)}</a>`
      : `<span class="irw-source-chip" title="${title}">${escapeHtml(source.id)}</span>`;
  }).join('');
}

export class InvestmentResearchWorkbenchPanel extends Panel {
  private activeStep: ResearchStepId = 'world-macro';
  private activeScenario: ResearchScenario['id'] = 'base';
  private report: InvestmentResearchReport | null = null;
  private symbol = 'ASTS';
  private loading = false;
  private error = '';
  private runAbort: AbortController | null = null;
  private readonly openHandler = (event: Event): void => {
    const symbol = (event as CustomEvent<{ symbol?: string }>).detail?.symbol;
    if (symbol) this.symbol = symbol.trim().toUpperCase();
    this.getElement().scrollIntoView({ behavior: 'smooth', block: 'center' });
    void this.runResearch();
  };

  constructor() {
    super({
      id: 'investment-research-workbench',
      title: 'Investment Research Workbench',
      className: 'panel-wide',
      defaultRowSpan: 3,
      infoTooltip: 'Source-traceable drill-down from global signals to a falsifiable company thesis. Research only; no trade execution.',
    });
    this.content.addEventListener('click', (event) => this.handleClick(event));
    this.content.addEventListener('keydown', (event) => this.handleKeydown(event));
    window.addEventListener(RESEARCH_WORKBENCH_EVENT, this.openHandler);
    void this.runResearch();
  }

  public override destroy(): void {
    this.runAbort?.abort();
    window.removeEventListener(RESEARCH_WORKBENCH_EVENT, this.openHandler);
    super.destroy();
  }

  private endpoint(): string {
    return (import.meta.env.VITE_RESEARCH_WORKBENCH_URL || '').trim();
  }

  private async runResearch(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.error = '';
    this.render();
    this.runAbort?.abort();
    this.runAbort = new AbortController();
    try {
      const adapter = createResearchWorkbenchAdapter({ endpoint: this.endpoint() });
      this.report = await adapter.run(this.symbol, this.runAbort.signal);
      this.symbol = this.report.symbol;
      this.applyStoredPillarStatuses();
      this.setDataBadge(this.report.sourceMode === 'live' ? 'live' : 'cached', this.report.sourceMode === 'live' ? 'orchestrated' : 'ASTS fixture');
    } catch (error) {
      if (this.isAbortError(error)) return;
      this.error = error instanceof Error ? error.message : 'Research workflow failed.';
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private handleClick(event: Event): void {
    const target = event.target as HTMLElement;
    const stepButton = target.closest<HTMLButtonElement>('button[data-irw-step]');
    if (stepButton?.dataset.irwStep) {
      this.activeStep = stepButton.dataset.irwStep as ResearchStepId;
      this.render();
      return;
    }
    const scenarioButton = target.closest<HTMLButtonElement>('button[data-irw-scenario]');
    if (scenarioButton?.dataset.irwScenario) {
      this.activeScenario = scenarioButton.dataset.irwScenario as ResearchScenario['id'];
      this.render();
      return;
    }
    const runButton = target.closest<HTMLButtonElement>('button[data-irw-run]');
    if (runButton) {
      const input = this.content.querySelector<HTMLInputElement>('input[data-irw-symbol]');
      if (input?.value.trim()) this.symbol = input.value.trim().toUpperCase();
      void this.runResearch();
      return;
    }
    const pillarButton = target.closest<HTMLButtonElement>('button[data-irw-pillar]');
    if (pillarButton?.dataset.irwPillar) this.cyclePillarStatus(pillarButton.dataset.irwPillar);
  }

  private handleKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter') return;
    const input = (event.target as HTMLElement).closest<HTMLInputElement>('input[data-irw-symbol]');
    if (!input) return;
    this.symbol = input.value.trim().toUpperCase();
    void this.runResearch();
  }

  private storageKey(): string {
    return `wm-investment-thesis-status-v1:${this.symbol}`;
  }

  private applyStoredPillarStatuses(): void {
    if (!this.report) return;
    try {
      const stored = JSON.parse(localStorage.getItem(this.storageKey()) || '{}') as Record<string, ThesisPillarStatus>;
      this.report.thesisPillars.forEach((pillar) => {
        const storedStatus = stored[pillar.id];
        if (storedStatus && STATUS_ORDER.includes(storedStatus)) pillar.status = storedStatus;
      });
    } catch {
      // The source report remains usable when storage is unavailable or corrupt.
    }
  }

  private cyclePillarStatus(pillarId: string): void {
    if (!this.report) return;
    const pillar = this.report.thesisPillars.find((candidate) => candidate.id === pillarId);
    if (!pillar) return;
    const currentIndex = STATUS_ORDER.indexOf(pillar.status);
    pillar.status = STATUS_ORDER[(currentIndex + 1) % STATUS_ORDER.length] ?? 'untested';
    try {
      localStorage.setItem(this.storageKey(), JSON.stringify(Object.fromEntries(this.report.thesisPillars.map((item) => [item.id, item.status]))));
    } catch {
      // Persistence is optional; keep the in-session edit.
    }
    this.render();
  }

  private render(): void {
    const report = this.report;
    const body = this.loading
      ? '<div class="irw-state">Running macro → sector → company → parallel agents → critic → scenarios…</div>'
      : this.error
        ? `<div class="irw-state irw-error">${escapeHtml(this.error)}</div>`
        : report
          ? this.renderReport(report)
          : '<div class="irw-state">No research loaded.</div>';

    this.setSafeContent(unsafeRawHtml(`
      <div class="irw-shell">
        <div class="irw-toolbar">
          <label class="irw-symbol-label">Company
            <input data-irw-symbol value="${escapeHtml(this.symbol)}" aria-label="Company ticker" autocomplete="off" spellcheck="false">
          </label>
          <button type="button" data-irw-run ${this.loading ? 'disabled' : ''}>${this.loading ? 'Running…' : 'Run research'}</button>
          <span class="irw-adapter">${this.endpoint() ? 'Langflow endpoint → OpenBB / agents' : 'Local ASTS fixture · add VITE_RESEARCH_WORKBENCH_URL for live orchestration'}</span>
        </div>
        <div class="irw-steps" role="tablist" aria-label="Research workflow">
          ${STEPS.map((step, index) => `<button type="button" role="tab" aria-selected="${this.activeStep === step.id}" class="${this.activeStep === step.id ? 'active' : ''}" data-irw-step="${step.id}"><span>${index + 1}</span>${escapeHtml(step.label)}</button>`).join('')}
        </div>
        ${body}
      </div>
    `, 'Investment Research Workbench uses escaped structured research data'));
  }

  private renderReport(report: InvestmentResearchReport): string {
    const sources = sourceMap(report);
    return `
      <div class="irw-snapshot">
        <div><strong>${escapeHtml(report.companyName)}</strong><span>${escapeHtml(report.symbol)} · ${escapeHtml(report.sector)}</span></div>
        <dl>
          <div><dt>Company thesis</dt><dd>${escapeHtml(report.companyThesisStatus)}</dd></div>
          <div><dt>Security readiness</dt><dd>${escapeHtml(report.securityThesisReadiness)}</dd></div>
          <div><dt>Action</dt><dd>${escapeHtml(report.action)}</dd></div>
          <div><dt>As of</dt><dd>${escapeHtml(report.asOf)}</dd></div>
        </dl>
      </div>
      ${this.activeStep === 'scenarios' ? this.renderScenarios(report, sources)
        : this.activeStep === 'thesis-tracker' ? this.renderTracker(report, sources)
          : this.renderStages(report, sources)}
      <div class="irw-footer"><strong>Readiness:</strong> ${escapeHtml(report.readiness)} · ${escapeHtml(report.pricedIn)}</div>
    `;
  }

  private renderStages(report: InvestmentResearchReport, sources: Map<string, ResearchSource>): string {
    const stages = report.stages.filter((stage) => stage.stepId === this.activeStep);
    const intro = this.activeStep === 'critic'
      ? `<div class="irw-callout"><strong>Variant wedge</strong>${escapeHtml(report.variantWedge)}</div>`
      : '';
    return `${intro}<div class="irw-stage-grid">${stages.map((stage) => `
      <section class="irw-stage-card">
        <header><div><strong>${escapeHtml(stage.name)}</strong><span>${escapeHtml(stage.provider)}</span></div><em class="${stage.status}">${escapeHtml(stage.status)}</em></header>
        ${stage.findings.map((finding) => `<div class="irw-finding"><span class="irw-claim-label">${escapeHtml(finding.label)}</span><p>${escapeHtml(finding.text)}</p><div>${renderSourceChips(finding.sourceIds, sources)}</div></div>`).join('')}
      </section>
    `).join('')}</div>`;
  }

  private renderScenarios(report: InvestmentResearchReport, sources: Map<string, ResearchSource>): string {
    const scenario = report.scenarios.find((candidate) => candidate.id === this.activeScenario) ?? report.scenarios[0];
    if (!scenario) return '<div class="irw-state">No scenarios available.</div>';
    return `
      <div class="irw-scenario-tabs">${report.scenarios.map((item) => `<button type="button" class="${item.id === this.activeScenario ? 'active' : ''}" data-irw-scenario="${item.id}">${escapeHtml(item.title)}</button>`).join('')}</div>
      <section class="irw-scenario-card ${scenario.id}">
        <div><strong>${escapeHtml(scenario.title)} case</strong><span>${escapeHtml(scenario.probabilityLabel)}</span></div>
        <p>${escapeHtml(scenario.summary)}</p>
        <p><b>Prove / kill test:</b> ${escapeHtml(scenario.provesOrKills)}</p>
        <div>${renderSourceChips(scenario.sourceIds, sources)}</div>
      </section>
    `;
  }

  private renderTracker(report: InvestmentResearchReport, sources: Map<string, ResearchSource>): string {
    return `<div class="irw-tracker">${report.thesisPillars.map((pillar) => `
      <section>
        <header><strong>${escapeHtml(pillar.title)}</strong><button type="button" class="status-${pillar.status}" data-irw-pillar="${escapeHtml(pillar.id)}" title="Click to cycle thesis status">${escapeHtml(STATUS_LABELS[pillar.status])}</button></header>
        <p><b>Falsifiable test:</b> ${escapeHtml(pillar.test)}</p>
        <p><b>Next evidence:</b> ${escapeHtml(pillar.nextEvidence)}</p>
        <div>${renderSourceChips(pillar.sourceIds, sources)}</div>
      </section>
    `).join('')}</div>`;
  }
}
