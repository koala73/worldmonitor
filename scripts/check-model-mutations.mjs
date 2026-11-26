#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const MARKER_WRITE = '  await redisRevoke([], [{ key: `brief:erased:${args.userId}`, value: "1", ttlSeconds: BRIEF_ERASED_TTL_SECONDS }]);\n';
const INDEX_READ = '  const slots = mergeUniqueStrings(await redisZrangeAll(slotsKey), slot ? [slot] : []);\n';

const MODELS = {
  'brief-erasure': {
    test: 'tests/brief-erase-compose-model.test.mts',
    mutations: [
  {
    name: 'the compose skips the erase-marker re-read after its envelope write (the race flagged on #10896)',
    file: 'scripts/lib/brief-l10n.mjs',
    apply: (s) => s.replace(`  if (await undoBriefWriteIfErased(userId, issueSlot, pipeline)) {
    throw new Error('account erased during compose; brief removed');
  }
`, ''),
    expect: 'with no Redis failures',
  },
  {
    name: 'the erase reads the slot index before it sets the marker',
    file: 'convex/accountDeletion/sideEffects.ts',
    apply: (s) => s.replace(MARKER_WRITE, '').replace(INDEX_READ, INDEX_READ + MARKER_WRITE),
    expect: 'with no Redis failures',
  },
  {
    name: 'completing the deletion schedules no brief sweep (#10956)',
    file: 'convex/accountDeletion/erase.ts',
    apply: (s) => s.replace(`    await ctx.scheduler.runAfter(BRIEF_SWEEP_DELAY_MS,
      internal.accountDeletion.sideEffects.sweepBriefEnvelopes,
      { deletionId: row._id, cursor: "0", attempt: 0 },
    );
`, ''),
    expect: 'the scheduled sweep removes',
  },
  {
    name: 'the sweep stops after its first SCAN page',
    file: 'convex/accountDeletion/sideEffects.ts',
    apply: (s) => s.replace('      if (cursor !== "0") {\n        const pages', '      if (false) {\n        const pages'),
    expect: 'the scheduled sweep removes',
  },
  {
    name: 'the sweep delay is shorter than a compose can run',
    file: 'convex/accountDeletion/registry.ts',
    apply: (s) => s.replace('export const BRIEF_SWEEP_DELAY_MS = 15 * 60_000;', 'export const BRIEF_SWEEP_DELAY_MS = 5_000;'),
    expect: 'the scheduled sweep removes',
  },
],
  },
  'relay-claims': {
    test: 'tests/notification-relay-claim-model.test.mts',
    mutations: [
      {
        name: 'a failed channel read keeps the dedup claim (SM-115, #10222)',
        file: 'scripts/notification-relay.cjs',
        apply: (s) => s.replace('      if (await releaseRealtimeClaim(dedupDecision, claim)) {', '      if (false) {'),
        expect: 'with one failed or lost request anywhere',
      },
      {
        name: 'the fail-open release skips the Redis claim a lost SET NX response committed (#10222)',
        file: 'scripts/notification-relay.cjs',
        apply: (s) => s.replace('    await releaseDedupClaim(claim.key, claim.token);\n    return releaseFailOpenFallback(claim.fallbackKey);',
          '    return releaseFailOpenFallback(claim.fallbackKey);'),
        expect: 'with a failed or lost dedup claim and a failed channel read',
      },
      {
        name: 'a failed entitlement cache write clamps a paying user to free tier',
        file: 'scripts/notification-relay.cjs',
        apply: (s) => s.replace('    await cacheUserTier(cacheKey, tier ?? 0, ENTITLEMENT_CACHE_TTL);',
          "    await upstashRest('SET', cacheKey, String(tier ?? 0), 'EX', String(ENTITLEMENT_CACHE_TTL));"),
        expect: 'with one failed or lost request anywhere',
      },
    ],
  },
};

const selected = process.argv[2] ? { [process.argv[2]]: MODELS[process.argv[2]] } : MODELS;
let escaped = 0;
for (const [modelName, model] of Object.entries(selected)) {
  if (!model) throw new Error(`unknown model ${modelName}; pick one of ${Object.keys(MODELS).join(', ')}`);
  for (const mutation of model.mutations) {
    const path = resolve(root, mutation.file);
    const original = readFileSync(path, 'utf8');
    const mutated = mutation.apply(original);
    if (mutated === original) throw new Error(`mutation no longer applies, update it: ${mutation.name}`);
    writeFileSync(path, mutated);
    let output = '';
    try {
      output = execFileSync(process.execPath, ['--import', 'tsx', '--test', model.test], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
      output = `${err.stdout ?? ''}`;
    } finally {
      writeFileSync(path, original);
    }
    const caught = output.split('\n').some((line) => line.startsWith('  ✖') && line.includes(mutation.expect));
    console.log(`${caught ? 'caught ' : 'ESCAPED'}  ${modelName}: ${mutation.name}`);
    if (!caught) escaped += 1;
  }
}
if (escaped > 0) {
  console.error(`${escaped} mutation(s) escaped their model`);
  process.exit(1);
}
