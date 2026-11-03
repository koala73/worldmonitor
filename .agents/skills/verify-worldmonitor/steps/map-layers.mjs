import { seedProfile, waitForBoot, waitForMap } from './_profile.mjs';

/**
 * Feature: map layer toggles (features/map-layers.md).
 * Turns a layer off and back on from the map's own control and proves all three
 * observable consequences: the control's own state, the shareable ?layers=
 * list, and the persisted worldmonitor-layers preference.
 *
 * The control is a different element per renderer — see features/map-layers.md.
 */
const LAYER = process.env.WM_VERIFY_LAYER ?? 'conflicts';

const readLayerState = (page, layer, renderer) =>
  page.evaluate(({ key, svg }) => {
    let stored = null;
    try {
      stored = JSON.parse(localStorage.getItem('worldmonitor-layers') ?? 'null')?.[key] ?? null;
    } catch {
      stored = 'unparseable';
    }
    const control = document.querySelector(`.layer-toggle[data-layer="${key}"]`);
    return {
      on: svg
        ? (control ? control.classList.contains('active') : null)
        : (control?.querySelector('input')?.checked ?? null),
      inUrl: (new URL(window.location.href).searchParams.get('layers') ?? '').split(',').includes(key),
      stored,
    };
  }, { key: layer, svg: renderer === 'svg' });

export default async function ({ page, base, shot, log }) {
  await seedProfile(page);
  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
  await waitForBoot(page);
  const renderer = await waitForMap(page);
  log(`map renderer: ${renderer}`);

  const control = page.locator(`.layer-toggle[data-layer="${LAYER}"]`);
  await control.waitFor({ state: 'visible', timeout: 60_000 });

  const before = await readLayerState(page, LAYER, renderer);
  log('before:', JSON.stringify(before));
  if (before.on !== true) {
    throw new Error(`layer "${LAYER}" was expected to boot enabled; got ${JSON.stringify(before)}`);
  }
  await shot('layer-on');

  const isOn = (want) =>
    page.waitForFunction(
      ({ key, svg, expected }) => {
        const el = document.querySelector(`.layer-toggle[data-layer="${key}"]`);
        if (!el) return false;
        const on = svg ? el.classList.contains('active') : !!el.querySelector('input')?.checked;
        return on === expected;
      },
      { key: LAYER, svg: renderer === 'svg', expected: want },
      { timeout: 15_000 },
    );

  // ?layers= is written through the same 250 ms debounce as every other map URL
  // sync, so poll for it rather than reading window.location once.
  const inUrl = (want) =>
    page.waitForFunction(
      ({ key, expected }) =>
        (new URL(window.location.href).searchParams.get('layers') ?? '').split(',').includes(key) === expected,
      { key: LAYER, expected: want },
      { timeout: 15_000 },
    );

  await control.click();
  await isOn(false);
  await inUrl(false);
  const off = await readLayerState(page, LAYER, renderer);
  log('after turning it off:', JSON.stringify(off));
  if (off.stored !== false) throw new Error(`layer "${LAYER}" was not persisted as off: ${JSON.stringify(off)}`);
  await shot('layer-off');

  await control.click();
  await isOn(true);
  await inUrl(true);
  const back = await readLayerState(page, LAYER, renderer);
  log('after turning it back on:', JSON.stringify(back));
  if (back.stored !== true) throw new Error(`layer "${LAYER}" was not persisted as on again: ${JSON.stringify(back)}`);
  await shot('layer-restored');

  return { layer: LAYER, renderer, before, off, back };
}
