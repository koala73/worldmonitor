import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportSettings, importSettings } from '@/utils/settings-persistence';
import { invalidatePanelStorageCacheForKeys, loadPanelSpans } from '@/utils/panel-storage';

const monitor = { id: 'saved', color: '#ff0000', keywords: ['oil', 'gas'] };
const file = (data: unknown, version = 1) => new File([JSON.stringify({ version, data })], 'settings.json');
const snapshot = () => Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)]));

beforeEach(() => {
  localStorage.clear();
  invalidatePanelStorageCacheForKeys(['worldmonitor-panel-spans']);
  localStorage.setItem('worldmonitor-monitors', JSON.stringify([monitor]));
  localStorage.setItem('worldmonitor-theme', 'dark');
  localStorage.setItem('unrelated', 'keep');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('settings file import', () => {
  it.each([
    'null', '{}', 'false', '"text"', '[null]', '[[]]', '[1]', 'not JSON',
    JSON.stringify([{ ...monitor, keywords: [3] }]),
    JSON.stringify([{ ...monitor, keywords: 'oil' }]),
    JSON.stringify([{ ...monitor, id: 3 }]),
    JSON.stringify([{ ...monitor, color: null }]),
    JSON.stringify([{ ...monitor, name: 1 }]),
    JSON.stringify([{ ...monitor, lat: '25' }]),
    JSON.stringify([{ ...monitor, lon: null }]),
  ])('rejects malformed monitor value %s without changing any storage', async value => {
    const before = snapshot();
    await expect(importSettings(file({ 'worldmonitor-theme': 'light', 'worldmonitor-monitors': value }))).rejects.toThrow();
    expect(snapshot()).toEqual(before);
  });

  it.each([null, [], 'settings', 1])('rejects invalid data envelope %j', async data => {
    const before = snapshot();
    await expect(importSettings(file(data))).rejects.toThrow();
    expect(snapshot()).toEqual(before);
  });

  it.each([null, 3, false, {}, []])('rejects a recognized non-string value %j before writing', async value => {
    const before = snapshot();
    await expect(importSettings(file({ 'worldmonitor-theme': 'light', 'wm-font-scale': value }))).rejects.toThrow();
    expect(snapshot()).toEqual(before);
  });

  it('round trips real exports including legacy optional fields and variant prefixes', async () => {
    localStorage.setItem('worldmonitor-monitors', JSON.stringify([monitor, { ...monitor, id: 'geo', name: 'Energy', lat: 25, lon: 55, futureField: true }]));
    localStorage.setItem('worldmonitor-panels-tech', '{"future-panel":{"enabled":true}}');
    localStorage.setItem('wm-map-theme:carto', 'voyager');
    localStorage.setItem('worldmonitor-disabled-feeds-schema', '9');
    const before = snapshot();
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:settings');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    exportSettings();
    const blob = create.mock.calls[0]![0] as Blob;
    const exported = JSON.parse(await blob.text());
    expect(exported.version).toBe(1);
    expect(exported.data.unrelated).toBeUndefined();
    localStorage.clear();
    await expect(importSettings(new File([await blob.text()], 'export.json'))).resolves.toEqual({ success: true, keysImported: Object.keys(exported.data).length });
    expect(snapshot()).toEqual(Object.fromEntries(Object.entries(before).filter(([key]) => key !== 'unrelated')));
  });

  it('accepts an empty monitor list, ignores unrelated values and invalidates panel cache', async () => {
    localStorage.setItem('worldmonitor-panel-spans', '{"news":2}');
    expect(loadPanelSpans()).toEqual({ news: 2 });
    await expect(importSettings(file({ 'worldmonitor-monitors': '[]', 'worldmonitor-panel-spans': '{"news":3}', unrelated: {} }))).resolves.toEqual({ success: true, keysImported: 2 });
    expect(localStorage.getItem('worldmonitor-monitors')).toBe('[]');
    expect(localStorage.getItem('unrelated')).toBe('keep');
    expect(loadPanelSpans()).toEqual({ news: 3 });
  });

  it('rejects unsupported versions, oversized files and malformed JSON without writes', async () => {
    const before = snapshot();
    for (const input of [file({ 'worldmonitor-theme': 'light' }, 2), new File(['{'], 'broken.json'), new File([' '.repeat(5 * 1024 * 1024 + 1)], 'large.json')]) {
      await expect(importSettings(input)).rejects.toThrow();
      expect(snapshot()).toEqual(before);
    }
  });

  it('does not turn a storage failure into import success', async () => {
    const storage = localStorage;
    vi.stubGlobal('localStorage', { getItem: storage.getItem.bind(storage), removeItem: storage.removeItem.bind(storage), setItem() { throw new DOMException('Full', 'QuotaExceededError'); } });
    await expect(importSettings(file({ 'worldmonitor-theme': 'light' }))).rejects.toThrow('Cannot persist');
  });
});


it('ignores prefix impostors while preserving known variant keys', async () => {
  await importSettings(file({ 'worldmonitor-theme-evil': '=bad', 'worldmonitor-panels-tech': '{}', 'wm-map-theme:unknown': 'bad' }));
  expect(localStorage.getItem('worldmonitor-theme-evil')).toBeNull();
  expect(localStorage.getItem('wm-map-theme:unknown')).toBeNull();
  expect(localStorage.getItem('worldmonitor-panels-tech')).toBe('{}');
});

it.each([
  ['worldmonitor-theme', 'invalid'],
  ['wm-stream-quality', 'ultra'],
  ['wm-map-theme:carto', 'invalid'],
  ['wm-analysis-frameworks', JSON.stringify([{ id: 'x', name: 'x', description: '', systemPromptAppend: 'x'.repeat(2001), isBuiltIn: false, createdAt: 0 }])],
  ['worldmonitor-live-channels', JSON.stringify({ order: ['x'], custom: [{ id: 'x', name: 'x', hlsUrl: 'javascript:alert(1)' }] })],
  ['worldmonitor-monitors', ' '.repeat(256 * 1024 + 1)],
])('rejects invalid %s before any storage change', async (key, value) => {
  const before = snapshot();
  await expect(importSettings(file({ 'worldmonitor-theme': 'light', [key]: value }))).rejects.toThrow();
  vi.unstubAllGlobals();
  expect(snapshot()).toEqual(before);
});

it('restores earlier entries when a later quota write fails', async () => {
  const before = snapshot();
  const original = localStorage.setItem.bind(localStorage);
  let failed = false;
  const storage = localStorage;
  vi.stubGlobal('localStorage', { getItem: storage.getItem.bind(storage), removeItem: storage.removeItem.bind(storage), setItem(key: string, value: string) {
    if (key === 'wm-font-scale' && !failed) { failed = true; throw new DOMException('Full', 'QuotaExceededError'); }
    return original(key, value);
  } });
  await expect(importSettings(file({ 'worldmonitor-theme': 'light', 'wm-font-scale': '1.2' }))).rejects.toThrow('Cannot persist');
  vi.unstubAllGlobals();
  expect(snapshot()).toEqual(before);
});
