import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initTestI18n } from './helpers/i18n.mts';

vi.mock('@/services/premium-fetch', () => ({ premiumFetch: vi.fn() }));
import { premiumFetch } from '@/services/premium-fetch';
import { ChatAnalystPanel } from '@/components/ChatAnalystPanel';

beforeAll(initTestI18n);
afterEach(() => { document.body.replaceChildren(); });

describe('Chat analyst principal reset', () => {
  it('retains completed history for the current session', async () => {
    const panel = new ChatAnalystPanel();
    document.body.append(panel.getElement());
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"delta":"Current answer","done":true}\n'));
        controller.close();
      },
    });
    vi.mocked(premiumFetch).mockResolvedValue(new Response(stream));
    await panel.send('Current question');
    expect((panel as unknown as { history: unknown[] }).history).toEqual([
      { role: 'user', content: 'Current question' },
      { role: 'assistant', content: 'Current answer' },
    ]);
    panel.destroy();
  });

  it('does not restore completed old-session history after sensitive content is cleared', async () => {
    const panel = new ChatAnalystPanel();
    document.body.append(panel.getElement());
    const view = panel as unknown as {
      readStream: (...args: unknown[]) => Promise<string>;
      history: unknown[];
    };
    vi.mocked(premiumFetch).mockResolvedValue(new Response(new ReadableStream()));
    vi.spyOn(view, 'readStream').mockImplementation(async (...args) => {
      (args[3] as (text: string) => void)('Account A private answer');
      queueMicrotask(() => { panel.clearSensitiveContent(); panel.unlockPanel(); });
      return 'done';
    });
    await panel.send('Account A private question');
    expect(view.history).toEqual([]);
    expect(panel.getElement().textContent).not.toContain('Account A private');
    panel.destroy();
  });

  it('ignores queued stream actions and tokens after a principal reset', async () => {
    const panel = new ChatAnalystPanel();
    document.body.append(panel.getElement());
    const action = vi.fn();
    const view = panel as unknown as {
      renderActionChip: typeof action;
      history: unknown[];
    };
    vi.spyOn(view, 'renderActionChip').mockImplementation(action);
    let release!: (value: ReadableStreamReadResult<Uint8Array>) => void;
    const read = vi.fn(() => new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => { release = resolve; }));
    vi.mocked(premiumFetch).mockResolvedValue({ ok: true, body: { getReader: () => ({ read }) } } as unknown as Response);
    const pending = panel.send('Account A private question');
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    panel.clearSensitiveContent();
    panel.unlockPanel();
    release({ done: false, value: new TextEncoder().encode('data: {"action":{"type":"open_panel","panelId":"forecast"},"delta":"private","done":true}\n') });
    await pending;
    expect(action).not.toHaveBeenCalled();
    expect(view.history).toEqual([]);
    panel.destroy();
  });
});
