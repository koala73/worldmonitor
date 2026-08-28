import test from 'node:test';
import assert from 'node:assert/strict';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readSectionFreshness } from '../scripts/_bundle-runner.mjs';
import { listBundleFiles } from './helpers/bundle-section-parser.mjs';
import {
  extractAttestationBundleSections,
  inspectRunSeedCalls,
} from './helpers/seed-bundle-attestation-parser.mjs';

const SCRIPTS_DIR = fileURLToPath(new URL('../scripts/', import.meta.url));
const COMPLETION_KEY_PREFIX = 'seed-completion:';

function virtualFiles(entries) {
  const files = new Map(Object.entries(entries));
  return (path) => {
    if (!files.has(path)) throw new Error(`missing virtual file ${path}`);
    return files.get(path);
  };
}

test('a partial publish cannot advance the canonical due-ness clock (#6960)', async () => {
  const canonicalPublishedAt = Date.now();
  const previousCompletionAt = canonicalPublishedAt - 40 * 24 * 60 * 60 * 1000;
  const freshness = await readSectionFreshness({
    canonicalKey: 'energy:iea-oil-stocks:v1:index',
    completionMetaKey: 'seed-completion:energy:iea-oil-stocks',
  }, async (key) => {
    if (key === 'energy:iea-oil-stocks:v1:index') {
      return { _seed: { fetchedAt: canonicalPublishedAt }, data: {} };
    }
    if (key === 'seed-completion:energy:iea-oil-stocks') {
      return { fetchedAt: previousCompletionAt };
    }
    return null;
  });
  assert.equal(freshness, null);
});

test('a validation skip cannot turn shared seed-meta into completion proof (#6960)', async () => {
  const partialPublishAt = Date.now();
  const freshness = await readSectionFreshness({
    canonicalKey: 'energy:jodi-gas:v1:_countries',
    seedMetaKey: 'energy:jodi-gas',
    completionMetaKey: 'seed-completion:energy:jodi-gas',
  }, async (key) => {
    if (key === 'energy:jodi-gas:v1:_countries') {
      return { _seed: { fetchedAt: partialPublishAt }, data: {} };
    }
    if (key === 'seed-meta:energy:jodi-gas') {
      // A later validation-skip mirrors the partial canonical timestamp here.
      return { fetchedAt: partialPublishAt, recordCount: 1 };
    }
    return null;
  });
  assert.equal(freshness, null, 'only the dedicated final marker can attest completion');
});

test('a completed run passes the canonical clock through unchanged (#6960)', async () => {
  const canonicalPublishedAt = Date.now() - 60 * 60 * 1000;
  const freshness = await readSectionFreshness({
    canonicalKey: 'energy:iea-oil-stocks:v1:index',
    completionMetaKey: 'seed-completion:energy:iea-oil-stocks',
  }, async (key) => {
    if (key === 'energy:iea-oil-stocks:v1:index') {
      return { _seed: { fetchedAt: canonicalPublishedAt }, data: {} };
    }
    if (key === 'seed-completion:energy:iea-oil-stocks') {
      return { fetchedAt: canonicalPublishedAt, completedAt: canonicalPublishedAt + 6_900 };
    }
    return null;
  });
  assert.deepEqual(freshness, { fetchedAt: canonicalPublishedAt });
});

test('a completion marker for a different canonical run does not attest freshness', async () => {
  const canonicalPublishedAt = Date.now();
  const freshness = await readSectionFreshness({
    canonicalKey: 'test:canonical:v1',
    completionMetaKey: 'seed-completion:test:canonical',
  }, async (key) => (
    key === 'test:canonical:v1'
      ? { _seed: { fetchedAt: canonicalPublishedAt }, data: {} }
      : { fetchedAt: canonicalPublishedAt + 1 }
  ));
  assert.equal(freshness, null);
});

test('a section without a completion key still reads the canonical clock alone (#6960)', async () => {
  const reads = [];
  const publishedAt = Date.now();
  const freshness = await readSectionFreshness({
    canonicalKey: 'infra:ontario-511:v1',
    seedMetaKey: 'infra:ontario-511',
  }, async (key) => {
    reads.push(key);
    if (key === 'infra:ontario-511:v1') return { _seed: { fetchedAt: publishedAt }, data: {} };
    return null;
  });
  assert.deepEqual(freshness, { fetchedAt: publishedAt });
  assert.deepEqual(reads, ['infra:ontario-511:v1']);
});

test('runSeed extraKeys discovery handles shorthand, named objects, and spreads', () => {
  const readSource = virtualFiles({
    '/virtual/seed.mjs': `
      import { runSeed } from './_seed-utils.mjs';
      const extraKeys = [];
      const shared = { extraKeys };
      const options = { ...shared, ttlSeconds: 60 };
      runSeed('d', 'r', 'd:r:v1', fetcher, options);
    `,
  });
  assert.deepEqual(inspectRunSeedCalls('/virtual/seed.mjs', readSource), [{
    hasExtraKeys: true,
    hasPostCanonicalWork: true,
  }]);
});

test('runSeed extraKeys discovery resolves imported options', () => {
  const readSource = virtualFiles({
    '/virtual/seed.mjs': `
      import { runSeed } from './_seed-utils.mjs';
      import { seedOptions } from './options.mjs';
      runSeed('d', 'r', 'd:r:v1', fetcher, seedOptions);
    `,
    '/virtual/options.mjs': `
      const extraKeys = [];
      export const seedOptions = { extraKeys };
    `,
  });
  assert.deepEqual(inspectRunSeedCalls('/virtual/seed.mjs', readSource), [{
    hasExtraKeys: true,
    hasPostCanonicalWork: true,
  }]);
});

test('runSeed discovery resolves named aliases and namespace imports', () => {
  const readSource = virtualFiles({
    '/virtual/aliased.mjs': `
      import { runSeed as seed } from './_seed-utils.mjs';
      seed('d', 'r', 'd:r:v1', fetcher, { afterPublish() {} });
    `,
    '/virtual/namespaced.mjs': `
      import * as seedUtils from './_seed-utils.mjs';
      seedUtils.runSeed('d', 'r', 'd:r:v1', fetcher, { afterFreshness: async () => {} });
    `,
  });
  assert.equal(inspectRunSeedCalls('/virtual/aliased.mjs', readSource)[0].hasPostCanonicalWork, true);
  assert.equal(inspectRunSeedCalls('/virtual/namespaced.mjs', readSource)[0].hasPostCanonicalWork, true);
});

test('runSeed extraKeys discovery fails closed on unresolved options', () => {
  const readSource = virtualFiles({
    '/virtual/seed.mjs': `
      import { runSeed } from './_seed-utils.mjs';
      runSeed('d', 'r', 'd:r:v1', fetcher, makeOptions());
    `,
  });
  assert.throws(
    () => inspectRunSeedCalls('/virtual/seed.mjs', readSource),
    /runSeed options are not statically resolvable/,
  );
});

test('runSeed discovery fails closed without an import binding', () => {
  const readSource = virtualFiles({
    '/virtual/seed.mjs': `runSeed('d', 'r', 'd:r:v1', fetcher, {});`,
  });
  assert.throws(
    () => inspectRunSeedCalls('/virtual/seed.mjs', readSource),
    /no statically identifiable runSeed import/,
  );
});

test('runSeed discovery fails closed on malformed post-canonical options', () => {
  const readSource = virtualFiles({
    '/virtual/extra-keys.mjs': `
      import { runSeed } from './_seed-utils.mjs';
      runSeed('d', 'r', 'd:r:v1', fetcher, { extraKeys: {} });
    `,
    '/virtual/hook.mjs': `
      import { runSeed } from './_seed-utils.mjs';
      runSeed('d', 'r', 'd:r:v1', fetcher, { afterPublish: true });
    `,
  });
  assert.throws(
    () => inspectRunSeedCalls('/virtual/extra-keys.mjs', readSource),
    /extraKeys must resolve to an array/,
  );
  assert.throws(
    () => inspectRunSeedCalls('/virtual/hook.mjs', readSource),
    /afterPublish must resolve to a function/,
  );
});

test('bundle member discovery resolves imported manifests', () => {
  const readSource = virtualFiles({
    '/virtual/bundle.mjs': `
      import { MEMBERS } from './members.mjs';
      runBundle('test', MEMBERS);
    `,
    '/virtual/members.mjs': `
      export const MEMBERS = [{
        label: 'Imported',
        script: 'seed-imported.mjs',
        canonicalKey: 'test:imported:v1',
        completionMetaKey: 'seed-completion:test:imported',
        intervalMs: 60,
      }];
    `,
  });
  assert.deepEqual(extractAttestationBundleSections('/virtual/bundle.mjs', readSource), [{
    label: 'Imported',
    script: 'seed-imported.mjs',
    hasCanonicalKey: true,
    hasFreshnessMetaKey: false,
    completionMetaKey: 'seed-completion:test:imported',
  }]);
});

test('bundle member discovery follows runtime truthiness for freshness defaults', () => {
  const readSource = virtualFiles({
    '/virtual/bundle.mjs': `
      const defaults = { freshnessMetaKey: undefined };
      runBundle('test', [{
        ...defaults,
        label: 'Falsy Freshness',
        script: 'seed-falsy.mjs',
        canonicalKey: 'test:falsy:v1',
        intervalMs: 60,
      }]);
    `,
  });
  assert.deepEqual(extractAttestationBundleSections('/virtual/bundle.mjs', readSource), [{
    label: 'Falsy Freshness',
    script: 'seed-falsy.mjs',
    hasCanonicalKey: true,
    hasFreshnessMetaKey: false,
    completionMetaKey: null,
  }]);
});

const COMPLETION_ATTESTATION_EXEMPT = new Map([
  [
    'seed-bundle-static-ref-heavy.mjs:Arms-Suppliers:seed-defense-industrial-suppliers.mjs',
    'The #6893 chunked sweep stays due until its own terminal marker is written.',
  ],
]);

function attestationIdentity(bundleName, section) {
  return `${bundleName}:${section.label}:${section.script}`;
}

test('an exemption identity does not cover a same-label different seeder', () => {
  const identity = attestationIdentity('seed-bundle-static-ref-heavy.mjs', {
    label: 'Arms-Suppliers',
    script: 'seed-unrelated.mjs',
  });
  assert.equal(COMPLETION_ATTESTATION_EXEMPT.has(identity), false);
});

test('every canonical-clock bundle member with post-canonical work has exact completion attestation (#6960)', () => {
  for (const [identity, reason] of COMPLETION_ATTESTATION_EXEMPT) {
    assert.ok(identity.split(':').length >= 3, `invalid exemption identity: ${identity}`);
    assert.ok(reason.trim().length > 0, `${identity}: exemption needs a reason`);
  }

  const matchedExemptions = new Map(
    [...COMPLETION_ATTESTATION_EXEMPT.keys()].map((identity) => [identity, 0]),
  );
  const offenders = [];
  let inspected = 0;

  for (const bundlePath of listBundleFiles(SCRIPTS_DIR)) {
    const bundleName = basename(bundlePath);
    const sections = extractAttestationBundleSections(bundlePath);
    if (sections == null) continue;
    assert.ok(sections.length > 0, `${bundleName}: no runtime members were resolved`);

    for (const section of sections) {
      if (!section.hasCanonicalKey || section.hasFreshnessMetaKey) continue;
      const calls = inspectRunSeedCalls(join(SCRIPTS_DIR, section.script));
      if (!calls.some((call) => call.hasPostCanonicalWork)) continue;
      inspected++;

      const identity = attestationIdentity(bundleName, section);
      if (COMPLETION_ATTESTATION_EXEMPT.has(identity)) {
        matchedExemptions.set(identity, matchedExemptions.get(identity) + 1);
        continue;
      }
      if (!section.completionMetaKey?.startsWith(COMPLETION_KEY_PREFIX)) {
        offenders.push(`${identity} -> ${section.completionMetaKey ?? 'missing'}`);
      }
    }
  }

  assert.ok(inspected > 0, 'the closed-world audit inspected no at-risk members');
  assert.deepEqual(offenders, [], 'at-risk members need a dedicated completion marker');
  assert.deepEqual(
    [...matchedExemptions],
    [...COMPLETION_ATTESTATION_EXEMPT.keys()].map((identity) => [identity, 1]),
    'every exemption must match exactly one at-risk runtime member',
  );
});
