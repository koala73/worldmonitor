import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  parseDesktopVersion,
  isNewerDesktopVersion,
  decideUpdateOutcome,
} from '../src/utils/desktop-version.ts';

// #5908: `remote.split('.').map(Number)` turned "2.10.0-tech" into [2, 10, NaN].
// Every comparison against NaN is false, so isNewerVersion returned false and the
// updater logged `no_update` — every client silently stopped updating, forever,
// with nothing in the logs to notice. A version we cannot parse must be loud.

test('parses a plain release version', () => {
  assert.deepEqual(parseDesktopVersion('2.10.0'), [2, 10, 0]);
});

test('tolerates a leading v and surrounding whitespace', () => {
  assert.deepEqual(parseDesktopVersion(' v2.10.0 '), [2, 10, 0]);
});

test('compares the numeric core of a suffixed version instead of NaN-poisoning it', () => {
  // The exact #5908 payload: a `-tech` tagged release reaching a `full` client.
  assert.deepEqual(parseDesktopVersion('2.10.0-tech'), [2, 10, 0]);
  assert.deepEqual(parseDesktopVersion('2.11.0+build.7'), [2, 11, 0]);
});

test('rejects a version whose numeric core is not parseable', () => {
  for (const bad of ['', '   ', 'latest', 'v', '2.x.0', '2..0', '-tech', 'nightly-2.10.0']) {
    assert.equal(parseDesktopVersion(bad), null, `expected ${JSON.stringify(bad)} to be unparseable`);
  }
});

test('rejects a non-string version', () => {
  assert.equal(parseDesktopVersion(undefined as unknown as string), null);
  assert.equal(parseDesktopVersion(null as unknown as string), null);
  assert.equal(parseDesktopVersion(2.1 as unknown as string), null);
});

test('detects a newer remote version', () => {
  assert.equal(isNewerDesktopVersion('2.11.0', '2.10.0'), true);
  assert.equal(isNewerDesktopVersion('2.10.1', '2.10.0'), true);
  assert.equal(isNewerDesktopVersion('3.0.0', '2.99.99'), true);
});

test('does not offer an update for an equal or older remote version', () => {
  assert.equal(isNewerDesktopVersion('2.10.0', '2.10.0'), false);
  assert.equal(isNewerDesktopVersion('2.9.9', '2.10.0'), false);
  assert.equal(isNewerDesktopVersion('2.10.0', '2.10.1'), false);
});

test('treats a missing trailing segment as zero, both directions', () => {
  assert.equal(isNewerDesktopVersion('2.10', '2.10.0'), false);
  assert.equal(isNewerDesktopVersion('2.10.0', '2.10'), false);
  assert.equal(isNewerDesktopVersion('2.10.1', '2.10'), true);
  assert.equal(isNewerDesktopVersion('2.10', '2.10.1'), false);
});

test('compares segments numerically, not lexicographically', () => {
  // The bug this guards: '2.9.0' > '2.10.0' under string comparison.
  assert.equal(isNewerDesktopVersion('2.10.0', '2.9.0'), true);
  assert.equal(isNewerDesktopVersion('2.9.0', '2.10.0'), false);
});

test('surfaces an unparseable version as null rather than a silent false', () => {
  // `false` here would be indistinguishable from "you are up to date" — the
  // exact failure mode of #5908. The caller must be able to log it.
  assert.equal(isNewerDesktopVersion('2.10.0-tech', 'garbage'), null);
  assert.equal(isNewerDesktopVersion('garbage', '2.10.0'), null);
  assert.equal(isNewerDesktopVersion('', '2.10.0'), null);
});

// The updater's decision itself — #5908 was a two-outcome mapping where the
// unreadable case fell into "up to date". These pin the third outcome so a
// regression that collapses it fails here instead of silently stranding every
// installed client.

test('decides update_available for a newer remote version', () => {
  assert.equal(decideUpdateOutcome('2.11.0', '2.10.0'), 'update_available');
  assert.equal(decideUpdateOutcome('2.10.1', '2.10.0'), 'update_available');
});

test('decides no_update for an equal or older remote version', () => {
  assert.equal(decideUpdateOutcome('2.10.0', '2.10.0'), 'no_update');
  assert.equal(decideUpdateOutcome('2.9.0', '2.10.0'), 'no_update');
});

test('decides version_unparsable instead of no_update for an unreadable version', () => {
  // The regression guard: every one of these returned `no_update` before the
  // fix, which is why the failure went unnoticed for months.
  for (const remote of ['', '   ', 'latest', 'nightly-2.11.0', '2.x.0']) {
    assert.equal(
      decideUpdateOutcome(remote, '2.10.0'),
      'version_unparsable',
      `remote=${JSON.stringify(remote)} must not be reported as up to date`
    );
  }
  assert.equal(decideUpdateOutcome('2.11.0', 'garbage'), 'version_unparsable');
});

test('a suffixed remote tag still offers the update rather than stalling', () => {
  // The literal #5908 payload: `2.11.0-tech` reaching a 2.10.0 client.
  assert.equal(decideUpdateOutcome('2.11.0-tech', '2.10.0'), 'update_available');
  assert.equal(decideUpdateOutcome('2.10.0-tech', '2.10.0'), 'no_update');
});
