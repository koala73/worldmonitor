/**
 * While the WM Analyst streams an answer, the partial text must go through the
 * same marked + DOMPurify path as the finished answer. Appending raw deltas as
 * text nodes showed literal markdown mid-stream (`**SITUATION:**`), which then
 * snapped to formatted text on completion.
 *
 * The stream is fed one SSE event at a time and requestAnimationFrame is held,
 * so each partial render can be inspected on its own.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initTestI18n } from './helpers/i18n.mts';

vi.mock('@/services/premium-fetch', () => ({ premiumFetch: vi.fn() }));

import DOMPurify from 'dompurify';
import { premiumFetch } from '@/services/premium-fetch';
import { ChatAnalystPanel } from '@/components/ChatAnalystPanel';
import { balanceStreamingMarkdown } from '@/utils/analyst-markdown';

let frames = new Map<number, FrameRequestCallback>();
let nextFrameId = 1;

function flushFrames(): void {
  const pending = [...frames.values()];
  frames = new Map();
  for (const frame of pending) frame(0);
}

const tick = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

function controlledStream(): {
  response: Response;
  push: (delta: string) => Promise<void>;
  pushWithoutFrame: (delta: string) => void;
  finish: () => void;
} {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  return {
    response: new Response(body),
    async push(delta: string) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta })}\n`));
      await tick();
      flushFrames();
    },
    pushWithoutFrame(delta: string) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta })}\n`));
    },
    finish() {
      controller.enqueue(encoder.encode('data: {"done":true}\n'));
      controller.close();
    },
  };
}

function answerBody(panel: ChatAnalystPanel): HTMLElement {
  const bodies = panel.getElement().querySelectorAll<HTMLElement>('.chat-msg-assistant .chat-msg-body');
  return bodies[bodies.length - 1]!;
}

beforeAll(initTestI18n);

beforeEach(() => {
  frames = new Map();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = nextFrameId++;
    frames.set(id, cb);
    return id;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('ChatAnalystPanel streaming markdown', () => {
  it('renders bold markdown mid-stream instead of literal asterisks', async () => {
    const stream = controlledStream();
    vi.mocked(premiumFetch).mockResolvedValue(stream.response);
    const panel = new ChatAnalystPanel();
    document.body.append(panel.getElement());

    const sent = panel.send('What is moving oil?');
    await tick();

    await stream.push('**SITUATION:**');
    const body = answerBody(panel);
    expect(body.textContent).toContain('SITUATION:');
    expect(body.textContent).not.toContain('*');
    expect(body.querySelector('strong')?.textContent).toBe('SITUATION:');

    // An opening `**` split across chunks, and a bold run still open at the end.
    await stream.push(' Oil prices fell.\n\n- **Supply Sh');
    expect(body.textContent).not.toContain('*');
    expect(body.querySelector('li strong')?.textContent).toBe('Supply Sh');

    // A lone trailing `*` (first half of the next `**`) must not leak.
    await stream.push('ock:** Ras Tanura. *');
    expect(body.textContent).not.toContain('*');
    expect(body.querySelector('li strong')?.textContent).toBe('Supply Shock:');

    await stream.push('*WATCH**');
    expect(body.textContent).not.toContain('*');
    expect([...body.querySelectorAll('strong')].map((el) => el.textContent))
      .toEqual(['SITUATION:', 'Supply Shock:', 'WATCH']);
    // Partial renders keep the streaming indicator after the formatted text.
    expect(body.lastElementChild?.classList.contains('chat-streaming-dot')).toBe(true);

    stream.finish();
    await sent;
    await tick();
    await tick();
    expect(body.textContent).not.toContain('*');
    expect(body.querySelector('.chat-streaming-dot')).toBeNull();
    expect([...body.querySelectorAll('strong')].map((el) => el.textContent))
      .toEqual(['SITUATION:', 'Supply Shock:', 'WATCH']);
    panel.destroy();
  });

  it('does not let a frame queued before completion overwrite the final render', async () => {
    const stream = controlledStream();
    vi.mocked(premiumFetch).mockResolvedValue(stream.response);
    const panel = new ChatAnalystPanel();
    document.body.append(panel.getElement());

    const sent = panel.send('question');
    await tick();
    await stream.push('**Partial');
    const body = answerBody(panel);
    // Queue another partial render, then end the stream before the frame runs.
    stream.pushWithoutFrame(' answer**');
    stream.finish();
    await sent;
    await tick();
    await tick();
    expect(body.querySelector('.chat-streaming-dot')).toBeNull();
    flushFrames();
    expect(body.querySelector('.chat-streaming-dot')).toBeNull();
    expect(body.querySelector('strong')?.textContent).toBe('Partial answer');
    panel.destroy();
  });

  // happy-dom's NodeIterator breaks DOMPurify's walk (see
  // deduction-purify-config.test.mts), so sanitizer OUTPUT proves nothing here.
  // This pins that partial renders call DOMPurify with the analyst allowlist;
  // the stripped <img> is checked in a real Chromium drive.
  it('sanitises partial renders with the analyst DOMPurify allowlist', async () => {
    const sanitize = vi.spyOn(DOMPurify, 'sanitize');
    const stream = controlledStream();
    vi.mocked(premiumFetch).mockResolvedValue(stream.response);
    const panel = new ChatAnalystPanel();
    document.body.append(panel.getElement());

    const sent = panel.send('question');
    await tick();
    sanitize.mockClear();
    await stream.push('**Hi** <img src=x onerror="alert(1)">');
    expect(sanitize).toHaveBeenCalledTimes(1);
    const [dirty, config] = sanitize.mock.calls[0]! as [string, { ALLOWED_TAGS: string[]; ALLOWED_ATTR: string[] }];
    expect(dirty).toContain('<strong>Hi</strong>');
    expect(config.ALLOWED_TAGS).not.toContain('img');
    expect(config.ALLOWED_TAGS).not.toContain('a');
    expect(config.ALLOWED_ATTR).toEqual(['class']);
    sanitize.mockRestore();

    stream.finish();
    await sent;
    panel.destroy();
  });
});

describe('balanceStreamingMarkdown', () => {
  it.each([
    ['**SITUATION:**', '**SITUATION:**'],
    ['**SITUA', '**SITUA**'],
    ['**SITUATION ', '**SITUATION**'],
    ['Text **', 'Text'],
    ['Text *', 'Text'],
    ['**SITUATION:*', '**SITUATION:**'],
    ['**Open\nnext line', 'Open\nnext line'],
    ['```\ncode **x', '```\ncode **x\n```'],
    ['`a ** b` done', '`a ** b` done'],
    ['Oil is *volatile*', 'Oil is *volatile*'],
    ['Oil is *volat', 'Oil is *volat*'],
    ['Oil is *', 'Oil is'],
    ['*Open\nnext line', 'Open\nnext line'],
    ['* bullet one\n* bul', '* bullet one\n* bul'],
    ['**Bold *ital', '**Bold *ital***'],
    ['*Ital **bo', '*Ital **bo***'],
    ['**Bold** and *ital*', '**Bold** and *ital*'],
    ['````\ncode', '````\ncode\n````'],
    ['~~~\ncode', '~~~\ncode\n~~~'],
    ['````\n```\nstill code', '````\n```\nstill code\n````'],
    ['```python\nresult = a ** b\n```\n\n**Result', '```python\nresult = a ** b\n```\n\n**Result**'],
    ['```\nx = *p\n```\n\nOil is *volatile*', '```\nx = *p\n```\n\nOil is *volatile*'],
  ])('%j -> %j', (input, expected) => {
    expect(balanceStreamingMarkdown(input)).toBe(expected);
  });
});
