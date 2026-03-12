import type { NormalizedStory, StoryCluster } from '@/types/news-reader';
import { el, formatRelative, threatColor, tierLabel, clear } from './helpers';
import { narrateCluster, getFallbackText } from '@/narration/narrator';
import { hasAIConfigured } from '@/services/settings-store';

export function renderReader(
  container: HTMLElement,
  clusters: StoryCluster[],
  stories: NormalizedStory[],
  searchQuery: string,
  loading: boolean,
  errorMsg: string | null,
  lastRefresh: Date | null,
): void {
  clear(container);

  // Status bar
  const statusBar = el('div', { className: 'status-bar' });
  if (loading) {
    statusBar.append(el('span', { className: 'status-loading' }, 'Refreshing feeds...'));
  } else if (errorMsg) {
    statusBar.append(el('span', { className: 'status-error' }, `Error: ${errorMsg}`));
  } else if (lastRefresh) {
    statusBar.append(
      el('span', { className: 'status-ok' },
        `${stories.length} stories \u00B7 ${clusters.length} clusters \u00B7 Updated ${formatRelative(lastRefresh)}`),
    );
  }
  container.append(statusBar);

  // Filter clusters by search
  let filtered = clusters;
  if (searchQuery.trim()) {
    const q = searchQuery.toLowerCase();
    filtered = clusters.filter((c) =>
      c.primaryTitle.toLowerCase().includes(q) ||
      c.mergedKeywords.some((k) => k.includes(q)) ||
      c.categories.some((cat) => cat.includes(q)),
    );
  }

  // Sort: by velocity then recency
  filtered = [...filtered].sort((a, b) => {
    if (b.velocityScore !== a.velocityScore) return b.velocityScore - a.velocityScore;
    return new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime();
  });

  if (filtered.length === 0 && !loading) {
    const empty = el('div', { className: 'empty-state' });
    if (searchQuery) {
      empty.append(el('p', {}, `No results for "${searchQuery}"`));
    } else {
      empty.append(
        el('p', {}, 'No stories yet'),
        el('p', { className: 'text-muted' }, 'Feeds will refresh shortly...'),
      );
    }
    container.append(empty);
    return;
  }

  // Loading skeleton
  if (loading && clusters.length === 0) {
    const skeletonContainer = el('div', { className: 'cluster-list' });
    for (let i = 0; i < 5; i++) {
      skeletonContainer.append(renderSkeleton());
    }
    container.append(skeletonContainer);
    return;
  }

  // Cluster cards
  const list = el('div', { className: 'cluster-list' });
  const storyMap = new Map(stories.map((s) => [s.id, s]));

  for (const cluster of filtered) {
    list.append(renderClusterCard(cluster, storyMap));
  }
  container.append(list);
}

function renderClusterCard(
  cluster: StoryCluster,
  storyMap: Map<string, NormalizedStory>,
): HTMLElement {
  const card = el('div', { className: 'cluster-card' });

  // Header row
  const headerRow = el('div', { className: 'card-header' });

  const threatBadge = el('span', {
    className: `threat-badge threat-${cluster.threatLevel}`,
  }, cluster.threatLevel.toUpperCase());
  threatBadge.style.borderColor = threatColor(cluster.threatLevel);

  const sourcesBadge = el('span', { className: 'sources-badge' },
    `${cluster.sourceCount} source${cluster.sourceCount > 1 ? 's' : ''}`);

  const velocity = el('span', { className: 'velocity-badge' },
    `\u26A1 ${cluster.velocityScore.toFixed(1)}`);

  const time = el('span', { className: 'card-time' }, formatRelative(cluster.lastUpdated));

  headerRow.append(threatBadge, sourcesBadge, velocity, time);
  card.append(headerRow);

  // Title
  const primary = storyMap.get(cluster.primaryStoryId);
  const titleLink = el('a', {
    className: 'card-title',
    href: primary?.url ?? '#',
    target: '_blank',
    rel: 'noopener',
  }, cluster.primaryTitle);
  card.append(titleLink);

  // Keywords
  if (cluster.mergedKeywords.length > 0) {
    const kwRow = el('div', { className: 'card-keywords' });
    for (const kw of cluster.mergedKeywords.slice(0, 6)) {
      kwRow.append(el('span', { className: 'keyword-tag' }, kw));
    }
    card.append(kwRow);
  }

  // Categories
  const catRow = el('div', { className: 'card-meta' });
  for (const cat of cluster.categories) {
    catRow.append(el('span', { className: 'category-tag' }, cat));
  }
  if (cluster.region) {
    catRow.append(el('span', { className: 'region-tag' }, cluster.region));
  }
  card.append(catRow);

  // Sources list
  if (cluster.topSources.length > 0) {
    const srcList = el('div', { className: 'card-sources' });
    for (const src of cluster.topSources.slice(0, 4)) {
      const srcLink = el('a', {
        href: src.url,
        target: '_blank',
        rel: 'noopener',
        className: 'source-link',
      }, `${src.name} [${tierLabel(src.tier)}]`);
      srcList.append(srcLink);
    }
    if (cluster.storyIds.length > 4) {
      srcList.append(el('span', { className: 'text-muted' },
        `+${cluster.storyIds.length - 4} more`));
    }
    card.append(srcList);
  }

  // AI Narration section
  if (hasAIConfigured()) {
    const narrationDiv = el('div', { className: 'card-narration' });
    const narrateBtn = el('button', { className: 'narrate-btn' }, 'Summarize');
    narrationDiv.append(narrateBtn);
    narrateBtn.addEventListener('click', async () => {
      narrateBtn.textContent = getFallbackText(true);
      narrateBtn.disabled = true;
      const result = await narrateCluster(cluster, 'shortSummary');
      if (result?.shortSummary) {
        narrationDiv.innerHTML = '';
        narrationDiv.append(el('p', { className: 'narration-text' }, result.shortSummary));
      } else {
        narrateBtn.textContent = getFallbackText(false);
        narrateBtn.disabled = false;
      }
    });
    card.append(narrationDiv);
  }

  return card;
}

function renderSkeleton(): HTMLElement {
  const card = el('div', { className: 'cluster-card skeleton-card' });
  card.append(
    el('div', { className: 'shimmer skeleton-line skeleton-short' }),
    el('div', { className: 'shimmer skeleton-line skeleton-long' }),
    el('div', { className: 'shimmer skeleton-line skeleton-medium' }),
    el('div', { className: 'shimmer skeleton-line skeleton-short' }),
  );
  return card;
}
