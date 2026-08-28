import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { Panel } from '@/components/Panel';
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
