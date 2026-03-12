import type { UserSettings, AIProviderConfig } from '@/types/news-reader';
import { DEFAULT_SETTINGS } from '@/types/news-reader';

const PREFIX = 'newsreader-ai-';

function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`${PREFIX}${key}`);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as T;
    if (typeof fallback === 'object' && fallback !== null && !Array.isArray(fallback)) {
      return { ...fallback, ...parsed };
    }
    return parsed;
  } catch {
    return fallback;
  }
}

function saveJSON<T>(key: string, value: T): void {
  try {
    localStorage.setItem(`${PREFIX}${key}`, JSON.stringify(value));
  } catch {
    // quota exceeded — silently fail
  }
}

// ── User Settings ─────────────────────────────────────────────────────────

let _settings: UserSettings | null = null;
const _listeners: Array<(s: UserSettings) => void> = [];

export function getSettings(): UserSettings {
  if (!_settings) {
    _settings = loadJSON<UserSettings>('settings', DEFAULT_SETTINGS);
  }
  return _settings;
}

export function updateSettings(partial: Partial<UserSettings>): UserSettings {
  const current = getSettings();
  _settings = { ...current, ...partial };
  saveJSON('settings', _settings);
  for (const fn of _listeners) fn(_settings);
  return _settings;
}

export function onSettingsChange(fn: (s: UserSettings) => void): () => void {
  _listeners.push(fn);
  return () => {
    const idx = _listeners.indexOf(fn);
    if (idx >= 0) _listeners.splice(idx, 1);
  };
}

// ── AI Provider Config ────────────────────────────────────────────────────

const DEFAULT_AI_CONFIG: AIProviderConfig = {
  provider: 'openai',
  apiKey: '',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  maxTokens: 300,
  validated: false,
};

// Simple XOR-based obfuscation for API key storage (not true encryption,
// but prevents plain-text storage). For real security use Web Crypto AES-GCM.
const OBFUSCATION_KEY = 'newsreader-key-v1';

function obfuscate(text: string): string {
  const result: number[] = [];
  for (let i = 0; i < text.length; i++) {
    result.push(text.charCodeAt(i) ^ OBFUSCATION_KEY.charCodeAt(i % OBFUSCATION_KEY.length));
  }
  return btoa(String.fromCharCode(...result));
}

function deobfuscate(encoded: string): string {
  try {
    const decoded = atob(encoded);
    const result: number[] = [];
    for (let i = 0; i < decoded.length; i++) {
      result.push(decoded.charCodeAt(i) ^ OBFUSCATION_KEY.charCodeAt(i % OBFUSCATION_KEY.length));
    }
    return String.fromCharCode(...result);
  } catch {
    return '';
  }
}

export function getAIConfig(): AIProviderConfig {
  const config = loadJSON<AIProviderConfig>('ai-config', DEFAULT_AI_CONFIG);
  // Deobfuscate API key
  if (config.apiKey) {
    config.apiKey = deobfuscate(config.apiKey);
  }
  return config;
}

export function saveAIConfig(config: AIProviderConfig): void {
  const toStore = { ...config };
  if (toStore.apiKey) {
    toStore.apiKey = obfuscate(toStore.apiKey);
  }
  saveJSON('ai-config', toStore);
}

export function hasAIConfigured(): boolean {
  const config = getAIConfig();
  return Boolean(config.apiKey && config.baseUrl && config.model);
}
