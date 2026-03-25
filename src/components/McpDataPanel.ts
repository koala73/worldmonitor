import { Panel } from './Panel';
import type { McpPanelSpec } from '@/services/mcp-store';
import { t } from '@/services/i18n';
import { h } from '@/utils/dom-utils';
import { proxyUrl, widgetAgentUrl } from '@/utils/proxy';
import { escapeHtml } from '@/utils/sanitize';
import { isProWidgetEnabled, getWidgetAgentKey, getProWidgetKey } from '@/services/widget-store';
import { wrapProWidgetHtml } from '@/utils/widget-sanitizer';

type McpResult = {
  content?: Array<{ type: string; text?: string }>;
  [key: string]: unknown;
};

export class McpDataPanel extends Panel {
  private spec: McpPanelSpec;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFetchedAt: number | null = null;
  private lastJsonHash: string | null = null;
  private cachedWidgetHtml: string | null = null;
  private visualizing = false;
  private pendingHash: string | null = null;
  private destroyController = new AbortController();

  constructor(spec: McpPanelSpec) {
    super({
      id: spec.id,
      title: spec.title,
      closable: true,
      className: 'mcp-data-panel',
    });
    this.spec = spec;
    this.addHeaderButtons();
    this.scheduleRefresh(true);
  }

  private addHeaderButtons(): void {
    const closeBtn = this.header.querySelector('.panel-close-btn');

    const refreshBtn = h('button', {
      className: 'icon-btn mcp-refresh-btn widget-header-btn',
      title: t('mcp.refreshNow'),
      'aria-label': t('mcp.refreshNow'),
    }, '\u21bb');
    refreshBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.fetchData();
    });

    const configBtn = h('button', {
      className: 'icon-btn mcp-config-btn widget-header-btn',
      title: t('mcp.configure'),
      'aria-label': t('mcp.configure'),
    }, '\u2699');
    configBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.element.dispatchEvent(new CustomEvent('wm:mcp-configure', {
        bubbles: true,
        detail: { panelId: this.spec.id },
      }));
    });

    if (closeBtn) {
      this.header.insertBefore(refreshBtn, closeBtn);
      this.header.insertBefore(configBtn, refreshBtn);
    } else {
      this.header.appendChild(configBtn);
      this.header.appendChild(refreshBtn);
    }
  }

  private scheduleRefresh(immediate = false): void {
    this.clearRefreshTimer();
    if (immediate) {
      void this.fetchData();
    }
    this.refreshTimer = setTimeout(() => {
      void this.fetchData().finally(() => this.scheduleRefresh());
    }, this.spec.refreshIntervalMs);
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  async fetchData(): Promise<void> {
    this.showLoading();
    try {
      const resp = await fetch(proxyUrl('/api/mcp-proxy'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverUrl: this.spec.serverUrl,
          toolName: this.spec.toolName,
          toolArgs: this.spec.toolArgs,
          customHeaders: this.spec.customHeaders,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      const data = await resp.json() as { result?: McpResult; error?: string };
      if (!resp.ok || data.error) throw new Error(data.error || `HTTP ${resp.status}`);
      this.lastFetchedAt = Date.now();
      this.renderResult(data.result ?? {});
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.showError(msg);
    }
  }

  private renderResult(result: McpResult): void {
    const jsonData = this.extractJsonData(result);

    if (jsonData !== null && isProWidgetEnabled()) {
      const hash = JSON.stringify(jsonData).slice(0, 8192);
      if (hash === this.lastJsonHash && this.cachedWidgetHtml) {
        this.setContent(`
          <div class="mcp-panel-meta">${this.buildMetaLine()}</div>
          <div class="mcp-panel-content mcp-panel-widget">${wrapProWidgetHtml(this.cachedWidgetHtml)}</div>
        `);
        return;
      }
      this.lastJsonHash = hash;
      this.cachedWidgetHtml = null;
      void this.autoVisualize(jsonData, hash);
      return;
    }

    const meta = this.buildMetaLine();
    const content = this.extractText(result);
    this.setContent(`
      <div class="mcp-panel-meta">${meta}</div>
      <div class="mcp-panel-content">${content}</div>
    `);
  }

  private extractJsonData(result: McpResult): unknown | null {
    if (Array.isArray(result.content)) {
      for (const c of result.content as Array<{ type: string; text?: string }>) {
        if (c.type === 'text' && c.text) {
          const trimmed = c.text.trim();
          if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try { return JSON.parse(trimmed); } catch { /* not JSON */ }
          }
        }
      }
    }
    // Only use result directly when content wrapper is absent
    if (!Array.isArray(result.content) && Object.keys(result).length > 0) {
      return result;
    }
    return null;
  }

  private async autoVisualize(jsonData: unknown, startHash: string): Promise<void> {
    if (this.visualizing) return;
    this.visualizing = true;
    this.pendingHash = startHash;

    this.setContent(`
      <div class="mcp-panel-meta">${this.buildMetaLine()}</div>
      <div class="mcp-panel-content mcp-panel-visualizing">
        <div class="panel-loading-radar"><span class="panel-radar-sweep"></span><span class="panel-radar-dot"></span></div>
        <span class="mcp-vis-label">${escapeHtml(t('mcp.generatingVisualization'))}</span>
      </div>
    `);

    const toolName = this.spec.toolName.slice(0, 100);
    const preview = JSON.stringify(jsonData, null, 2).slice(0, 3000);
    const prompt = `Create a compact, interactive data visualization widget for this ${toolName} data. Choose the best format (charts, tables, cards). Data:\n${preview}`;

    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), 120_000);

    try {
      const res = await fetch(widgetAgentUrl(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Widget-Key': getWidgetAgentKey(),
          'X-Pro-Key': getProWidgetKey(),
        },
        body: JSON.stringify({ prompt, mode: 'create', tier: 'pro' }),
        signal: this.destroyController.signal.aborted
          ? this.destroyController.signal
          : timeoutController.signal,
      });

      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let resultHtml = '';
      let rendered = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          let event: { type: string; [k: string]: unknown };
          try { event = JSON.parse(line.slice(6)); } catch { continue; }

          if (event.type === 'html_complete') {
            resultHtml = String(event.html ?? '');
          } else if (event.type === 'done') {
            // Only cache and render if data hasn't changed since we started
            if (this.pendingHash === this.lastJsonHash) {
              this.cachedWidgetHtml = resultHtml;
              this.setContent(`
                <div class="mcp-panel-meta">${this.buildMetaLine()}</div>
                <div class="mcp-panel-content mcp-panel-widget">${wrapProWidgetHtml(resultHtml)}</div>
              `);
              rendered = true;
            }
          } else if (event.type === 'error') {
            throw new Error(String(event.message ?? t('mcp.visualizationFailed')));
          }
        }
      }

      // Stream ended without 'done' — flush whatever html_complete gave us
      if (!rendered) {
        if (resultHtml && this.pendingHash === this.lastJsonHash) {
          this.cachedWidgetHtml = resultHtml;
          this.setContent(`
            <div class="mcp-panel-meta">${this.buildMetaLine()}</div>
            <div class="mcp-panel-content mcp-panel-widget">${wrapProWidgetHtml(resultHtml)}</div>
          `);
        } else if (!resultHtml) {
          this.cachedWidgetHtml = null;
          this.lastJsonHash = null;
          this.showError(t('mcp.visualizationFailed'));
        }
      }
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') return;
      this.cachedWidgetHtml = null;
      this.lastJsonHash = null;
      const msg = err instanceof Error ? err.message : t('mcp.visualizationFailed');
      this.showError(msg);
    } finally {
      clearTimeout(timeoutId);
      this.pendingHash = null;
      this.visualizing = false;
    }
  }

  private buildMetaLine(): string {
    const host = (() => {
      try { return new URL(this.spec.serverUrl).hostname.replace(/^www\./, ''); } catch { return ''; }
    })();
    const ago = this.lastFetchedAt ? this.formatAgo(this.lastFetchedAt) : '';
    return [
      `<span class="mcp-meta-tool">${escapeHtml(this.spec.toolName)}</span>`,
      host ? `<span class="mcp-meta-server">${escapeHtml(host)}</span>` : '',
      ago ? `<span class="mcp-meta-time">${escapeHtml(ago)}</span>` : '',
    ].filter(Boolean).join('<span class="mcp-meta-sep">\u00b7</span>');
  }

  private extractText(result: McpResult): string {
    if (Array.isArray(result.content)) {
      const parts = (result.content as Array<{ type: string; text?: string }>)
        .filter(c => c.type === 'text' && c.text)
        .map(c => `<div class="mcp-content-block">${this.formatValue(c.text!)}</div>`);
      if (parts.length) return parts.join('');
    }
    return `<pre class="mcp-content-json">${escapeHtml(JSON.stringify(result, null, 2))}</pre>`;
  }

  private formatValue(text: string): string {
    const trimmed = text.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        return `<pre class="mcp-content-json">${escapeHtml(JSON.stringify(parsed, null, 2))}</pre>`;
      } catch { /* fall through */ }
    }
    return `<p class="mcp-content-text">${escapeHtml(trimmed)}</p>`;
  }

  private formatAgo(ts: number): string {
    const diff = Date.now() - ts;
    if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    return `${Math.floor(diff / 3_600_000)}h ago`;
  }

  updateSpec(spec: McpPanelSpec): void {
    this.spec = spec;
    const titleEl = this.header.querySelector('.panel-title');
    if (titleEl) titleEl.textContent = spec.title;
    this.clearRefreshTimer();
    this.lastJsonHash = null;
    this.cachedWidgetHtml = null;
    this.scheduleRefresh(true);
  }

  getSpec(): McpPanelSpec {
    return this.spec;
  }

  destroy(): void {
    this.destroyController.abort();
    this.clearRefreshTimer();
    super.destroy();
  }
}
