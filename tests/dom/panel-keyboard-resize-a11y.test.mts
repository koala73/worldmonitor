import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { Panel } from '@/components/Panel';
import { unsafeRawHtml } from '@/utils/sanitize';
import {
  clearPanelColSpans,
  clearPanelSpans,
  savePanelColSpan,
  savePanelSpan,
} from '@/utils/panel-storage';

import { initTestI18n } from './helpers/i18n.mts';

beforeAll(async () => {
  await initTestI18n();
});

afterEach(() => {
  clearPanelSpans();
  clearPanelColSpans();
  document.body.replaceChildren();
});

describe('Panel heading outline', () => {
  it('exposes the panel title as a level-2 heading', () => {
    const panel = new Panel({ id: 'heading-outline-probe', title: 'Probe' });
    const title = panel.getElement().querySelector('.panel-title');

    expect(title?.id).toBe('heading-outline-probeTitle');
    expect(title?.getAttribute('role')).toBe('heading');
    expect(title?.getAttribute('aria-level')).toBe('2');
    expect(title?.textContent).toBe('Probe');

    panel.destroy();
  });
});

describe('Panel keyboard resize accessibility', () => {
  it('exposes restored row and column spans as the initial separator values', () => {
    savePanelSpan('resize-a11y-probe', 3);
    savePanelColSpan('resize-a11y-probe', 2);

    const panel = new Panel({ id: 'resize-a11y-probe', title: 'Probe' });
    const element = panel.getElement();
    const rowHandle = element.querySelector('.panel-resize-handle');
    const colHandle = element.querySelector('.panel-col-resize-handle');

    expect(rowHandle?.getAttribute('aria-valuenow')).toBe('3');
    expect(colHandle?.getAttribute('aria-valuenow')).toBe('2');

    panel.destroy();
  });

  it('updates separator values when saved dimensions are reset', () => {
    savePanelSpan('resize-reset-probe', 4);
    savePanelColSpan('resize-reset-probe', 3);

    const panel = new Panel({ id: 'resize-reset-probe', title: 'Probe' });
    const element = panel.getElement();
    const rowHandle = element.querySelector('.panel-resize-handle');
    const colHandle = element.querySelector('.panel-col-resize-handle');

    panel.resetHeight();
    panel.resetWidth();

    expect(rowHandle?.getAttribute('aria-valuenow')).toBe('1');
    expect(colHandle?.getAttribute('aria-valuenow')).toBe('1');

    panel.destroy();
  });
});

describe('Panel scrollable content keyboard access (#8460)', () => {
  it('makes the overflow-y:auto content region a tab stop', () => {
    const panel = new Panel({ id: 'insights', title: 'Insights' });
    const content = panel.getElement().querySelector('#insightsContent');

    expect(content).toBeInstanceOf(HTMLElement);
    expect((content as HTMLElement).tabIndex).toBe(0);

    panel.destroy();
  });

  it('names the content tab stop from the panel title without a region landmark', () => {
    const panel = new Panel({ id: 'insights', title: 'Insights' });
    const title = panel.getElement().querySelector('.panel-title');
    const content = panel.getElement().querySelector('#insightsContent');

    expect(title?.id).toBe('insightsTitle');
    expect(content?.getAttribute('aria-labelledby')).toBe('insightsTitle');
    expect(content?.getAttribute('role')).toBeNull();

    panel.destroy();
  });

  it('applies the same tab stop to every panel content id, not only insights', () => {
    const panel = new Panel({ id: 'markets', title: 'Markets' });
    const content = panel.getElement().querySelector('#marketsContent');

    expect(content).toBeInstanceOf(HTMLElement);
    expect((content as HTMLElement).tabIndex).toBe(0);
    expect(content?.getAttribute('aria-labelledby')).toBe('marketsTitle');

    panel.destroy();
  });

  it('keeps the content region focusable after a content write', () => {
    const panel = new Panel({ id: 'insights', title: 'Insights' });
    panel.setSafeContentImmediate(
      unsafeRawHtml('<p class="brief-para">brief that may wrap</p>', 'test fixture'),
    );
    const content = panel.getElement().querySelector('#insightsContent');

    expect(content).toBeInstanceOf(HTMLElement);
    expect((content as HTMLElement).tabIndex).toBe(0);
    expect(content?.getAttribute('aria-labelledby')).toBe('insightsTitle');
    expect(content?.querySelector('.brief-para')?.textContent).toBe('brief that may wrap');

    panel.destroy();
  });
});
