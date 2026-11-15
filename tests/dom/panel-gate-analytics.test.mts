import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Panel } from '@/components/Panel';
import { PanelGateReason } from '@/services/panel-gating';
import * as analytics from '@/services/analytics';

class VisibilityObserver {
  static instances: VisibilityObserver[] = [];
  target?: Element;
  disconnect = vi.fn();
  constructor(readonly callback: IntersectionObserverCallback) { VisibilityObserver.instances.push(this); }
  observe(target: Element) { this.target = target; }
  emit(visible: boolean) {
    this.callback([{ target: this.target!, isIntersecting: visible, intersectionRatio: visible ? 1 : 0 } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}
const panels: Panel[] = [];
let nextId = 0;
function mount(id = `gate-test-${nextId++}`) {
  const panel = new Panel({ id, title: 'Locked panel' });
  panels.push(panel);
  document.body.append(panel.getElement());
  return panel;
}
function observer(panel: Panel) {
  return VisibilityObserver.instances.findLast(item => item.target === panel.getElement())!;
}
beforeEach(() => {
  VisibilityObserver.instances = [];
  vi.stubGlobal('IntersectionObserver', VisibilityObserver);
});
afterEach(() => {
  panels.splice(0).forEach(panel => panel.destroy());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('locked panel analytics', () => {
  it.each([PanelGateReason.ANONYMOUS, PanelGateReason.FREE_TIER])('counts %s only on first viewport entry, across rerenders and remounts', reason => {
    const hit = vi.spyOn(analytics, 'trackGateHit');
    const panel = mount();
    const id = panel.getElement().dataset.panel!;
    panel.showGatedCta(reason, () => {});
    expect(hit).not.toHaveBeenCalled();
    const visibility = observer(panel);
    expect(visibility).toBeDefined();
    visibility.emit(false);
    panel.showGatedCta(reason, () => {});
    expect(observer(panel)).toBe(visibility);
    expect(hit).not.toHaveBeenCalled();
    visibility.emit(true);
    visibility.emit(true);
    expect(hit).toHaveBeenCalledExactlyOnceWith(`panel:${id}`);
    expect(visibility.disconnect).toHaveBeenCalled();
    panel.unlockPanel();
    panel.showGatedCta(reason, () => {});
    panel.destroy();
    const remounted = mount(id);
    remounted.showGatedCta(reason, () => {});
    observer(remounted)?.emit(true);
    expect(hit).toHaveBeenCalledTimes(1);
  });

  it.each([PanelGateReason.ANONYMOUS, PanelGateReason.FREE_TIER])('reports one click with panel and %s reason and runs the action', reason => {
    const click = vi.spyOn(analytics, 'trackPanelGateClick');
    const action = vi.fn();
    const panel = mount();
    panel.showGatedCta(reason, action);
    panel.showGatedCta(reason, action);
    panel.getElement().querySelector<HTMLButtonElement>('.panel-locked-cta')!.click();
    expect(click).toHaveBeenCalledExactlyOnceWith(panel.getElement().dataset.panel, reason);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it.each([PanelGateReason.PAYMENT_ON_HOLD, PanelGateReason.RENEWAL_PENDING, PanelGateReason.RENEWAL_FAILED, PanelGateReason.LAPSED])('never counts billing reason %s, including a queued prior view', reason => {
    const hit = vi.spyOn(analytics, 'trackGateHit');
    const click = vi.spyOn(analytics, 'trackPanelGateClick');
    const panel = mount();
    panel.showGatedCta(PanelGateReason.FREE_TIER, () => {});
    const pending = observer(panel);
    panel.showGatedCta(reason, () => {});
    pending.emit(true);
    panel.getElement().querySelector<HTMLButtonElement>('.panel-locked-cta')!.click();
    expect(hit).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    expect(pending.disconnect).toHaveBeenCalled();
    panel.showGatedCta(PanelGateReason.FREE_TIER, () => {});
    observer(panel).emit(true);
    expect(hit).toHaveBeenCalledTimes(1);
  });

  it.each(['unlock', 'destroy', 'desktop'] as const)('cancels pending views on %s', transition => {
    const hit = vi.spyOn(analytics, 'trackGateHit');
    const panel = mount();
    panel.showGatedCta(PanelGateReason.ANONYMOUS, () => {});
    const pending = observer(panel);
    if (transition === 'unlock') panel.unlockPanel();
    else if (transition === 'destroy') panel.destroy();
    else panel.showLocked();
    pending.emit(true);
    expect(hit).not.toHaveBeenCalled();
    expect(pending.disconnect).toHaveBeenCalled();
  });
});
