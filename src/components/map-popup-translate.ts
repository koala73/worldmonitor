/**
 * On-demand Translate / Original toggle for provider prose in map popups (#10065).
 *
 * Nothing is translated on open: a request is only made when the user presses
 * the button. It reuses the News panel's translateText() chain, so provider
 * availability, feature gating, circuit breaking and error handling stay in one
 * place. The original text is always one click away and translated text is
 * labelled as automatic (and, for official warnings, as not an official
 * translation).
 */
import { getCurrentLanguageTag, t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';

export type TranslateFn = (text: string, targetLang: string) => Promise<string | null>;

export interface TranslatableTextOptions {
  /** Class of the paragraph holding the text (popup-description, popup-headline…). */
  className: string;
  /** Render (and translate) only this many characters, preserving the ellipsis. */
  maxLength?: number;
  /** Official warning text: show the "not an official translation" notice. */
  official?: boolean;
}

const ELLIPSIS = '...';

const defaultTranslate: TranslateFn = async (text, targetLang) => {
  const { translateText } = await import('@/services/summarization');
  return translateText(text, targetLang);
};

/** Render a prose block with an (inactive) translate button for non-English UIs. */
export function renderTranslatableText(text: string, opts: TranslatableTextOptions): string {
  const truncated = typeof opts.maxLength === 'number' && text.length > opts.maxLength;
  const excerpt = truncated ? text.slice(0, opts.maxLength) : text;
  const shown = `${escapeHtml(excerpt)}${truncated ? ELLIPSIS : ''}`;
  const lang = getCurrentLanguageTag();
  // Truncated prose keeps the complete original one click away; only the excerpt is translated.
  const fullOriginal = truncated
    ? `<details class="popup-full-original"><summary>${escapeHtml(t('popups.mapPopup.translate.fullOriginal'))}</summary>`
      + `<p class="${opts.className}">${escapeHtml(text)}</p></details>`
    : '';
  if (lang === 'en' || !excerpt.trim()) {
    return `<p class="${opts.className}">${shown}</p>${fullOriginal}`;
  }
  const label = t('popups.mapPopup.translate.translate');
  return `<div class="popup-translatable" data-state="original"${truncated ? ' data-truncated="1"' : ''}${opts.official ? ' data-official="1"' : ''}>`
    + `<p class="${opts.className} popup-translatable-text" data-source="${escapeHtml(excerpt)}">${shown}</p>`
    + `<button type="button" class="popup-translate-btn" aria-pressed="false" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">文</button>`
    + `</div>${fullOriginal}`;
}

export class PopupProseTranslator {
  private static cache = new Map<string, string>();

  constructor(private readonly translate: TranslateFn = defaultTranslate) {}

  static clearCache(): void {
    PopupProseTranslator.cache.clear();
  }

  /**
   * Toggle one block. `isCurrent` must return false once the popup that owns
   * the button has been replaced or closed, so a late response for marker A
   * can never be written into marker B.
   */
  async toggle(button: HTMLButtonElement, isCurrent: () => boolean): Promise<void> {
    const block = button.closest<HTMLElement>('.popup-translatable');
    const textEl = block?.querySelector<HTMLElement>('.popup-translatable-text');
    if (!block || !textEl) return;
    const state = block.dataset.state;
    if (state === 'translating') return;
    if (state === 'translated') {
      this.showOriginal(block, textEl, button);
      return;
    }

    const source = textEl.dataset.source ?? '';
    const lang = getCurrentLanguageTag();
    if (!source || lang === 'en') return;
    block.querySelector('.popup-translation-error')?.remove();

    const cacheKey = `${lang}\u0000${source}`;
    const cached = PopupProseTranslator.cache.get(cacheKey);
    if (cached) {
      this.showTranslated(block, textEl, button, cached);
      return;
    }

    block.dataset.state = 'translating';
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = '…';
    let translated: string | null = null;
    try {
      translated = await this.translate(source, lang);
    } catch (err) {
      console.warn('[MapPopup] translation failed', err);
      translated = null;
    }
    if (!isCurrent() || !button.isConnected) return;
    button.disabled = false;
    button.removeAttribute('aria-busy');
    const clean = typeof translated === 'string' ? translated.trim() : '';
    if (clean) {
      PopupProseTranslator.cache.set(cacheKey, clean);
      this.showTranslated(block, textEl, button, clean);
      return;
    }
    block.dataset.state = 'original';
    button.textContent = '文';
    const error = document.createElement('span');
    error.className = 'popup-translation-error';
    error.setAttribute('role', 'status');
    error.textContent = t('components.newsPanel.translationUnavailable');
    block.appendChild(error);
  }

  private showTranslated(block: HTMLElement, textEl: HTMLElement, button: HTMLButtonElement, translated: string): void {
    const truncated = block.dataset.truncated === '1';
    if (textEl.dataset.originalShown === undefined) textEl.dataset.originalShown = textEl.textContent ?? '';
    textEl.textContent = `${translated}${truncated ? ELLIPSIS : ''}`;
    textEl.setAttribute('lang', getCurrentLanguageTag());
    block.dataset.state = 'translated';
    block.querySelector('.popup-translation-note')?.remove();
    const note = document.createElement('span');
    note.className = 'popup-translation-note';
    note.textContent = block.dataset.official === '1'
      ? `${t('popups.mapPopup.translate.automatic')} · ${t('popups.mapPopup.translate.notOfficial')}`
      : t('popups.mapPopup.translate.automatic');
    block.insertBefore(note, button);
    const label = t('popups.mapPopup.translate.showOriginal');
    button.textContent = label;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', 'true');
  }

  private showOriginal(block: HTMLElement, textEl: HTMLElement, button: HTMLButtonElement): void {
    textEl.textContent = textEl.dataset.originalShown ?? textEl.textContent;
    textEl.removeAttribute('lang');
    block.dataset.state = 'original';
    block.querySelector('.popup-translation-note')?.remove();
    const label = t('popups.mapPopup.translate.translate');
    button.textContent = '文';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', 'false');
  }
}
