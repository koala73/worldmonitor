import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindMapControlDisclosure } from '@/components/map-control-disclosure';

let resize: () => void;
let width = 562;
let height = 600;
const disconnect = vi.fn();
class Observer {
  constructor(callback: () => void) { resize = callback; }
  observe() {}
  disconnect = disconnect;
}
function mount(kind: 'layers' | 'legend' = 'layers') {
  vi.stubGlobal('ResizeObserver', Observer);
  const container = document.createElement('div');
  Object.defineProperty(container, 'clientWidth', { get: () => width });
  Object.defineProperty(container, 'clientHeight', { get: () => height });
  const panel = document.createElement('div');
  panel.innerHTML = '<div class="content">Controls</div>';
  container.append(panel);
  document.body.append(container);
  const cleanup = bindMapControlDisclosure(container, panel, kind, kind);
  return { panel, button: panel.querySelector('button')!, cleanup };
}
afterEach(() => { localStorage.clear(); document.body.innerHTML = ''; width = 562; height = 600; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('map control disclosure', () => {
  it('uses the map width and follows resize until the visitor chooses', () => {
    const { panel, button, cleanup } = mount();
    expect(panel.classList.contains('map-control-collapsed')).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    width = 700; resize();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    button.click();
    width = 900; resize();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    cleanup();
    expect(disconnect).toHaveBeenCalled();
  });
  it('retains separate choices across remounts and viewport changes', () => {
    const layers = mount();
    layers.button.click();
    layers.cleanup();
    expect(mount().button.getAttribute('aria-expanded')).toBe('true');
    expect(mount('legend').button.getAttribute('aria-expanded')).toBe('false');
  });
  it('collapses short stacked maps until the visitor chooses', () => {
    width = 938;
    height = 307;
    const { panel, button } = mount();
    expect(panel.classList.contains('map-control-compact')).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    height = 400; resize();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    height = 307; resize();
    button.click();
    height = 300; resize();
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });
  it('waits for a hidden map to acquire a width', () => {
    width = 0;
    const { button } = mount();
    width = 900; resize();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    width = 562; resize();
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });
  it('remains usable when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    const { button } = mount();
    button.click();
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });
  it('reuses the WebGL/globe button and leaves dynamic legend visibility intact', () => {
    vi.stubGlobal('ResizeObserver', Observer);
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { value: 562 });
    const panel = document.createElement('div');
    panel.innerHTML = '<div class="toggle-header"><span>Layers</span><button class="toggle-collapse">▼</button></div><input class="layer-search"><div class="toggle-list"></div>';
    const button = panel.querySelector('button')!;
    const cleanup = bindMapControlDisclosure(container, panel, 'layers', 'Layers');
    expect(panel.querySelectorAll('button')).toHaveLength(1);
    expect(button.textContent).toBe('Layers');
    button.click();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    cleanup();
    button.click();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const legend = document.createElement('div');
    legend.hidden = true;
    bindMapControlDisclosure(container, legend, 'legend', 'Legend');
    expect(legend.hidden).toBe(true);
    legend.hidden = false;
    resize();
    expect(legend.hidden).toBe(false);
  });
});
