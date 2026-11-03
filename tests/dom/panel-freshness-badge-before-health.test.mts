/**
 * The dashboard defers the first /api/health poll until after first paint, so
 * the panels above the fold are constructed before any freshness is known. Each
 * of them must still show its badge once the poll lands.
 */
import { afterEach, describe, expect, it } from 'vitest';

const { Panel } = await import('@/components/Panel');
const { refreshDataFreshnessFromHealth } = await import('@/services/health-freshness');

const panels: InstanceType<typeof Panel>[] = [];

function mount(id: string): HTMLElement {
  const panel = new Panel({ id, title: id });
  panels.push(panel);
  document.body.append(panel.getElement());
  return panel.getElement();
}

function visibleBadge(root: HTMLElement): HTMLElement | null {
  const badge = root.querySelector<HTMLElement>('.panel-freshness-badge');
  return badge && badge.style.display !== 'none' ? badge : null;
}

async function pollHealth(body: Record<string, unknown>): Promise<void> {
  await refreshDataFreshnessFromHealth({
    urlResolver: (path) => path,
    fetchFn: async () => new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });
}

afterEach(() => {
  for (const panel of panels.splice(0)) panel.destroy();
  document.body.replaceChildren();
});

describe('panel freshness badge for a panel mounted before the first health poll', () => {
  it('shows the badge for each panel state once the poll lands, and updates it on later polls', async () => {
    const climate = mount('climate');
    const displacement = mount('displacement');
    const unmapped = mount('markets');

    expect(visibleBadge(climate), 'no badge before health is known').toBeNull();
    expect(visibleBadge(displacement), 'no badge before health is known').toBeNull();

    await pollHealth({
      status: 'DEGRADED',
      checkedAt: new Date().toISOString(),
      problems: {
        displacement: { status: 'STALE_SEED', records: 40, seedAgeMin: 2000, maxStaleMin: 1440 },
      },
    });

    const climateBadge = visibleBadge(climate);
    expect(climateBadge, 'climate badge appears after the poll').not.toBeNull();
    expect(climateBadge!.classList.contains('panel-freshness-fresh'), climateBadge!.className).toBe(true);

    const displacementBadge = visibleBadge(displacement);
    expect(displacementBadge, 'displacement badge appears after the poll').not.toBeNull();
    expect(displacementBadge!.classList.contains('panel-freshness-stale'), displacementBadge!.className).toBe(true);

    expect(unmapped.querySelector('.panel-freshness-badge'), 'unmapped panel never gets a badge').toBeNull();

    await pollHealth({
      status: 'DEGRADED',
      checkedAt: new Date().toISOString(),
      problems: { climateAnomalies: { status: 'SEED_ERROR', records: 0 } },
    });

    const badges = climate.querySelectorAll('.panel-freshness-badge');
    expect(badges, 'later polls update the same badge').toHaveLength(1);
    expect(badges[0]!.classList.contains('panel-freshness-error'), badges[0]!.className).toBe(true);
  });
});
