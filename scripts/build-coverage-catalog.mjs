// /reference/coverage/: every dashboard panel, map layer and MCP tool by name,
// generated from the registries the product itself reads. The descriptions are
// the strings users already see (panel info tooltips, layer explanation cards,
// MCP tool descriptions), so the page cannot claim coverage the product lacks.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const COVERAGE_CONTENT_VERSION = '2026-10-18';
export const COVERAGE_PAGE_PATH = '/reference/coverage/';
export const COVERAGE_DATASET_FILE = 'coverage.json';
// Written descriptions for panels whose component shows no info tooltip. The
// tooltip wins when one exists; news panels without either fall back to their
// feed list.
export const PANEL_DESCRIPTIONS_PATH = 'scripts/data/coverage-panel-descriptions.json';
const SERVER_FEEDS_PATH = 'server/worldmonitor/news/v1/_feeds.ts';
export const COVERAGE_INPUT_PATHS = Object.freeze([
  'scripts/build-coverage-catalog.mjs',
  PANEL_DESCRIPTIONS_PATH,
  'src/config/panels.ts',
  'src/config/map-layer-definitions.ts',
  'src/locales/en.json',
  SERVER_FEEDS_PATH,
  'api/mcp/registry',
]);

const VARIANTS = Object.freeze([
  { id: 'full', name: 'World Monitor', host: 'www.worldmonitor.app' },
  { id: 'tech', name: 'Tech Monitor', host: 'tech.worldmonitor.app' },
  { id: 'finance', name: 'Finance Monitor', host: 'finance.worldmonitor.app' },
  { id: 'commodity', name: 'Commodity Monitor', host: 'commodity.worldmonitor.app' },
  { id: 'energy', name: 'Energy Monitor', host: 'energy.worldmonitor.app' },
  { id: 'happy', name: 'Happy Monitor', host: 'happy.worldmonitor.app' },
]);
const VARIANT_IDS = VARIANTS.map((variant) => variant.id);
const VARIANT_NAME = new Map(VARIANTS.map((variant) => [variant.id, variant.name]));

const TOOL_ACCESS_LABEL = Object.freeze({
  free: 'No account',
  'free-account': 'Free account',
  subscription: 'Pro or API plan',
});

// Tooltips carry interaction hints for the dashboard; they describe nothing a
// reader of this page can do.
const UI_HINT_SENTENCE = /^(?:click|tap|hover|drag|toggle|use the|select|press|scroll)\b/i;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };

/**
 * Drops every run from "<" to the next ">" and any unmatched "<". A scan rather
 * than a tag regex: nested input such as "<scr<script>ipt>" cannot reassemble.
 */
function withoutTags(text) {
  let out = '';
  let inTag = false;
  for (const char of text) {
    if (char === '<') inTag = true;
    else if (char === '>' && inTag) inTag = false;
    else if (!inTag) out += char;
  }
  return out;
}

export function tooltipText(html) {
  if (typeof html !== 'string') return '';
  const marked = html
    // A leading bold run is the tooltip's title ("Methodology", the panel name).
    .replace(/^\s*<strong>[^<]*<\/strong>\s*/i, '')
    .replace(/<li[^>]*>/gi, ' ')
    .replace(/<\/li>/gi, '; ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(?:p|ul)>/gi, '. ');
  // Decoding comes after the first strip and is followed by a second, because
  // coverage.json hands this text to consumers unescaped: an encoded
  // "&lt;script&gt;" must not become a tag.
  const decoded = withoutTags(marked)
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, name) => ENTITIES[name]);
  const flat = withoutTags(decoded)
    .replace(/\s+/g, ' ')
    .replace(/\s+([;:,.])/g, '$1')
    .replace(/;\s*\./g, '.')
    .replace(/:\s*\./g, ':')
    .replace(/\.(\s*\.)+/g, '.')
    .replace(/;\s*$/, '')
    .trim();
  // A terminator only ends a sentence before a space or the end, so "Llama 3.3"
  // and "GPT-4.1" stay whole.
  const sentences = flat.match(/.+?[.!?]+(?=\s|$)|.+$/g) || [];
  return sentences
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence && !UI_HINT_SENTENCE.test(sentence))
    .join(' ')
    .replace(/;\s*$/, '.')
    .trim();
}

const MIN_SUMMARY_LENGTH = 60;

/**
 * The opening of a tool description. A short opener ("Despite the name,
 * carries no tariff data.") keeps the sentence that explains it; an overlong
 * sentence ends at its first colon, where tool descriptions start their field
 * lists, before falling back to a word cut.
 */
export function firstSentence(text, maxLength = 240) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  const sentences = clean.match(/.+?[.!?](?=\s|$)|.+$/g) || [];
  let summary = '';
  for (const sentence of sentences) {
    const next = summary ? `${summary} ${sentence.trim()}` : sentence.trim();
    if (summary && next.length > maxLength) break;
    summary = next;
    if (summary.length >= MIN_SUMMARY_LENGTH) break;
  }
  if (summary.length <= maxLength) return summary;
  const boundary = lastClauseBoundary(summary, maxLength);
  if (boundary >= MIN_SUMMARY_LENGTH / 2) return `${summary.slice(0, boundary)}.`;
  const cut = summary.slice(0, maxLength);
  return `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}

/** Index of the last ", " "; " or ": " before maxLength that is outside parentheses. */
function lastClauseBoundary(text, maxLength) {
  let depth = 0;
  let last = -1;
  for (let index = 0; index < Math.min(text.length - 1, maxLength); index += 1) {
    const char = text[index];
    if (char === '(') depth += 1;
    else if (char === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (char === ',' || char === ';' || char === ':') && text[index + 1] === ' ') last = index;
  }
  return last;
}

function camelCase(id) {
  return id.replace(/-([a-z0-9])/g, (_, char) => char.toUpperCase());
}

function proseList(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** Feed names per news category, merged across the server's variant feed sets. */
export function feedNamesByCategory(variantFeeds) {
  const byCategory = new Map();
  for (const categories of Object.values(variantFeeds)) {
    for (const [category, feeds] of Object.entries(categories)) {
      const names = byCategory.get(category) || new Set();
      for (const feed of feeds) if (feed?.name) names.add(feed.name);
      byCategory.set(category, names);
    }
  }
  return new Map([...byCategory].map(([category, names]) => [category, [...names]]));
}

export function feedPanelDescription(names) {
  if (!names?.length) return '';
  const shown = names.slice(0, 4);
  return names.length === 1
    ? `Headlines from ${shown[0]}.`
    : `Headlines from ${names.length} news feeds, including ${proseList(shown)}.`;
}

/**
 * Panels grouped the way the dashboard's panel picker groups them; a panel
 * listed under several categories appears once, under the first. Its
 * dashboards come from the per-variant panel registries (`isNative`), not the
 * categories: a category spans more dashboards than some of its panels.
 */
export function buildPanelGroups({
  allPanels,
  categoryMap,
  locale,
  writtenDescriptions = {},
  feedNames = new Map(),
  isNative = () => true,
}) {
  const components = locale?.components || {};
  const headerLabels = locale?.header || {};
  const seen = new Set();
  const groups = [];
  const groupByLabel = new Map();
  for (const category of Object.values(categoryMap)) {
    const label = headerLabels[category.labelKey.replace(/^header\./, '')] || category.labelKey;
    for (const id of category.panelKeys) {
      const config = allPanels[id];
      if (!config || seen.has(id)) continue;
      let group = groupByLabel.get(label);
      if (!group) {
        group = { label, panels: [] };
        groupByLabel.set(label, group);
        groups.push(group);
      }
      const entry = {
        id,
        name: config.name,
        description: tooltipText(components[camelCase(id)]?.infoTooltip ?? components[id]?.infoTooltip)
          || writtenDescriptions[id]
          || feedPanelDescription(feedNames.get(id)),
        pro: config.premium === 'locked',
        variants: VARIANT_IDS.filter((variant) => isNative(id, variant)),
      };
      seen.add(id);
      group.panels.push(entry);
    }
  }
  return groups;
}

export function buildLayerEntries({ registry, explanations, catalogKeys, allowedKeysForVariant, locale }) {
  const labels = locale?.components?.deckgl?.layers || {};
  return catalogKeys.map((key) => {
    const definition = registry[key];
    const explanation = explanations[key];
    return {
      id: key,
      name: labels[definition.i18nSuffix] || definition.fallbackLabel,
      category: explanation?.category || null,
      description: explanation?.purpose || null,
      source: explanation?.source || null,
      freshness: explanation?.freshness || null,
      pro: definition.premium === 'locked',
      variants: VARIANT_IDS.filter((variant) => allowedKeysForVariant(variant).has(key)),
    };
  });
}

export function buildToolEntries({ tools, toolAccess }) {
  return tools
    .map((tool) => ({
      name: tool.name,
      title: tool.title || tool.name,
      description: firstSentence(tool.description),
      access: toolAccess(tool),
    }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

export async function loadCoverageCatalog({ importModule, readJson }) {
  const [panels, layers, mcp, serverFeeds] = await Promise.all([
    importModule('src/config/panels.ts'),
    importModule('src/config/map-layer-definitions.ts'),
    importModule('api/mcp/registry/index.ts'),
    importModule(SERVER_FEEDS_PATH),
  ]);
  const locale = readJson('src/locales/en.json');
  const writtenDescriptions = readJson(PANEL_DESCRIPTIONS_PATH);
  assertWrittenDescriptionsTargetPanels(writtenDescriptions, panels.ALL_PANELS);
  const catalog = {
    panelGroups: buildPanelGroups({
      allPanels: panels.ALL_PANELS,
      categoryMap: panels.PANEL_CATEGORY_MAP,
      locale,
      writtenDescriptions,
      feedNames: feedNamesByCategory(serverFeeds.VARIANT_FEEDS),
      isNative: panels.isPanelNativeToVariant,
    }),
    layers: buildLayerEntries({
      registry: layers.LAYER_REGISTRY,
      explanations: layers.LAYER_EXPLANATIONS,
      catalogKeys: layers.getCompleteLayerCatalogKeys('full'),
      allowedKeysForVariant: layers.getAllowedLayerKeys,
      locale,
    }),
    tools: buildToolEntries({ tools: mcp.TOOL_REGISTRY, toolAccess: mcp.toolAccess }),
  };
  assertCatalogComplete(catalog, {
    panelCount: Object.keys(panels.ALL_PANELS).length,
    toolCount: mcp.TOOL_REGISTRY.length,
  });
  return catalog;
}

/** A renamed or removed panel would otherwise leave its description orphaned. */
export function assertWrittenDescriptionsTargetPanels(descriptions, allPanels) {
  const unknown = Object.keys(descriptions).filter((id) => !allPanels[id]);
  if (unknown.length > 0) {
    throw new Error(`${PANEL_DESCRIPTIONS_PATH} describes unknown panels: ${unknown.join(', ')}`);
  }
}

/** A panel missing from every picker category would vanish from the page silently. */
export function assertCatalogComplete(catalog, { panelCount, toolCount }) {
  const listed = catalog.panelGroups.reduce((sum, group) => sum + group.panels.length, 0);
  if (listed !== panelCount) {
    throw new Error(`coverage catalog lists ${listed} panels but the panel registry has ${panelCount}; add the missing panels to PANEL_CATEGORY_MAP`);
  }
  if (catalog.tools.length !== toolCount) {
    throw new Error(`coverage catalog lists ${catalog.tools.length} MCP tools but the registry has ${toolCount}`);
  }
  if (catalog.layers.length === 0) throw new Error('coverage catalog lists no map layers');
}

export function coverageCounts(catalog) {
  const panels = catalog.panelGroups.flatMap((group) => group.panels);
  return {
    panels: panels.length,
    panelGroups: catalog.panelGroups.length,
    proPanels: panels.filter((panel) => panel.pro).length,
    layers: catalog.layers.length,
    proLayers: catalog.layers.filter((layer) => layer.pro).length,
    tools: catalog.tools.length,
    accountFreeTools: catalog.tools.filter((tool) => tool.access !== 'subscription').length,
    dashboards: VARIANTS.length,
  };
}

function slug(text) {
  return text.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function variantList(variants) {
  if (variants.length === VARIANT_IDS.length) return 'All dashboards';
  if (variants.length === 0) return 'Layer catalog';
  return variants.map((variant) => VARIANT_NAME.get(variant)).join(', ');
}

export function coverageAnswer(counts) {
  return `World Monitor covers geopolitics, conflict, military activity, markets, commodities, energy, shipping and supply chains, aviation, infrastructure, cyber threats, natural hazards, climate and live news. It does so across ${counts.panels} dashboard panels in ${counts.panelGroups} groups, ${counts.layers} map layers and ${counts.tools} MCP tools, spread over ${counts.dashboards} dashboards. Every item is listed below by name with what it shows.`;
}

// On a phone each row becomes a card, so a description reads at full width
// instead of inside a sideways-scrolling table.
const CATALOG_STYLES = `      .catalog td small { color: var(--accent); font-weight: 700; }
      .catalog td:last-child { color: var(--muted); font-size: 13px; }
      @media (max-width: 640px) {
        .catalog thead { display: none; }
        .catalog table, .catalog tbody, .catalog tr, .catalog td { display: block; width: 100%; }
        .catalog tr { margin-bottom: 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
        .catalog td { border: 0; padding: 6px 12px; }
        .catalog td:first-child { padding-top: 12px; }
        .catalog td:last-child { padding-bottom: 12px; }
      }`;

function renderPanelTable(group, escapeHtml) {
  const rows = group.panels.map((panel) => `            <tr><td><strong>${escapeHtml(panel.name)}</strong>${panel.pro ? ' <small>Pro</small>' : ''}</td><td>${panel.description ? escapeHtml(panel.description) : '—'}</td><td>${escapeHtml(variantList(panel.variants))}</td></tr>`).join('\n');
  return `      <h3 id="panels-${slug(group.label)}">${escapeHtml(group.label)}</h3>
      <div class="catalog">
        <table>
          <thead><tr><th scope="col">Panel</th><th scope="col">What it shows</th><th scope="col">Dashboards</th></tr></thead>
          <tbody>
${rows}
          </tbody>
        </table>
      </div>`;
}

function renderLayerTable(layers, escapeHtml) {
  const rows = layers.map((layer) => {
    const detail = [
      layer.description,
      layer.source ? `Source: ${layer.source}` : null,
      layer.freshness ? `Freshness: ${layer.freshness}` : null,
    ].filter(Boolean).join(' ');
    return `            <tr><td><strong>${escapeHtml(layer.name)}</strong>${layer.pro ? ' <small>Pro</small>' : ''}</td><td>${detail ? escapeHtml(detail) : '—'}</td><td>${escapeHtml(variantList(layer.variants))}</td></tr>`;
  }).join('\n');
  return `      <div class="catalog">
        <table>
          <thead><tr><th scope="col">Layer</th><th scope="col">What it shows, source and freshness</th><th scope="col">Dashboards</th></tr></thead>
          <tbody>
${rows}
          </tbody>
        </table>
      </div>`;
}

function renderToolTable(tools, escapeHtml) {
  const rows = tools.map((tool) => `            <tr><td><strong>${escapeHtml(tool.title)}</strong><br><code>${escapeHtml(tool.name)}</code></td><td>${escapeHtml(tool.description)}</td><td>${escapeHtml(TOOL_ACCESS_LABEL[tool.access] || tool.access)}</td></tr>`).join('\n');
  return `      <div class="catalog">
        <table>
          <thead><tr><th scope="col">Tool</th><th scope="col">What it returns</th><th scope="col">Access</th></tr></thead>
          <tbody>
${rows}
          </tbody>
        </table>
      </div>`;
}

export function renderCoveragePage({ catalog, baseUrl, lastmod, tpl }) {
  const { escapeHtml, absoluteUrl, breadcrumbLd, pageDocument } = tpl;
  const counts = coverageCounts(catalog);
  const url = absoluteUrl(baseUrl, COVERAGE_PAGE_PATH);
  const description = `Every World Monitor dashboard panel, map layer and MCP tool by name: ${counts.panels} panels, ${counts.layers} map layers and ${counts.tools} agent tools, with what each one shows.`;
  const answer = coverageAnswer(counts);
  const groupLinks = catalog.panelGroups.map((group) => `<a href="#panels-${slug(group.label)}">${escapeHtml(group.label)}</a>`).join(' · ');
  const body = `      <p class="eyebrow">Coverage catalog</p>
      <h1>What World Monitor covers</h1>
      <p class="lede">${escapeHtml(answer)}</p>
      <div class="grid">
        <div class="metric"><small>Dashboard panels</small><strong>${counts.panels}</strong><span>${counts.proPanels} ${counts.proPanels === 1 ? 'needs' : 'need'} Pro</span></div>
        <div class="metric"><small>Map layers</small><strong>${counts.layers}</strong><span>${counts.proLayers} ${counts.proLayers === 1 ? 'needs' : 'need'} Pro</span></div>
        <div class="metric"><small>MCP tools</small><strong>${counts.tools}</strong><span>${counts.accountFreeTools} without a paid plan</span></div>
        <div class="metric"><small>Dashboards</small><strong>${counts.dashboards}</strong><span>${escapeHtml(proseList(VARIANTS.map((variant) => variant.name.replace(/ Monitor$/, ''))))}</span></div>
      </div>
      <h2 id="how-to-read">How to read this catalog</h2>
      <p>Each entry is generated from the registry the product reads, and each description is the text the product shows: a panel's info tooltip, a layer's explanation card, or an MCP tool's description. A dash means the product has no written description for that item yet. Data sources behind these surfaces are listed provider by provider on the <a href="/sources/">source catalog</a>. The same catalog is available as <a href="${COVERAGE_DATASET_FILE}">JSON</a>.</p>
      <h2 id="panels">Dashboard panels</h2>
      <p>Panels are grouped as in the dashboard's panel picker. Groups: ${groupLinks}.</p>
${catalog.panelGroups.map((group) => renderPanelTable(group, escapeHtml)).join('\n')}
      <h2 id="layers">Map layers</h2>
      <p>Layers with a published explanation card list their source and freshness. "Layer catalog" means the layer is not on by default on any dashboard but can be added from the map's layer catalog.</p>
${renderLayerTable(catalog.layers, escapeHtml)}
      <h2 id="mcp-tools">MCP tools for AI agents</h2>
      <p>Agents reach the same data through the <a href="/docs/mcp">World Monitor MCP server</a>. Call <code>tools/list</code> for the live inventory and <code>describe_tool</code> for a tool's full definition.</p>
${renderToolTable(catalog.tools, escapeHtml)}
      <p class="source">Generated from src/config/panels.ts, src/config/map-layer-definitions.ts, src/locales/en.json and api/mcp/registry at build time. Open the <a href="/dashboard">live dashboard</a> to use any of them.</p>`;
  return pageDocument({
    baseUrl,
    path: COVERAGE_PAGE_PATH,
    title: 'What World Monitor Covers: Panels, Map Layers and MCP Tools',
    description,
    lastmod,
    ogType: 'website',
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        '@id': `${url}#webpage`,
        name: 'What World Monitor covers',
        description,
        url,
        inLanguage: 'en-US',
        dateModified: lastmod,
      },
      {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: [{
          '@type': 'Question',
          name: 'What does World Monitor cover?',
          acceptedAnswer: { '@type': 'Answer', text: answer },
        }],
      },
    ],
    breadcrumbs: breadcrumbLd(baseUrl, [
      { name: 'Home', path: '/' },
      { name: 'Coverage', path: COVERAGE_PAGE_PATH },
    ]),
    body,
    extraStyles: CATALOG_STYLES,
  });
}

export function coverageDatasetJson(catalog) {
  return `${JSON.stringify({
    schemaVersion: 1,
    counts: coverageCounts(catalog),
    dashboards: VARIANTS,
    panelGroups: catalog.panelGroups,
    layers: catalog.layers,
    tools: catalog.tools,
  }, null, 2)}\n`;
}

export function writeCoverageSection({ outDir, baseUrl, lastmod, catalog, tpl }) {
  const dir = join(outDir, ...COVERAGE_PAGE_PATH.split('/').filter(Boolean));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), renderCoveragePage({ catalog, baseUrl, lastmod, tpl }));
  writeFileSync(join(dir, COVERAGE_DATASET_FILE), coverageDatasetJson(catalog));
}
