/**
 * U4: optional About-you questions on the MCP connect screen. They render only
 * for a due profile, never hold the grant, and "Not now" records a skip.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountMcpAboutYou, type McpAboutYouDeps } from '@/services/mcp-grant-about-you';

const DUE = { status: 'due', answers: {}, keyQuestionsComplete: false, returnDue: false } as const;

function deps(overrides: Partial<McpAboutYouDeps> = {}): McpAboutYouDeps {
  return {
    loadStatus: vi.fn(async () => DUE),
    recordAnswers: vi.fn(async () => ({ ok: true })),
    skip: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
}

function container(): HTMLElement {
  const el = document.createElement('div');
  document.body.append(el);
  return el;
}

function pick(question: string, option: string): void {
  document.querySelector<HTMLButtonElement>(`[data-question="${question}"][data-option="${option}"]`)!.click();
}

async function flushMicrotasks(): Promise<void> {
  // settle() chains catch -> then -> race -> finally before the caller's then.
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

/** settle() on an idle section resolves without waiting. */
async function mountedIdle(section: { settle(ms: number): Promise<void> }): Promise<void> {
  let done = false;
  void section.settle(60_000).then(() => { done = true; });
  await flushMicrotasks();
  expect(done).toBe(true);
}

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('MCP connect About-you section', () => {
  it('renders collapsed when the profile is due', async () => {
    const section = await mountMcpAboutYou(container(), deps(), 1000);
    expect(section).not.toBeNull();
    const details = document.querySelector('details#mcpAboutYou');
    expect(details).not.toBeNull();
    expect((details as HTMLDetailsElement).open).toBe(false);
    expect(document.querySelectorAll('[data-question="primaryUse"]').length).toBeGreaterThan(1);
  });

  it('AE2: renders nothing when the profile was answered or skipped elsewhere', async () => {
    for (const status of ['answered', 'skipped'] as const) {
      const section = await mountMcpAboutYou(container(), deps({ loadStatus: async () => ({ ...DUE, status }) }), 1000);
      expect(section).toBeNull();
      expect(document.getElementById('mcpAboutYou')).toBeNull();
    }
  });

  it('renders nothing when the status read fails or is too slow', async () => {
    expect(await mountMcpAboutYou(container(), deps({ loadStatus: async () => null }), 1000)).toBeNull();
    expect(
      await mountMcpAboutYou(container(), deps({ loadStatus: () => Promise.reject(new Error('down')) }), 1000),
    ).toBeNull();
    vi.useFakeTimers();
    const pending = mountMcpAboutYou(container(), deps({ loadStatus: () => new Promise(() => {}) }), 3000);
    vi.advanceTimersByTime(3000);
    expect(await pending).toBeNull();
    expect(document.getElementById('mcpAboutYou')).toBeNull();
  });

  it('submit sends the chosen answers once and returns without waiting on the write', async () => {
    const recordAnswers = vi.fn(() => new Promise<{ ok: boolean }>(() => {}));
    const section = await mountMcpAboutYou(container(), deps({ recordAnswers }), 1000);
    pick('primaryUse', 'api-agent');
    pick('usageContext', 'work');
    expect(section!.submit()).toBeUndefined();
    section!.submit();
    expect(recordAnswers).toHaveBeenCalledTimes(1);
    expect(recordAnswers).toHaveBeenCalledWith({ primaryUse: 'api-agent', usageContext: 'work' });
  });

  it('an Authorize retry sends changed answers, but never the same answers twice', async () => {
    const d = deps();
    const section = await mountMcpAboutYou(container(), d, 1000);
    pick('primaryUse', 'news');
    section!.submit();
    section!.submit();
    pick('primaryUse', 'markets');
    section!.submit();
    expect(d.recordAnswers).toHaveBeenCalledTimes(2);
    expect(d.recordAnswers).toHaveBeenLastCalledWith({ primaryUse: 'markets' });
  });

  it('settle waits for the write in flight, bounded by its timeout', async () => {
    vi.useFakeTimers();
    let release: (value: { ok: boolean }) => void = () => {};
    const recordAnswers = vi.fn(() => new Promise<{ ok: boolean }>((resolve) => { release = resolve; }));
    const section = await mountMcpAboutYou(container(), deps({ recordAnswers }), 1000);
    pick('usageContext', 'work');
    section!.submit();
    let settled = false;
    void section!.settle(1500).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(false);
    release({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);

    const stuck = await mountMcpAboutYou(container(), deps({ recordAnswers: () => new Promise(() => {}) }), 1000);
    expect(stuck).toBeNull(); // one section per page
  });

  it('settle gives up after its timeout so the redirect is never held', async () => {
    vi.useFakeTimers();
    const section = await mountMcpAboutYou(container(), deps({ recordAnswers: () => new Promise(() => {}) }), 1000);
    pick('payer', 'self');
    section!.submit();
    let settled = false;
    void section!.settle(1500).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(1500);
    expect(settled).toBe(true);
  });

  it('settle also waits for a "Not now" skip in flight, and resolves at once when idle', async () => {
    let release: (value: { ok: boolean }) => void = () => {};
    const skip = vi.fn(() => new Promise<{ ok: boolean }>((resolve) => { release = resolve; }));
    const section = await mountMcpAboutYou(container(), deps({ skip }), 1000);
    let settled = false;
    const idle = mountedIdle(section!);
    await idle;
    document.querySelector<HTMLButtonElement>('.about-you-not-now')!.click();
    void section!.settle(5000).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    release({ ok: true });
    await flushMicrotasks();
    expect(settled).toBe(true);
  });

  it('destroy removes the section and stops any later submit (account switch)', async () => {
    const d = deps();
    const section = await mountMcpAboutYou(container(), d, 1000);
    pick('primaryUse', 'news');
    section!.destroy();
    expect(document.getElementById('mcpAboutYou')).toBeNull();
    section!.submit();
    expect(d.recordAnswers).not.toHaveBeenCalled();
  });

  it('a failing write never throws out of submit', async () => {
    const section = await mountMcpAboutYou(
      container(),
      deps({ recordAnswers: () => Promise.reject(new Error('offline')) }),
      1000,
    );
    pick('payer', 'self');
    expect(() => section!.submit()).not.toThrow();
    await Promise.resolve();
  });

  it('authorize without answers makes no profile write', async () => {
    const d = deps();
    const section = await mountMcpAboutYou(container(), d, 1000);
    section!.submit();
    expect(d.recordAnswers).not.toHaveBeenCalled();
    expect(d.skip).not.toHaveBeenCalled();
  });

  it('"Not now" records one skip, removes the section, and blocks a later submit', async () => {
    const d = deps();
    const section = await mountMcpAboutYou(container(), d, 1000);
    pick('primaryUse', 'news');
    document.querySelector<HTMLButtonElement>('.about-you-not-now')!.click();
    expect(d.skip).toHaveBeenCalledTimes(1);
    expect(document.getElementById('mcpAboutYou')).toBeNull();
    section!.submit();
    expect(d.recordAnswers).not.toHaveBeenCalled();
  });

  it('tapping a chosen option again clears it', async () => {
    const d = deps();
    const section = await mountMcpAboutYou(container(), d, 1000);
    pick('usageContext', 'personal');
    pick('usageContext', 'personal');
    section!.submit();
    expect(d.recordAnswers).not.toHaveBeenCalled();
  });
});
