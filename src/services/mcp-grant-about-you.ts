/**
 * Optional About-you questions on the MCP connect screen (U4, R7). Rendered as
 * a collapsed section under the consent details, only when the account has not
 * answered or skipped. The grant never waits on it (KTD7): answers are sent in
 * a separate fire-and-forget write when the user authorizes.
 *
 * The connect page is English-only, so these labels are too; the option ids
 * come from the shared taxonomy like every other surface.
 */
import {
  ABOUT_YOU_CHOICE_QUESTIONS,
  type AboutYouChoiceQuestionId,
} from '../../shared/audience-profile';
import type { AboutYouStatus } from './onboarding-prompt';

type WriteResult = { ok: boolean };

export interface McpAboutYouDeps {
  loadStatus(): Promise<AboutYouStatus | null>;
  recordAnswers(answers: Partial<Record<AboutYouChoiceQuestionId, string>>): Promise<WriteResult>;
  skip(): Promise<WriteResult>;
}

export interface McpAboutYouSection {
  /** Send any chosen answers. Never awaits; never throws. */
  submit(): void;
}

const QUESTIONS: ReadonlyArray<{ id: AboutYouChoiceQuestionId; label: string; options: Record<string, string> }> = [
  {
    id: 'primaryUse',
    label: 'What will you mainly use World Monitor for?',
    options: {
      news: 'News and world events',
      markets: 'Markets and trading',
      commodities: 'Commodities and supply chain',
      travel: 'Travel and flights',
      security: 'Security and OSINT',
      research: 'Research and journalism',
      'api-agent': 'Building with the API or an AI agent',
      other: 'Something else',
    },
  },
  { id: 'usageContext', label: 'Work or personal use?', options: { personal: 'Personal', work: 'Work' } },
  {
    id: 'payer',
    label: 'Who pays for it?',
    options: { self: 'I do', employer: 'My employer or team', 'not-paying': 'Nobody yet' },
  },
];

const SECTION_ID = 'mcpAboutYou';

/**
 * Read the status within `timeoutMs` and, when due, render the section into
 * `container`. Resolves to null when nothing was rendered.
 */
export async function mountMcpAboutYou(
  container: HTMLElement,
  deps: McpAboutYouDeps,
  timeoutMs: number,
): Promise<McpAboutYouSection | null> {
  if (document.getElementById(SECTION_ID)) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const status = await Promise.race([
    deps.loadStatus().catch(() => null),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  if (status?.status !== 'due' || document.getElementById(SECTION_ID)) return null;

  const answers: Partial<Record<AboutYouChoiceQuestionId, string>> = {};
  let settled = false;

  const section = document.createElement('details');
  section.id = SECTION_ID;
  section.className = 'about-you';
  const summary = document.createElement('summary');
  summary.textContent = 'Help us improve World Monitor (optional)';
  section.append(summary);

  for (const question of QUESTIONS) {
    const labelId = `${SECTION_ID}-${question.id}`;
    const label = document.createElement('p');
    label.id = labelId;
    label.className = 'about-you-label';
    label.textContent = question.label;
    const group = document.createElement('div');
    group.className = 'about-you-options';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-labelledby', labelId);
    for (const optionId of ABOUT_YOU_CHOICE_QUESTIONS[question.id]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'about-you-option';
      button.dataset.question = question.id;
      button.dataset.option = optionId;
      button.setAttribute('aria-pressed', 'false');
      button.textContent = question.options[optionId] ?? optionId;
      button.addEventListener('click', () => {
        const same = answers[question.id] === optionId;
        if (same) delete answers[question.id];
        else answers[question.id] = optionId;
        for (const sibling of group.querySelectorAll('button')) {
          sibling.setAttribute('aria-pressed', String(!same && sibling === button));
        }
      });
      group.append(button);
    }
    section.append(label, group);
  }

  const notNow = document.createElement('button');
  notNow.type = 'button';
  notNow.className = 'about-you-not-now';
  notNow.textContent = 'Not now';
  notNow.addEventListener('click', () => {
    if (settled) return;
    settled = true;
    section.remove();
    void deps.skip().catch(() => undefined);
  });
  section.append(notNow);
  container.append(section);

  return {
    submit(): void {
      if (settled || Object.keys(answers).length === 0) return;
      settled = true;
      void deps.recordAnswers({ ...answers }).catch(() => undefined);
    },
  };
}
