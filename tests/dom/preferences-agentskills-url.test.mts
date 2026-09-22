import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderPreferences } from '@/services/preferences-content';

afterEach(() => vi.unstubAllGlobals());

describe('AgentSkills import URL validation', () => {
  it('rejects lookalike URLs before sending an import request', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 400 }));
    vi.stubGlobal('fetch', fetch);
    const preferences = renderPreferences({ isDesktopApp: false });
    const container = document.createElement('div');
    container.innerHTML = '<input id="fwAgentskillsUrl"><button id="fwFetchBtn">Fetch</button><div id="fwAgentskillsError"></div>';
    const detach = preferences.attach(container);
    try {
      for (const url of ['https://notagentskills.io', 'https://agentskills.io.example.org', 'https://example.org/agentskills.io', 'not a URL']) {
        container.querySelector<HTMLInputElement>('input')!.value = url;
        container.querySelector('button')!.click();
        expect(fetch).not.toHaveBeenCalled();
      }
      container.querySelector<HTMLInputElement>('input')!.value = 'https://www.agentskills.io/skills/test';
      container.querySelector('button')!.click();
      expect(fetch).toHaveBeenCalledWith('/api/skills/fetch-agentskills', expect.objectContaining({ method: 'POST' }));
      await Promise.resolve();
    } finally {
      detach();
    }
  });
});
