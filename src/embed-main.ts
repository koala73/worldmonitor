import './styles/base-layer.css';
import './styles/happy-theme.css';
import './styles/embed.css';
import { initI18n } from '@/services/i18n';
import { getEmbedPanelFreeTier } from '../shared/embed-panels';
import { parseEmbedParams } from '@/embed/embed-url';
import { waitForEmbeddingApiKey } from '@/embed/embed-credential';
import { fetchEmbedEntitlement } from '@/embed/embed-fetch';
import { mountEmbedMapPanel } from '@/embed/panels/map';
import { mountEmbedChokepointStrip } from '@/embed/panels/chokepoint-strip';
import { mountEmbedFearGreed } from '@/embed/panels/fear-greed';

/**
 * Tell the partner's own console that the credential in their page HTML does
 * more than embed.
 *
 * The frame is inside an iframe on somebody else's site, so this warning lands
 * in the console of the person who can actually fix it. It names the risk
 * rather than the deadline: the `wm_` and enterprise paths still work, and
 * when they stop is a commercial decision nobody has made yet.
 */
function warnOnDeprecatedCredential(kind: string | undefined): void {
  if (!kind) return;
  const what = kind === 'enterprise_key'
    ? 'an enterprise key, which bypasses entitlement checks entirely'
    : 'a World Monitor user API key (wm_…), which unlocks your whole paid REST allowance';
  console.warn(
    `[worldmonitor-embed] This embed authenticates with ${what}. It sits in your page's public HTML, `
    + 'where anyone can read and reuse it. Replace it with a scoped embed key (wme_…): '
    + 'World Monitor dashboard → Settings → Embeds. https://www.worldmonitor.app/docs/embed-live-map',
  );
}

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
    // dropped while initI18n() fetches locale bundles. Started for EVERY panel
    // now, not just the paid-only ones: a tiered panel renders keylessly but
    // upgrades in place when a credential arrives, so it must be listening too.
    const apiKeyPromise = waitForEmbeddingApiKey();

    await initI18n();

    if (!params.panel) {
      mountError(root, `Unknown World Monitor embed panel "${params.requestedPanel}".`);
      document.body.dataset.embedReady = 'error';
      return;
    }

    let apiKey: string | null = null;
    if (getEmbedPanelFreeTier(params.panel) === null) {
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
      warnOnDeprecatedCredential(entitlement.body.deprecatedCredential);
    }

    let destroy: (() => void) | undefined;
    if (params.panel === 'map') {
      // Mounts free-tier first and upgrades if `apiKeyPromise` resolves, so a
      // keyless embed never waits out the credential handshake.
      destroy = await mountEmbedMapPanel(root, params, apiKeyPromise);
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
