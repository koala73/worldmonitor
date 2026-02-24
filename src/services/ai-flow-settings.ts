/**
 * AI Flow Settings — Web-only user preferences for AI analysis pipeline.
 * Controls which AI providers the InsightsPanel uses.
 * Desktop (Tauri) manages AI config via its own settings window.
 */

const STORAGE_KEY_BROWSER_MODEL = 'wm-ai-flow-browser-model';
const STORAGE_KEY_CLOUD_LLM = 'wm-ai-flow-cloud-llm';
const EVENT_NAME = 'ai-flow-changed';

export interface AiFlowSettings {
  browserModel: boolean;
  cloudLlm: boolean;
}

function readBool(key: string, defaultValue: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return defaultValue;
    return raw === 'true';
  } catch {
    return defaultValue;
  }
}

function writeBool(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Quota or private-browsing; silently ignore
  }
}

export function getAiFlowSettings(): AiFlowSettings {
  return {
    browserModel: readBool(STORAGE_KEY_BROWSER_MODEL, false),
    cloudLlm: readBool(STORAGE_KEY_CLOUD_LLM, true),
  };
}

export function setAiFlowSetting(key: keyof AiFlowSettings, value: boolean): void {
  const storageKey = key === 'browserModel' ? STORAGE_KEY_BROWSER_MODEL : STORAGE_KEY_CLOUD_LLM;
  writeBool(storageKey, value);
  window.dispatchEvent(new CustomEvent(EVENT_NAME));
}

export function isAnyAiProviderEnabled(): boolean {
  const s = getAiFlowSettings();
  return s.cloudLlm || s.browserModel;
}

export function subscribeAiFlowChange(cb: () => void): () => void {
  const handler = () => cb();
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}
