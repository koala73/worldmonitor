import { seedProfile, waitForBoot, waitForMap } from './_profile.mjs';

/**
 * Not a feature drive — a discovery aid. Boots the dashboard and dumps the
 * handles a new drive needs (panel keys, layer keys, header controls) so a
 * step can be written against what the app actually renders today.
 *
 *   wm-verify.sh drive .agents/skills/verify-worldmonitor/steps/_inspect.mjs --name inspect
 */
export default async function ({ page, base, shot, log }) {
  await seedProfile(page);
  await page.goto(`${base}${process.env.WM_VERIFY_PATH ?? '/dashboard'}`, { waitUntil: 'domcontentloaded' });
  await waitForBoot(page);
  await page.locator('#panelsGrid .panel').first().waitFor({ state: 'visible', timeout: 90_000 });
  const renderer = await waitForMap(page);

  const handles = await page.evaluate(() => ({
    mapCanvases: document.querySelectorAll('#mapContainer canvas').length,
    layerControl: document.querySelector('button.layer-toggle') ? 'button' : (document.querySelector('.layer-toggle input') ? 'checkbox' : 'none'),
    panelKeys: [...document.querySelectorAll('#panelsGrid .panel[data-panel]')].map((el) => el.getAttribute('data-panel')),
    layerKeys: [...document.querySelectorAll('[data-layer]')].map((el) => `${el.tagName.toLowerCase()}.${el.className}[${el.getAttribute('data-layer')}]`),
    headerIds: [...document.querySelectorAll('.header [id], #main > [id]')].map((el) => el.id).filter(Boolean),
    urlLayers: new URL(window.location.href).searchParams.get('layers'),
  }));
  log('map renderer:', renderer, '| canvases:', String(handles.mapCanvases), '| layer control:', handles.layerControl);
  log('panel keys:', JSON.stringify(handles.panelKeys));
  log('layer handles:', JSON.stringify([...new Set(handles.layerKeys)]));
  log('header ids:', JSON.stringify(handles.headerIds));
  log('url layers:', String(handles.urlLayers));
  await shot('inspect');
  return handles;
}
