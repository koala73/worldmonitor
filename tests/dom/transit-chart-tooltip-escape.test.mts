import { afterEach, describe, expect, it } from 'vitest';

import { TransitChart } from '@/utils/transit-chart';
import type { TransitDayCount } from '../../src/generated/client/worldmonitor/supply_chain/v1/service_client';

const HOSTILE = '<img src=x onerror="window.__pwned=1">';

function day(date: string): TransitDayCount {
  return {
    date,
    tanker: 1, cargo: 1, other: 0, total: 2,
    container: 1, dryBulk: 0, generalCargo: 0, roro: 0,
    capContainer: 0, capDryBulk: 0, capGeneralCargo: 0, capRoro: 0, capTanker: 0,
  } as TransitDayCount;
}

let chart: TransitChart | null = null;

afterEach(() => {
  chart?.destroy();
  chart = null;
  document.body.innerHTML = '';
});

describe('TransitChart tooltip escapes the seeded date', () => {
  it('renders a hostile date as text, not markup', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    chart = new TransitChart();
    chart.mount(container, [day(HOSTILE)]);

    const canvas = container.querySelector('canvas')!;
    canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 10, clientY: 10, bubbles: true }));

    const tooltip = (chart as unknown as { tooltip: HTMLDivElement }).tooltip;
    expect(tooltip.style.display).toBe('block');
    expect(tooltip.querySelector('img')).toBeNull();
    expect(tooltip.textContent).toContain(HOSTILE);
    expect(container.querySelector('img')).toBeNull();
  });
});
