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
  type ProActivationInterstitialOptions,
} from '@/components/ProActivationInterstitial';

type Captured = ProActivationInterstitialOptions;

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
  const controls = { confirmAndFinish: vi.fn(), setBusy: vi.fn() };
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
    const last = captured!.steps[captured!.steps.length - 1]!;
    expect(last.id).toBe('about');
    expect(last.state).toBe('confirmable');
    expect(profile.loadAboutYouStatus).toHaveBeenCalledWith('user_pro');
  });

  it('is already-done when the profile was answered, and omitted when it was skipped', async () => {
    profile.status = { status: 'answered', answers: { primaryUse: 'news' }, keyQuestionsComplete: false, returnDue: false };
    const answered = await openFlow();
    expect(answered.captured!.steps.find((step) => step.id === 'about')?.state).toBe('already-done');
    profile.status = { status: 'skipped', answers: {}, keyQuestionsComplete: false, returnDue: false };
    const skipped = await openFlow();
    expect(skipped.captured!.steps.map((step) => step.id)).not.toContain('about');
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

  it('while a save is in flight, picking an option keeps Save disabled and a second Save sends nothing', async () => {
    profile.recordAboutYouAnswers.mockImplementation(() => new Promise(() => {}));
    const { captured } = await openFlow();
    const { root } = mountAboutExtra(captured!);
    root.querySelector<HTMLButtonElement>('[data-question="primaryUse"][data-option="markets"]')!.click();
    const save = root.querySelector<HTMLButtonElement>('.pro-activation-about-save')!;
    save.click();
    root.querySelector<HTMLButtonElement>('[data-question="payer"][data-option="self"]')!.click();
    expect(save.disabled).toBe(true);
    save.click();
    await flush();
    expect(profile.recordAboutYouAnswers).toHaveBeenCalledTimes(1);
  });

  it('a save that settles after the step was left does not confirm or finish', async () => {
    let release: (value: { ok: true }) => void = () => {};
    profile.recordAboutYouAnswers.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const { captured, onEvent } = await openFlow();
    const { root, controls } = mountAboutExtra(captured!);
    root.querySelector<HTMLButtonElement>('[data-question="usageContext"][data-option="work"]')!.click();
    root.querySelector<HTMLButtonElement>('.pro-activation-about-save')!.click();
    root.remove();
    release({ ok: true });
    await flush();
    expect(controls.confirmAndFinish).not.toHaveBeenCalled();
    expect(onEvent.mock.calls.some(([event]) => event === 'pro-activation-step-confirmed')).toBe(false);
  });

  it('Skip and close are disabled while the save is in flight', async () => {
    profile.recordAboutYouAnswers.mockImplementation(() => new Promise(() => {}));
    const { captured } = await openFlow();
    const about = captured!.steps.findIndex((step) => step.id === 'about');
    openProActivationInterstitial({ ...captured!, steps: captured!.steps.slice(about) });
    document.querySelector<HTMLButtonElement>('[data-question="primaryUse"][data-option="news"]')!.click();
    document.querySelector<HTMLButtonElement>('.pro-activation-about-save')!.click();
    expect(document.querySelector<HTMLButtonElement>('.pro-activation-skip')!.disabled).toBe(true);
    const close = document.querySelector<HTMLButtonElement>('.pro-activation-close');
    if (close) expect(close.disabled).toBe(true);
  });

  it('Escape and a backdrop click do not dismiss the flow while the save is in flight', async () => {
    let release: (value: { ok: true }) => void = () => {};
    profile.recordAboutYouAnswers.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const { captured } = await openFlow();
    const about = captured!.steps.findIndex((step) => step.id === 'about');
    const onSkipStep = vi.fn(captured!.onSkipStep);
    openProActivationInterstitial({ ...captured!, steps: captured!.steps.slice(about), onSkipStep });
    document.querySelector<HTMLButtonElement>('[data-question="primaryUse"][data-option="news"]')!.click();
    document.querySelector<HTMLButtonElement>('.pro-activation-about-save')!.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.querySelector<HTMLElement>('.pro-activation-overlay')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onSkipStep).not.toHaveBeenCalled();
    expect(document.querySelector('.pro-activation-about')).not.toBeNull();

    release({ ok: true });
    await flush();
  });

  it('a failed save releases the frame, so Escape dismisses again', async () => {
    profile.recordAboutYouAnswers.mockResolvedValue({ ok: false, reason: 'error' });
    const { captured } = await openFlow();
    const about = captured!.steps.findIndex((step) => step.id === 'about');
    const onSkipStep = vi.fn(captured!.onSkipStep);
    openProActivationInterstitial({ ...captured!, steps: captured!.steps.slice(about), onSkipStep });
    document.querySelector<HTMLButtonElement>('[data-question="primaryUse"][data-option="news"]')!.click();
    document.querySelector<HTMLButtonElement>('.pro-activation-about-save')!.click();
    await flush();
    expect(document.querySelector<HTMLButtonElement>('.pro-activation-skip')!.disabled).toBe(false);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onSkipStep).toHaveBeenCalledWith('about');
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
