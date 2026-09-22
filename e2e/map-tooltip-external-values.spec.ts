import { expect, test } from '@playwright/test';

test('map tooltip external values remain text', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1100 });
  await page.goto('/tests/map-harness.html');
  await page.waitForFunction(() => (window as Window & { __mapHarness?: { ready: boolean } }).__mapHarness?.ready === true);

  const labels = await page.evaluate(async () => {
    const deckModule = '/src/components/DeckGLMap.ts';
    const globeModule = '/src/components/GlobeMap.ts';
    const { DeckGLMap } = await import(/* @vite-ignore */ deckModule);
    const { GlobeMap } = await import(/* @vite-ignore */ globeModule);
    const getTooltip = DeckGLMap.prototype.getTooltip;
    const disease = (cases: unknown) => getTooltip.call({}, {
      layer: { id: 'disease-outbreaks-layer' },
      object: { item: {
        disease: 'Cholera', location: 'Test location', alertLevel: 'warning',
        sourceName: 'ThinkGlobalHealth', publishedAt: Date.UTC(2026, 8, 1), cases,
      } },
    }).html;

    const container = document.createElement('div');
    container.style.cssText = 'position:fixed;width:600px;height:400px;left:0;top:0';
    document.body.appendChild(container);
    const map = new GlobeMap(container, {
      view: 'global', layers: {}, timeRange: 'all', zoom: 2, pan: { x: 0, y: 0 },
    }, { chrome: false });
    await map.whenReady();
    const pathLabel = map.globe.pathLabel();
    const names = ['Storm <img src=x onerror=alert(1)>', 'Satellite <b>name</b>', 'A & B "航天"'];
    map.setNaturalEvents([{
      id: 'fixture-storm', stormName: names[0], lat: 10, lon: 20,
      forecastTrack: [{ lat: 11, lon: 21 }],
    }]);
    map.setSatellites([{
      noradId: 123, name: names[1], lat: 10, lng: 20, alt: 400,
      country: 'US', type: 'test', trail: [[19, 9, 400], [18, 8, 400]],
    }]);
    const results = {
      disease: [disease('<img src=x onerror=alert(1)>'), disease(1), disease(42), disease(0)],
      paths: [
        pathLabel(map.stormTrackPaths[0]),
        pathLabel(map.satelliteTrailPaths[0]),
        pathLabel({ name: names[2] }),
      ],
      names,
      empty: pathLabel({}),
    };
    map.destroy();
    container.remove();
    return results;
  });

  expect(labels.empty).toBe('');
  expect(labels.disease[0]).toContain('&lt;img');
  expect(labels.disease[1]).toContain('1 case</span>');
  expect(labels.disease[2]).toContain('42 cases</span>');
  expect(labels.disease[3]).not.toContain(' case');

  await page.evaluate(({ disease, paths }) => {
    const evidence = document.createElement('main');
    evidence.id = 'tooltip-evidence';
    evidence.style.cssText = 'position:fixed;inset:20px;z-index:999999;background:#111c29;color:#eee;padding:28px;font:16px/1.8 sans-serif';
    evidence.innerHTML = '<h1>Map tooltip regression fixtures</h1><p>Controlled external values; actual renderer output</p>'
      + [...disease, ...paths].map(html => `<section style="margin:14px;padding:12px;border:1px solid #617186">${html}</section>`).join('');
    document.body.appendChild(evidence);
  }, labels);
  const evidence = page.locator('#tooltip-evidence');
  await expect(evidence.locator('img, script, b')).toHaveCount(0);
  await expect(evidence).toContainText('Storm <img src=x onerror=alert(1)>');
  await expect(evidence).toContainText('Satellite <b>name</b>');
  await expect(evidence).toContainText(labels.names[2]);
  await evidence.screenshot({ path: 'test-results/map-tooltip-external-values.png' });
});
