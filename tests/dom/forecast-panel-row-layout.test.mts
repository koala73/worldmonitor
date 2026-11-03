/**
 * #8984 — forecast rows lay out from the table's own width.
 *
 * The four-column row (`1fr 80px 100px 60px`) needs about 270px beside the
 * title, and the default desktop layout puts the panel in a 214px column, so
 * the title collapsed to 0px. A container query on the table stacks the row
 * below 440px of table width. jsdom has no layout; the widths themselves are
 * measured in a browser by .claude/verify-steps/forecast-row-8984.mjs.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { ForecastPanel } from '@/components/ForecastPanel';

import { initTestI18n } from './helpers/i18n.mts';

let panel: ForecastPanel | null = null;

beforeAll(async () => {
  await initTestI18n();
  panel = new ForecastPanel();
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

afterAll(() => {
  panel?.destroy();
});

function css(): string {
  return Array.from(document.head.querySelectorAll('style')).map((el) => el.textContent ?? '').join('\n');
}

function containerBlock(query: string): string {
  const text = css();
  const start = text.indexOf(`@container ${query}`);
  if (start < 0) return '';
  const open = text.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    if (text[i] === '}') depth -= 1;
    if (depth === 0) return text.slice(open + 1, i);
  }
  return '';
}

describe('ForecastPanel row layout', () => {
  it('constructs the panel that injects the styles', () => {
    expect(panel).not.toBeNull();
  });

  it('makes the probability table a named inline-size container that still fills its parent', () => {
    const rule = css().match(/\.fc-prob-table\s*\{[^}]*container:[^}]*\}/)?.[0] ?? '';
    expect(rule).toMatch(/container:\s*fc-table\s*\/\s*inline-size/);
    // Inline-size containment gives a zero intrinsic width; a shrink-to-fit table would collapse to 0px (#8955).
    expect(css()).not.toMatch(/\.fc-prob-table\s*\{[^}]*(fit-content|inline-block|inline-flex|float)/);
  });

  it('keeps the four-column row at and above the threshold', () => {
    expect(css()).toMatch(/\.fc-prob-row\s*\{[^}]*grid-template-columns:\s*1fr 80px 100px 60px/);
    expect(css()).toMatch(/\.fc-prob-label\s*\{[^}]*min-width:\s*0/);
  });

  it('stacks the title block above the data below 440px of table width', () => {
    const narrow = containerBlock('fc-table (max-width: 439px)');
    expect(narrow, 'narrow @container rule').not.toBe('');
    expect(narrow).toMatch(/\.fc-prob-row\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap/);
    expect(narrow).toMatch(/\.fc-prob-label\s*\{[^}]*flex:\s*1 0 100%/);
    expect(narrow).toMatch(/\.fc-bar-wrap\s*\{[^}]*min-width:\s*0/);
    expect(narrow).toMatch(/\.fc-domain-tag\s*\{[^}]*max-width:\s*100%/);
    expect(narrow).toMatch(/\.fc-prob-hdr span:not\(:first-child\)\s*\{[^}]*display:\s*none/);
  });

  it('keeps the existing card-meta queries on the label container', () => {
    expect(containerBlock('(max-width: 159px)')).toMatch(/\.fc-card-meta/);
    expect(containerBlock('(max-width: 109px)')).toMatch(/\.fc-res-slot/);
  });

  it('renders rows whose structure the narrow layout depends on', async () => {
    const el = (panel as unknown as { element: HTMLElement }).element;
    document.body.appendChild(el);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 503 }));
    panel!.updateForecasts([{ id: 'fc-1', title: 'Forecast one', domain: 'conflict', probability: 0.4, trend: 'stable', signals: [] } as never]);
    const row = await vi.waitFor(() => {
      const found = el.querySelector('.fc-prob-table .fc-prob-item > .fc-prob-row');
      expect(found).not.toBeNull();
      return found;
    });
    expect(Array.from(row!.children).map((c) => c.className)).toEqual(['fc-prob-label', 'fc-bar-wrap', 'fc-trend-text', 'fc-domain-tag']);
  });
});
