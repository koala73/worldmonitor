import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

const repoRoot = resolve(new URL('..', import.meta.url).pathname);
const readSrc = (path) => readFileSync(join(repoRoot, path), 'utf8');

describe('LCP attribution debug contract', () => {
  it('installs the attribution observer before App construction', () => {
    const src = readSrc('src/main.ts');
    const installIndex = src.indexOf('installLcpAttributionDebug();');
    const appIndex = src.indexOf('new App(');

    assert.ok(installIndex >= 0, 'main.ts must install LCP attribution debug');
    assert.ok(appIndex >= 0, 'main.ts must construct App');
    assert.ok(installIndex < appIndex, 'LCP attribution debug must install before App construction');
  });

  it('marks the boot gates that can delay final LCP', () => {
    const appSrc = readSrc('src/App.ts');
    for (const mark of [
      'wm:boot:app-init-start',
      'wm:boot:i18n-ready',
      'wm:boot:session-ready',
      'wm:boot:fast-bootstrap-ready',
      'wm:layout:init-start',
      'wm:layout:init-complete',
      'wm:data:country-geometry-start',
      'wm:data:country-geometry-ready',
      'wm:data:slow-tier-wait-start',
      'wm:data:slow-tier-wait-end',
      'wm:data:initial-fanout-start',
      'wm:data:initial-fanout-complete',
    ]) {
      assert.ok(appSrc.includes(`markLcpDebug('${mark}'`), `missing App LCP mark ${mark}`);
    }
  });

  it('marks shell replacement and map renderer phases', () => {
    const layoutSrc = readSrc('src/app/panel-layout.ts');
    const mapContainerSrc = readSrc('src/components/MapContainer.ts');

    assert.ok(layoutSrc.includes("markLcpDebug('wm:layout:render-start'"));
    assert.ok(layoutSrc.includes("markLcpDebug('wm:layout:shell-replaced'"));
    assert.ok(layoutSrc.includes("markLcpDebug('wm:map:container-construct'"));
    assert.ok(layoutSrc.includes("markLcpDebug('wm:map:container-ready'"));

    for (const mark of [
      'wm:map:shell-shown',
      'wm:map:after-first-paint',
      'wm:map:renderer-demand',
      'wm:map:svg-init-start',
      'wm:map:svg-ready',
      'wm:map:deck-init-start',
      'wm:map:deck-ready',
      'wm:map:globe-init-start',
      'wm:map:globe-ready',
    ]) {
      assert.ok(mapContainerSrc.includes(`markLcpDebug('${mark}'`), `missing MapContainer LCP mark ${mark}`);
    }
  });

  it('marks actual country geometry fetch and post-geometry replay timing', () => {
    const countryGeometrySrc = readSrc('src/services/country-geometry.ts');
    const dataLoaderSrc = readSrc('src/app/data-loader.ts');
    assert.ok(countryGeometrySrc.includes("markLcpDebug('wm:data:country-geometry-fetch-start'"));
    assert.ok(countryGeometrySrc.includes("markLcpDebug('wm:data:country-geometry-fetch-ready'"));
    assert.ok(countryGeometrySrc.includes("markLcpDebug('wm:data:country-geometry-fetch-error'"));
    assert.ok(dataLoaderSrc.includes("markLcpDebug('wm:data:country-geometry-replay-start'"));
    assert.ok(dataLoaderSrc.includes("markLcpDebug('wm:data:country-geometry-replay-ready'"));
  });

  it('marks feed digest request timing for U4 evidence', () => {
    const dataLoaderSrc = readSrc('src/app/data-loader.ts');
    assert.ok(dataLoaderSrc.includes("markLcpDebug('wm:data:feed-digest-start'"));
    assert.ok(dataLoaderSrc.includes("markLcpDebug('wm:data:feed-digest-ready'"));
    assert.ok(dataLoaderSrc.includes("markLcpDebug('wm:data:feed-digest-error'"));
  });
});
