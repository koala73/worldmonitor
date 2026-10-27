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
      for (let i = 0; i < 100 && el.querySelectorAll('.item-translate-btn').length < 3; i++) {
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
