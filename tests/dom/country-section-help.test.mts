import { beforeEach, describe, expect, it } from 'vitest';
import { CountryDeepDivePanel } from '@/components/CountryDeepDivePanel';
import type { BriefSectionId } from '@/components/country-brief-presentation';

type SectionFactory = {
  sectionCard(id: BriefSectionId, title: string, helpText?: string): [HTMLElement, HTMLElement];
};

beforeEach(() => { document.body.replaceChildren(); });

describe('Country section help', () => {
  it('reveals and hides the explanation through the native button without moving focus', () => {
    const panel = new CountryDeepDivePanel(null) as unknown as SectionFactory;
    const help = 'Synthetic workforce explanation.';
    const [card] = panel.sectionCard('demographics', 'Demographics & Workforce', help);
    document.body.append(card);
    const button = card.querySelector<HTMLButtonElement>('button')!;
    expect(button.type).toBe('button');
    expect(button.getAttribute('aria-label')).toBe('About Demographics & Workforce');
    button.focus();
    button.click();
    expect(card.textContent).toContain(help);
    const explanation = document.getElementById(button.getAttribute('aria-controls')!)!;
    expect(explanation.hidden).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('aria-describedby')).toBe(explanation.id);
    expect(document.activeElement).toBe(button);
    button.click();
    expect(explanation.hidden).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(button);
  });

  it('keeps separate collapsed descriptions and literal help text through body updates', () => {
    const panel = new CountryDeepDivePanel(null) as unknown as SectionFactory;
    const help = '<img src="invalid" onerror="throw 1"> is explanatory text.';
    const [first, body] = panel.sectionCard('demographics', 'Workforce', help);
    const [second] = panel.sectionCard('energy', 'Energy', 'Synthetic energy explanation.');
    document.body.append(first, second);
    const buttons = [first, second].map(card => card.querySelector<HTMLButtonElement>('button')!);
    const descriptions = buttons.map(button => document.getElementById(button.getAttribute('aria-controls')!));
    expect(descriptions[0]?.textContent).toBe(help);
    expect(descriptions[1]?.textContent).toBe('Synthetic energy explanation.');
    expect(descriptions[0]!.id).not.toBe(descriptions[1]!.id);
    for (const [index, button] of buttons.entries()) {
      expect(button.getAttribute('aria-expanded')).toBe('false');
      expect(button.getAttribute('aria-describedby')).toBe(descriptions[index]!.id);
      expect(descriptions[index]!.hidden).toBe(true);
    }
    body.replaceChildren(document.createTextNode('Updated synthetic data.'));
    buttons[0]!.click();
    expect(first.contains(descriptions[0]!)).toBe(true);
    expect(descriptions[0]!.hidden).toBe(false);
    expect(descriptions[0]!.textContent).toBe(help);
    expect(first.querySelector('img')).toBeNull();
    expect(body.textContent).toBe('Updated synthetic data.');
  });

  it('adds no help control or explanation when help text is absent', () => {
    const panel = new CountryDeepDivePanel(null) as unknown as SectionFactory;
    const [card, body] = panel.sectionCard('facts', 'Country Facts');
    expect(card.querySelector('button')).toBeNull();
    expect(card.querySelector('p')).toBeNull();
    expect(body.className).toBe('cdp-card-body');
  });
});
