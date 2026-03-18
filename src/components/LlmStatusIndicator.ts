// Small header indicator showing LLM provider reachability.
// Polls /api/llm-health every 60s. Shows green dot when available, red when offline.

import { h } from '@/utils/dom-utils';

const POLL_INTERVAL_MS = 60_000;

interface LlmHealthResponse {
  available: boolean;
  providers: Array<{ name: string; url: string; available: boolean }>;
  checkedAt: number;
}

export class LlmStatusIndicator {
  private element: HTMLElement;
  private dot: HTMLElement;
  private label: HTMLElement;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.dot = h('span', {
      style: 'display:inline-block;width:6px;height:6px;border-radius:50%;background:#ff4444;margin-right:4px;',
    });
    this.label = h('span', {
      style: 'font-size:9px;letter-spacing:0.5px;opacity:0.7;',
    }, 'LLM');
    this.element = h('div', {
      className: 'llm-status-indicator',
      title: 'LLM provider status — checking...',
      style: 'display:flex;align-items:center;padding:0 6px;cursor:default;user-select:none;',
    }, this.dot, this.label);

    this.poll();
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
  }

  private async poll(): Promise<void> {
    try {
      const resp = await fetch('/api/llm-health', {
        signal: AbortSignal.timeout(5_000),
      });
      if (resp.status === 404) {
        // Endpoint only exists in sidecar/Docker — hide indicator on Vercel
        this.element.style.display = 'none';
        this.destroy();
        return;
      }
      if (!resp.ok) {
        this.setStatus(false, 'LLM', 'Health endpoint error');
        return;
      }
      const data: LlmHealthResponse = await resp.json();
      const active = data.providers.filter(p => p.available);
      // Show the active provider name in the label (first available wins the chain)
      const activeName = active.length > 0 ? active[0]!.name.toUpperCase() : '';
      const tooltipLines: string[] = [];
      for (const p of data.providers) {
        tooltipLines.push(`${p.available ? '●' : '○'} ${p.name} — ${p.available ? 'online' : 'offline'}`);
      }
      this.setStatus(
        data.available,
        activeName || 'LLM',
        data.available
          ? `LLM via ${activeName}\n${tooltipLines.join('\n')}`
          : `LLM offline — AI features unavailable\n${tooltipLines.join('\n')}`,
      );
    } catch {
      this.setStatus(false, 'LLM', 'LLM health check failed');
    }
  }

  private setStatus(available: boolean, labelText: string, tooltip: string): void {
    this.dot.style.background = available ? '#44ff88' : '#ff4444';
    this.label.textContent = labelText;
    this.element.title = tooltip;
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public destroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
