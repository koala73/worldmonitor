import type { ViewMode } from '@/types/news-reader';
import { getSettings, updateSettings, onSettingsChange } from '@/services/settings-store';
import { subscribePipeline, startPipeline } from '@/pipeline';
import { autoNarrateTop } from '@/narration/narrator';
import { hasAIConfigured } from '@/services/settings-store';
import { renderHeader } from './header';
import { renderReader } from './reader';
import { renderDashboard } from './dashboard';
import { renderSettings } from './settings';
import type { NormalizedStory, StoryCluster } from '@/types/news-reader';

let currentView: ViewMode | 'settings' = 'reader';
let searchQuery = '';
let headerEl: HTMLElement;
let contentEl: HTMLElement;

// Latest pipeline data
let pipelineStories: NormalizedStory[] = [];
let pipelineClusters: StoryCluster[] = [];
let pipelineLoading = false;
let pipelineError: string | null = null;
let pipelineLastRefresh: Date | null = null;

export function initApp(rootId: string): void {
  const root = document.getElementById(rootId);
  if (!root) return;
  root.innerHTML = '';

  // Apply font size
  const settings = getSettings();
  document.documentElement.dataset.fontsize = settings.fontSize;
  currentView = settings.viewMode;

  // Create layout
  headerEl = document.createElement('div');
  headerEl.id = 'app-header';
  contentEl = document.createElement('div');
  contentEl.id = 'app-content';
  contentEl.className = 'app-content';
  root.append(headerEl, contentEl);

  // Subscribe to pipeline updates
  subscribePipeline((data) => {
    pipelineStories = data.stories;
    pipelineClusters = data.clusters;
    pipelineLoading = data.loading;
    pipelineError = data.error;
    pipelineLastRefresh = data.lastRefresh;
    renderContent();

    // Auto-narrate top clusters if configured
    if (!data.loading && data.clusters.length > 0 && hasAIConfigured() && getSettings().autoNarrate) {
      void autoNarrateTop(data.clusters);
    }
  });

  // Listen to settings changes
  onSettingsChange(() => renderContent());

  // Initial render
  renderAll();

  // Start the pipeline
  startPipeline();
}

function renderAll(): void {
  renderHeader(headerEl, currentView, {
    onViewChange: (mode) => {
      currentView = mode;
      if (mode !== 'settings') {
        updateSettings({ viewMode: mode });
      }
      renderAll();
    },
    onSearch: (q) => {
      searchQuery = q;
      renderContent();
    },
  });
  renderContent();
}

function renderContent(): void {
  switch (currentView) {
    case 'reader':
      renderReader(contentEl, pipelineClusters, pipelineStories, searchQuery, pipelineLoading, pipelineError, pipelineLastRefresh);
      break;
    case 'dashboard':
      renderDashboard(contentEl, pipelineClusters, pipelineStories, searchQuery, pipelineLoading, pipelineError, pipelineLastRefresh);
      break;
    case 'settings':
      renderSettings(contentEl);
      break;
  }
}
