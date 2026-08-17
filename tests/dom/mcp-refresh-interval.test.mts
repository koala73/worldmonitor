import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MIN_MCP_REFRESH_INTERVAL_MS,
  loadMcpPanels,
  normalizeMcpRefreshIntervalMs,
  saveMcpPanel,
  type McpPanelSpec,
} from '@/services/mcp-store';
import { McpDataPanel } from '@/components/McpDataPanel';

const spec = (refreshIntervalMs: number): McpPanelSpec => ({
  id: 'mcp-test', title: 'Test', serverUrl: 'https://example.test/mcp', customHeaders: {},
  toolName: 'status', toolArgs: {}, refreshIntervalMs, createdAt: 1, updatedAt: 1,
});

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
  clear(): void { this.values.clear(); }
}

const storage = new MemoryStorage();
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

beforeEach(() => {
  storage.clear();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
});
afterEach(() => {
  if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

describe('MCP refresh interval policy', () => {
  it('clamps invalid and sub-minute values to the supported one-minute cadence', () => {
    expect(normalizeMcpRefreshIntervalMs(0)).toBe(MIN_MCP_REFRESH_INTERVAL_MS);
    expect(normalizeMcpRefreshIntervalMs(59_999)).toBe(MIN_MCP_REFRESH_INTERVAL_MS);
    expect(normalizeMcpRefreshIntervalMs(Number.NaN)).toBe(MIN_MCP_REFRESH_INTERVAL_MS);
    expect(normalizeMcpRefreshIntervalMs(60_000)).toBe(60_000);
    expect(normalizeMcpRefreshIntervalMs(61_234.9)).toBe(61_234);
  });

  it('normalizes stale saved specifications before their panel can reschedule itself', () => {
    saveMcpPanel(spec(1_000));
    expect(loadMcpPanels()[0]?.refreshIntervalMs).toBe(MIN_MCP_REFRESH_INTERVAL_MS);
  });

  it('uses the same minimum when a legacy panel schedules its next refresh', () => {
    const panel = new McpDataPanel(spec(1_000));
    document.body.append(panel.getElement());
    const timer = vi.spyOn(globalThis, 'setTimeout');

    (panel as unknown as { scheduleRefresh(immediate: boolean): void }).scheduleRefresh(false);

    expect(timer).toHaveBeenLastCalledWith(expect.any(Function), MIN_MCP_REFRESH_INTERVAL_MS);
    panel.destroy();
  });
});
