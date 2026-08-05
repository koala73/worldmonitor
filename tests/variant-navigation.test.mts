import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const panelLayout = readFileSync(new URL('../src/app/panel-layout.ts', import.meta.url), 'utf8');

describe('variant switcher navigation', () => {
  it('keeps every production variant link on the dashboard route', () => {
    const dashboardUrls = {
      full: 'https://worldmonitor.app/dashboard',
      tech: 'https://tech.worldmonitor.app/dashboard',
      finance: 'https://finance.worldmonitor.app/dashboard',
      commodity: 'https://commodity.worldmonitor.app/dashboard',
      energy: 'https://energy.worldmonitor.app/dashboard',
      happy: 'https://happy.worldmonitor.app/dashboard',
    } as const;

    for (const [variant, url] of Object.entries(dashboardUrls)) {
      assert.match(
        panelLayout,
        new RegExp(`vHref\\('${variant}', '${url.replaceAll('.', '\\.')}'\\)`),
        `${variant} switcher link must target ${url}`,
      );
    }
  });
});
