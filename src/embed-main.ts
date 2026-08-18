import './styles/base-layer.css';
import './styles/happy-theme.css';
import './styles/embed.css';
import { initI18n } from '@/services/i18n';
import { panelRequiresEmbeddingApiKey } from '../shared/embed-panels';
import { parseEmbedParams } from '@/embed/embed-url';
import { waitForEmbeddingApiKey } from '@/embed/embed-credential';
import { fetchEmbedEntitlement } from '@/embed/embed-fetch';
import { mountEmbedMapPanel } from '@/embed/panels/map';
import { mountEmbedChokepointStrip } from '@/embed/panels/chokepoint-strip';
import { mountEmbedFearGreed } from '@/embed/panels/fear-greed';

function mountError(root: HTMLElement, message: string): void {
  root.textContent = '';
  const error = document.createElement('div');
  error.className = 'wm-embed-error';
  error.textContent = message;
  root.appendChild(error);
}

async function bootEmbed(): Promise<void> {
  const root = document.getElementById('embedRoot');
  if (!root) return;

  try {
    const params = parseEmbedParams(window.location.search);
    document.documentElement.dataset.theme = params.theme;
    document.documentElement.dataset.variant = params.variant;
    document.body.dataset.embedPanel = params.panel ?? 'unknown';
    document.body.dataset.embedReady = 'false';

    // Listen before any await so the parent's iframe `load` postMessage is not
    // dropped while initI18n() fetches locale bundles.
    const apiKeyPromise = params.panel && panelRequiresEmbeddingApiKey(params.panel)
      ? waitForEmbeddingApiKey()
      : Promise.resolve(null);

    await initI18n();

    if (!params.panel) {
      mountError(root, `Unknown World Monitor embed panel "${params.requestedPanel}".`);
      document.body.dataset.embedReady = 'error';
      return;
    }

    let apiKey: string | null = null;
    if (panelRequiresEmbeddingApiKey(params.panel)) {
      apiKey = await apiKeyPromise;
      if (!apiKey) {
        mountError(root, 'This World Monitor panel requires an embedding API key from the partner account.');
        document.body.dataset.embedReady = 'error';
        return;
      }
      const entitlement = await fetchEmbedEntitlement(params.panel, apiKey);
      if (!entitlement.ok) {
        const denied = entitlement.status === 403
          ? 'The embedding account is not entitled to this World Monitor panel.'
          : 'World Monitor could not verify the embedding API key for this panel.';
        mountError(root, denied);
        document.body.dataset.embedReady = 'error';
        return;
      }
    }

    let destroy: (() => void) | undefined;
    if (params.panel === 'map') {
      destroy = await mountEmbedMapPanel(root, params);
    } else if (params.panel === 'chokepoint-strip') {
      await mountEmbedChokepointStrip(root, apiKey ?? '');
    } else if (params.panel === 'fear-greed') {
      await mountEmbedFearGreed(root, apiKey ?? '');
    }

    document.title = params.panel === 'map'
      ? 'World Monitor Live Map Embed'
      : 'World Monitor Panel Embed';
    document.body.dataset.embedReady = 'true';
    if (destroy) {
      window.addEventListener('pagehide', destroy, { once: true });
    }
  } catch (error) {
    console.error('[embed] Failed to boot panel:', error);
    mountError(root, 'World Monitor embed could not load.');
    document.body.dataset.embedReady = 'error';
  }
}

void bootEmbed();
