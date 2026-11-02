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
