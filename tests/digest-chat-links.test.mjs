// #9214: chat digests (Telegram, Slack, Discord) link every story to its
// original report, the way the email digest already does. These tests run the
// production formatDigest, buildChannelBodies and Telegram sanitizer from
// scripts/seed-digest-notifications.mjs, extracted from source because the
// cron module has import-time env checks.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

import {
  escapeDigestText,
  escapeDiscordText,
  escapeSlackMrkdwn,
  escapeTelegramHtml,
  formatDigestItemTitle,
  markdownToDiscord,
  truncateDiscordContent,
  markdownToSlackMrkdwn,
  markdownToTelegramHtml,
} from '../scripts/_digest-markdown.mjs';
import {
  DIGEST_CRITICAL_LIMIT,
  DIGEST_HIGH_LIMIT,
  DIGEST_MEDIUM_LIMIT,
  formatDigestHtml,
} from '../scripts/lib/digest-email-html.mjs';
import { stripSourceSuffix } from '../scripts/lib/brief-dedup-jaccard.mjs';
import { digestCoverageText } from '../scripts/lib/digest-corroboration.mjs';

const source = readFileSync(new URL('../scripts/seed-digest-notifications.mjs', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('digest.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function productionFunction(name) {
  const fn = parsed.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(fn, `production function ${name} must exist`);
  return fn.getText(parsed);
}

const { formatDigest, buildChannelBodies, sanitizeTelegramHtml } = runInNewContext(
  ['formatDigest', 'buildChannelBodies', 'sanitizeTelegramHtml'].map(productionFunction).join('\n')
    + '\n({ formatDigest, buildChannelBodies, sanitizeTelegramHtml })',
  {
    Intl, Date, RegExp,
    DIGEST_CRITICAL_LIMIT, DIGEST_HIGH_LIMIT, DIGEST_MEDIUM_LIMIT,
    DIVIDER: '─'.repeat(40),
    stripSourceSuffix, digestCoverageText, escapeDigestText, formatDigestItemTitle,
    escapeTelegramHtml, escapeSlackMrkdwn, escapeDiscordText,
    markdownToTelegramHtml, markdownToSlackMrkdwn, markdownToDiscord,
  },
);

const NOW = Date.UTC(2026, 9, 17, 7, 0, 0);

function story(n, overrides = {}) {
  return {
    title: `Story ${n} headline`,
    severity: 'high',
    sources: ['Reuters'],
    link: `https://news.example/story-${n}`,
    description: `Context for story ${n}.`,
    ...overrides,
  };
}

const FIXTURE = [
  story(1, { severity: 'critical' }),
  story(2, { severity: 'high', sources: ['AP', 'BBC', 'DW', 'NOS'] }),
  story(3, { severity: 'medium', description: '' }),
];

function itemLines(text) {
  return text.split('\n').filter((line) => line.startsWith('  • '));
}

describe('formatDigest links every item on chat channels', () => {
  it('Telegram renders one <a href> per item', () => {
    const out = formatDigest(FIXTURE, NOW, 'telegram');
    const items = itemLines(out);
    assert.equal(items.length, 3);
    items.forEach((line, i) => {
      assert.equal((line.match(/<a href="/g) ?? []).length, 1, line);
      assert.ok(line.startsWith(`  • <a href="https://news.example/story-${i + 1}">Story ${i + 1} headline</a>`), line);
    });
    assert.match(out, /\[AP, BBC, DW \+1\]/);
    assert.match(out, /^ {4}Context for story 1\.$/m, 'description line is kept');
  });

  it('Slack renders one <url|title> per item', () => {
    const out = formatDigest(FIXTURE, NOW, 'slack');
    const items = itemLines(out);
    assert.equal(items.length, 3);
    items.forEach((line, i) => {
      assert.ok(line.startsWith(`  • <https://news.example/story-${i + 1}|Story ${i + 1} headline>`), line);
    });
  });

  it('Discord renders one masked link per item with embeds suppressed', () => {
    const out = formatDigest(FIXTURE, NOW, 'discord');
    const items = itemLines(out);
    assert.equal(items.length, 3);
    items.forEach((line, i) => {
      assert.ok(line.startsWith(`  • [Story ${i + 1} headline](<https://news.example/story-${i + 1}>)`), line);
    });
    assert.match(out, /\\\[AP, BBC, DW \+1\]/, 'outlet brackets stay escaped');
  });

  it('plain text keeps the unlinked form', () => {
    const out = formatDigest(FIXTURE, NOW);
    assert.deepEqual(itemLines(out), [
      '  • Story 1 headline [Reuters]',
      '  • Story 2 headline [AP, BBC, DW +1]',
      '  • Story 3 headline [Reuters]',
    ]);
    assert.doesNotMatch(out, /https:\/\/news\.example/);
  });

  it('keeps the per-severity limits on every channel', () => {
    const stories = Array.from({ length: DIGEST_HIGH_LIMIT + 2 }, (_, i) => story(i, { description: '' }));
    for (const target of ['plain', 'telegram', 'slack', 'discord']) {
      const out = formatDigest(stories, NOW, target);
      assert.equal(itemLines(out).length, DIGEST_HIGH_LIMIT, target);
      assert.match(out, /\.\.\. and 2 more/, target);
    }
  });

  it('renders a story with no link, or a non-http link, as an unlinked title', () => {
    const stories = [
      story(1, { link: '' }),
      story(2, { link: 'javascript:alert(1)' }),
      story(3, { link: 'not a url' }),
    ];
    assert.doesNotMatch(formatDigest(stories, NOW, 'telegram'), /<a /);
    assert.doesNotMatch(formatDigest(stories, NOW, 'slack'), /<[a-z]+:/);
    assert.doesNotMatch(formatDigest(stories, NOW, 'discord'), /\]\(/);
  });
});

describe('formatDigestItemTitle escaping', () => {
  const hostile = 'A | B > C ] D [E] *F* <G> & H_I `J` ~K~';
  const link = 'https://news.example/a(b)?q=1&r=x|y';

  it('Slack: no |, < or > in the label or URL can end the link early', () => {
    const out = formatDigestItemTitle(hostile, link, 'slack');
    assert.equal(out, '<https://news.example/a(b)?q=1&r=x%7Cy|A ∣ B &gt; C ] D [E] *F* &lt;G&gt; &amp; H_I `J` ~K~>');
    const inner = out.slice(1, -1);
    assert.doesNotMatch(inner, /[<>]/);
    assert.equal(inner.split('|').length, 2, 'exactly one separator');
  });

  it('Discord: brackets and markdown in the label are escaped, parens in the URL encoded', () => {
    const out = formatDigestItemTitle(hostile, link, 'discord');
    assert.equal(out, '[A \\| B > C \\] D \\[E\\] \\*F\\* <G> & H\\_I \\`J\\` \\~K\\~](<https://news.example/a%28b%29?q=1&r=x|y>)');
  });

  it('Telegram: HTML-escapes the label and the href attribute', () => {
    const out = formatDigestItemTitle('Q&A <b>x</b>', 'https://news.example/?a=1&b="2"', 'telegram');
    assert.equal(out, '<a href="https://news.example/?a=1&amp;b=%222%22">Q&amp;A &lt;b&gt;x&lt;/b&gt;</a>');
  });

  it('plain: returns the title unchanged and drops the link', () => {
    assert.equal(formatDigestItemTitle(hostile, link, 'plain'), hostile);
  });

  it('escapeDigestText matches the per-channel escapers', () => {
    const s = 'a <b> & [c] \\';
    assert.equal(escapeDigestText(s, 'telegram'), escapeTelegramHtml(s));
    assert.equal(escapeDigestText(s, 'slack'), escapeSlackMrkdwn(s));
    assert.equal(escapeDigestText(s, 'discord'), escapeDiscordText(s));
    assert.equal(escapeDigestText(s, 'plain'), s);
  });
});

describe('buildChannelBodies sends the linked list to each chat channel', () => {
  const lists = {
    plain: formatDigest(FIXTURE, NOW),
    telegram: formatDigest(FIXTURE, NOW, 'telegram'),
    slack: formatDigest(FIXTURE, NOW, 'slack'),
    discord: formatDigest(FIXTURE, NOW, 'discord'),
  };

  for (const summary of [null, 'Assessment: calm.']) {
    it(`does not re-escape the linked markup (summary=${summary ? 'yes' : 'no'})`, () => {
      const bodies = buildChannelBodies(lists, summary, null);
      assert.ok(bodies.text.includes(lists.plain));
      assert.ok(bodies.telegramText.includes(lists.telegram));
      assert.ok(bodies.slackText.includes(lists.slack));
      assert.ok(bodies.discordText.includes(lists.discord));
      assert.equal((bodies.telegramText.match(/<a href="https:\/\/news\.example/g) ?? []).length, 3);
      assert.equal((bodies.slackText.match(/<https:\/\/news\.example/g) ?? []).length, 3);
      assert.equal((bodies.discordText.match(/\]\(<https:\/\/news\.example/g) ?? []).length, 3);
    });
  }
});

describe('sanitizeTelegramHtml', () => {
  it('closes an <a> left open by truncation', () => {
    assert.equal(
      sanitizeTelegramHtml('x <a href="https://news.example/1">Story'),
      'x <a href="https://news.example/1">Story</a>',
    );
  });

  it('drops a half-written <a tag', () => {
    assert.equal(sanitizeTelegramHtml('x <a href="https://news.exa'), 'x ');
  });

  it('leaves balanced links alone', () => {
    const html = '<a href="https://news.example/1">One</a> <a href="https://news.example/2">Two</a>';
    assert.equal(sanitizeTelegramHtml(html), html);
  });
});

describe('truncateDiscordContent with linked items', () => {
  it('cuts at a line boundary so no masked link is left half-written', () => {
    const stories = Array.from({ length: 12 }, (_, i) => story(i, { description: 'x '.repeat(90) }));
    const out = truncateDiscordContent(formatDigest(stories, NOW, 'discord'));
    assert.ok(out.length <= 2000);
    const items = itemLines(out);
    assert.ok(items.length > 0);
    for (const line of items) assert.match(line, /\]\(<https:\/\/news\.example\/story-\d+>\)/, line);
    assert.ok(out.endsWith('\n\u2026'), 'ellipsis follows the last whole line');
  });

  it('never leaves a partial masked link when the last line break is far back', () => {
    const url = `https://news.example/${'a'.repeat(400)}`;
    const line = Array.from({ length: 12 }, (_, i) => `[Story ${i}](<${url}/${i}>)`).join(' ');
    const out = truncateDiscordContent(`Header\n${line}`);
    assert.ok(out.length <= 2000);
    const body = out.slice('Header\n'.length, -1);
    assert.ok(body.length > 0, 'keeps the complete links that fit');
    assert.match(body, /^(\[Story \d+\]\(<[^>]+>\) ?)+$/, 'only whole links remain');
  });

  it('does not treat an escaped bracket as a link start', () => {
    const text = `${'x'.repeat(1990)} \\[not a link ${'y'.repeat(50)}`;
    const out = truncateDiscordContent(text);
    assert.ok(out.length <= 2000);
    assert.ok(out.length > 1990, 'escaped text is cut at the limit, not rewound');
  });

  it('is not fooled by >) or ] inside a headline', () => {
    const link = formatDigestItemTitle('Talks >) stall ] again', `https://news.example/${'b'.repeat(300)}`, 'discord');
    const out = truncateDiscordContent(`Header\n${'z'.repeat(1700)} ${link}`);
    assert.ok(out.length <= 2000);
    assert.doesNotMatch(out, /\[Talks/, 'the incomplete link is dropped whole');
  });

  it('encodes [ and ] in the URL so a cut inside it rewinds to the whole link', () => {
    const link = formatDigestItemTitle('Talks', `https://news.example/a[1]/${'c'.repeat(300)}`, 'discord');
    assert.doesNotMatch(link.slice(link.indexOf('](<') + 3), /[[\]]/, 'no raw bracket in the URL');
    const out = truncateDiscordContent(`Header\n${'z'.repeat(1750)} ${link}`);
    assert.ok(out.length <= 2000);
    assert.doesNotMatch(out, /\[Talks/, 'the incomplete link is dropped whole');
  });

  it('keeps a headline with a line break on one line, so a line cut never splits its link', () => {
    for (const target of ['telegram', 'slack', 'discord']) {
      const out = formatDigestItemTitle('Talks stall\nagain\r\n today', 'https://news.example/x', target);
      assert.doesNotMatch(out, /[\r\n]/, target);
      assert.match(out, /Talks stall again today/, target);
    }
  });
});

describe('email digest links', () => {
  const card = (link) => formatDigestHtml([{
    title: 'Port strike halts traffic', severity: 'high', phase: 'sustained', sources: ['Reuters'],
    link, description: '', hash: 'e1',
  }], NOW);

  it('links an http(s) headline', () => {
    assert.match(card('https://news.example/x'), /<a href="https:\/\/news\.example\/x"[^>]*>Port strike halts traffic<\/a>/);
  });

  it('renders a non-http link as an unlinked headline', () => {
    for (const link of ['javascript:alert(1)', 'data:text/html,x', 'not a url']) {
      const html = card(link);
      assert.doesNotMatch(html, /href="(javascript|data|not)/i, link);
      assert.match(html, /<span[^>]*>Port strike halts traffic<\/span>/, link);
    }
  });
});
