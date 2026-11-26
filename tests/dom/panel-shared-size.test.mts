import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Panel } from '@/components/Panel';

import { initTestI18n } from './helpers/i18n.mts';

beforeAll(async () => {
  await initTestI18n();
});

let panel: Panel;

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  panel.destroy();
  document.body.replaceChildren();
});

const spans = () => JSON.parse(localStorage.getItem('worldmonitor-panel-spans') ?? '{}') as Record<string, number>;

describe('Panel.applySharedSize', () => {
  it('a shared layout with no row size keeps the panel at its built-in height', () => {
    panel = new Panel({ id: 'shared-size-tall', title: 'Tall', defaultRowSpan: 2 });
    panel.applySharedSize(4, undefined);
    expect(panel.getElement().classList.contains('span-4')).toBe(true);

    panel.applySharedSize(undefined, undefined);

    expect(panel.getElement().classList.contains('span-2')).toBe(true);
    expect(panel.getElement().classList.contains('span-4')).toBe(false);
    expect(spans()['shared-size-tall']).toBeUndefined();
  });

  it('a panel without a built-in height goes back to one row', () => {
    panel = new Panel({ id: 'shared-size-plain', title: 'Plain' });
    panel.applySharedSize(3, undefined);

    panel.applySharedSize(undefined, undefined);

    expect(['span-1', 'span-2', 'span-3', 'span-4'].some((c) => panel.getElement().classList.contains(c))).toBe(false);
    expect(spans()['shared-size-plain']).toBeUndefined();
  });

  it('a shared row size is saved and shown', () => {
    panel = new Panel({ id: 'shared-size-set', title: 'Set', defaultRowSpan: 2 });
    panel.applySharedSize(3, undefined);
    expect(panel.getElement().classList.contains('span-3')).toBe(true);
    expect(spans()['shared-size-set']).toBe(3);
  });
});
