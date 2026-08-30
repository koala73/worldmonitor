import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  PANEL_LAYOUT_PERSIST_FAILED_MESSAGE,
  applyExclusiveFullscreenEnter,
  applyLayoutPersistReceipt,
  describePanelLayout,
  mutationApplied,
  otherFullscreenPanelIds,
  resolveMovePanel,
  resolveSetPanelCollapsed,
  resolveSetPanelFullscreen,
  type PanelLayoutEntry,
} from '../src/services/panel-layout-actions.ts';

function entry(
  id: string,
  region: PanelLayoutEntry['region'],
  index: number,
  patch: Partial<PanelLayoutEntry> = {},
): PanelLayoutEntry {
  return {
    id,
    region,
    index,
    collapsed: false,
    fullscreen: false,
    collapsible: false,
    fullscreenCapable: false,
    fixed: false,
    ...patch,
  };
}

const sidebarOnly = [
  entry('live-news', 'sidebar', 0, { collapsible: true, fullscreenCapable: true }),
  entry('markets', 'sidebar', 1),
  entry('giving', 'sidebar', 2),
  entry('monitors', 'sidebar', 3),
];

const bothRegions = [
  entry('live-news', 'sidebar', 0, { collapsible: true, fullscreenCapable: true }),
  entry('markets', 'sidebar', 1),
  entry('giving', 'bottom', 0),
  entry('strategic-risk', 'bottom', 1),
];

describe('applyLayoutPersistReceipt', () => {
  it('keeps an applied move when both storage writes succeed', () => {
    const applied = mutationApplied('move', {
      message: 'Moved panel.',
      panelId: 'markets',
      region: 'sidebar',
      index: 0,
      changed: true,
      unchanged: false,
    });
    const persisted = applyLayoutPersistReceipt({ persisted: true }, applied);
    assert.equal(persisted.ok, true);
    assert.equal(persisted.status, 'applied');
    assert.equal(persisted.persisted, true);
    assert.equal(persisted.message, 'Moved panel.');
  });

  it('does not report applied after a swallowed storage failure', () => {
    const applied = mutationApplied('move', {
      message: 'Moved panel.',
      panelId: 'markets',
      region: 'bottom',
      index: 1,
      changed: true,
      unchanged: false,
    });
    const failed = applyLayoutPersistReceipt({ persisted: false }, applied);
    assert.deepEqual(failed, {
      ok: false,
      status: 'denied',
      actionType: 'move',
      reason: 'persist_failed',
      persisted: false,
      message: PANEL_LAYOUT_PERSIST_FAILED_MESSAGE,
      panelId: 'markets',
      region: 'bottom',
      index: 1,
      changed: true,
      unchanged: false,
    });
  });

  it('denies collapse with the effective state when persistence fails', () => {
    const applied = mutationApplied('set_collapsed', {
      message: 'Panel collapsed.',
      panelId: 'live-news',
      requestedCollapsed: true,
      effectiveCollapsed: false,
      changed: false,
    });
    const failed = applyLayoutPersistReceipt({ persisted: false }, applied);
    assert.equal(failed.reason, 'persist_failed');
    assert.equal(failed.ok, false);
    assert.equal(failed.persisted, false);
    assert.equal(failed.effectiveCollapsed, false);
    assert.equal(failed.changed, false);
  });
});

describe('describePanelLayout', () => {
  it('reports named regions, order, collapsed, and fullscreen state', () => {
    const snapshot = describePanelLayout([
      entry('live-news', 'sidebar', 0, { collapsed: true, collapsible: true, fullscreenCapable: true }),
      entry('giving', 'bottom', 0, { fullscreen: true, fullscreenCapable: true }),
    ], true);
    assert.deepEqual(snapshot.regions, {
      sidebar: { available: true, panelCount: 1 },
      bottom: { available: true, panelCount: 1 },
    });
    assert.equal(snapshot.panelCount, 2);
    assert.equal(snapshot.panels[0]?.collapsed, true);
    assert.equal(snapshot.panels[1]?.region, 'bottom');
    assert.equal(snapshot.panels[1]?.fullscreen, true);
  });

  it('marks the bottom region unavailable when the split layout is inactive', () => {
    const snapshot = describePanelLayout(sidebarOnly, false);
    assert.equal(snapshot.regions.bottom.available, false);
    assert.equal(snapshot.regions.bottom.panelCount, 0);
  });
});

describe('resolveSetPanelCollapsed', () => {
  it('is a no-op when the requested collapsed state already matches', () => {
    const panels = [entry('live-news', 'sidebar', 0, { collapsed: true, collapsible: true })];
    const result = resolveSetPanelCollapsed(panels, 'live-news', true);
    assert.deepEqual(result, {
      ok: true,
      unchanged: true,
      panelId: 'live-news',
      requestedCollapsed: true,
      effectiveCollapsed: true,
    });
  });

  it('allows expand and collapse for collapsible panels and rejects unsupported ones', () => {
    const panels = [
      entry('live-news', 'sidebar', 0, { collapsible: true }),
      entry('markets', 'sidebar', 1),
    ];
    const collapse = resolveSetPanelCollapsed(panels, 'live-news', true);
    assert.equal(collapse.ok, true);
    if (collapse.ok) {
      assert.equal(collapse.unchanged, false);
      assert.equal(collapse.effectiveCollapsed, true);
    }
    assert.equal(resolveSetPanelCollapsed(panels, 'markets', true).reason, 'collapse_unsupported');
    assert.equal(resolveSetPanelCollapsed(panels, 'missing', true).reason, 'panel_not_mounted');
    assert.equal(resolveSetPanelCollapsed(panels, 'Live News', true).reason, 'malformed_arguments');
  });
});

describe('resolveSetPanelFullscreen', () => {
  it('is a no-op when fullscreen already matches and denies unsupported panels', () => {
    const panels = [
      entry('live-news', 'sidebar', 0, { fullscreen: true, fullscreenCapable: true }),
      entry('markets', 'sidebar', 1),
    ];
    assert.deepEqual(resolveSetPanelFullscreen(panels, 'live-news', true), {
      ok: true,
      unchanged: true,
      panelId: 'live-news',
      requestedFullscreen: true,
      effectiveFullscreen: true,
    });
    const exit = resolveSetPanelFullscreen(panels, 'live-news', false);
    assert.equal(exit.ok, true);
    if (exit.ok) assert.equal(exit.unchanged, false);
    assert.equal(resolveSetPanelFullscreen(panels, 'markets', true).reason, 'fullscreen_unsupported');
  });
});

describe('exclusive panel fullscreen', () => {
  function createSharedClassPanel(body: { classActive: boolean }) {
    let fullscreen = false;
    return {
      isFullscreenActive: () => fullscreen,
      setFullscreen(next: boolean) {
        if (fullscreen === next) return true;
        fullscreen = next;
        body.classActive = next;
        return true;
      },
    };
  }

  it('exits the previous fullscreen panel before a second panel enters', () => {
    const body = { classActive: false };
    const liveNews = createSharedClassPanel(body);
    const liveWebcams = createSharedClassPanel(body);
    const registry: Record<string, ReturnType<typeof createSharedClassPanel>> = {
      'live-news': liveNews,
      'live-webcams': liveWebcams,
    };

    liveNews.setFullscreen(true);
    assert.equal(liveNews.isFullscreenActive(), true);
    assert.equal(body.classActive, true);

    const panels = [
      entry('live-news', 'sidebar', 0, { fullscreen: true, fullscreenCapable: true }),
      entry('live-webcams', 'sidebar', 1, { fullscreenCapable: true }),
    ];
    assert.deepEqual(otherFullscreenPanelIds(panels, 'live-webcams'), ['live-news']);

    const result = applyExclusiveFullscreenEnter(
      panels,
      (id) => registry[id],
      'live-webcams',
    );
    assert.deepEqual(result, { exitedIds: ['live-news'], entered: true });
    assert.equal(liveNews.isFullscreenActive(), false);
    assert.equal(liveWebcams.isFullscreenActive(), true);
    assert.equal(body.classActive, true);

    liveWebcams.setFullscreen(false);
    assert.equal(liveNews.isFullscreenActive(), false);
    assert.equal(liveWebcams.isFullscreenActive(), false);
    assert.equal(body.classActive, false);
  });

  it('wires exclusive enter through PanelLayoutManager.set_fullscreen', () => {
    const managerSrc = readFileSync(resolve(process.cwd(), 'src/app/panel-layout.ts'), 'utf8');
    const applyStart = managerSrc.indexOf('public applyWebMcpSetPanelFullscreen(');
    const applyEnd = managerSrc.indexOf('public applyWebMcpMovePanel(', applyStart);
    const applyBody = managerSrc.slice(applyStart, applyEnd);
    assert.ok(applyBody.includes('applyExclusiveFullscreenEnter('));
    assert.match(
      applyBody,
      /if \(resolved\.requestedFullscreen\) \{[\s\S]*applyExclusiveFullscreenEnter\(/,
    );
  });
});

describe('resolveMovePanel', () => {
  it('accepts first and last indices in the sidebar region', () => {
    const first = resolveMovePanel({
      panels: sidebarOnly,
      panelId: 'monitors',
      region: 'sidebar',
      index: 0,
      bottomAvailable: false,
    });
    assert.equal(first.ok, true);
    if (first.ok) {
      assert.equal(first.unchanged, false);
      assert.equal(first.index, 0);
    }

    const last = resolveMovePanel({
      panels: sidebarOnly,
      panelId: 'live-news',
      region: 'sidebar',
      index: 3,
      bottomAvailable: false,
    });
    assert.equal(last.ok, true);
    if (last.ok) assert.equal(last.index, 3);
  });

  it('is a no-op for the same region and index', () => {
    const result = resolveMovePanel({
      panels: sidebarOnly,
      panelId: 'markets',
      region: 'sidebar',
      index: 1,
      bottomAvailable: true,
    });
    assert.deepEqual(result, {
      ok: true,
      unchanged: true,
      panelId: 'markets',
      region: 'sidebar',
      index: 1,
    });
  });

  it('moves into the bottom region when available and denies when inactive', () => {
    const moved = resolveMovePanel({
      panels: bothRegions,
      panelId: 'markets',
      region: 'bottom',
      index: 2,
      bottomAvailable: true,
    });
    assert.equal(moved.ok, true);
    if (moved.ok) {
      assert.equal(moved.region, 'bottom');
      assert.equal(moved.index, 2);
    }

    const denied = resolveMovePanel({
      panels: sidebarOnly,
      panelId: 'markets',
      region: 'bottom',
      index: 0,
      bottomAvailable: false,
    });
    assert.equal(denied.reason, 'region_unavailable');
  });

  it('rejects invalid regions, out-of-range indices, fixed panels, and missing panels', () => {
    assert.equal(resolveMovePanel({
      panels: sidebarOnly,
      panelId: 'markets',
      region: 'map',
      index: 0,
      bottomAvailable: true,
    }).reason, 'invalid_region');

    assert.equal(resolveMovePanel({
      panels: sidebarOnly,
      panelId: 'markets',
      region: 'sidebar',
      index: 99,
      bottomAvailable: true,
    }).reason, 'invalid_index');

    assert.equal(resolveMovePanel({
      panels: sidebarOnly,
      panelId: 'markets',
      region: 'sidebar',
      index: 1.5,
      bottomAvailable: true,
    }).reason, 'invalid_index');

    assert.equal(resolveMovePanel({
      panels: [
        entry('runtime-config', 'sidebar', 0, { fixed: true }),
        entry('markets', 'sidebar', 1),
      ],
      panelId: 'runtime-config',
      region: 'sidebar',
      index: 1,
      bottomAvailable: true,
    }).reason, 'panel_fixed');

    assert.equal(resolveMovePanel({
      panels: sidebarOnly,
      panelId: 'missing',
      region: 'sidebar',
      index: 0,
      bottomAvailable: true,
    }).reason, 'panel_not_mounted');
  });

  it('treats append index as the count of remaining peers in the target region', () => {
    // Remove markets from sidebar first → 3 peers remain → append index 3.
    const within = resolveMovePanel({
      panels: sidebarOnly,
      panelId: 'markets',
      region: 'sidebar',
      index: 3,
      bottomAvailable: true,
    });
    assert.equal(within.ok, true);

    // Bottom currently has 2; markets is not there → append index 2.
    const cross = resolveMovePanel({
      panels: bothRegions,
      panelId: 'markets',
      region: 'bottom',
      index: 2,
      bottomAvailable: true,
    });
    assert.equal(cross.ok, true);
    assert.equal(resolveMovePanel({
      panels: bothRegions,
      panelId: 'markets',
      region: 'bottom',
      index: 3,
      bottomAvailable: true,
    }).reason, 'invalid_index');
  });
});
