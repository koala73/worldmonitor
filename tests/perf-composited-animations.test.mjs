import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mainCss = readFileSync(resolve(root, 'src/styles/main.css'), 'utf8');
const panelsCss = readFileSync(resolve(root, 'src/styles/panels.css'), 'utf8');

const auditedRules = [
  { file: 'src/styles/panels.css', css: panelsCss, selector: '.oref-pulse' },
  { file: 'src/styles/panels.css', css: panelsCss, selector: '.oref-pulse::after' },
  { file: 'src/styles/main.css', css: mainCss, selector: '.panel-count.bump' },
  { file: 'src/styles/main.css', css: mainCss, selector: '.panel-count.bump::before' },
  { file: 'src/styles/main.css', css: mainCss, selector: '.header.signal-flash' },
  { file: 'src/styles/main.css', css: mainCss, selector: '.header.signal-flash::after' },
  { file: 'src/styles/main.css', css: mainCss, selector: '.status-dot.signal-pulse' },
  { file: 'src/styles/main.css', css: mainCss, selector: '.status-dot.signal-pulse::after' },
  { file: 'src/styles/main.css', css: mainCss, selector: '.panel-new-badge.pulse' },
  { file: 'src/styles/main.css', css: mainCss, selector: '.panel-new-badge.pulse::after' },
  { file: 'src/styles/main.css', css: mainCss, selector: '.item.item-new-highlight' },
  { file: 'src/styles/main.css', css: mainCss, selector: '.item.item-new-highlight::before' },
  { file: 'src/styles/main.css', css: mainCss, selector: '.search-highlight' },
  { file: 'src/styles/main.css', css: mainCss, selector: '.search-highlight::after' },
  { file: 'src/styles/main.css', css: mainCss, selector: '.flash-highlight' },
  { file: 'src/styles/main.css', css: mainCss, selector: '.flash-highlight::after' },
  { file: 'src/styles/main.css', css: mainCss, selector: '.panel.flash-new::after' },
  { file: 'src/styles/main.css', css: mainCss, selector: '.tech-indicator-item' },
  { file: 'src/styles/main.css', css: mainCss, selector: '.tech-indicator-item::before' },
  { file: 'src/styles/main.css', css: mainCss, selector: '.tech-event-marker.upcoming-soon' },
  { file: 'src/styles/main.css', css: mainCss, selector: '.tech-event-marker.upcoming-soon::after' },
  { file: 'src/styles/main.css', css: mainCss, selector: '.intel-skeleton' },
  { file: 'src/styles/main.css', css: mainCss, selector: '.intel-skeleton::after' },
  { file: 'src/styles/main.css', css: mainCss, selector: '.cw-dot' },
  { file: 'src/styles/main.css', css: mainCss, selector: '.cw-dot::after' },
];

const expectedIssueKeyframes = new Set([
  'oref-pulse-anim',
  'oref-pulse-ring',
  'count-bump',
  'count-bump-highlight',
  'header-flash',
  'signal-dot-pulse',
  'signal-dot-pulse-glow',
  'badge-pulse',
  'badge-pulse-glow',
  'item-glow',
  'search-glow-pulse',
  'panel-flash',
  'tech-item-pulse',
  'tech-item-highlight-pulse',
  'pulse-marker',
  'skeleton-shimmer',
  'cw-dot-pulse',
  'cw-dot-ring',
]);


const finiteAnimationRules = [
  { css: mainCss, selector: '.panel-count.bump' },
  { css: mainCss, selector: '.panel-count.bump::before' },
  { css: mainCss, selector: '.header.signal-flash' },
  { css: mainCss, selector: '.header.signal-flash::after' },
  { css: mainCss, selector: '.status-dot.signal-pulse' },
  { css: mainCss, selector: '.status-dot.signal-pulse::after' },
  { css: mainCss, selector: '.item.item-new-highlight' },
  { css: mainCss, selector: '.item.item-new-highlight::before' },
  { css: mainCss, selector: '.search-highlight' },
  { css: mainCss, selector: '.search-highlight::after' },
  { css: mainCss, selector: '.flash-highlight' },
  { css: mainCss, selector: '.flash-highlight::after' },
  { css: mainCss, selector: '.panel.flash-new::after' },
];

// animation-timing-function is a per-keyframe-stop easing override, not an
// animated property. It triggers no paint work, so it is allowed alongside the
// compositor-friendly properties to avoid a false failure if a stop later gains
// its own easing.
const compositedKeyframeProperties = new Set(['animation-timing-function', 'opacity', 'transform']);

const animationKeywords = new Set([
  'none',
  'infinite',
  'linear',
  'ease',
  'ease-in',
  'ease-out',
  'ease-in-out',
  'step-start',
  'step-end',
  'forwards',
  'backwards',
  'both',
  'alternate',
  'alternate-reverse',
  'normal',
  'reverse',
  'running',
  'paused',
  'initial',
  'inherit',
  'unset',
  'revert',
]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function blockFromOpenBrace(css, open, token) {
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    const char = css[i];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }

  assert.fail(`Unclosed CSS block after: ${token}`);
}

function ruleBlock(css, selector) {
  const pattern = new RegExp(`(?:^|[}\\n,])\\s*${escapeRegExp(selector)}\\s*(?:,|\\{)`, 'g');
  const match = pattern.exec(css);
  assert.ok(match, `Missing CSS selector: ${selector}`);

  const open = css.indexOf('{', match.index);
  assert.notEqual(open, -1, `Missing opening brace after: ${selector}`);
  return blockFromOpenBrace(css, open, selector);
}

function keyframeBlock(name, css) {
  const pattern = new RegExp(`@keyframes\\s+${escapeRegExp(name)}\\s*\\{`, 'g');
  const match = pattern.exec(css);
  assert.ok(match, `Missing exact @keyframes block: ${name}`);

  const open = match.index + match[0].lastIndexOf('{');
  return blockFromOpenBrace(css, open, `@keyframes ${name}`);
}

function declarations(block) {
  const withoutComments = block.replace(/\/\*[\s\S]*?\*\//g, '');
  const result = [];
  const declarationPattern = /(?:^|[;{}\n\r])\s*([a-zA-Z-]+)\s*:\s*([^;{}]+)/g;
  let match;
  while ((match = declarationPattern.exec(withoutComments))) {
    result.push({ property: match[1], value: match[2].trim() });
  }
  return result;
}

function declarationProperties(block) {
  return declarations(block).map(({ property }) => property);
}

function splitAnimationList(value) {
  const items = [];
  let depth = 0;
  let current = '';

  for (const char of value) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;

    if (char === ',' && depth === 0) {
      items.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  if (current.trim()) items.push(current.trim());
  return items;
}

function animationNameFromShorthand(value) {
  const tokens = value.match(/[a-zA-Z_][\w-]*/g) ?? [];
  return tokens.find((token) => {
    if (animationKeywords.has(token)) return false;
    if (/^(?:cubic-bezier|steps|var)$/.test(token)) return false;
    return true;
  });
}

function animationNamesFromRule(block) {
  const names = new Set();

  for (const { property, value } of declarations(block)) {
    if (property === 'animation-name') {
      for (const name of splitAnimationList(value)) {
        if (name && name !== 'none') names.add(name);
      }
    }

    if (property === 'animation') {
      for (const item of splitAnimationList(value)) {
        const name = animationNameFromShorthand(item);
        if (name && name !== 'none') names.add(name);
      }
    }
  }

  return names;
}

function collectAuditedAnimationNames() {
  const byName = new Map();

  for (const rule of auditedRules) {
    const block = ruleBlock(rule.css, rule.selector);
    for (const name of animationNamesFromRule(block)) {
      if (!byName.has(name)) byName.set(name, rule);
    }
  }

  return byName;
}

describe('issue 4538 composited animation invariants', () => {
  it('finds keyframes by exact name instead of prefix matches', () => {
    const css = '@keyframes count-bump-highlight { 0% { opacity: 1; } } @keyframes count-bump { 0% { transform: scale(1); } }';
    assert.match(keyframeBlock('count-bump', css), /transform:\s*scale\(1\)/);
  });

  it('matches audited selectors exactly instead of pseudo-element prefixes', () => {
    const css = '.panel.flash-new::after { animation: panel-flash 0.8s ease-out; }';
    const selectorListCss = '.search-highlight,\n.flash-highlight { animation: search-glow-pulse 1s ease-out; }';

    assert.throws(() => ruleBlock(css, '.panel.flash-new'), /Missing CSS selector: \.panel\.flash-new/);
    assert.match(ruleBlock(css, '.panel.flash-new::after'), /panel-flash/);
    assert.match(ruleBlock(selectorListCss, '.search-highlight'), /search-glow-pulse/);
    assert.match(ruleBlock(selectorListCss, '.flash-highlight'), /search-glow-pulse/);
  });

  it('derives the audited keyframes from the issue selectors', () => {
    const found = collectAuditedAnimationNames();
    assert.deepEqual(new Set(found.keys()), expectedIssueKeyframes);
  });

  it('keeps every audited selector animation on transform/opacity only', () => {
    const found = collectAuditedAnimationNames();

    for (const [name, rule] of found) {
      const properties = declarationProperties(keyframeBlock(name, rule.css));
      assert.ok(properties.length > 0, `${name} should have declarations`);

      for (const property of properties) {
        assert.ok(
          compositedKeyframeProperties.has(property),
          `${name} is used by ${rule.selector} in ${rule.file} and must not animate ${property}; use a static pseudo-element plus transform/opacity instead`,
        );
      }
    }
  });

  it('does not leave persistent will-change hints on finite animations', () => {
    for (const { css, selector } of finiteAnimationRules) {
      const properties = declarationProperties(ruleBlock(css, selector));
      assert.ok(!properties.includes('will-change'), `${selector} should not keep will-change after its finite animation ends`);
    }
  });

  it('keeps host transform-sensitive marker and skeleton animations on pseudo-elements', () => {
    assert.equal(
      animationNamesFromRule(ruleBlock(mainCss, '.tech-event-marker.upcoming-soon')).size,
      0,
      'pulse-marker would overwrite the map marker transform if applied to the marker host',
    );
    assert.ok(
      animationNamesFromRule(ruleBlock(mainCss, '.tech-event-marker.upcoming-soon::after')).has('pulse-marker'),
      'the upcoming marker ring should animate on the pseudo-element',
    );

    assert.equal(
      animationNamesFromRule(ruleBlock(mainCss, '.intel-skeleton')).size,
      0,
      'skeleton-shimmer should not animate background-position on the skeleton host',
    );
    assert.ok(
      animationNamesFromRule(ruleBlock(mainCss, '.intel-skeleton::after')).has('skeleton-shimmer'),
      'the shimmer gradient should animate on the skeleton pseudo-element',
    );
  });

  it('keeps panel-flash on the pseudo-element, never the panel host', () => {
    let hostBlock = null;
    try {
      hostBlock = ruleBlock(mainCss, '.panel.flash-new');
    } catch (error) {
      assert.match(String(error?.message ?? error), /Missing CSS selector: \.panel\.flash-new/);
    }

    if (hostBlock) {
      assert.equal(
        animationNamesFromRule(hostBlock).size,
        0,
        'the .panel.flash-new host must not animate at all; any host animation (under any name) would run on the clipped/box-shadow-bearing panel and bypass the pseudo-element layering',
      );
    }
    assert.ok(
      animationNamesFromRule(ruleBlock(mainCss, '.panel.flash-new::after')).has('panel-flash'),
      'the panel flash should animate on the .panel.flash-new::after pseudo-element',
    );
  });
});
