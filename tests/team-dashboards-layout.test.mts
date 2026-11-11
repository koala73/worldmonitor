import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { PanelConfig } from '../src/types/index.ts';
import { resetMissionPresetState } from '../src/services/mission-presets.ts';
import {
  captureTeamDashboardLayout,
  teamDashboardErrorKind,
  toTeamDashboardTab,
  type TeamDashboardCaptureInput,
  type TeamDashboardLayout,
} from '../src/services/team-dashboards.ts';

class MemoryStorage {
  readonly store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
}

const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: new MemoryStorage() });
});

afterEach(() => {
  if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
});

/** The variant defaults, as a fresh browser holds them. */
function defaults(): Record<string, PanelConfig> {
  return resetMissionPresetState({}).panelSettings;
}

/** Real panel keys from the defaults, so the overlay recognises them. */
function realKeys(n: number): string[] {
  const keys = Object.keys(defaults()).filter((k) => k !== 'map');
  assert.ok(keys.length >= n, `need ${n} default panels`);
  return keys.slice(0, n);
}

function captureInput(overrides: Partial<TeamDashboardCaptureInput> = {}): TeamDashboardCaptureInput {
  const [a, b, c] = realKeys(3) as [string, string, string];
  const panelSettings = defaults();
  for (const key of Object.keys(panelSettings)) panelSettings[key] = { ...panelSettings[key]!, enabled: false };
  panelSettings[a] = { ...panelSettings[a]!, enabled: true };
  panelSettings[c] = { ...panelSettings[c]!, enabled: true };
  return {
    panelSettings,
    panelOrder: [c, a, b],
    bottomSet: [b],
    rowSpans: { [c]: 3 },
    colSpans: { [a]: 2 },
    map: {
      view: 'mena',
      zoom: 4.5,
      center: { lat: 26.5, lon: 52.1 },
      timeRange: '24h',
      layers: { conflicts: true, ais: true, flights: false, hotspots: undefined },
    },
    ...overrides,
  };
}

describe('captureTeamDashboardLayout', () => {
  it('records grid order, visibility, dock and sizes, then the remaining panels', () => {
    const input = captureInput();
    const [c, a, b] = input.panelOrder as [string, string, string];

    const layout = captureTeamDashboardLayout(input);

    assert.deepEqual(layout.panels.slice(0, 3), [
      { key: c, on: true, rows: 3 },
      { key: a, on: true, cols: 2 },
      { key: b, on: false, bottom: true },
    ]);
    // Panels missing from the order still travel, hidden as they are here.
    assert.equal(layout.panels.length, Object.keys(input.panelSettings).length);
    assert.ok(layout.panels.slice(3).every((p) => p.on === false));
  });

  it('records the map view, center and only the layers that are on', () => {
    assert.deepEqual(captureTeamDashboardLayout(captureInput()).map, {
      view: 'mena',
      zoom: 4.5,
      lat: 26.5,
      lon: 52.1,
      timeRange: '24h',
      layers: ['conflicts', 'ais'],
    });
  });

  it('leaves the map out when the map has no center yet', () => {
    const input = captureInput();
    const layout = captureTeamDashboardLayout({ ...input, map: { ...input.map!, center: null } });
    assert.equal(layout.map, undefined);
  });

  it("leaves out the publisher's own custom widgets and MCP panels", () => {
    const input = captureInput();
    input.panelSettings['cw-mine'] = { name: 'Mine', enabled: true, priority: 1 };
    input.panelSettings['mcp-tool'] = { name: 'Tool', enabled: true, priority: 1 };
    input.panelOrder.push('cw-mine', 'mcp-tool');

    const keys = captureTeamDashboardLayout(input).panels.map((p) => p.key);
    assert.ok(!keys.includes('cw-mine') && !keys.includes('mcp-tool'));
  });

  it('drops sizes the grid cannot take and keys the server would refuse', () => {
    const input = captureInput();
    const [a] = realKeys(1) as [string];
    input.rowSpans = { [a]: 9 };
    input.colSpans = { [a]: 1.5 };
    input.panelSettings['bad key'] = { name: 'Bad', enabled: true, priority: 1 };

    const layout = captureTeamDashboardLayout(input);
    assert.deepEqual(layout.panels.find((p) => p.key === a), { key: a, on: true });
    assert.ok(!layout.panels.some((p) => p.key === 'bad key'));
  });
});

describe('toTeamDashboardTab', () => {
  it('round-trips a captured layout into the same tab on another browser', () => {
    const input = captureInput();
    const [c, a, b] = input.panelOrder as [string, string, string];

    const tab = toTeamDashboardTab(captureTeamDashboardLayout(input), defaults());

    assert.deepEqual(tab.panelOrder.slice(0, 3), [c, a, b]);
    assert.equal(tab.panelSettings[c]!.enabled, true);
    assert.equal(tab.panelSettings[a]!.enabled, true);
    assert.equal(tab.panelSettings[b]!.enabled, false);
    assert.deepEqual(tab.bottomSet, [b]);
    assert.deepEqual(tab.sizes.slice(0, 3), [
      { key: c, rows: 3, cols: undefined },
      { key: a, rows: undefined, cols: 2 },
      { key: b, rows: undefined, cols: undefined },
    ]);
    assert.deepEqual(tab.map, {
      view: 'mena', zoom: 4.5, lat: 26.5, lon: 52.1, timeRange: '24h', layers: ['conflicts', 'ais'],
    });
  });

  it('skips panels this browser does not have, including object-member names', () => {
    const [a] = realKeys(1) as [string];
    const layout: TeamDashboardLayout = {
      panels: [
        { key: 'cw-someone-elses', on: true, rows: 2 },
        { key: 'constructor', on: true },
        { key: a, on: true, bottom: true },
      ],
    };

    const tab = toTeamDashboardTab(layout, defaults());

    assert.deepEqual(tab.panelOrder, [a]);
    assert.deepEqual(tab.bottomSet, [a]);
    assert.deepEqual(tab.sizes.map((s) => s.key), [a]);
    assert.ok(!Object.prototype.hasOwnProperty.call(tab.panelSettings, 'cw-someone-elses'));
  });

  it('drops the whole map part when its view or time range is unknown here', () => {
    const [a] = realKeys(1) as [string];
    const map = { view: 'mena', zoom: 3, lat: 1, lon: 2, timeRange: '24h', layers: ['ais'] };

    assert.equal(toTeamDashboardTab({ panels: [{ key: a, on: true }], map: { ...map, view: 'mars' } }, defaults()).map, null);
    assert.equal(toTeamDashboardTab({ panels: [{ key: a, on: true }], map: { ...map, timeRange: '90d' } }, defaults()).map, null);
    assert.equal(toTeamDashboardTab({ panels: [{ key: a, on: true }] }, defaults()).map, null);
  });

  it('keeps sizes inside the grid limits', () => {
    const [a] = realKeys(1) as [string];
    const tab = toTeamDashboardTab({ panels: [{ key: a, on: true, rows: 4, cols: 4 }] }, defaults());
    assert.deepEqual(tab.sizes, [{ key: a, rows: 4, cols: undefined }]);
  });
});

describe('teamDashboardErrorKind', () => {
  it('reads the kind from ConvexError data or from the message', () => {
    assert.equal(teamDashboardErrorKind({ data: { kind: 'TEAM_DASHBOARD_LIMIT', limit: 25 } }), 'TEAM_DASHBOARD_LIMIT');
    assert.equal(teamDashboardErrorKind(new Error('Uncaught ConvexError: {"kind":"NOT_ON_A_TEAM"}')), 'NOT_ON_A_TEAM');
    assert.equal(teamDashboardErrorKind(new Error('network down')), null);
    assert.equal(teamDashboardErrorKind(null), null);
  });
});
