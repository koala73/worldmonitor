/**
 * Dashboard focus (#10453): a panel that does not filter by country says so
 * in its header while a focus is active, and says nothing otherwise.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Panel } from '@/components/Panel';
import { getPanelScopeBehaviour } from '@/config/panel-scope';
import { scopeNoticeFor } from '@/components/panel-scope-notice';
import type { ResolvedScope } from '@/services/tab-focus';

import { initTestI18n } from './helpers/i18n.mts';

beforeAll(async () => {
  await initTestI18n();
});

const SCOPE: ResolvedScope = {
  scope: { countries: ['TH'], neighbours: true },
  chosen: ['TH'],
  neighbours: ['KH', 'LA', 'MM', 'MY'],
};

class FilteringPanel extends Panel {
  received: Array<ResolvedScope | null> = [];
  override applyScope(scope: ResolvedScope | null): void {
    this.received.push(scope);
  }
}

let panel: Panel;
const chip = () => panel.getElement().querySelector<HTMLElement>('.panel-header .panel-scope-chip');

beforeEach(() => {
  document.body.replaceChildren();
});

afterEach(() => {
  panel?.destroy();
  document.body.replaceChildren();
});

describe('Panel scope notice', () => {
  it('a global panel shows "Not filtered" only while a focus is active', () => {
    panel = new Panel({ id: 'markets', title: 'Markets' });
    document.body.appendChild(panel.getElement());
    const behaviour = getPanelScopeBehaviour('markets');
    expect(behaviour).toBe('global');

    panel.setScopeNotice(scopeNoticeFor(behaviour, panel, null));
    expect(chip()).toBeNull();

    panel.setScopeNotice(scopeNoticeFor(behaviour, panel, SCOPE));
    expect(chip()?.textContent).toBe('Not filtered');
    expect(chip()?.title).toBe('Global data: not filtered by country');
    expect(chip()?.dataset.scopeNotice).toBe('global');

    panel.setScopeNotice(scopeNoticeFor(behaviour, panel, null));
    expect(chip()).toBeNull();
  });

  it('an unsupported panel says it is not filtered yet', () => {
    panel = new Panel({ id: 'cii', title: 'Country Instability' });
    panel.setScopeNotice(scopeNoticeFor(getPanelScopeBehaviour('cii'), panel, SCOPE));
    expect(chip()?.textContent).toBe('Not filtered');
    expect(chip()?.title).toBe('Not filtered by country yet');
    expect(chip()?.getAttribute('aria-label')).toContain('Not filtered by country yet');
  });

  it('repeated calls keep a single chip', () => {
    panel = new Panel({ id: 'markets', title: 'Markets' });
    panel.setScopeNotice('global');
    panel.setScopeNotice('unsupported');
    expect(panel.getElement().querySelectorAll('.panel-scope-chip')).toHaveLength(1);
    expect(chip()?.dataset.scopeNotice).toBe('unsupported');
  });

  it('a panel declared as filtering but without applyScope is still labelled', () => {
    panel = new Panel({ id: 'politics', title: 'World News' });
    expect(scopeNoticeFor('filters', panel, SCOPE)).toBe('unsupported');
  });

  it('a panel that implements applyScope and filters shows no chip', () => {
    const filtering = new FilteringPanel({ id: 'politics', title: 'World News' });
    panel = filtering;
    expect(scopeNoticeFor('filters', filtering, SCOPE)).toBeNull();
    filtering.applyScope(SCOPE);
    expect(filtering.received).toEqual([SCOPE]);
    expect(chip()).toBeNull();
  });

  it('the base applyScope is a no-op', () => {
    panel = new Panel({ id: 'markets', title: 'Markets' });
    const before = panel.getElement().outerHTML;
    panel.applyScope(SCOPE);
    expect(panel.getElement().outerHTML).toBe(before);
  });
});
