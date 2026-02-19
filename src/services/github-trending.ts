import { API_URLS } from '@/config';
import { createCircuitBreaker, fetchWithCache } from '@/utils';

export interface GitHubRepo {
  author: string;
  name: string;
  url: string;
  description: string;
  language: string;
  languageColor?: string;
  stars: number;
  forks: number;
  currentPeriodStars: number;
  builtBy?: Array<{
    username: string;
    href: string;
    avatar: string;
  }>;
}

const breaker = createCircuitBreaker<GitHubRepo[]>({ name: 'GitHub Trending' });

export async function fetchGitHubTrending(
  language: string = 'python',
  since: string = 'daily'
): Promise<GitHubRepo[]> {
  return breaker.execute(async () => {
    const data = await fetchWithCache<unknown[]>(API_URLS.githubTrending(language, since), { ttl: 120_000 });

    // The API returns different structures depending on the endpoint
    // Normalize the response
    if (Array.isArray(data)) {
      return data.map((repo: any) => ({
        author: repo.author || repo.owner?.login || '',
        name: repo.name || '',
        url: repo.url || repo.html_url || `https://github.com/${repo.author}/${repo.name}`,
        description: repo.description || '',
        language: repo.language || language,
        languageColor: repo.languageColor || repo.language_color,
        stars: repo.stars || repo.stargazers_count || 0,
        forks: repo.forks || repo.forks_count || 0,
        currentPeriodStars: repo.currentPeriodStars || repo.stars_diff || 0,
        builtBy: repo.builtBy || [],
      }));
    }

    return [];
  }, []);
}

// Fetch trending repos for multiple AI/ML languages
export async function fetchAIMLTrending(): Promise<GitHubRepo[]> {
  const languages = ['python', 'jupyter-notebook', 'typescript', 'javascript'];

  const results = await Promise.allSettled(
    languages.map(lang => fetchGitHubTrending(lang, 'daily'))
  );

  const allRepos: GitHubRepo[] = [];
  results.forEach((result) => {
    if (result.status === 'fulfilled') {
      allRepos.push(...result.value);
    }
  });

  // Filter for AI/ML related repos based on description and name
  const aiKeywords = [
    'ai', 'ml', 'machine learning', 'deep learning', 'neural', 'llm',
    'gpt', 'transformer', 'model', 'pytorch', 'tensorflow', 'diffusion',
    'stable diffusion', 'chatgpt', 'claude', 'anthropic', 'openai',
    'langchain', 'embeddings', 'vector', 'rag', 'agent'
  ];

  const aiRepos = allRepos.filter(repo => {
    const searchText = `${repo.name} ${repo.description}`.toLowerCase();
    return aiKeywords.some(keyword => searchText.includes(keyword));
  });

  // Sort by current period stars
  return aiRepos.sort((a, b) => b.currentPeriodStars - a.currentPeriodStars).slice(0, 30);
}

export function getGitHubTrendingStatus(): string {
  return breaker.getStatus();
}
