/**
 * U3: the About-you step at the end of Pro activation. Drives the real
 * `openProActivationFlow` (default context read) with the profile service and
 * the network readers mocked, then mounts the step's extras in jsdom.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const profile = vi.hoisted(() => ({
  status: { status: 'due', answers: {}, keyQuestionsComplete: false, returnDue: false } as unknown,
  loadAboutYouStatus: vi.fn(),
  recordAboutYouAnswers: vi.fn(),
  skipAboutYou: vi.fn(),
}));

vi.mock('@/services/audience-profile', () => ({
  loadAboutYouStatus: (...args: unknown[]) => profile.loadAboutYouStatus(...args),
  recordAboutYouAnswers: (...args: unknown[]) => profile.recordAboutYouAnswers(...args),
  skipAboutYou: (...args: unknown[]) => profile.skipAboutYou(...args),
}));
vi.mock('@/services/i18n', () => ({
  t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
}));
vi.mock('@/services/auth-state', () => ({
  getAuthState: () => ({ user: { id: 'user_pro', email: 'pro@worldmonitor.test' }, isPending: false }),
  subscribeAuthState: (listener: () => void) => {
    listener();
    return () => {};
  },
}));
vi.mock('@/services/notification-channels', () => ({
  getChannelsData: async () => ({ channels: [], alertRules: [] }),
  setEmailChannel: async () => true,
  setNotificationConfig: async () => true,
}));
vi.mock('@/services/mcp-clients', () => ({ listMcpClients: async () => [] }));
vi.mock('@/services/widget-store', () => ({ loadWidgets: () => [], loadWidgetsStrict: () => [] }));
vi.mock('@/services/insights-loader', () => ({
  getServerInsights: () => null,
  fetchServerInsights: async () => null,
}));
vi.mock('@/bootstrap/sentry-defer', () => ({
  scheduleSentryInit: async () => {},
  enqueueSentryCall: () => {},
}));
vi.mock('@/components/ProActivationChip', () => ({
  showFinishSetupChipForResults: () => {},
  maybeShowFinishSetupChip: () => {},
}));

import {
  closeProActivationInterstitial,
  openProActivationFlow,
  openProActivationInterstitial,
} from '@/components/ProActivationInterstitial';

type Captured = Parameters<NonNullable<Parameters<typeof openProActivationFlow>[1]['openInterstitial']>>[0];

async function openFlow(onEvent = vi.fn()): Promise<{ captured: Captured | null; onEvent: typeof onEvent }> {
  let captured: Captured | null = null;
  await openProActivationFlow(
    {
      accountUserId: 'user_pro',
      accountEmail: 'pro@worldmonitor.test',
      isAccountCurrent: () => true,
      onEvent,
    },
    {
      claimPresentation: async () => 'claimed',
      confirmPresentation: async () => true,
      openDay0Presentation: async () => 'opened',
      recordOutcome: async () => true,
      openInterstitial: (options) => {
        captured = options;
      },
    },
  );
  return { captured, onEvent };
}

function mountAboutExtra(captured: Captured) {
  const extra = captured.stepExtras?.about;
  if (!extra) throw new Error('about step has no extras');
  const root = document.createElement('div');
  root.innerHTML = String(extra.html);
  document.body.append(root);
  const controls = { confirmAndFinish: vi.fn() };
  extra.onMount?.(root, controls);
  return { root, controls };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

beforeEach(() => {
  profile.loadAboutYouStatus.mockImplementation(async () => profile.status);
  profile.recordAboutYouAnswers.mockResolvedValue({ ok: true });
  profile.skipAboutYou.mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.clearAllMocks();
  closeProActivationInterstitial();
  document.body.replaceChildren();
  profile.status = { status: 'due', answers: {}, keyQuestionsComplete: false, returnDue: false };
});

describe('Pro activation About-you step', () => {
  it('is the last step and confirmable when the profile is due', async () => {
    const { captured } = await openFlow();
    expect(captured!.steps.map((step) => step.id).at(-1)).toBe('about');
    expect(captured!.steps.at(-1)!.state).toBe('confirmable');
    expect(profile.loadAboutYouStatus).toHaveBeenCalledWith('user_pro');
  });

  it('is already-done when the profile was answered or skipped', async () => {
    profile.status = { status: 'skipped', answers: {}, keyQuestionsComplete: false, returnDue: false };
    const { captured } = await openFlow();
    expect(captured!.steps.find((step) => step.id === 'about')?.state).toBe('already-done');
  });

  it('is omitted when the profile status cannot be read', async () => {
    profile.loadAboutYouStatus.mockResolvedValue(null);
    const { captured } = await openFlow();
    expect(captured!.steps.map((step) => step.id)).not.toContain('about');
  });

  it('Save records the chosen answers, emits step-confirmed once, and finishes', async () => {
    const { captured, onEvent } = await openFlow();
    const { root, controls } = mountAboutExtra(captured!);
    const save = root.querySelector<HTMLButtonElement>('.pro-activation-about-save')!;
    expect(save.disabled).toBe(true);
    root.querySelector<HTMLButtonElement>('[data-question="primaryUse"][data-option="markets"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-question="payer"][data-option="employer"]')!.click();
    expect(save.disabled).toBe(false);
    save.click();
    save.click();
    await flush();
    expect(profile.recordAboutYouAnswers).toHaveBeenCalledTimes(1);
    expect(profile.recordAboutYouAnswers).toHaveBeenCalledWith('user_pro', 'activation', {
      primaryUse: 'markets',
      payer: 'employer',
    });
    expect(onEvent.mock.calls.filter(([event, step]) => event === 'pro-activation-step-confirmed' && step === 'about')).toHaveLength(1);
    expect(controls.confirmAndFinish).toHaveBeenCalledTimes(1);
  });

  it('a failed save keeps the step open and re-enables Save', async () => {
    profile.recordAboutYouAnswers.mockResolvedValue({ ok: false, reason: 'error' });
    const { captured } = await openFlow();
    const { root, controls } = mountAboutExtra(captured!);
    root.querySelector<HTMLButtonElement>('[data-question="usageContext"][data-option="work"]')!.click();
    root.querySelector<HTMLButtonElement>('.pro-activation-about-save')!.click();
    await flush();
    expect(controls.confirmAndFinish).not.toHaveBeenCalled();
    expect(root.querySelector<HTMLButtonElement>('.pro-activation-about-save')!.disabled).toBe(false);
    expect(root.querySelector('.pro-activation-about-status')!.textContent).not.toBe('');
  });

  it('tapping a chosen option again clears it', async () => {
    const { captured } = await openFlow();
    const { root } = mountAboutExtra(captured!);
    const work = root.querySelector<HTMLButtonElement>('[data-question="usageContext"][data-option="work"]')!;
    work.click();
    work.click();
    expect(work.getAttribute('aria-pressed')).toBe('false');
    expect(root.querySelector<HTMLButtonElement>('.pro-activation-about-save')!.disabled).toBe(true);
  });

  it('the frame offers only "Skip for now" beside Save, never a Continue that drops the answers', async () => {
    const { captured } = await openFlow();
    const about = captured!.steps.findIndex((step) => step.id === 'about');
    openProActivationInterstitial({ ...captured!, steps: captured!.steps.slice(about) });
    const actions = document.querySelector('.pro-activation-actions')!;
    expect(actions.querySelector('.pro-activation-primary')).toBeNull();
    const skip = actions.querySelector<HTMLButtonElement>('.pro-activation-skip');
    expect(skip?.textContent).toBe('Skip for now');
    expect(document.querySelector('.pro-activation-about-save')).not.toBeNull();
  });

  it('skipping the step emits step-skipped and records a profile skip', async () => {
    const { captured, onEvent } = await openFlow();
    captured!.onSkipStep('about');
    expect(onEvent).toHaveBeenCalledWith('pro-activation-step-skipped', 'about');
    expect(profile.skipAboutYou).toHaveBeenCalledWith('user_pro', 'activation');
    captured!.onSkipStep('power');
    expect(profile.skipAboutYou).toHaveBeenCalledTimes(1);
  });
});
