import { beforeEach, describe, expect, it, vi } from 'vitest';

const loops = vi.hoisted(() => [] as Array<(arg: { signal: AbortSignal }) => Promise<void>>);

vi.mock('@/services/runtime', () => ({
  startSmartPollLoop: (task: (arg: { signal: AbortSignal }) => Promise<void>) => {
    loops.push(task);
    return { isActive: () => true, stop: vi.fn() };
  },
  toApiUrl: (path: string) => path,
}));

vi.mock('@/services/summarization', () => ({
  translateText: vi.fn(async (text: string) => text),
}));

import { onOrefAlertsUpdate, startOrefPolling, stopOrefPolling } from '@/services/oref-alerts';

describe('OREF update listeners', () => {
  beforeEach(() => {
    loops.length = 0;
    stopOrefPolling();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        configured: true,
        alerts: [],
        historyCount24h: 0,
        timestamp: '2026-09-19T00:00:00.000Z',
      }),
    })));
  });

  it('registers a callback once and removes it on unsubscribe', async () => {
    let calls = 0;
    const listener = () => { calls += 1; };
    const unsubscribe = onOrefAlertsUpdate(listener);
    onOrefAlertsUpdate(listener);
    startOrefPolling();
    startOrefPolling();

    expect(loops).toHaveLength(1);
    await loops[0]!({ signal: new AbortController().signal });
    expect(calls).toBe(1);

    unsubscribe();
    await loops[0]!({ signal: new AbortController().signal });
    expect(calls).toBe(1);
  });
});
