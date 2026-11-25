import { expect, it, vi } from 'vitest';

const { generateSummary } = vi.hoisted(() => ({ generateSummary: vi.fn().mockResolvedValue({ summary: "A painter says turning 50 taught him patience." }) }));
vi.mock('@/services/summarization', () => ({ generateSummary }));
vi.mock('@/components/Panel', () => ({ Panel: class {
  element = document.body.appendChild(document.createElement('div'));
  content = this.element.appendChild(document.createElement('div'));
  isLocked = false;
  setContentNodes(...nodes: Node[]) { this.content.replaceChildren(...nodes); }
} }));
vi.mock('@/services/i18n', () => ({ t: (key: string) => key }));
import { GoodThingsDigestPanel } from '@/components/GoodThingsDigestPanel';

it('summarizes each story alone from its own article text, and shows the headline when there is none', async () => {
  const panel = new GoodThingsDigestPanel();
  const story = (title: string, snippet?: string) => ({ title, snippet, source: 'Upworthy', link: `https://example.org/${title}`, pubDate: new Date(0), isAlert: false });
  await panel.setStories([
    story("Artist shares 5 things he sees 'differently' after 50", 'A painter reflects on patience and curiosity.'),
    story('Town opens free tool library'),
  ] as never);
  expect(generateSummary).toHaveBeenCalledTimes(1);
  expect(generateSummary.mock.calls[0]?.[0]).toEqual(["Artist shares 5 things he sees 'differently' after 50"]);
  expect(generateSummary.mock.calls[0]?.[4]).toMatchObject({ mode: 'article', bodies: ['A painter reflects on patience and curiosity.'] });
  const summaries = [...panel['content'].querySelectorAll('.digest-card-summary')].map((el) => el.textContent);
  expect(summaries).toEqual(['A painter says turning 50 taught him patience.', 'Town opens free tool library']);
});
