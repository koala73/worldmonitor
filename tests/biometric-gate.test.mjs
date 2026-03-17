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
      /const desktopRuntime = await waitForDesktopRuntimeSnapshot\(\)/,
      'desktop unlock should wait for runtime bootstrap before deciding whether to show the gate',
    );
    assert.match(
      mainSrc,
      /if \(desktopRuntime\.detected \|\| desktopRuntime\.forcedDesktopBuild\) \{/,
      'desktop-built bundles should still show the unlock gate even if runtime globals are late',
    );
    assert.match(
      mainSrc,
      /const FORCE_DESKTOP_GATE = import\.meta\.env\.VITE_DESKTOP_RUNTIME === '1';/,
      'desktop builds should carry an explicit gate-forcing signal',
    );
  });

  it('shows a visible runtime warning if a desktop build never detects Tauri', () => {
    assert.match(
      mainSrc,
      /function showDesktopRuntimeDebugNotice\(/,
      'startup should surface a visible runtime warning when a desktop build misses Tauri detection',
    );
    assert.match(
      mainSrc,
      /desktop-runtime-debug-notice/,
      'runtime warning should have a stable DOM id so regressions are easy to spot',
    );
    assert.match(
      mainSrc,
      /Desktop build skipped biometric gate because Tauri runtime never appeared\./,
      'runtime warning copy should explain exactly why the biometric gate was skipped',
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

  it('renders real user context instead of placeholder bay telemetry', () => {
    assert.doesNotMatch(
      gateSrc,
      /\['BAY', 'A-12'\]/,
      'biometric telemetry should not show placeholder bay identifiers',
    );
    assert.match(
      gateSrc,
      /async function resolveBiometricIdentity\(/,
      'biometric gate should resolve a real identity payload for the user',
    );
    assert.match(
      gateSrc,
      /\['USER', biometricIdentity\.displayName\]/,
      'biometric telemetry should show the user name',
    );
    assert.match(
      gateSrc,
      /\['LOCATION', biometricIdentity\.location\]/,
      'biometric telemetry should show the user location',
    );
    assert.match(
      gateSrc,
      /\['PLANET', biometricIdentity\.planet\]/,
      'biometric telemetry should show the planet',
    );
    assert.match(
      gateSrc,
      /\['COUNTRY', `\$\{biometricIdentity\.flag\} \$\{biometricIdentity\.country\}`\.trim\(\)\]/,
      'biometric telemetry should show the country with its flag',
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
      /worldmonitor-airlock-depth/,
      'unlock stage should include a dedicated inner airlock chamber instead of a flat backdrop only',
    );
    assert.match(
      gateSrc,
      /worldmonitor-aperture-ring/,
      'unlock stage should include a machined aperture ring to frame the inner bay',
    );
    assert.match(
      gateSrc,
      /worldmonitor-door-track-left/,
      'unlock stage should include visible door track hardware on the left side',
    );
    assert.match(
      gateSrc,
      /worldmonitor-door-track-right/,
      'unlock stage should include visible door track hardware on the right side',
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
    assert.match(
      gateSrc,
      /UNLOCK_SCAN_SETTLE_MS\s*=\s*720/,
      'unlock success should pause long enough for a clean biometric verification beat before the doors move',
    );
    assert.match(
      gateSrc,
      /UNLOCK_DOOR_OPEN_MS\s*=\s*1680/,
      'unlock doors should open on a slower, premium cadence instead of snapping away too fast',
    );
    assert.match(
      gateSrc,
      /UNLOCK_SEAL_BREAK_MS\s*=\s*240/,
      'unlock motion should include a distinct seal-break beat before the full door travel',
    );
    assert.match(
      gateSrc,
      /UNLOCK_PANEL_WITHDRAW_MS\s*=\s*760/,
      'the command panel should linger during the opening instead of disappearing the instant unlock starts',
    );
    assert.match(
      gateSrc,
      /wm-biometry-fingerprint-verify/,
      'unlock sequence should drive a dedicated fingerprint verification animation',
    );
    assert.match(
      gateSrc,
      /wm-biometry-seal-break/,
      'unlock sequence should include a dedicated seal-break lighting pass',
    );
    assert.match(
      gateSrc,
      /UNLOCK_SOUND_SEAL_TRANSIENT_MS\s*=\s*180/,
      'unlock sound should include a short seal-break transient before the main door movement',
    );
    assert.match(
      gateSrc,
      /UNLOCK_SOUND_DOOR_SWELL_MS\s*=\s*1480/,
      'unlock sound should sustain through the slower door travel instead of ending too early',
    );
    assert.match(
      gateSrc,
      /sealNoiseFilter/,
      'unlock sound should have a distinct seal-break layer instead of one generic noise burst',
    );
    assert.match(
      gateSrc,
      /doorRumbleFilter/,
      'unlock sound should include a separate low rumble for the door motion',
    );
    assert.match(
      gateSrc,
      /hydraulicNoiseFilter/,
      'unlock sound should include a dedicated hydraulic pressure-release layer',
    );
    assert.match(
      gateSrc,
      /hydraulicPulseOsc/,
      'unlock sound should include a pulsing hydraulic/mechanical actuator tone',
    );
    assert.match(
      gateSrc,
      /createDynamicsCompressor/,
      'unlock sound should use mastering control so the layered effect feels polished instead of raw',
    );
    assert.match(
      gateSrc,
      /createConvolver/,
      'unlock sound should include a designed reflective tail for a premium chamber feel',
    );
    assert.match(
      gateSrc,
      /createStereoPanner/,
      'unlock sound should place mechanical motion across the sound field instead of dead center only',
    );
    assert.match(
      gateSrc,
      /hydraulicTailFilter/,
      'unlock sound should include a separate hydraulic tail texture for the pressure release',
    );
    assert.match(
      gateSrc,
      /conic-gradient/,
      'unlock surfaces should use more premium machined-light treatment instead of flat metal only',
    );
    assert.match(
      gateSrc,
      /BIOMETRIC MATCH CONFIRMED/,
      'success state should read like a refined secure-facility verification screen',
    );
  });
});
