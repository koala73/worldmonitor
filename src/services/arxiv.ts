import { API_URLS } from '@/config';
import { createCircuitBreaker, fetchWithCache } from '@/utils';

export interface ArxivPaper {
  id: string;
  title: string;
  summary: string;
  authors: string[];
  published: Date;
  updated: Date;
  categories: string[];
  link: string;
  pdfLink: string;
}

const breaker = createCircuitBreaker<ArxivPaper[]>({ name: 'ArXiv Papers' });

// Parse ArXiv Atom XML response
function parseArxivXML(xmlText: string): ArxivPaper[] {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlText, 'text/xml');

  const entries = xmlDoc.querySelectorAll('entry');
  const papers: ArxivPaper[] = [];

  entries.forEach((entry) => {
    const id = entry.querySelector('id')?.textContent || '';
    const title = entry.querySelector('title')?.textContent?.trim() || '';
    const summary = entry.querySelector('summary')?.textContent?.trim() || '';

    const authors: string[] = [];
    entry.querySelectorAll('author name').forEach((authorEl) => {
      const name = authorEl.textContent?.trim();
      if (name) authors.push(name);
    });

    const published = entry.querySelector('published')?.textContent || '';
    const updated = entry.querySelector('updated')?.textContent || '';

    const categories: string[] = [];
    entry.querySelectorAll('category').forEach((catEl) => {
      const term = catEl.getAttribute('term');
      if (term) categories.push(term);
    });

    // Find links
    let link = id;
    let pdfLink = id.replace('/abs/', '/pdf/') + '.pdf';

    entry.querySelectorAll('link').forEach((linkEl) => {
      const rel = linkEl.getAttribute('rel');
      const href = linkEl.getAttribute('href');
      if (href) {
        if (rel === 'alternate') link = href;
        if (linkEl.getAttribute('title') === 'pdf') pdfLink = href;
      }
    });

    papers.push({
      id: id.split('/').pop() || id,
      title,
      summary,
      authors,
      published: new Date(published),
      updated: new Date(updated),
      categories,
      link,
      pdfLink,
    });
  });

  return papers;
}

export async function fetchArxivPapers(
  category: string = 'cs.AI',
  maxResults: number = 50
): Promise<ArxivPaper[]> {
  return breaker.execute(async () => {
    const xmlText = await fetchWithCache<string>(API_URLS.arxiv(category, maxResults), { ttl: 300_000, parseAs: 'text' });
    return parseArxivXML(xmlText);
  }, []);
}

// Fetch papers from multiple AI/ML categories
export async function fetchAllAIPapers(): Promise<ArxivPaper[]> {
  const categories = ['cs.AI', 'cs.LG', 'cs.CL']; // AI, Machine Learning, Computation & Language

  const results = await Promise.allSettled(
    categories.map(cat => fetchArxivPapers(cat, 20))
  );

  const allPapers: ArxivPaper[] = [];
  results.forEach((result) => {
    if (result.status === 'fulfilled') {
      allPapers.push(...result.value);
    }
  });

  // Remove duplicates by ID and sort by published date
  const uniquePapers = Array.from(
    new Map(allPapers.map(p => [p.id, p])).values()
  ).sort((a, b) => b.published.getTime() - a.published.getTime());

  return uniquePapers.slice(0, 50); // Return top 50 most recent
}

export function getArxivStatus(): string {
  return breaker.getStatus();
}
