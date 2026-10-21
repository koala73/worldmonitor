import { afterEach, describe, expect, it, vi } from 'vitest';

import { GlobeMap } from '@/components/GlobeMap';

type GlobePrivateMethods = {
  handleMarkerClick: (marker: unknown, anchor: HTMLElement) => void;
  showMarkerTooltip: (marker: unknown, anchor: HTMLElement) => void;
  setProtests: (events: unknown[]) => void;
};

type TooltipHost = {
  container: HTMLElement;
  popup: null;
  tooltipEl: HTMLElement | null;
  tooltipHideTimer: ReturnType<typeof setTimeout> | null;
  hideTooltip: () => void;
};

const globeMethods = GlobeMap.prototype as unknown as GlobePrivateMethods;

function protestMarker(title: string, sourceUrls?: string[]) {
  return {
    _kind: 'protest',
    _lat: 48.8566,
    _lng: 2.3522,
    id: title,
    title,
    eventType: 'protest',
    country: 'France',
    sourceUrls,
  };
}

function tooltipHost(container: HTMLElement): TooltipHost {
  const host: TooltipHost = {
    container,
    popup: null,
    tooltipEl: null,
    tooltipHideTimer: null,
    hideTooltip: () => {
      if (host.tooltipHideTimer) clearTimeout(host.tooltipHideTimer);
      host.tooltipHideTimer = null;
      host.tooltipEl?.remove();
      host.tooltipEl = null;
    },
  };
  return host;
}

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('Globe protest source links', () => {
  it('preserves source URLs when projecting unrest events into Globe markers', () => {
    const sourceUrls = ['https://gdelt.example/story?q=protest'];
    const host = {
      protestMarkers: [] as unknown[],
      flushMarkers: vi.fn(),
    };

    Reflect.apply(globeMethods.setProtests, host, [[{
      id: 'gdelt-protest',
      title: 'GDELT protest',
      eventType: 'protest',
      country: 'France',
      lat: 48.8566,
      lon: 2.3522,
      sourceUrls,
    }]]);

    expect(host.protestMarkers).toEqual([expect.objectContaining({ sourceUrls })]);
    expect(host.flushMarkers).toHaveBeenCalledOnce();
  });

  it('keeps GDELT and ACLED links clickable after a protest-marker click', () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    const anchor = document.createElement('button');
    container.appendChild(anchor);
    document.body.appendChild(container);

    const marker = protestMarker('GDELT protest', ['https://gdelt.example/story?q=protest']);
    const showTooltip = vi.fn();
    Reflect.apply(globeMethods.handleMarkerClick, { showMarkerTooltip: showTooltip }, [marker, anchor]);
    expect(showTooltip).toHaveBeenCalledWith(marker, anchor);

    const host = tooltipHost(container);
    Reflect.apply(globeMethods.showMarkerTooltip, host, [marker, anchor]);

    let link = host.tooltipEl?.querySelector<HTMLAnchorElement>('.popup-source-links a');
    expect(link).toBeInstanceOf(HTMLAnchorElement);
    expect(link?.href).toBe('https://gdelt.example/story?q=protest');
    expect(link?.target).toBe('_blank');
    expect(link?.rel.split(' ')).toEqual(expect.arrayContaining(['noopener', 'noreferrer']));

    const onLinkClick = vi.fn((event: MouseEvent) => event.preventDefault());
    link?.addEventListener('click', onLinkClick);
    link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(onLinkClick).toHaveBeenCalledOnce();
    expect(host.tooltipEl).toContain(link);

    host.tooltipEl?.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(3_501);
    expect(link?.isConnected).toBe(true);

    Reflect.apply(globeMethods.showMarkerTooltip, host, [
      protestMarker('ACLED protest', ['https://acled.example/event/123']),
      anchor,
    ]);
    link = host.tooltipEl?.querySelector<HTMLAnchorElement>('.popup-source-links a');
    expect(link).toBeInstanceOf(HTMLAnchorElement);
    expect(link?.href).toBe('https://acled.example/event/123');

    host.tooltipEl?.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(3_501);
    expect(link?.isConnected).toBe(true);

    host.tooltipEl?.dispatchEvent(new MouseEvent('mouseleave'));
    vi.advanceTimersByTime(2_000);
    expect(link?.isConnected).toBe(false);
  });

  it('leaves the protest tooltip intact without a usable source URL', () => {
    const container = document.createElement('div');
    const anchor = document.createElement('button');
    container.appendChild(anchor);
    document.body.appendChild(container);

    const host = tooltipHost(container);
    Reflect.apply(globeMethods.showMarkerTooltip, host, [protestMarker('No source'), anchor]);
    expect(host.tooltipEl?.textContent).toContain('No source');
    expect(host.tooltipEl?.querySelector('.popup-source-links')).toBeNull();

    Reflect.apply(globeMethods.showMarkerTooltip, host, [
      protestMarker('Unsafe source', ['javascript:alert(1)', 'data:text/html,unsafe']),
      anchor,
    ]);
    expect(host.tooltipEl?.textContent).toContain('Unsafe source');
    expect(host.tooltipEl?.querySelector('.popup-source-links')).toBeNull();
  });
});
