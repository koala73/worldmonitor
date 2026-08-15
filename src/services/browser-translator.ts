/**
 * On-device translation via the browser's built-in Translator API
 * (Chromium 138+; https://developer.mozilla.org/docs/Web/API/Translator).
 *
 * This is the zero-setup path for headline auto-translation: no API keys, no
 * server spend, works offline once the browser has the language pack. The
 * headline-translation service tries this first and falls back to the server
 * LLM chain (Ollama/Groq/OpenRouter) when the API or language pair is
 * unavailable (non-Chromium browsers, unsupported pairs).
 *
 * Caveats handled here:
 *  - Language-pack downloads may require a user gesture. warmBrowserTranslator()
 *    is called from settings interactions (toggle / language select) so the
 *    download can start inside a click; background translate attempts simply
 *    fail closed to the server chain until the pack is present.
 *  - create() can hang while a pack downloads — attempts are capped by a soft
 *    timeout and retried on later calls.
 */

const CREATE_TIMEOUT_MS = 10_000;

interface TranslatorInstance {
  translate(text: string): Promise<string>;
}

interface TranslatorStatic {
  availability(opts: { sourceLanguage: string; targetLanguage: string }): Promise<string>;
  create(opts: { sourceLanguage: string; targetLanguage: string }): Promise<TranslatorInstance>;
}

function getTranslatorApi(): TranslatorStatic | null {
  const api = (globalThis as { Translator?: unknown }).Translator;
  if (!api || (typeof api !== 'object' && typeof api !== 'function')) return null;
  const candidate = api as Partial<TranslatorStatic>;
  return typeof candidate.availability === 'function' && typeof candidate.create === 'function'
    ? candidate as TranslatorStatic
    : null;
}

/**
 * BCP-47 candidates for an app language code. The app uses bare codes ('ja',
 * 'zh'); the Translator API wants BCP-47 and Chinese is only served as
 * script-tagged variants, so 'zh' probes 'zh-Hans' first.
 */
export function translatorLanguageCandidates(lang: string): string[] {
  const norm = (lang || '').trim();
  if (!norm) return [];
  if (norm === 'zh') return ['zh-Hans', 'zh'];
  return [norm];
}

/** target lang → resolved instance (null = resolved as unavailable) */
const instances = new Map<string, TranslatorInstance | null>();
/** target lang → in-flight resolution */
const pending = new Map<string, Promise<TranslatorInstance | null>>();

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('translator create timeout')), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

async function resolveTranslator(targetLang: string): Promise<TranslatorInstance | null> {
  const api = getTranslatorApi();
  if (!api) return null;
  for (const candidate of translatorLanguageCandidates(targetLang)) {
    try {
      const availability = await api.availability({ sourceLanguage: 'en', targetLanguage: candidate });
      if (availability === 'unavailable') continue;
      return await withTimeout(api.create({ sourceLanguage: 'en', targetLanguage: candidate }), CREATE_TIMEOUT_MS);
    } catch {
      // Pack still downloading, user-activation required, or pair rejected —
      // try the next candidate / leave uncached so a later attempt retries.
    }
  }
  return null;
}

function getTranslator(targetLang: string): Promise<TranslatorInstance | null> {
  const cached = instances.get(targetLang);
  if (cached !== undefined) return Promise.resolve(cached);
  let inFlight = pending.get(targetLang);
  if (!inFlight) {
    inFlight = resolveTranslator(targetLang).then((instance) => {
      pending.delete(targetLang);
      // Only cache positive results — a null may just mean "pack not ready
      // yet"; retrying on a later chunk is cheap and self-heals.
      if (instance) instances.set(targetLang, instance);
      return instance;
    });
    pending.set(targetLang, inFlight);
  }
  return inFlight;
}

/**
 * Kick off translator resolution (and thereby the language-pack download)
 * from inside a user gesture. Fire-and-forget.
 */
export function warmBrowserTranslator(targetLang: string): void {
  if (!targetLang || targetLang === 'en') return;
  void getTranslator(targetLang);
}

/**
 * Translate English texts on-device. Returns null when the API/pair is
 * unavailable (caller falls back to the server chain); otherwise an array
 * aligned 1:1 with `texts` (per-text failures stay null).
 */
export async function translateTextsInBrowser(
  texts: string[],
  targetLang: string,
): Promise<Array<string | null> | null> {
  const translator = await getTranslator(targetLang);
  if (!translator) return null;
  const out: Array<string | null> = [];
  for (const text of texts) {
    const trimmed = text.trim();
    if (!trimmed) {
      out.push(null);
      continue;
    }
    try {
      const translated = (await translator.translate(trimmed)).trim();
      out.push(translated.length > 0 ? translated : null);
    } catch {
      out.push(null);
    }
  }
  return out;
}
