/**
 * ChatAnalystPanel defers the synchronous marked + DOMPurify render of a
 * finished answer off the current task (#4537), so the stream's last paint
 * lands first. Three behaviours depend on that deferral:
 *
 *   1. The markdown render waits for `yieldToMain()`.
 *   2. A bubble detached before the yield resolves is not rendered.
 *   3. The panel scrolls again after the rendered markdown lands. Rendered
 *      markdown is taller than the raw streamed text, so a scroll taken
 *      before the render stops short of the true bottom.
 *
 * The test controls `yieldToMain` and `requestAnimationFrame` so each phase can
 * be observed on its own.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initTestI18n } from './helpers/i18n.mts';

const yieldControl = vi.hoisted(() => ({ releases: [] as Array<() => void> }));

vi.mock('@/utils/after-paint', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/utils/after-paint')>(),
  yieldToMain: () => new Promise<void>((resolve) => { yieldControl.releases.push(resolve); }),
}));
vi.mock('@/services/premium-fetch', () => ({ premiumFetch: vi.fn() }));

import { premiumFetch } from '@/services/premium-fetch';
import { ChatAnalystPanel } from '@/components/ChatAnalystPanel';

const RENDERED_HEIGHT = 500;
const RAW_HEIGHT = 100;

let frames: FrameRequestCallback[] = [];

function flushFrames(): void {
  const pending = frames;
  frames = [];
  for (const frame of pending) frame(0);
}

async function releaseYields(): Promise<void> {
  const pending = yieldControl.releases.splice(0);
  for (const release of pending) release();
  // Let the `.then` continuations run.
  await Promise.resolve();
  await Promise.resolve();
}

function streamOf(...events: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${event}\n`));
      controller.close();
    },
  }));
}

/**
 * Mounts a panel whose message list reports a taller scrollHeight once the
 * markdown has rendered, so `scrollTop` shows which content the last scroll saw.
 */
function mountPanel(): { panel: ChatAnalystPanel; messages: HTMLElement } {
  const panel = new ChatAnalystPanel();
  document.body.append(panel.getElement());
  const messages = panel.getElement().querySelector<HTMLElement>('.chat-analyst-messages')!;
  let scrollTop = 0;
  Object.defineProperty(messages, 'scrollHeight', {
    configurable: true,
    get: () => (messages.querySelector('strong') ? RENDERED_HEIGHT : RAW_HEIGHT),
  });
  Object.defineProperty(messages, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => { scrollTop = value; },
  });
  return { panel, messages };
}

function answerBody(panel: ChatAnalystPanel): HTMLElement {
  const bodies = panel.getElement().querySelectorAll<HTMLElement>('.chat-msg-assistant .chat-msg-body');
  return bodies[bodies.length - 1]!;
}

beforeAll(initTestI18n);

beforeEach(() => {
  frames = [];
  yieldControl.releases.length = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
  vi.mocked(premiumFetch).mockImplementation(async () => streamOf(
    '{"delta":"**Bold** answer"}',
    '{"done":true}',
  ));
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('ChatAnalystPanel deferred markdown render (#4537)', () => {
  it('renders the finished answer after the yield, then scrolls to the rendered bottom', async () => {
    const { panel, messages } = mountPanel();
    await panel.send('question');

    // Before the yield: the raw streamed text is shown and the frames already
    // requested scroll to the raw height.
    const body = answerBody(panel);
    expect(yieldControl.releases).toHaveLength(1);
    expect(body.querySelector('strong')).toBeNull();
    expect(body.textContent).toBe('**Bold** answer');
    flushFrames();
    expect(messages.scrollTop).toBe(RAW_HEIGHT);

    await releaseYields();
    expect(body.querySelector('strong')?.textContent).toBe('Bold');
    flushFrames();
    expect(messages.scrollTop).toBe(RENDERED_HEIGHT);
    panel.destroy();
  });

  it('skips the render and the scroll when the bubble is detached before the yield', async () => {
    const { panel, messages } = mountPanel();
    await panel.send('question');
    const body = answerBody(panel);
    flushFrames();
    const scrollBefore = messages.scrollTop;

    panel.getElement().remove();
    await releaseYields();

    expect(body.querySelector('strong')).toBeNull();
    expect(body.textContent).toBe('**Bold** answer');
    expect(frames).toHaveLength(0);
    expect(messages.scrollTop).toBe(scrollBefore);
    panel.destroy();
  });
});
