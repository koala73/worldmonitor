/**
 * The About-you card: a docked, non-modal panel that asks one question at a
 * time and saves each answer as it is given (KTD5). Lazy-loaded from
 * `src/app/event-handlers.ts` so the dashboard main chunk does not carry it.
 *
 * Not a dialog: it never takes focus on open, never blocks the map, and never
 * counts as an open modal. Each choice saves on tap and typed text saves after
 * a short pause, so a reload loses nothing and the reload guards may treat it
 * as safe.
 *
 * Escape is handled only while focus is inside the card. A non-modal panel that
 * caught every Escape on the page would turn an unrelated Escape (closing a
 * popover or fullscreen) into a permanent skip.
 */
import {
  ABOUT_YOU_CHOICE_QUESTIONS,
  ABOUT_YOU_FREE_TEXT_MAX,
  isAboutYouChoiceQuestion,
  type AboutYouChoiceQuestionId,
  type AboutYouQuestionId,
  type AboutYouSurface,
} from '../../shared/audience-profile';
import type { ProfileWriteResult } from '@/services/audience-profile';
import { t } from '@/services/i18n';
import { declareOverlay } from '@/utils/open-modal';
import { ABOUT_YOU_CARD_CSS } from './about-you-card-styles';

export const ABOUT_YOU_CARD_ID = 'wm-about-you-card';
const STYLE_ID = 'wm-about-you-card-style';
const THANKS_DISMISS_MS = 4_000;
/** Typed free text saves after this pause, so a reload loses at most this much. */
const FREE_TEXT_AUTOSAVE_MS = 1_500;

export interface AboutYouCardDeps {
  recordAnswer(questionId: AboutYouChoiceQuestionId, optionId: string): Promise<ProfileWriteResult>;
  recordFreeText(text: string): Promise<ProfileWriteResult>;
  skip(): Promise<ProfileWriteResult>;
  markReturnShown(): Promise<ProfileWriteResult>;
  track(event: 'about-you-shown' | 'about-you-answered' | 'about-you-skipped', data: Record<string, unknown>): void;
}

export interface AboutYouCardOptions {
  mode: 'full' | 'return';
  questions: AboutYouQuestionId[];
  surface: AboutYouSurface;
  deps: AboutYouCardDeps;
  parent?: HTMLElement;
}

function label(key: string, fallback: string, vars?: Record<string, unknown>): string {
  return t(`components.aboutYou.${key}`, { defaultValue: fallback, ...vars });
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function removeAboutYouCard(): void {
  document.getElementById(ABOUT_YOU_CARD_ID)?.remove();
}

/** Mount the card. Returns the root element, or null if one is already open. */
export function mountAboutYouCard(options: AboutYouCardOptions): HTMLElement | null {
  if (document.getElementById(ABOUT_YOU_CARD_ID)) return null;
  const { mode, questions, surface, deps } = options;
  if (questions.length === 0) return null;

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = ABOUT_YOU_CARD_CSS;
    document.head.appendChild(style);
  }

  const root = el('section', 'about-you-card');
  root.id = ABOUT_YOU_CARD_ID;
  root.setAttribute('role', 'region');
  root.setAttribute('aria-labelledby', `${ABOUT_YOU_CARD_ID}-title`);
  declareOverlay(root, { reload: 'safe' });

  const header = el('div', 'about-you-card__header');
  const title = el('h2', 'about-you-card__title', label('title', 'Help us build World Monitor for you'));
  title.id = `${ABOUT_YOU_CARD_ID}-title`;
  const closeBtn = el('button', 'about-you-card__close', '×');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', label('close', 'Close'));
  header.append(title, closeBtn);

  // The step meter: one segment per question; the count is the text form.
  const progress = el('div', 'about-you-card__progress');
  const meter = el('div', 'about-you-card__meter');
  meter.setAttribute('aria-hidden', 'true');
  const segments = questions.map(() => {
    const segment = el('span', 'about-you-card__segment');
    meter.append(segment);
    return segment;
  });
  const count = el('span', 'about-you-card__count');
  progress.append(meter, count);
  progress.hidden = questions.length < 2;
  const body = el('div', 'about-you-card__body');
  const status = el('p', 'about-you-card__status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const footer = el('div', 'about-you-card__footer');
  const skipBtn = el('button', 'about-you-card__skip', label('skip', 'Skip'));
  skipBtn.type = 'button';
  footer.append(skipBtn);

  root.append(header, progress, body, status, footer);
  (options.parent ?? document.body).appendChild(root);

  let step = 0;
  let answeredAny = false;
  let finished = false;
  let saving = false;
  let freeTextSave: Promise<ProfileWriteResult> | null = null;
  let lastSavedText = '';
  let autosaveTimer: number | undefined;
  const cancelAutosave = (): void => {
    if (autosaveTimer !== undefined) window.clearTimeout(autosaveTimer);
    autosaveTimer = undefined;
  };

  deps.track('about-you-shown', { surface, mode, questionCount: questions.length });
  if (mode === 'return') void deps.markReturnShown();

  const close = (): void => {
    cancelAutosave();
    finished = true;
    root.remove();
  };

  const finish = (): void => {
    cancelAutosave();
    finished = true;
    body.replaceChildren();
    progress.hidden = true;
    footer.replaceChildren();
    status.textContent = label('thanks', 'Thanks. This helps us decide what to build next.');
    window.setTimeout(close, THANKS_DISMISS_MS);
  };

  const advance = (): void => {
    step += 1;
    if (step >= questions.length) finish();
    else render();
  };

  const saveFreeText = (text: string): Promise<ProfileWriteResult> | null => {
    cancelAutosave();
    const trimmed = text.trim();
    if (!trimmed || trimmed === lastSavedText) return null;
    lastSavedText = trimmed;
    const pending = deps.recordFreeText(trimmed).then((result) => {
      if (result.ok) {
        answeredAny = true;
        deps.track('about-you-answered', { surface, mode, questionId: 'alternative' });
      } else {
        lastSavedText = '';
      }
      return result;
    });
    freeTextSave = pending;
    return pending;
  };

  const showFailure = (onRetry: () => void): void => {
    status.replaceChildren(document.createTextNode(label('saveFailed', "Couldn't save that. Try again.")));
    const retry = el('button', 'about-you-card__retry', label('retry', 'Retry'));
    retry.type = 'button';
    retry.addEventListener('click', onRetry);
    status.append(' ', retry);
  };

  const renderChoice = (questionId: AboutYouChoiceQuestionId): void => {
    const legend = el('p', 'about-you-card__question', label(`questions.${questionId}.label`, questionId));
    legend.id = `${ABOUT_YOU_CARD_ID}-q`;
    const group = el('div', 'about-you-card__options');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-labelledby', legend.id);
    if (ABOUT_YOU_CHOICE_QUESTIONS[questionId].length > 4) group.dataset.layout = 'grid';
    for (const optionId of ABOUT_YOU_CHOICE_QUESTIONS[questionId]) {
      const option = el(
        'button',
        'about-you-card__option',
        label(`questions.${questionId}.options.${optionId}`, optionId),
      );
      option.type = 'button';
      option.dataset.optionId = optionId;
      option.setAttribute('aria-pressed', 'false');
      option.addEventListener('click', () => {
        const choose = (): void => {
          if (saving || finished) return;
          saving = true;
          option.setAttribute('aria-pressed', 'true');
          group.setAttribute('aria-busy', 'true');
          status.textContent = label('saving', 'Saving…');
          void deps.recordAnswer(questionId, optionId).then((result) => {
            saving = false;
            group.removeAttribute('aria-busy');
            if (finished) return;
            if (result.ok) {
              answeredAny = true;
              status.textContent = '';
              deps.track('about-you-answered', { surface, mode, questionId });
              advance();
            } else {
              option.setAttribute('aria-pressed', 'false');
              showFailure(choose);
            }
          });
        };
        choose();
      });
      group.append(option);
    }
    body.replaceChildren(legend, group);
  };

  const renderFreeText = (): void => {
    const textareaId = `${ABOUT_YOU_CARD_ID}-alternative`;
    const prompt = el('label', 'about-you-card__question', label('questions.alternative.label', "What would you use if World Monitor didn't exist?"));
    prompt.htmlFor = textareaId;
    const textarea = el('textarea', 'about-you-card__text');
    textarea.id = textareaId;
    textarea.rows = 2;
    textarea.maxLength = ABOUT_YOU_FREE_TEXT_MAX;
    textarea.placeholder = label('questions.alternative.placeholder', 'Optional');
    textarea.addEventListener('blur', () => void saveFreeText(textarea.value));
    // The card declares itself reload-safe, so typed text must not wait for blur.
    textarea.addEventListener('input', () => {
      cancelAutosave();
      autosaveTimer = window.setTimeout(() => {
        autosaveTimer = undefined;
        if (!finished) void saveFreeText(textarea.value);
      }, FREE_TEXT_AUTOSAVE_MS);
    });
    const done = el('button', 'about-you-card__done', label('done', 'Done'));
    done.type = 'button';
    done.addEventListener('click', () => {
      const submit = (): void => {
        const pending = saveFreeText(textarea.value) ?? freeTextSave;
        if (!pending) {
          finish();
          return;
        }
        status.textContent = label('saving', 'Saving…');
        void pending.then((result) => {
          if (finished) return;
          if (result.ok) finish();
          else showFailure(submit);
        });
      };
      submit();
    });
    body.replaceChildren(prompt, textarea, done);
  };

  function render(): void {
    const questionId = questions[step]!;
    count.textContent = label('progress', `${step + 1} of ${questions.length}`, {
      current: step + 1,
      total: questions.length,
    });
    segments.forEach((segment, index) => {
      segment.dataset.state = index < step ? 'done' : index === step ? 'current' : 'todo';
    });
    status.textContent = '';
    if (isAboutYouChoiceQuestion(questionId)) renderChoice(questionId);
    else renderFreeText();
  }

  const skipAll = async (): Promise<void> => {
    if (finished) return;
    const questionId = questions[step];
    finished = true;
    root.remove();
    // A free-text answer typed before Skip still counts.
    const textarea = root.querySelector('textarea');
    const pending = (textarea ? saveFreeText(textarea.value) : null) ?? freeTextSave;
    if (pending) await pending;
    deps.track('about-you-skipped', { surface, mode, questionId, answeredAny });
    // The return visit is already recorded as shown; a full-card close is a skip.
    if (mode === 'full') await deps.skip();
  };

  skipBtn.addEventListener('click', () => void skipAll());
  closeBtn.addEventListener('click', () => {
    if (finished) close();
    else void skipAll();
  });
  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    if (finished) close();
    else void skipAll();
  });

  render();
  return root;
}
