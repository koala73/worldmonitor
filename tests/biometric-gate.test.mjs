import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const mainSrc = readFileSync(path.join(repoRoot, 'src/main.ts'), 'utf8');
const gateSrc = readFileSync(path.join(repoRoot, 'src/app/biometric-gate.ts'), 'utf8');

describe('desktop biometric bootstrap', () => {
  it('uses desktop runtime detection for the unlock gate', () => {
    assert.match(
      mainSrc,
      /if \(isDesktopRuntime\(\)\) \{/,
      'desktop unlock should follow the shared runtime detector instead of raw window globals',
    );
  });

  it('uses the shared tauri bridge inside the biometric gate', () => {
    assert.match(
      gateSrc,
      /from '\.\.\/services\/tauri-bridge'/,
      'biometric gate should import the shared tauri bridge helper',
    );
    assert.match(
      gateSrc,
      /invokeTauri<|await invokeTauri\(/,
      'biometric gate should invoke the plugin through the shared tauri bridge',
    );
  });

  it('authenticates directly with the plugin instead of suppressing the prompt with a status preflight', () => {
    assert.doesNotMatch(
      gateSrc,
      /plugin:biometry\|status/,
      'unlock flow should not depend on a separate status IPC call before prompting',
    );
    assert.match(
      gateSrc,
      /options:\s*\{\s*allowDeviceCredential: true,\s*\}/,
      'authenticate should send allowDeviceCredential inside the required options object',
    );
  });

  it('waits for an interactive window before prompting and keeps the happy path free of custom auth chrome', () => {
    assert.match(
      gateSrc,
      /async function waitForInteractiveWindow\(/,
      'unlock flow should wait until the desktop window is interactive',
    );
    assert.match(
      gateSrc,
      /const windowReady = await waitForInteractiveWindow\(\)/,
      'startup auth should check window readiness before prompting',
    );
    assert.doesNotMatch(
      gateSrc,
      /document\.body\.appendChild\(container\)/,
      'happy path should not inject a custom full-screen auth window before the OS prompt',
    );
    assert.match(
      gateSrc,
      /AUTO_PROMPT_DELAY_MS\s*=\s*80/,
      'unlock flow should move into biometric auth almost immediately once the window is interactive',
    );
  });

  it('auto-resumes authentication as soon as the window becomes interactive again', () => {
    assert.match(
      gateSrc,
      /window\.addEventListener\('focus',/,
      'unlock flow should resume automatically when the desktop window regains focus',
    );
    assert.match(
      gateSrc,
      /document\.addEventListener\('visibilitychange',/,
      'unlock flow should resume automatically when the document becomes visible again',
    );
    assert.match(
      gateSrc,
      /Authentication will start automatically\./,
      'fallback copy should tell the user auth will auto-resume instead of requiring manual recovery only',
    );
    assert.match(
      gateSrc,
      /showFallbackOverlay\(/,
      'manual retry controls should be created only in the fallback overlay path',
    );
    assert.match(
      gateSrc,
      /Try Again/,
      'fallback controls should present retry language instead of a primary authenticate click on startup',
    );
    assert.match(
      gateSrc,
      /AUTO_PROMPT_DELAY_MS\s*=\s*80/,
      'pre-auth delay should be tightened so the biometric prompt feels immediate',
    );
    assert.match(
      gateSrc,
      /WINDOW_READY_TIMEOUT_MS\s*=\s*1200/,
      'startup should fail over to auto-resume quickly instead of stalling for several seconds',
    );
  });

  it('keeps auto-retrying while the Tauri bridge is still booting', () => {
    assert.match(
      gateSrc,
      /Preparing secure unlock\. Authentication will start automatically\./,
      'bridge bootstrap failures should stay in an auto-retry state instead of requiring a manual click',
    );
    assert.match(
      gateSrc,
      /hasTauriInvokeBridge\(\)/,
      'fallback recovery should explicitly watch for the shared Tauri bridge becoming available',
    );
    assert.match(
      gateSrc,
      /window\.setInterval\(/,
      'fallback recovery should poll for bridge readiness so auth can resume without a focus change',
    );
  });

  it('uses a minimal fallback screen instead of a second theatrical auth window', () => {
    assert.match(
      gateSrc,
      /const container = document\.createElement\('div'\)/,
      'fallback path should still be able to render a minimal recovery screen',
    );
    assert.match(
      gateSrc,
      /Touch ID did not complete\./,
      'fallback screen should explain the issue plainly',
    );
    assert.doesNotMatch(
      gateSrc,
      /playUnlockSound|createConvolver|doorRumbleFilter|hydraulicNoiseFilter/,
      'fallback auth should not ship the door sound stack',
    );
    assert.doesNotMatch(
      gateSrc,
      /worldmonitor-door-left|worldmonitor-airlock-depth|worldmonitor-lock-frame|wm-biometry-seal-break/,
      'fallback auth should not render the sci-fi door and airlock treatment',
    );
  });
});
