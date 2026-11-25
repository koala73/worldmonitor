import { expect, it, vi } from 'vitest';

const counts = vi.hoisted(() => [] as number[]);
vi.mock('@/components/Panel', () => ({ Panel: class {
  element = document.body.appendChild(document.createElement('div'));
  content = this.element.appendChild(document.createElement('div'));
  setCount(count: number) { counts.push(count); }
  setTrustedContent() {}
} }));
vi.mock('@/services/i18n', () => ({ t: (key: string) => key, getCurrentLanguageTag: () => 'en' }));
import { PositiveNewsFeedPanel } from '@/components/PositiveNewsFeedPanel';

it('counts the stories the active category filter shows', () => {
  const panel = new PositiveNewsFeedPanel();
  const story = (title: string, happyCategory: string) => ({ title, happyCategory, source: 'GNN', link: `https://example.org/${title}`, pubDate: new Date(0), isAlert: false });
  panel.renderPositiveNews([story('A', 'science-health'), story('B', 'science-health'), story('C', 'nature-wildlife')] as never);
  expect(counts[counts.length - 1]).toBe(3);
  document.body.querySelector<HTMLButtonElement>('button[data-category="nature-wildlife"]')!.click();
  expect(counts[counts.length - 1]).toBe(1);
});
