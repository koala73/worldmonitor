#!/usr/bin/env node
/**
 * Composited-layer audit harness (#4630 / #4487) — the layer-tree companion to
 * scripts/measure-desktop-mainthread.mjs (#4539).
 *
 * The desktop main-thread harness surfaced that Blink `Layerize` (compositor
 * layerization) is ~27.6% / ~3s of desktop /dashboard's main thread — the single
 * largest component of the #4539 "Other" bucket. `Layerize` cost scales with the
 * NUMBER of composited layers and how often the layer tree is rebuilt, but the
 * trace share is noisy under host contention and cannot name WHICH DOM nodes own
 * the layers. This tool answers that: it enables the CDP `LayerTree` domain,
 * loads a URL, and reports the composited-layer count, the top owning selectors,
 * and the compositing reasons — the deterministic evidence (#4630 R1) that makes
 * a demotion targeted and its effect legible (N fewer layers).
 *
 * Philosophy mirrors the desktop harness (KTD1/#4486): trust the layer COUNT
 * (deterministic) as the leading indicator; the `Layerize` trace share is the
 * goal metric, measured separately. The pure aggregation functions are exported
 * and unit-tested with fixtures (deterministic, CI-safe); Playwright is imported
 * lazily so importing this module for its helpers never launches a browser.
 *
 * Usage:
 *   node scripts/measure-composited-layers.mjs [url] [--cpu 1] [--settle 15000] [--json]
 *   (default url: https://www.worldmonitor.app/dashboard; run against a local
 *    `vite preview` build for in-session before/after per #4630 KTD3)
 */
import { pathToFileURL } from 'node:url';

const DESCRIBE_NODE_CAP = 400;
const DESCRIBE_NODE_CAP_SKIPPED_SELECTOR = '(describe-cap-skipped)';
const CAP_SKIPPED_NODE = Object.freeze({ skippedByDescribeNodeCap: true });

function parsePositiveNumberFlag(name, raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a finite positive number`);
  }
  return n;
}

export function parseArgs(argv) {
  const args = { url: 'https://www.worldmonitor.app/dashboard', cpu: 1, settle: 15000, json: false };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--cpu') {
      args.cpu = parsePositiveNumberFlag('--cpu', rest[++i]);
    } else if (a === '--settle') {
      args.settle = parsePositiveNumberFlag('--settle', rest[++i]);
    } else if (a === '--json') {
      args.json = true;
    } else if (!a.startsWith('--')) {
      args.url = a;
    }
  }
  return args;
}

/**
 * Pick the current layer tree from a sequence of `LayerTree.layerTreeDidChange`
 * snapshots. The last event carrying a defined `layers` array is the live tree;
 * events without a `layers` field are no-ops and ignored, so repeated changes do
 * not double-count and only the final composited-layer set is measured.
 */
export function latestSnapshot(snapshots) {
  let last = [];
  for (const s of Array.isArray(snapshots) ? snapshots : []) {
    if (Array.isArray(s?.layers)) last = s.layers;
  }
  return last;
}

/** Flat CDP attribute array [name,val,name,val,…] -> { id, className }. */
export function parseAttributes(attrs) {
  const out = {};
  const list = Array.isArray(attrs) ? attrs : [];
  for (let i = 0; i + 1 < list.length; i += 2) out[list[i]] = list[i + 1];
  return { id: out.id || '', className: out.class || '' };
}

/**
 * Compact CSS-ish selector for a layer's owning DOM node (from
 * `DOM.describeNode`): `tag#id` when an id exists, else `tag.class1.class2`
 * (first two classes), else the bare tag. Unknown nodes yield '(unknown)'.
 */
export function selectorForNode(node) {
  if (!node || !node.nodeName) return '(unknown)';
  const tag = String(node.nodeName).toLowerCase();
  const { id, className } = parseAttributes(node.attributes);
  if (id) return `${tag}#${id}`;
  const cls = String(className).trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
  return cls ? `${tag}.${cls}` : tag;
}

/**
 * Attribute each layer to a selector. A layer with a resolvable backend node
 * gets its selector; one whose node failed to resolve is '(detached)'; one with
 * a node skipped by the describe cap is '(describe-cap-skipped)'; one with
 * no backend node at all is '(structural)' (compositor root/scroll layer). Every
 * layer is kept — nothing is dropped — so the count stays honest.
 */
export function attributeLayers(layers, nodes) {
  return (Array.isArray(layers) ? layers : []).map((l) => {
    const hasNode = l?.backendNodeId != null;
    const node = hasNode ? nodes?.[l.backendNodeId] : null;
    const selector = !hasNode
      ? '(structural)'
      : node?.skippedByDescribeNodeCap
        ? DESCRIBE_NODE_CAP_SKIPPED_SELECTOR
        : node
          ? selectorForNode(node)
          : '(detached)';
    return { layerId: l?.layerId, selector, width: l?.width, height: l?.height, paintCount: l?.paintCount };
  });
}

/** Group attributed layers by selector, descending by layer count. */
export function groupBySelector(attributed) {
  const counts = new Map();
  for (const a of Array.isArray(attributed) ? attributed : []) {
    counts.set(a.selector, (counts.get(a.selector) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([selector, count]) => ({ selector, count }))
    .sort((a, b) => b.count - a.count || a.selector.localeCompare(b.selector));
}

/** Aggregate compositing reasons across all layers, descending by frequency. */
export function summarizeReasons(reasons) {
  const counts = new Map();
  for (const list of Object.values(reasons || {})) {
    for (const r of Array.isArray(list) ? list : []) counts.set(r, (counts.get(r) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

/** Build the structured report (pure — exported for tests). */
export function buildLayerReport(result) {
  const layers = Array.isArray(result?.layers) ? result.layers : [];
  if (result?.warning) {
    return {
      url: result?.url,
      cpu: result?.cpu,
      layerCount: 0,
      contentLayerCount: 0,
      owners: [],
      reasons: [],
      warning: result.warning,
    };
  }
  const attributed = attributeLayers(layers, result?.nodes);
  const describeNodeSkippedCount = attributed.filter((a) => a.selector === DESCRIBE_NODE_CAP_SKIPPED_SELECTOR).length;
  return {
    url: result?.url,
    cpu: result?.cpu,
    layerCount: layers.length,
    contentLayerCount: layers.filter((l) => l?.drawsContent).length,
    owners: groupBySelector(attributed).slice(0, 25),
    reasons: summarizeReasons(result?.reasons).slice(0, 20),
    ...(describeNodeSkippedCount > 0
      ? {
          describeNodeCap: DESCRIBE_NODE_CAP,
          describeNodeSkippedCount,
          warning: `DOM.describeNode cap reached; ${describeNodeSkippedCount} layers are bucketed as ${DESCRIBE_NODE_CAP_SKIPPED_SELECTOR}`,
        }
      : {}),
  };
}

/** Live capture (best-effort). Loads the URL and snapshots the composited layer tree via CDP `LayerTree`. */
async function measure(url, { cpu = 1, settle = 15000 } = {}) {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: { width: 1350, height: 940 },
      deviceScaleFactor: 1,
      isMobile: false,
    });
    const page = await context.newPage();
    const client = await context.newCDPSession(page);
    if (cpu > 1) {
      try {
        await client.send('Emulation.setCPUThrottlingRate', { rate: cpu });
      } catch {
        /* CDP throttle unavailable — continue at host speed */
      }
    }
    const snapshots = [];
    client.on('LayerTree.layerTreeDidChange', (e) => snapshots.push(e));
    try {
      await client.send('DOM.enable');
      await client.send('LayerTree.enable');
    } catch (err) {
      return { url, cpu, layers: [], nodes: {}, reasons: {}, warning: `CDP LayerTree unavailable: ${err?.message || err}` };
    }
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(settle);

    const layers = latestSnapshot(snapshots);
    const nodes = {};
    const reasons = {};
    let described = 0;
    for (const layer of layers) {
      if (layer.backendNodeId != null && nodes[layer.backendNodeId] === undefined) {
        if (described < DESCRIBE_NODE_CAP) {
          described++;
          try {
            const { node } = await client.send('DOM.describeNode', { backendNodeId: layer.backendNodeId });
            nodes[layer.backendNodeId] = { nodeName: node?.nodeName, attributes: node?.attributes || [] };
          } catch {
            nodes[layer.backendNodeId] = null;
          }
        } else {
          nodes[layer.backendNodeId] = CAP_SKIPPED_NODE;
        }
      }
      try {
        const r = await client.send('LayerTree.compositingReasons', { layerId: layer.layerId });
        reasons[layer.layerId] = r?.compositingReasons?.length ? r.compositingReasons : r?.compositingReasonIds || [];
      } catch {
        reasons[layer.layerId] = [];
      }
    }
    const slim = layers.map((l) => ({
      layerId: l.layerId,
      backendNodeId: l.backendNodeId,
      width: l.width,
      height: l.height,
      paintCount: l.paintCount,
      drawsContent: l.drawsContent,
    }));
    return { url, cpu, layers: slim, nodes, reasons };
  } finally {
    await browser.close();
  }
}

function printHuman(report) {
  console.log(`\nComposited-layer audit — ${report.url} (CPU ${report.cpu}x)\n`);
  if (report.warning && report.layerCount === 0) {
    console.log('Warning:');
    console.log('  ' + report.warning + '\n');
    return;
  }
  console.log(`Composited layers: ${report.layerCount}  (${report.contentLayerCount} draw content)\n`);
  if (report.warning) console.log(`Warning: ${report.warning}\n`);
  console.log('Top owners (layers per selector — over-promotion shows up here):');
  for (const o of report.owners) {
    console.log(`  ${String(o.count).padStart(4)}  ${o.selector}`);
  }
  console.log('\nCompositing reasons (frequency across layers):');
  for (const r of report.reasons) {
    console.log(`  ${String(r.count).padStart(4)}  ${r.reason}`);
  }
  console.log('\nNote: the layer COUNT is the deterministic signal (#4630 KTD4). Pair with the');
  console.log('`Layerize` self-time share from measure-desktop-mainthread.mjs for the outcome.\n');
}

async function main() {
  const args = parseArgs(process.argv);
  const result = await measure(args.url, { cpu: args.cpu, settle: args.settle });
  const report = buildLayerReport(result);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else printHuman(report);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
