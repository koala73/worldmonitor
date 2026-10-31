import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { Panel } from '@/components/Panel';
import { unsafeRawHtml } from '@/utils/sanitize';
import {
  clearPanelColSpans,
  clearPanelSpans,
  loadPanelSpans,
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

  it('synchronizes natural video panel spans after mounting and viewport resize (#8276)', () => {
    for (const id of ['live-news', 'live-webcams']) {
      const panel = new Panel({
        id,
        title: id,
        className: 'panel-wide',
      });

      const element = panel.getElement();
      const handle = element.querySelector('.panel-resize-handle');

      // Before mounting, the wide-panel fallback is two rows.
      expect(handle?.getAttribute('aria-valuenow')).toBe('2');

      // Simulate the natural three-row CSS footprint.
      element.style.gridRowStart = 'span 3';

      document.body.appendChild(element);
      panel.notifyConnected();

      expect(getComputedStyle(element).gridRowStart).toBe('span 3');
      expect(handle?.getAttribute('aria-valuenow')).toBe('3');

      // Simulate the compact viewport layout.
      element.style.gridRowStart = 'span 2';
      window.dispatchEvent(new Event('resize'));

      expect(handle?.getAttribute('aria-valuenow')).toBe('2');

      // Return to the regular desktop layout.
      element.style.gridRowStart = 'span 3';
      window.dispatchEvent(new Event('resize'));

      expect(handle?.getAttribute('aria-valuenow')).toBe('3');

      panel.destroy();
      element.remove();
    }
  });

  it.each(['mouse', 'touch'] as const)('keeps a natural span responsive after a no-op %s gesture', (input) => {
    const panel = new Panel({ id: 'live-news', title: 'News', className: 'panel-wide' });
    const element = panel.getElement();
    element.style.gridRowStart = 'span 3';
    document.body.appendChild(element);
    panel.notifyConnected();
    const handle = element.querySelector<HTMLElement>('.panel-resize-handle')!;
    const touch = (type: string, y: number) => new TouchEvent(type, {
      bubbles: true,
      cancelable: true,
      touches: type === 'touchend' ? [] : [{ clientY: y } as Touch],
    });
    const start = () => handle.dispatchEvent(input === 'mouse'
      ? new MouseEvent('mousedown', { clientY: 300, bubbles: true })
      : touch('touchstart', 300));
    const move = (y: number) => document.dispatchEvent(input === 'mouse'
      ? new MouseEvent('mousemove', { clientY: y, bubbles: true })
      : touch('touchmove', y));
    const end = () => document.dispatchEvent(input === 'mouse'
      ? new MouseEvent('mouseup', { bubbles: true })
      : touch('touchend', 300));

    try {
      for (const deltas of [[], [5], [80, 0]]) {
        start();
        for (const delta of deltas) move(300 + delta);
        end();
        expect(loadPanelSpans()['live-news']).toBeUndefined();
        expect(element.classList.contains('resized')).toBe(false);
        expect(element.classList.contains('span-3')).toBe(false);
      }

      element.style.gridRowStart = 'span 2';
      window.dispatchEvent(new Event('resize'));
      expect(handle.getAttribute('aria-valuenow')).toBe('2');

      start();
      move(380);
      end();
      expect(loadPanelSpans()['live-news']).toBe(3);
      expect(element.classList.contains('resized')).toBe(true);
      expect(element.classList.contains('span-3')).toBe(true);

      start();
      move(380);
      move(300);
      end();
      expect(loadPanelSpans()['live-news']).toBe(3);
      expect(element.classList.contains('resized')).toBe(true);
      expect(element.classList.contains('span-3')).toBe(true);
    } finally {
      panel.destroy();
    }
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
