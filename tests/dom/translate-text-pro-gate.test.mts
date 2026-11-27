/**
 * translateText is Pro. A free browser may send exactly two translate
 * requests, both on the plain client: Hebrew OREF alerts into English, and the
 * desktop app's own local model. Pro translation carries the credential.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const access = vi.hoisted(() => ({ premium: false, desktop: false, ollama: false }));
const premiumFetch = vi.hoisted(() => vi.fn());

vi.mock('@/services/ml-worker', () => ({
  mlWorker: { isAvailable: false, isModelLoaded: () => false, loadModel: vi.fn(), summarize: vi.fn() },
}));
vi.mock('@/config/beta', () => ({ BETA_MODE: false }));
vi.mock('@/services/analytics', () => ({ trackLLMUsage: vi.fn(), trackLLMFailure: vi.fn() }));
vi.mock('@/services/i18n', () => ({ getCurrentLanguage: () => 'en', t: (key: string) => key }));
vi.mock('@/services/panel-gating', () => ({ hasPremiumAccess: () => access.premium }));
vi.mock('@/services/desktop-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/desktop-runtime')>()),
  isDesktopRuntime: () => access.desktop,
}));
vi.mock('@/services/runtime-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/runtime-config')>()),
  isFeatureAvailable: (id: string) => id === 'aiOpenRouter' || (id === 'aiOllama' && access.ollama),
}));
vi.mock('@/services/premium-fetch', () => ({ premiumFetch }));

import { translateText } from '@/services/summarization';

const HEBREW = 'ירי רקטות וטילים';
const answer = (summary: string) => new Response(JSON.stringify({ summary, fallback: false, status: 'SUMMARIZE_STATUS_SUCCESS' }), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});
const plainFetch = vi.fn();
let seq = 0;
const unique = (text: string) => `${text} ${++seq}`;
const sentProviders = (spy: typeof plainFetch) =>
  spy.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)).provider);

beforeEach(() => {
  Object.assign(access, { premium: false, desktop: false, ollama: false });
  plainFetch.mockReset().mockImplementation(async () => answer('plain'));
  premiumFetch.mockReset().mockImplementation(async () => answer('pro'));
  vi.stubGlobal('fetch', plainFetch);
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('translateText Pro gate', () => {
  it('sends nothing for a free reader translating a headline', async () => {
    expect(await translateText(unique('Parliament passes the budget'), 'de')).toBeNull();
    expect(plainFetch).not.toHaveBeenCalled();
    expect(premiumFetch).not.toHaveBeenCalled();
  });

  it('sends nothing for Hebrew into a language other than English', async () => {
    expect(await translateText(unique(HEBREW), 'de')).toBeNull();
    expect(plainFetch).not.toHaveBeenCalled();
    expect(premiumFetch).not.toHaveBeenCalled();
  });

  it('translates a Hebrew alert into English for a free reader on the plain client', async () => {
    expect(await translateText(unique(HEBREW), 'en')).toBe('plain');
    expect(plainFetch).toHaveBeenCalledTimes(1);
    expect(premiumFetch).not.toHaveBeenCalled();
  });

  it('sends a Pro translation with the credential', async () => {
    access.premium = true;
    expect(await translateText(unique('Parliament passes the budget'), 'de')).toBe('pro');
    expect(premiumFetch).toHaveBeenCalledTimes(1);
    expect(premiumFetch.mock.calls[0]?.[1]).toMatchObject({ forcePremium: true });
    expect(plainFetch).not.toHaveBeenCalled();
  });

  it('lets a free desktop reader use the local model only', async () => {
    Object.assign(access, { desktop: true, ollama: true });
    plainFetch.mockImplementation(async () => new Response(JSON.stringify({ summary: '', fallback: true }), { status: 200 }));
    expect(await translateText(unique('Parliament passes the budget'), 'de')).toBeNull();
    expect(sentProviders(plainFetch)).toEqual(['ollama']);
    expect(premiumFetch).not.toHaveBeenCalled();
  });

  it('honours the 429 cooldown: no second provider and no later Pro request', async () => {
    Object.assign(access, { premium: true, ollama: true });
    premiumFetch.mockImplementation(async () => new Response('{}', { status: 429, headers: { 'Retry-After': '60' } }));
    expect(await translateText(unique('Parliament passes the budget'), 'de')).toBeNull();
    expect(premiumFetch).toHaveBeenCalledTimes(1);
    expect(await translateText(unique('Parliament passes the budget'), 'de')).toBeNull();
    expect(premiumFetch).toHaveBeenCalledTimes(1);
  });
});
