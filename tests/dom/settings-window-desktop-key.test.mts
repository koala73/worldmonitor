/**
 * Desktop settings window -> Overview: the "Desktop key" box (plan
 * 2026-10-25-001, U6).
 *
 * Pro on desktop works through sign-in, so sign-in leads and the key is the
 * alternative for builds without sign-in. The settings window has no Clerk; it
 * reads the main window's last verified paid-and-signed-in hint
 * (`wm-desktop-cloud-access`, same origin). Without it the window cannot tell a
 * signed-out user from a free one, so the badge stays neutral, never a warning.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import { DESKTOP_CLOUD_ACCESS_HINT_KEY } from '@/services/desktop-cloud-access-hint';

let keyPresent = false;

vi.mock('@/services/i18n', async () => {
  const i18next = (await import('i18next')).default;
  return {
    initI18n: async () => {},
    t: (key: string, options?: Record<string, unknown>) => i18next.t(key, options),
  };
});

vi.mock('@/services/runtime-config', () => ({
  RUNTIME_FEATURES: [],
  getEffectiveSecrets: () => [],
  getRuntimeConfigSnapshot: () => ({ featureToggles: {}, secrets: {} }),
  getSecretState: (key: string) => (
    key === 'WORLDMONITOR_API_KEY' && keyPresent
      ? { present: true, valid: true, source: 'vault' }
      : { present: false, valid: false, source: 'missing' }
  ),
  isFeatureAvailable: () => false,
  isFeatureEnabled: () => false,
  setFeatureToggle: vi.fn(),
  setSecretValue: vi.fn(async () => {}),
  validateSecret: () => ({ valid: true }),
  loadDesktopSecrets: async () => {},
}));

vi.mock('@/services/settings-manager', () => ({
  SettingsManager: class {
    hasPending() { return false; }
    hasPendingChanges() { return false; }
    getValidationState() { return {}; }
    captureUnsavedInputs() {}
    destroy() {}
  },
}));

vi.mock('@/services/runtime', () => ({
  resolveLocalApiPort: async () => 46123,
  startSmartPollLoop: () => ({ stop() {} }),
}));
vi.mock('@/services/tauri-bridge', () => ({
  proxyLocalApiRequest: vi.fn(),
  tryInvokeTauri: vi.fn(async () => null),
}));
vi.mock('@/services/ollama-models', () => ({ fetchOllamaModels: vi.fn(async () => []) }));
vi.mock('@/services/analytics', () => ({ trackFeatureToggle: vi.fn() }));
vi.mock('@/services/font-settings', () => ({ applyFont: () => {} }));
vi.mock('@/utils/theme-manager', () => ({ applyStoredTheme: () => {} }));

const badge = () => document.querySelector<HTMLElement>('.settings-ov-license .wm-badge');
const license = () => document.querySelector<HTMLElement>('.settings-ov-license')!;

async function openSettingsWindow(): Promise<void> {
  vi.resetModules();
  await import('@/settings-main');
  await vi.waitFor(() => expect(badge()).not.toBeNull());
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  keyPresent = false;
  localStorage.clear();
  document.body.innerHTML = '<nav id="sidebarNav"></nav><main id="contentArea"></main>';
});

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe('desktop settings: Desktop key box', () => {
  it('names the box "Desktop key" and says API-plan keys also work', async () => {
    await openSettingsWindow();
    const text = license().textContent ?? '';

    expect(text).toContain('Desktop key');
    expect(text).not.toContain('License / API Key');
    expect(text).toContain('API-plan keys also work');
    expect(text).toContain('shared or public deployments need an API plan');
    expect(text).toContain('worldmonitor.app/docs/api-keys');
    expect(text).toContain('View plans');
  });

  it('shows a signed-in Pro user with no key no warning badge', async () => {
    localStorage.setItem(DESKTOP_CLOUD_ACCESS_HINT_KEY, '1');
    await openSettingsWindow();

    expect(badge()!.classList.contains('warn')).toBe(false);
    expect(badge()!.textContent).not.toContain('Not set');
    expect(badge()!.textContent).toContain('Not needed');
  });

  it('shows a saved key as Active', async () => {
    keyPresent = true;
    await openSettingsWindow();

    expect(badge()!.textContent).toContain('Active');
    expect(badge()!.classList.contains('ok')).toBe(true);
  });

  it('shows a free or signed-out user sign-in first and the key as optional', async () => {
    await openSettingsWindow();

    const sections = [...license().querySelectorAll<HTMLElement>('.wm-section')];
    expect(sections[0]?.textContent).toContain('Sign in with Pro');
    expect(sections[1]?.textContent).toContain('Desktop key');
    expect(badge()!.classList.contains('warn')).toBe(false);
    expect(badge()!.textContent).toContain('Optional');
    expect(badge()!.textContent).not.toContain('Not set');
  });
});
