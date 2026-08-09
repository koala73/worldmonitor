import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EventHandlerManager } from '@/app/event-handlers';

describe('map fullscreen resize synchronization', () => {
  let resize: ReturnType<typeof vi.fn>;
  let manager: EventHandlerManager;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    document.body.replaceChildren();
    resize = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    manager = new EventHandlerManager({
      container,
      isDesktopApp: false,
      panels: {},
      panelSettings: {},
      mapLayers: {},
      map: { resize, setIsResizing: vi.fn() },
    } as never, {} as never);
  });

  afterEach(() => {
    manager.destroy();
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  function expectImmediateAndSettledResize(action: () => void): void {
    action();
    expect(resize).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(320);
    expect(resize).toHaveBeenCalledTimes(2);
  }

  it('resizes after browser fullscreen changes', () => {
    const button = document.createElement('button');
    button.id = 'fullscreenBtn';
    document.body.append(button);
    manager.init();

    expectImmediateAndSettledResize(() => document.dispatchEvent(new Event('fullscreenchange')));
  });

  it('resizes after map-panel fullscreen toggles', () => {
    const section = document.createElement('section');
    section.id = 'mapSection';
    const pinButton = document.createElement('button');
    pinButton.id = 'mapPinBtn';
    const fullscreenButton = document.createElement('button');
    fullscreenButton.id = 'mapFullscreenBtn';
    document.body.append(section, pinButton, fullscreenButton);
    manager.setupMapPin();

    expectImmediateAndSettledResize(() => fullscreenButton.click());
  });
});
