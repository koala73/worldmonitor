/**
 * ClaudeAgentPanel
 *
 * Interactive intelligence analyst powered by Claude's tool-use (agentic) API.
 * Users can ask natural-language questions; Claude autonomously calls tools
 * (news, risk scores, market data, cyber threats) to gather live data before
 * synthesizing a structured intelligence brief.
 */
import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';
import { h, safeHtml, replaceChildren } from '@/utils/dom-utils';
import { t } from '@/services/i18n';
import { isFeatureAvailable } from '@/services/runtime-config';
import {
  runClaudeAgent,
  toolLabel,
  AGENT_PRESET_QUERIES,
  type AgentToolCall,
} from '@/services/claude-agent';

/** Render state for a single session entry */
interface SessionEntry {
  query: string;
  toolCalls: AgentToolCall[];
  response: string;
  model: string;
  turns: number;
  error?: string;
  timestamp: Date;
}

export class ClaudeAgentPanel extends Panel {
  private history: SessionEntry[] = [];
  private agentAbortController: AbortController | null = null;
  private inputEl: HTMLInputElement | null = null;
  private submitBtn: HTMLButtonElement | null = null;
  private progressEl: HTMLElement | null = null;

  constructor() {
    super({
      id: 'claude-agent',
      title: t('panels.claudeAgent'),
      showCount: false,
      trackActivity: true,
      infoTooltip:
        'Agentic intelligence analyst powered by Claude. Ask questions in natural language — ' +
        'Claude autonomously gathers live data (news, risk scores, markets, cyber threats) ' +
        'and synthesizes a structured intelligence brief.',
    });

    this.buildUI();
  }

  /** Build the static chrome (input form + presets) once */
  private buildUI(): void {
    if (!isFeatureAvailable('aiClaude')) {
      this.setContent(
        `<div class="agent-unavailable">
          <p>Claude AI is not configured.</p>
          <p>Set <code>ANTHROPIC_API_KEY</code> in Settings to enable the Intelligence Agent.</p>
        </div>`,
      );
      return;
    }

    // ── Progress / history container ──────────────────────────────────────────
    const historyEl = h('div', { className: 'agent-history' });

    // ── Preset queries ────────────────────────────────────────────────────────
    const presetEl = h('div', { className: 'agent-presets' },
      ...AGENT_PRESET_QUERIES.map(p =>
        h('button', {
          className: 'agent-preset-btn',
          title: p.query,
          onClick: () => this.submit(p.query),
        },
          h('span', { className: 'agent-preset-icon' }, p.icon),
          h('span', { className: 'agent-preset-label' }, p.label),
        ),
      ),
    );

    // ── Progress indicator (hidden until running) ─────────────────────────────
    this.progressEl = h('div', { className: 'agent-progress agent-progress--hidden' });

    // ── Input form ────────────────────────────────────────────────────────────
    this.inputEl = h('input', {
      type: 'text',
      className: 'agent-input',
      placeholder: 'Ask the intelligence analyst anything…',
      maxlength: '500',
    }) as HTMLInputElement;

    this.submitBtn = h('button', {
      className: 'agent-submit-btn',
      title: 'Run analysis',
      onClick: () => this.submit(this.inputEl?.value ?? ''),
    }, '▶') as HTMLButtonElement;

    const formEl = h('form', { className: 'agent-form',
      onSubmit: (e: Event) => { e.preventDefault(); this.submit(this.inputEl?.value ?? ''); },
    },
      this.inputEl,
      this.submitBtn,
    );

    // ── Assemble into panel content ───────────────────────────────────────────
    const wrapper = h('div', { className: 'agent-wrapper' },
      historyEl,
      this.progressEl,
      presetEl,
      formEl,
    );

    // Replace panel content with the wrapper element
    this.content.innerHTML = '';
    this.content.append(wrapper);

    // Store reference to history element for updates
    this.content.dataset.historyInit = 'true';
    (wrapper as HTMLElement & { _historyEl?: HTMLElement })._historyEl = historyEl;
  }

  /** Submit a query to the Claude agent */
  private async submit(rawQuery: string): Promise<void> {
    const query = rawQuery.trim().slice(0, 500);
    if (!query) return;

    if (this.agentAbortController) {
      this.agentAbortController.abort();
    }

    if (this.inputEl) this.inputEl.value = '';
    this.setLoading(true);
    this.showProgress([{ tool: 'initializing', input: {} }]);

    this.agentAbortController = new AbortController();

    try {
      const result = await runClaudeAgent(query, this.agentAbortController.signal);
      const entry: SessionEntry = {
        query,
        toolCalls: result.toolCalls,
        response: result.response,
        model: result.model,
        turns: result.turns,
        timestamp: new Date(),
      };
      this.history.unshift(entry);
      if (this.history.length > 5) this.history.pop();
      this.renderHistory();
    } catch (error: unknown) {
      if ((error as Error).name === 'AbortError') return;
      const entry: SessionEntry = {
        query,
        toolCalls: [],
        response: '',
        error: (error as Error).message || 'Agent request failed',
        model: '',
        turns: 0,
        timestamp: new Date(),
      };
      this.history.unshift(entry);
      if (this.history.length > 5) this.history.pop();
      this.renderHistory();
    } finally {
      this.setLoading(false);
      this.hideProgress();
    }
  }

  private setLoading(loading: boolean): void {
    if (this.submitBtn) {
      this.submitBtn.disabled = loading;
      this.submitBtn.textContent = loading ? '⏳' : '▶';
    }
    if (this.inputEl) this.inputEl.disabled = loading;
  }

  private showProgress(toolCalls: AgentToolCall[]): void {
    if (!this.progressEl) return;
    const label = toolCalls.length > 0
      ? toolLabel(toolCalls[toolCalls.length - 1]?.tool ?? 'unknown')
      : 'Initializing agent…';
    this.progressEl.textContent = label;
    this.progressEl.classList.remove('agent-progress--hidden');
  }

  private hideProgress(): void {
    if (!this.progressEl) return;
    this.progressEl.classList.add('agent-progress--hidden');
  }

  /** Render the session history list */
  private renderHistory(): void {
    const wrapper = this.content.querySelector('.agent-wrapper') as (HTMLElement & { _historyEl?: HTMLElement }) | null;
    const historyEl = wrapper?._historyEl;
    if (!historyEl) return;

    if (this.history.length === 0) {
      replaceChildren(historyEl);
      return;
    }

    // Use safeHtml to sanitize the rendered HTML before DOM insertion
    const html = this.history.map(entry => this.renderEntry(entry)).join('');
    replaceChildren(historyEl, safeHtml(html));
  }

  /** Render a single session entry to an HTML string */
  private renderEntry(entry: SessionEntry): string {
    const timeStr = entry.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const queryHtml = escapeHtml(entry.query);

    const toolsHtml = entry.toolCalls.length > 0
      ? `<div class="agent-tools">
          ${entry.toolCalls.map(tc => {
            const label = toolLabel(tc.tool);
            const inputStr = tc.input && Object.keys(tc.input).length > 0
              ? ` — ${escapeHtml(this.summarizeToolInput(tc.tool, tc.input))}`
              : '';
            return `<span class="agent-tool-badge">${escapeHtml(label)}${inputStr}</span>`;
          }).join('')}
        </div>`
      : '';

    if (entry.error) {
      return `<div class="agent-entry agent-entry--error">
        <div class="agent-query">${queryHtml}</div>
        <div class="agent-error">⚠ ${escapeHtml(entry.error)}</div>
        <div class="agent-meta">${timeStr}</div>
      </div>`;
    }

    const responseHtml = this.formatResponseText(entry.response);
    const metaHtml = entry.model
      ? `<div class="agent-meta">${escapeHtml(entry.model)} · ${entry.turns} turn${entry.turns === 1 ? '' : 's'} · ${timeStr}</div>`
      : `<div class="agent-meta">${timeStr}</div>`;

    return `<div class="agent-entry">
      <div class="agent-query">${queryHtml}</div>
      ${toolsHtml}
      <div class="agent-response">${responseHtml}</div>
      ${metaHtml}
    </div>`;
  }

  /** Convert ** bold ** and newlines to safe HTML */
  private formatResponseText(text: string): string {
    if (!text) return '';
    return escapeHtml(text)
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\n{2,}/g, '</p><p>')
      .replace(/\n/g, '<br>')
      .replace(/^/, '<p>')
      .replace(/$/, '</p>');
  }

  /** Produce a short human-readable summary of the tool's input */
  private summarizeToolInput(tool: string, input: Record<string, unknown>): string {
    if (tool === 'get_news_headlines' && typeof input.topic === 'string') {
      return input.topic.slice(0, 40);
    }
    if (tool === 'get_risk_scores' && Array.isArray(input.countries)) {
      return (input.countries as string[]).join(', ').slice(0, 30);
    }
    return '';
  }

  override destroy(): void {
    this.agentAbortController?.abort();
    super.destroy();
  }
}
