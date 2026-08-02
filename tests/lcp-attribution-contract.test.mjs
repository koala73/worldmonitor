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

  it('registers LCP RUM reporting before App construction', () => {
    const src = readSrc('src/main.ts');
    const importIndex = src.indexOf("import { registerLcpReporting } from '@/bootstrap/lcp-report';");
    const registerIndex = src.indexOf('registerLcpReporting();');
    const appIndex = src.indexOf('new App(');

    assert.ok(importIndex >= 0, 'main.ts must import registerLcpReporting');
    assert.ok(registerIndex >= 0, 'main.ts must register LCP RUM reporting');
    assert.ok(appIndex >= 0, 'main.ts must construct App');
    assert.ok(registerIndex < appIndex, 'LCP RUM reporting must register before App construction');
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
      'wm:panel:deferred-mount-start',
      'wm:panel:deferred-mount-ready',
      'wm:panel:deferred-mount-unavailable',
    ]) {
      assert.ok(layoutSrc.includes(`markLcpDebug('${mark}'`), `missing deferred panel trace mark ${mark}`);
    }

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

  it('caches and replays every geometry-dependent CII source so deferred geometry never drops attribution (#4512)', () => {
    const contextSrc = readSrc('src/app/app-context.ts');
    const dataLoaderSrc = readSrc('src/app/data-loader.ts');

    // Isolate the replay method body so we assert against the replay, not the
    // whole file (a stray ingest elsewhere must not satisfy the guard).
    const replayStart = dataLoaderSrc.indexOf('refreshGeometryDependentCiiAfterCountryGeometry(): void {');
    assert.ok(replayStart >= 0, 'replay method must exist');
    const replayEnd = dataLoaderSrc.indexOf('\n  private async tryFetchDigest', replayStart);
    assert.ok(replayEnd > replayStart, 'could not bound replay method body');
    const replayBody = dataLoaderSrc.slice(replayStart, replayEnd);

    // Coordinate-only sources have NO country hint, so their CII attribution is
    // 100% geometry-dependent. They were silently lost before #4512 because they
    // had no IntelligenceCache field and were never replayed. Each must now be:
    //   1) declared on IntelligenceCache,
    //   2) written to the cache at its ingest site, and
    //   3) re-ingested from the cache inside the replay.
    const coordinateOnlySources = [
      { field: 'gpsJamming', ingest: 'ingestGpsJammingForCII' },
      { field: 'aisDisruptions', ingest: 'ingestAisDisruptionsForCII' },
      { field: 'satelliteFires', ingest: 'ingestSatelliteFiresForCII' },
    ];

    for (const { field, ingest } of coordinateOnlySources) {
      assert.ok(
        new RegExp(`\\b${field}\\?:`).test(contextSrc),
        `IntelligenceCache must declare ${field}`,
      );
      assert.ok(
        dataLoaderSrc.includes(`this.ctx.intelligenceCache.${field} =`),
        `data-loader must cache ${field} at its ingest site`,
      );
      assert.ok(
        replayBody.includes(`${ingest}(cache.${field})`),
        `replay must re-ingest ${field} via ${ingest}(cache.${field})`,
      );
    }
  });

  it('skips the post-LCP replay when geometry was already applied during the fan-out (#4512)', () => {
    const appSrc = readSrc('src/App.ts');
    // The replay is a full second CII compute + choropleth repaint; it must only
    // run when the fan-out ingested before geometry was ready.
    assert.ok(appSrc.includes('isCountryGeometryLoaded()'), 'App must snapshot geometry readiness before the fan-out');
    assert.match(
      appSrc,
      /if \(!geometryAlreadyApplied\) \{\s*this\.dataLoader\.refreshGeometryDependentCiiAfterCountryGeometry\(\);/s,
      'replay must be guarded by !geometryAlreadyApplied',
    );
  });

  it('marks feed digest request timing for U4 evidence', () => {
    const dataLoaderSrc = readSrc('src/app/data-loader.ts');
    assert.ok(dataLoaderSrc.includes("markLcpDebug('wm:data:feed-digest-start'"));
    assert.ok(dataLoaderSrc.includes("markLcpDebug('wm:data:feed-digest-ready'"));
    assert.ok(dataLoaderSrc.includes("markLcpDebug('wm:data:feed-digest-error'"));
  });
});
