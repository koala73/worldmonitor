import { expect, test } from '@playwright/test';

const HEADLINES = [
  'Erdbeben erschüttert Küstenregion',
  'Zentralbank senkt Leitzins überraschend',
  'Wahlen in Südamerika knapp entschieden',
  'Hackerangriff legt Hafenbetrieb lahm',
  'Dürre bedroht Weizenernte massiv',
  'Raumsonde erreicht fernen Asteroiden',
  'Streik stoppt Bahnverkehr landesweit',
  'Ölpreis steigt nach Pipeline-Ausfall',
  'Gipfeltreffen endet ohne Einigung',
  'Waldbrände zwingen Tausende zur Flucht',
  'Neue Sanktionen gegen Reederei verhängt',
  'Chiphersteller meldet Rekordgewinn',
];

test.use({ viewport: { width: 1600, height: 900 } });

test('panel resize strips never cover the headline translate button (#9729)', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('wm-locale-explicit', 'de'));
  await page.goto('/tests/runtime-harness.html');

  const result = await page.evaluate(async (headlines) => {
    await import('/src/styles/main.css');
    const { initI18n, getCurrentLanguage } = await import('/src/services/i18n.ts');
    await initI18n();
    const { NewsPanel } = await import('/src/components/NewsPanel.ts');

    document.getElementById('runtime-harness')?.remove();
    const grid = document.createElement('div');
    grid.className = 'panels-grid';
    grid.id = 'panelsGrid';
    document.body.appendChild(grid);

    const now = Date.now();
    const items = headlines.map((title, i) => ({
      source: `Quelle ${i}`,
      title,
      link: `https://example.test/${i}`,
      pubDate: new Date(now - i * 60_000),
      isAlert: false,
      lang: 'en',
    }));

    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    const sweep = (btn: Element, strips: Element[]) => {
      const r = btn.getBoundingClientRect();
      let total = 0;
      let stolen = 0;
      for (let x = Math.ceil(r.left) + 0.5; x < r.right; x += 1) {
        for (let y = Math.ceil(r.top) + 0.5; y < r.bottom; y += 1) {
          total++;
          const hit = document.elementFromPoint(x, y);
          if (hit && strips.includes(hit)) stolen++;
        }
      }
      return { total, stolen };
    };

    const measure = async (clustered: boolean) => {
      grid.replaceChildren();
      const panel = new NewsPanel(clustered ? 'probe-clustered' : 'probe-flat', 'Probe');
      const el = panel.getElement();
      grid.appendChild(el);
      (panel as unknown as { clusteredMode: boolean }).clusteredMode = clustered;
      panel.renderNews(items);
      const ready = clustered ? '.cluster-meta .item-translate-btn' : '.item-translate-btn';
      for (let i = 0; i < 100 && el.querySelectorAll(ready).length < 3; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      await frame();

      const colStrip = el.querySelector('.panel-col-resize-handle')!;
      const rowStrip = el.querySelector('.panel-resize-handle')!;
      const strips = [colStrip, rowStrip];
      const content = el.querySelector<HTMLElement>('.panel-content')!;

      const visible = [...el.querySelectorAll('.item-translate-btn')].filter((btn) => {
        const r = btn.getBoundingClientRect();
        return r.width > 0 && r.bottom <= content.getBoundingClientRect().bottom;
      });
      const top = visible.map((btn) => sweep(btn, strips));

      content.scrollTop = content.scrollHeight;
      await frame();
      const all = el.querySelectorAll('.item-translate-btn');
      const last = sweep(all[all.length - 1]!, strips);

      const pr = el.getBoundingClientRect();
      return {
        clustered,
        clusterRows: el.querySelectorAll('.cluster-meta').length,
        buttons: top.length,
        stolenTop: top.reduce((n, s) => n + s.stolen, 0),
        last,
        colStripReachable: document.elementFromPoint(pr.right - 3, pr.top + pr.height / 2) === colStrip,
        rowStripReachable: document.elementFromPoint(pr.left + pr.width / 2, pr.bottom - 3) === rowStrip,
      };
    };

    return { lang: getCurrentLanguage(), clustered: await measure(true), flat: await measure(false) };
  }, HEADLINES);

  expect(result.lang).toBe('de');
  expect(result.clustered.clusterRows, 'clustered sweep measures clustered rows').toBeGreaterThan(2);
  expect(result.flat.clusterRows, 'flat sweep measures flat rows').toBe(0);
  for (const layout of [result.clustered, result.flat]) {
    expect(layout.buttons, `${layout.clustered ? 'clustered' : 'flat'} rows render translate buttons`).toBeGreaterThan(0);
    expect(layout, 'resize strips cover no translate-button pixel').toMatchObject({
      stolenTop: 0,
      last: { stolen: 0 },
      colStripReachable: true,
      rowStripReachable: true,
    });
  }
});

test('the right part of the translate button clicks, and the strip still resizes (#9729)', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('wm-locale-explicit', 'de'));
  await page.goto('/tests/runtime-harness.html');

  await page.evaluate(async (headlines) => {
    await import('/src/styles/main.css');
    const { initI18n } = await import('/src/services/i18n.ts');
    await initI18n();
    const { NewsPanel } = await import('/src/components/NewsPanel.ts');
    document.getElementById('runtime-harness')?.remove();
    const grid = document.createElement('div');
    grid.className = 'panels-grid';
    grid.id = 'panelsGrid';
    document.body.appendChild(grid);
    const panel = new NewsPanel('probe-click', 'Probe');
    grid.appendChild(panel.getElement());
    panel.renderNews(headlines.map((title, i) => ({
      source: `Quelle ${i}`,
      title,
      link: `https://example.test/${i}`,
      pubDate: new Date(Date.now() - i * 60_000),
      isAlert: false,
      lang: 'en',
    })));
  }, HEADLINES);

  const panel = page.locator('.panel').first();
  const button = panel.locator('.cluster-meta .item-translate-btn').first();
  await expect(button).toBeVisible();
  await button.evaluate((btn) => {
    btn.addEventListener('click', (e) => {
      (window as unknown as { __translateClicks: number }).__translateClicks =
        ((window as unknown as { __translateClicks?: number }).__translateClicks ?? 0) + 1;
      e.stopPropagation();
    });
  });

  const box = (await button.boundingBox())!;
  await page.mouse.click(box.x + box.width - 2, box.y + box.height / 2);
  expect(await page.evaluate(() => (window as unknown as { __translateClicks?: number }).__translateClicks ?? 0)).toBe(1);
  await expect(panel).not.toHaveClass(/col-resizing/);

  const panelBox = (await panel.boundingBox())!;
  const startX = panelBox.x + panelBox.width - 3;
  const midY = panelBox.y + panelBox.height / 2;
  await page.mouse.move(startX, midY);
  await page.mouse.down();
  await page.mouse.move(startX + panelBox.width, midY, { steps: 8 });
  await page.mouse.up();
  await expect(panel).toHaveClass(/col-span-[23]/);
});

test('aiming at a visible resize grip lands on its drag strip (#9729)', async ({ page }) => {
  await page.goto('/tests/runtime-harness.html');
  const strips = await page.evaluate(async () => {
    await import('/src/styles/main.css');
    const { NewsPanel } = await import('/src/components/NewsPanel.ts');
    document.getElementById('runtime-harness')?.remove();
    const grid = document.createElement('div');
    grid.className = 'panels-grid';
    document.body.appendChild(grid);
    const panel = new NewsPanel('probe-grip', 'Probe');
    grid.appendChild(panel.getElement());
    const style = document.createElement('style');
    style.textContent = '.panel-resize-handle, .panel-col-resize-handle { background: none !important; }'
      + ' .panel-resize-handle::after, .panel-col-resize-handle::after { color: #ff00ff !important; transition: none !important; }';
    document.head.appendChild(style);
    return ['.panel-col-resize-handle', '.panel-resize-handle'].map((selector) => {
      const r = panel.getElement().querySelector(selector)!.getBoundingClientRect();
      return { selector, x: r.left, y: r.top, width: r.width, height: r.height };
    });
  });

  for (const strip of strips) {
    const pad = 24;
    const clip = strip.selector === '.panel-col-resize-handle'
      ? { x: strip.x - pad, y: strip.y + strip.height / 2 - pad, width: strip.width + pad * 2, height: pad * 2 }
      : { x: strip.x + strip.width / 2 - pad, y: strip.y - pad, width: pad * 2, height: strip.height + pad * 2 };
    const png = await page.screenshot({ clip });
    const ink = await page.evaluate(async (b64) => {
      const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const canvas = new OffscreenCanvas(img.width, img.height);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, img.width, img.height).data;
      let sx = 0;
      let sy = 0;
      let n = 0;
      for (let y = 0; y < img.height; y++) {
        for (let x = 0; x < img.width; x++) {
          const i = (y * img.width + x) * 4;
          if (data[i]! > 120 && data[i + 2]! > 120 && data[i + 1]! < 90) {
            sx += x;
            sy += y;
            n++;
          }
        }
      }
      return n ? { x: (sx / n + 0.5) / devicePixelRatio, y: (sy / n + 0.5) / devicePixelRatio } : null;
    }, png.toString('base64'));
    expect(ink, `${strip.selector} grip renders`).not.toBeNull();
    const hit = await page.evaluate(
      ({ x, y, selector }) => document.elementFromPoint(x, y)?.matches(selector) ?? false,
      { x: clip.x + ink!.x, y: clip.y + ink!.y, selector: strip.selector },
    );
    expect(hit, `the visible ${strip.selector} grip is on the drag strip`).toBe(true);
  }
});
