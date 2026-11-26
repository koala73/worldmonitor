#!/usr/bin/env node
// Splits the dashboard's panels into shards for the panel content run (.github/workflows/dogfood-content.yml).
// The input is each host's panel catalog as the live app stores it (`worldmonitor-panels` in localStorage), read
// by the workflow's plan job before any agent runs. A panel id that several monitors share is checked once, on
// the first host in the list that has it, so www comes first.
// Run with: DOGFOOD_CATALOGS=<file> DOGFOOD_PLAN=<out file> [PANELS_PER_SHARD=10] [ONLY_PANELS=a,b] node scripts/dogfood/plan-content-shards.mjs
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { isMainModule } from '../lib/main-module.mjs';

const PANEL_ID = /^[a-z0-9-]{1,64}$/;
/** The map is the dashboard's canvas, not a panel with content of its own; the weekly run covers it. */
const SKIPPED = new Set(['map']);

/**
 * @param {Array<{ host: string, target: string, panels: Array<{ id: string, name?: string }> }>} catalogs
 * @returns {{ shards: Array<{ id: string, target: string, panels: string[] }>, panels: Array<{ id: string, name: string, host: string, shard: string }> }}
 */
export function planShards(catalogs, { perShard = 4, only = [] } = {}) {
  if (!Number.isInteger(perShard) || perShard < 1) throw new Error('panels per shard must be a positive integer');
  const wanted = new Set(only);
  const seen = new Set();
  const shards = [];
  const panels = [];
  for (const { host, target, panels: catalog } of catalogs) {
    if (!/^[a-z]+$/.test(host) || !/^https:\/\/[a-z]+\.worldmonitor\.app$/.test(target)) throw new Error(`bad host ${host} ${target}`);
    if (!Array.isArray(catalog) || !catalog.some((panel) => PANEL_ID.test(panel?.id ?? '') && !SKIPPED.has(panel.id))) {
      // A monitor that did not boot in time must fail the run, not vanish from the review.
      throw new Error(`no panel catalog was read from ${host}`);
    }
    const mine = [];
    for (const panel of catalog) {
      if (!PANEL_ID.test(panel?.id ?? '') || SKIPPED.has(panel.id) || seen.has(panel.id)) continue;
      if (wanted.size > 0 && !wanted.has(panel.id)) continue;
      seen.add(panel.id);
      mine.push({ id: panel.id, name: String(panel.name ?? panel.id).slice(0, 80) });
    }
    if (mine.length === 0) continue;
    const count = Math.ceil(mine.length / perShard);
    for (let i = 0; i < count; i += 1) {
      const slice = mine.slice(Math.floor((i * mine.length) / count), Math.floor(((i + 1) * mine.length) / count));
      const id = `${host}-${i + 1}`;
      shards.push({ id, target, panels: slice.map((panel) => panel.id) });
      for (const panel of slice) panels.push({ ...panel, host, shard: id });
    }
  }
  return { shards, panels };
}

if (isMainModule(import.meta.url, process.argv[1])) {
  try {
    const catalogs = JSON.parse(readFileSync(process.env.DOGFOOD_CATALOGS, 'utf8'));
    const only = (process.env.ONLY_PANELS ?? '').split(',').map((id) => id.trim()).filter(Boolean);
    const plan = planShards(catalogs, { perShard: Number(process.env.PANELS_PER_SHARD || 4), only });
    if (plan.shards.length === 0) throw new Error('no panels to check');
    writeFileSync(process.env.DOGFOOD_PLAN, JSON.stringify(plan, null, 2));
    const matrix = { include: plan.shards.map(({ id, target, panels }) => ({ id, target, panels: panels.join(',') })) };
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify(matrix)}\n`);
    const line = `${plan.panels.length} panels in ${plan.shards.length} shards`;
    console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  } catch (error) {
    console.error(`Could not plan the panel content run: ${error.message}`);
    process.exitCode = 1;
  }
}
