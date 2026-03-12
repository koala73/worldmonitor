import type { NormalizedStory, StoryCluster } from '@/types/news-reader';
import { el, formatRelative, threatColor, clear } from './helpers';

export function renderDashboard(
  container: HTMLElement,
  clusters: StoryCluster[],
  stories: NormalizedStory[],
  searchQuery: string,
  loading: boolean,
  errorMsg: string | null,
  lastRefresh: Date | null,
): void {
  clear(container);

  // Header stats
  const stats = el('div', { className: 'dash-stats' });
  stats.append(
    renderStatCard('Stories', stories.length.toString()),
    renderStatCard('Clusters', clusters.length.toString()),
    renderStatCard('Sources', countUniqueSources(clusters).toString()),
    renderStatCard('Updated', lastRefresh ? formatRelative(lastRefresh) : '--'),
  );
  container.append(stats);

  if (loading && clusters.length === 0) {
    const skeleton = el('div', { className: 'dash-grid' });
    for (let i = 0; i < 6; i++) {
      const card = el('div', { className: 'dash-card shimmer' });
      card.style.height = '120px';
      skeleton.append(card);
    }
    container.append(skeleton);
    return;
  }

  if (errorMsg) {
    container.append(el('div', { className: 'status-error' }, `Error: ${errorMsg}`));
  }

  // Filter
  let filtered = clusters;
  if (searchQuery.trim()) {
    const q = searchQuery.toLowerCase();
    filtered = clusters.filter((c) =>
      c.primaryTitle.toLowerCase().includes(q) ||
      c.mergedKeywords.some((k) => k.includes(q)),
    );
  }

  // Sort by sourceCount desc
  filtered = [...filtered].sort((a, b) => b.sourceCount - a.sourceCount);

  // Threat breakdown
  const breakdown = el('div', { className: 'dash-section' });
  breakdown.append(el('h3', { className: 'dash-section-title' }, 'Threat Breakdown'));
  const threatGrid = el('div', { className: 'threat-grid' });
  const threatCounts = countByThreat(filtered);
  for (const [level, count] of Object.entries(threatCounts)) {
    const item = el('div', { className: `threat-item threat-${level}` });
    item.style.borderLeftColor = threatColor(level);
    item.append(
      el('span', { className: 'threat-count' }, count.toString()),
      el('span', { className: 'threat-label' }, level),
    );
    threatGrid.append(item);
  }
  breakdown.append(threatGrid);
  container.append(breakdown);

  // Category breakdown
  const catSection = el('div', { className: 'dash-section' });
  catSection.append(el('h3', { className: 'dash-section-title' }, 'Categories'));
  const catGrid = el('div', { className: 'category-grid' });
  const catCounts = countByCategory(filtered);
  for (const [cat, count] of Object.entries(catCounts)) {
    catGrid.append(
      el('div', { className: 'cat-item' },
        el('span', { className: 'cat-name' }, cat),
        el('span', { className: 'cat-count' }, count.toString()),
      ),
    );
  }
  catSection.append(catGrid);
  container.append(catSection);

  // Cluster grid
  const gridSection = el('div', { className: 'dash-section' });
  gridSection.append(el('h3', { className: 'dash-section-title' }, 'Top Clusters'));
  const grid = el('div', { className: 'dash-grid' });
  for (const cluster of filtered.slice(0, 20)) {
    grid.append(renderDashCard(cluster));
  }
  gridSection.append(grid);
  container.append(gridSection);
}

function renderStatCard(label: string, value: string): HTMLElement {
  const card = el('div', { className: 'stat-card' });
  card.append(
    el('div', { className: 'stat-value' }, value),
    el('div', { className: 'stat-label' }, label),
  );
  return card;
}

function renderDashCard(cluster: StoryCluster): HTMLElement {
  const card = el('div', { className: 'dash-card' });
  card.style.borderLeftColor = threatColor(cluster.threatLevel);

  const header = el('div', { className: 'dash-card-header' });
  header.append(
    el('span', { className: `threat-badge threat-${cluster.threatLevel}` },
      cluster.threatLevel.toUpperCase()),
    el('span', { className: 'sources-badge' }, `${cluster.sourceCount}x`),
  );
  card.append(header);

  card.append(el('div', { className: 'dash-card-title' }, cluster.primaryTitle));

  const meta = el('div', { className: 'dash-card-meta' });
  meta.append(
    el('span', {}, formatRelative(cluster.lastUpdated)),
    el('span', {}, cluster.categories.join(', ')),
  );
  card.append(meta);

  return card;
}

function countUniqueSources(clusters: StoryCluster[]): number {
  const sources = new Set<string>();
  for (const c of clusters) {
    for (const s of c.topSources) sources.add(s.name);
  }
  return sources.size;
}

function countByThreat(clusters: StoryCluster[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of clusters) {
    counts[c.threatLevel] = (counts[c.threatLevel] || 0) + 1;
  }
  return counts;
}

function countByCategory(clusters: StoryCluster[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of clusters) {
    for (const cat of c.categories) {
      counts[cat] = (counts[cat] || 0) + 1;
    }
  }
  return counts;
}
