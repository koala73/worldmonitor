import { expect, it, vi } from 'vitest';

vi.mock('@/components/Panel', () => ({ Panel: class {
  element = document.body.appendChild(document.createElement('div'));
  content = this.element.appendChild(document.createElement('div'));
  count = '';
  setCount(count: number) { this.count = String(count); }
  setTrustedContent() {}
} }));
vi.mock('@/services/i18n', () => ({ t: (key: string) => key, getCurrentLanguageTag: () => 'en' }));
import { PositiveNewsFeedPanel } from '@/components/PositiveNewsFeedPanel';

it('counts the stories the active category filter shows', () => {
  const panel = new PositiveNewsFeedPanel();
  const story = (title: string, happyCategory: string) => ({ title, happyCategory, source: 'GNN', link: `https://example.org/${title}`, pubDate: new Date(0), isAlert: false });
  panel.renderPositiveNews([story('A', 'science-health'), story('B', 'science-health'), story('C', 'nature-wildlife')] as never);
  expect(panel['count']).toBe('3');
  panel.element.querySelector<HTMLButtonElement>('[data-category="nature-wildlife"]')!.click();
  expect(panel['count']).toBe('1');
});
