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

  it('waits for an interactive window and leaves a manual retry path if auto-prompting cannot start', () => {
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
    assert.match(
      gateSrc,
      /Click Authenticate to unlock World Monitor\./,
      'unlock overlay should preserve a visible manual retry path',
    );
    assert.match(
      gateSrc,
      /AUTO_PROMPT_DELAY_MS\s*=\s*450/,
      'unlock overlay should stay visible briefly before auto-auth starts',
    );
  });

  it('plays a sci-fi unlock sequence before dismissing the gate', () => {
    assert.match(
      gateSrc,
      /async function playUnlockCelebration\(/,
      'unlock flow should define a dedicated celebration sequence',
    );
    assert.match(
      gateSrc,
      /await playUnlockCelebration\(/,
      'successful authentication should wait for the unlock celebration before continuing',
    );
    assert.match(
      gateSrc,
      /worldmonitor-door-left/,
      'unlock overlay should include spaceship-style door visuals',
    );
    assert.match(
      gateSrc,
      /worldmonitor-lock-frame/,
      'unlock overlay should include a hard outer lock frame so the gate is unmistakable',
    );
    assert.match(
      gateSrc,
      /worldmonitor-biometric-hero/,
      'unlock overlay should include a dedicated fingerprint access hero',
    );
    assert.match(
      gateSrc,
      /BIOMETRIC SIGNATURE VERIFIED/,
      'unlock overlay should include biometric access callouts instead of a generic modal body only',
    );
    assert.match(
      gateSrc,
      /appRoot\.style\.filter = 'blur\(10px\) saturate\(0\.75\)'/,
      'unlock overlay should suppress the dashboard beneath it while active',
    );
    assert.match(
      gateSrc,
      /MIN_OVERLAY_VISIBLE_MS\s*=\s*900/,
      'unlock overlay should remain visible long enough to be perceived before the success transition',
    );
  });
});
