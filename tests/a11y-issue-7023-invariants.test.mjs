/**
 * Regression guard for the accessibility fixes in issue #7023 / PR #7031:
 *   - LiveNews channel loading pairs disabled + aria-busy with a generation-
 *     scoped finally cleanup, and overlapping switches ignore stale completions.
 *   - Panel.setSeverity exposes non-none severity as a named image.
 *   - Theme prepaint and applyStoredTheme agree on first-visit OS light.
 *   - Insights sentiment counts are one named image; the color track is decorative.
 *   - Forced-colors CSS keeps severity dots and badge borders visible.
 *   - Tariff gap classes are named by direction, not inverted numeric sign.
 *   - sparkline() stays decorative by default; ConsumerPrices Trend cells pass a label.
 *
 * Source-invariant assertions (components render via createElement / inline HTML
 * with no DOM in the Node test runner), the same shape as
 * a11y-issue-4373-invariants.test.mjs.
 *
 * Run: node --test tests/a11y-issue-7023-invariants.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(resolve(__dirname, '..', ...p), 'utf-8');

const liveNews = read('src', 'components', 'LiveNewsPanel.ts');
const panel = read('src', 'components', 'Panel.ts');
const insights = read('src', 'components', 'InsightsPanel.ts');
const themeManager = read('src', 'utils', 'theme-manager.ts');
const indexHtml = read('index.html');
const css = read('src', 'styles', 'main.css');
const tradePolicy = read('src', 'components', 'TradePolicyPanel.ts');
const sparklineSrc = read('src', 'utils', 'sparkline.ts');
const consumerPrices = read('src', 'components', 'ConsumerPricesPanel.ts');

const switchChannel = liveNews.slice(
  liveNews.indexOf('private switchChannel'),
  liveNews.indexOf('private showOfflineMessage'),
);
const clearLoading = liveNews.slice(
  liveNews.indexOf('private resetChannelButtonLoading'),
  liveNews.indexOf('private switchChannel'),
);
const onVideoState = liveNews.slice(
  liveNews.indexOf('private onVideoState'),
  liveNews.indexOf('private showPlayerStatus'),
);
const stopFromController = liveNews.slice(
  liveNews.indexOf('private stopPlaybackFromController'),
  liveNews.indexOf('private saveChannels'),
);
const applyStoredTheme = themeManager.slice(
  themeManager.indexOf('export function applyStoredTheme'),
);
const setSeverity = panel.slice(
  panel.indexOf('public setSeverity'),
  panel.indexOf('public getId()'),
);
const sentimentOverview = insights.slice(
  insights.indexOf('private renderSentimentOverview'),
  insights.indexOf('private renderStats'),
);
const forcedColors = css.slice(css.indexOf('@media (forced-colors: active)'));

describe('LiveNews channel loading lifecycle', () => {
  it('createChannelButton exposes aria-pressed for the active channel', () => {
    const createBtn = liveNews.slice(
      liveNews.indexOf('private createChannelButton'),
      liveNews.indexOf('private createChannelSwitcher'),
    );
    assert.match(createBtn, /setAttribute\('aria-pressed',\s*String\(channel\.id === this\.activeChannel\.id\)\)/);
  });

  it('loading marks the target button aria-busy and aria-disabled without disabling it', () => {
    // A disabled button drops keyboard focus to <body> for the whole connection.
    assert.match(clearLoading, /markChannelButtonLoading/);
    assert.match(clearLoading, /setAttribute\('aria-busy',\s*'true'\)/);
    assert.match(clearLoading, /setAttribute\('aria-disabled',\s*'true'\)/);
    assert.doesNotMatch(liveNews, /\.disabled\s*=\s*true/);
  });

  it('clearChannelLoadingState resets every channel button, not only .loading', () => {
    assert.match(clearLoading, /querySelectorAll\('\.live-channel-btn'\)/);
    assert.doesNotMatch(clearLoading, /querySelectorAll\('\.live-channel-btn\.loading'\)/);
    assert.match(clearLoading, /removeAttribute\('aria-busy'\)/);
    assert.match(clearLoading, /removeAttribute\('aria-disabled'\)/);
  });

  it('switchChannel marks the target busy only while its live session is connecting', () => {
    const beginPos = switchChannel.indexOf("this.beginPlayback('explicit')");
    const markPos = switchChannel.indexOf('this.markChannelButtonLoading(channel.id)');
    assert.ok(beginPos > 0, 'switchChannel must start the selected channel');
    assert.ok(markPos > beginPos, 'switchChannel must mark loading after the session starts');
    assert.match(switchChannel, /if \(this\.videoPhase === 'connecting'\) this\.markChannelButtonLoading\(channel\.id\)/);
  });

  it('clears prior loading before marking the new target, and clears it once the session settles or playback stops', () => {
    assert.match(clearLoading, /private markChannelButtonLoading\(channelId: string\): void \{\s*this\.clearChannelLoadingState\(\);/);
    assert.match(onVideoState, /if \(state\.phase !== 'connecting'\) this\.clearChannelLoadingState\(\)/);
    assert.match(stopFromController, /this\.clearChannelLoadingState\(\)/);
    const previewOnly = switchChannel.slice(switchChannel.indexOf('if (!shouldStartMedia)'));
    const clearPos = previewOnly.indexOf('this.clearChannelLoadingState()');
    const placeholderPos = previewOnly.indexOf('this.renderPlaceholder()');
    assert.ok(clearPos >= 0, 'a switch that starts no media must clear loading');
    assert.ok(placeholderPos >= 0, 'a switch that starts no media must render the preview');
    assert.ok(clearPos < placeholderPos, 'a switch that starts no media must clear loading before rendering the preview');
  });

  it('success path no longer drops only the loading class', () => {
    assert.doesNotMatch(switchChannel, /classList\.remove\('loading'\)/);
  });
});

describe('Panel.setSeverity named image', () => {
  it('non-none severity is a named image', () => {
    assert.match(setSeverity, /removeAttribute\('aria-hidden'\)/);
    assert.match(setSeverity, /setAttribute\('role',\s*'img'\)/);
    assert.match(setSeverity, /setAttribute\('aria-label',\s*`\$\{level\} severity`\)/);
  });

  it('none severity is decorative again', () => {
    assert.match(setSeverity, /setAttribute\('aria-hidden',\s*'true'\)/);
    assert.match(setSeverity, /removeAttribute\('role'\)/);
    assert.match(setSeverity, /removeAttribute\('aria-label'\)/);
  });
});

describe('theme prepaint and first-visit applyStoredTheme', () => {
  it('index.html prepaint falls through to prefers-color-scheme: light', () => {
    const prepaint = indexHtml.slice(
      indexHtml.indexOf('<script data-wm-prepaint>'),
      indexHtml.indexOf('</script>', indexHtml.indexOf('<script data-wm-prepaint>')),
    );
    assert.match(prepaint, /matchMedia\('\(prefers-color-scheme: light\)'\)/);
    assert.match(prepaint, /dataset\.theme='light'/);
  });

  it('applyStoredTheme no-preference branch uses resolveAutoTheme, not DEFAULT_THEME', () => {
    assert.match(applyStoredTheme, /variant === 'happy' \? 'light' : resolveAutoTheme\(\)/);
    assert.doesNotMatch(applyStoredTheme, /effective = variant === 'happy' \? 'light' : DEFAULT_THEME/);
  });
});

describe('Insights sentiment named counts', () => {
  it('color track is decorative and labels are one named image', () => {
    assert.match(sentimentOverview, /class="sentiment-bar-track" aria-hidden="true"/);
    assert.match(
      sentimentOverview,
      /role="img" aria-label="\$\{negative\} negative, \$\{neutral\} neutral, \$\{positive\} positive"/,
    );
    assert.match(sentimentOverview, /class="sentiment-label negative" aria-hidden="true"/);
    assert.match(sentimentOverview, /class="sentiment-label neutral" aria-hidden="true"/);
    assert.match(sentimentOverview, /class="sentiment-label positive" aria-hidden="true"/);
  });
});

describe('forced-colors severity and badge borders', () => {
  it('defines a forced-colors block for the severity dot and badge borders', () => {
    assert.match(css, /@media \(forced-colors: active\)/);
    assert.match(forcedColors, /\.panel-severity-dot/);
    assert.match(forcedColors, /forced-color-adjust:\s*none/);
    assert.match(forcedColors, /border:\s*1px solid CanvasText/);
    assert.match(forcedColors, /\.panel-data-badge/);
    assert.match(forcedColors, /\.pizzint-location-status/);
    assert.match(forcedColors, /\.panel-count/);
  });
});

describe('tariff gap class names', () => {
  it('uses direction-vs-baseline names in TS and CSS', () => {
    assert.match(tradePolicy, /trade-tariff-gap-above/);
    assert.match(tradePolicy, /trade-tariff-gap-below/);
    assert.match(css, /\.trade-tariff-gap-above/);
    assert.match(css, /\.trade-tariff-gap-below/);
  });

  it('does not keep the inverted numeric-sign class names', () => {
    assert.doesNotMatch(tradePolicy, /trade-tariff-gap-positive/);
    assert.doesNotMatch(tradePolicy, /trade-tariff-gap-negative/);
    assert.doesNotMatch(css, /trade-tariff-gap-positive/);
    assert.doesNotMatch(css, /trade-tariff-gap-negative/);
  });
});

describe('sparkline default decorative, ConsumerPrices Trend labeled', () => {
  it('sparkline stays aria-hidden unless a label is passed', () => {
    assert.match(sparklineSrc, /a11y\?: \{ label\?: string \}/);
    assert.match(sparklineSrc, /aria-hidden="true"/);
    assert.match(sparklineSrc, /role="img" aria-label=/);
  });

  it('ConsumerPrices Trend cell passes a label; mini row stays unlabeled', () => {
    assert.match(
      consumerPrices,
      /sparkline\(c\.sparkline, 'var\(--accent\)', 48, 18, '', \{ label: `\$\{c\.name\} price trend` \}\)/,
    );
    assert.match(consumerPrices, /sparkline\(c\.sparkline, 'var\(--accent\)', 40, 16\)/);
  });
});
