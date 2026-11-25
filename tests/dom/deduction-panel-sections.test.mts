import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

const { deductSituation } = vi.hoisted(() => ({ deductSituation: vi.fn() }));
vi.mock('@/services/generated-rpc-clients', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/generated-rpc-clients')>(),
  IntelligenceServiceClient: class { deductSituation = deductSituation; },
}));

// happy-dom breaks DOMPurify's tree walk (see deduction-purify-config.test.mts),
// so sanitizing here would reshape the markup before the panel formats it.
vi.mock('dompurify', () => ({ default: { sanitize: (html: string) => html } }));

import { DeductionPanel } from '@/components/DeductionPanel';

beforeAll(async () => {
  await initTestI18n();
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function renderAnalysis(analysis: string): Promise<HTMLElement> {
  deductSituation.mockResolvedValueOnce({ analysis, provider: 'test' });
  const panel = new DeductionPanel();
  document.body.append(panel.getElement());
  panel.getElement().querySelector<HTMLTextAreaElement>('.deduction-input')!.value = 'What happens next?';
  await (panel as unknown as { handleSubmit: (event: Event) => Promise<void> }).handleSubmit(new Event('submit'));
  return panel.getElement().querySelector<HTMLElement>('.deduction-result')!;
}

function sectionBody(result: HTMLElement, cls: string): string {
  const section = result.querySelector(`.${cls}`)?.cloneNode(true) as HTMLElement | undefined;
  section?.querySelector('.ds-section-label')?.remove();
  return section?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

describe('DeductionPanel section formatting', () => {
  it('keeps summary and confidence text written on the heading line', async () => {
    const result = await renderAnalysis([
      '**Bottom line** Talks are likely to stall this week.',
      '',
      '**What we know**',
      '- Delegations left Doha on Monday.',
      '',
      '**Most likely path (next 24 hours)** No agreement is signed.',
      '',
      '**Alternative paths** -5% for Brent if talks resume.',
      '',
      '**Confidence** — Medium: two sources agree, one is unconfirmed.',
    ].join('\n'));

    expect(sectionBody(result, 'ds-verdict')).toBe('Talks are likely to stall this week.');
    expect(sectionBody(result, 'ds-evidence')).toBe('Delegations left Doha on Monday.');
    expect(result.querySelector('.ds-primary .ds-section-label')?.textContent).toBe('Most Likely Pathnext 24 hours');
    expect(sectionBody(result, 'ds-primary')).toBe('No agreement is signed.');
    expect(sectionBody(result, 'ds-alt')).toBe('-5% for Brent if talks resume.');
    expect(sectionBody(result, 'ds-confidence')).toBe('Medium: two sources agree, one is unconfirmed.');
  });

  it('keeps heading-line text when the section also has bullets', async () => {
    const result = await renderAnalysis([
      '**Bottom line**',
      'Talks are likely to stall.',
      '- Neither side has moved on borders.',
    ].join('\n'));

    expect(sectionBody(result, 'ds-verdict')).toBe('Talks are likely to stall. Neither side has moved on borders.');
  });
});
