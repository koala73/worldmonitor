import { expect, test } from '@playwright/test';

test('replaying domain snapshots keeps the visible convergence count and confidence stable', async ({ page }, testInfo) => {
  await page.goto('/tests/runtime-harness.html');
  await page.evaluate(async () => {
    await import('/src/styles/main.css');
    const { initI18n } = await import('/src/services/i18n.ts');
    await initI18n();
    const geo = await import('/src/services/geo-convergence.ts');
    const { SignalModal } = await import('/src/components/SignalModal.ts');
    geo.clearCells();
    const modal = new SignalModal();
    const now = new Date();
    const protest = { id: 'protest-1', lat: 32.4, lon: 44.5, time: now };
    const flight = { id: 'flight-1', lat: 32.4, lon: 44.5, lastSeen: now };
    const vessel = { id: 'vessel-1', lat: 32.4, lon: 44.5, lastAisUpdate: now };
    const title = document.createElement('h1');
    title.textContent = 'Controlled convergence fixture: repeated complete feed snapshots';
    document.body.prepend(title);
    const refresh = document.createElement('button');
    refresh.textContent = 'Replay same feeds';
    refresh.onclick = () => {
      for (let i = 0; i < 10; i++) {
        geo.ingestProtests([protest] as never);
        geo.ingestFlights([flight] as never);
        geo.ingestVessels([vessel] as never);
        geo.ingestEarthquakes([{ id: 'quake-1', location: { latitude: 0, longitude: 0 }, occurredAt: now.getTime() }] as never);
      }
      modal.showSignal(geo.geoConvergenceToSignal(geo.detectConvergence()[0]!) as never);
    };
    const add = document.createElement('button');
    add.textContent = 'Add one flight';
    add.onclick = () => {
      geo.ingestFlights([flight, { ...flight, id: 'flight-2', lat: 32.6 }] as never);
      modal.showSignal(geo.geoConvergenceToSignal(geo.detectConvergence()[0]!) as never);
    };
    document.body.prepend(refresh, add);
  });
  await page.getByRole('button', { name: 'Replay same feeds', exact: true }).click();
  await expect(page.locator('.signal-description')).toContainText('3 events/24h');
  await expect(page.locator('.signal-confidence')).toContainText('81%');
  await page.screenshot({ path: testInfo.outputPath('geo-replay.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Add one flight', exact: true }).click();
  await expect(page.locator('.signal-description')).toContainText('4 events/24h');
  await expect(page.locator('.signal-confidence')).toContainText('83%');
  await page.screenshot({ path: testInfo.outputPath('geo-new-flight.png'), fullPage: true, animations: 'disabled' });
});
