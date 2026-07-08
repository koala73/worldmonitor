import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import test from 'node:test';

const source = readFileSync(new URL('../pro-test/src/App.tsx', import.meta.url), 'utf8');
const signalBars = source.match(/const SignalBars = \(\) => \{[\s\S]*?\n\};\n\nconst Hero = \(\) => \{/);

test('/pro SignalBars keeps hero animation on compositor-friendly transforms', () => {
  assert.ok(signalBars, 'SignalBars source block should be present');
  const body = signalBars[0];

  assert.match(body, /scaleY/, 'bars should animate scaleY instead of layout height');
  assert.match(body, /transformOrigin:\s*'bottom'/, 'bars should scale from the baseline');
  assert.doesNotMatch(
    body,
    /animate=\{[\s\S]*?height\s*:/,
    'SignalBars must not animate height; mobile DebugBear reports this as forced layout work.',
  );
});
