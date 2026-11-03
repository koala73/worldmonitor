import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

// The /pro hero renders 60 bars that scale continuously and forever. Motion
// can only hand an animation to the browser's native compositor when the
// animated value is one it lists as accelerated -- `transform` is, the
// individual `scaleY` shorthand is not. Passing `scaleY: [...]` therefore
// drives all 60 bars from Motion's JavaScript frame loop, which DebugBear's
// mobile profile reports as main-thread task time; passing complete
// `transform: ['scaleY(x)', ...]` keyframes moves the same motion to WAAPI.
//
// That distinction is invisible in a screenshot and cheap to undo -- a
// "simplification" back to the `scaleY` shorthand looks identical and silently
// restores the frame loop. So this spec asserts the mechanism (a native
// KeyframeEffect on every bar) AND the contract (the keyframes are the
// intended scaleY sequence, and the animation is actually running). Asserting
// only that a transform animation exists would stay green through a wrong
// axis, a frozen value, or a paused animation.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://pro-hero-animation.test';
const PRO_INDEX = 'public/pro/index.html';
const BAR_COUNT = 60;

// Matches the `scaleY(<number>)` strings pro-test/src/App.tsx builds from its
// scale keyframes. Deliberately narrow: a change to another transform function
// should fail here and be widened on purpose, not absorbed silently.
const SCALE_Y_KEYFRAME = /^scaleY\(\d*\.?\d+\)$/;

// DebugBear's mobile profile, and a desktop width past the `md:` breakpoint
// where the bars get wider and taller.
const VIEWPORTS = [
  { width: 360, height: 640 },
  { width: 1440, height: 900 },
];

test.describe('pro hero animation', () => {
  for (const viewport of VIEWPORTS) {
    test(`bars animate natively at ${viewport.width}px`, async ({ page }) => {
      // public/pro/ is gitignored build output. Fail with the fix rather than
      // with an opaque net::ERR_FAILED from aborting the document request.
      expect(
        existsSync(resolve(repoRoot, PRO_INDEX)),
        `${PRO_INDEX} is missing. Run \`npm run build:pro\` first.`,
      ).toBe(true);

      await page.setViewportSize(viewport);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      // Exercise the built React/Motion code; keep analytics and APIs offline.
      await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== ORIGIN) return route.abort();
        const pathname = url.pathname === '/pro' ? '/pro/index.html' : url.pathname;
        const path = resolve(repoRoot, 'public', pathname.replace(/^\//, ''));
        if (!existsSync(path)) return route.abort();
        return route.fulfill({ path });
      });
      await page.goto(`${ORIGIN}/pro`, { waitUntil: 'load' });
      const bars = page.locator('main div[aria-hidden="true"] > div > div');
      await expect(bars).toHaveCount(BAR_COUNT);

      // Every bar must carry a running, infinitely repeating native animation
      // whose keyframes are more than one distinct scaleY value. `iterations`
      // alone would accept an idle or paused animation, and a keyframe type
      // check alone would accept scaleX, a translate, or a frozen scaleY(1).
      await expect
        .poll(
          () => bars.evaluateAll(
            (elements, pattern) => elements.filter((bar) => bar.getAnimations().some((animation) => {
              const effect = animation.effect;
              if (!(effect instanceof KeyframeEffect)) return false;
              if (effect.getTiming().iterations !== Infinity) return false;
              if (animation.playState !== 'running') return false;
              const transforms = effect
                .getKeyframes()
                .map((frame) => frame.transform)
                .filter((value): value is string => typeof value === 'string');
              return transforms.length > 1
                && new Set(transforms).size > 1
                && transforms.every((value) => new RegExp(pattern).test(value));
            })).length,
            SCALE_Y_KEYFRAME.source,
          ),
          { message: 'every hero bar must run a native scaleY keyframe animation' },
        )
        .toBe(BAR_COUNT);

      expect(errors).toEqual([]);
    });
  }
});
