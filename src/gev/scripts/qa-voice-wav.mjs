#!/usr/bin/env node
/**
 * Credentialed AI voice acceptance using a prerecorded Chromium microphone.
 *
 * Run: node scripts/qa-voice-wav.mjs http://localhost:4189
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appUrl = process.argv[2] || 'http://localhost:4189';
const wavPath = process.argv[3]
  || path.join(repoRoot, 'scripts', 'fixtures', 'voice', 'full-globe-turn-on-radio.wav');
const expectedFixtureSha256 = 'b57af70db1922b72fec2c6c58348ccd3309e10aa1e8edec2890277dff26cc7bb';

if (!wavPath || !fs.existsSync(wavPath)) {
  console.error(`WAV fixture not found: ${wavPath || '(missing argument)'}`);
  process.exit(2);
}

const fixtureSha256 = createHash('sha256').update(fs.readFileSync(wavPath)).digest('hex');
if (fixtureSha256 !== expectedFixtureSha256) {
  console.error(`Unexpected WAV fixture SHA-256: ${fixtureSha256}`);
  process.exit(2);
}

const appOrigin = new URL(appUrl).origin;
const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: puppeteer.executablePath(),
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${wavPath}%noloop`,
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1440,900',
  ],
});

try {
  const context = browser.defaultBrowserContext();
  await context.overridePermissions(appOrigin, ['microphone']);
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(() => (
    window.__godsEyeView?.voiceCommands
    && document.getElementById('gev-voice-button')
  ), { timeout: 30_000 });

  const readState = () => page.evaluate(() => {
    const voice = window.__godsEyeView?.voiceCommands;
    const radio = window.__godsEyeView?.dataManager?.layers?.get('radio')?.module;
    const radioState = radio?.getUIState?.() || null;
    const camera = window.__godsEyeView?.viewer?.camera;
    const cartographic = camera?.positionCartographic;
    return {
      at: Date.now(),
      voiceStatus: voice?.status || null,
      voiceDetail: document.getElementById('gev-voice-detail')?.textContent?.trim() || null,
      cameraHeightM: cartographic?.height ?? null,
      radioEnabled: radioState?.enabled ?? null,
      radioAudioState: radioState?.audioState ?? null,
      radioStation: radioState?.selected?.name || null,
      radioVoiceDucked: radioState?.voiceDucked ?? null,
    };
  });

  const initial = await readState();
  await page.evaluate(() => document.getElementById('gev-voice-button').click());

  const timeline = [initial];
  let lastSignature = JSON.stringify(initial);
  const deadline = Date.now() + 75_000;
  let finalState = initial;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    finalState = await readState();
    const signature = JSON.stringify({
      voiceStatus: finalState.voiceStatus,
      voiceDetail: finalState.voiceDetail,
      cameraHeightM: Math.round(finalState.cameraHeightM || 0),
      radioEnabled: finalState.radioEnabled,
      radioAudioState: finalState.radioAudioState,
      radioStation: finalState.radioStation,
      radioVoiceDucked: finalState.radioVoiceDucked,
    });
    if (signature !== lastSignature) {
      timeline.push(finalState);
      lastSignature = signature;
    }
    if (
      finalState.voiceStatus === 'idle'
      && finalState.radioAudioState === 'playing'
      && finalState.radioVoiceDucked === false
      && Number(finalState.cameraHeightM) >= 10_000_000
    ) break;
    if (finalState.voiceStatus === 'error') break;
  }

  const result = {
    ok: finalState.voiceStatus === 'idle'
      && finalState.radioAudioState === 'playing'
      && finalState.radioVoiceDucked === false
      && Number(finalState.cameraHeightM) >= 10_000_000,
    fixture: wavPath,
    fixtureSha256,
    appUrl,
    elapsedMs: finalState.at - initial.at,
    finalState,
    timeline,
    consoleErrors,
  };
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
} finally {
  await browser.close();
}
