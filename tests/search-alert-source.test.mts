/**
 * The Cmd+K "Alerts sent to you" source: fetched for a signed-in Pro account
 * when search opens, kept for a minute, and dropped as soon as the account
 * changes so one user's alerts never stay in the index for the next.
 *
 * Run: node --import tsx --test tests/search-alert-source.test.mts
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  SENT_ALERTS_REFRESH_MS,
  SentAlertSearchSource,
  isOpenableAlertLink,
  sentAlertSearchItems,
} from '../src/app/search-alert-source.ts';
import { querySearchIndex } from '../src/components/search-engine.ts';
import type { SearchableSource } from '../src/components/search-types.ts';
import type { SentAlert } from '../src/services/sent-alerts.ts';

function alert(title: string, extra: Partial<SentAlert> = {}): SentAlert {
  return {
    title,
    source: 'Reuters',
    link: 'https://www.reuters.com/world/story',
    sentAt: 1_763_370_000_000,
    ...extra,
  };
}

const describeAlert = (item: SentAlert) => `${item.source} · sent ${item.sentAt}`;

function harness(initial: { account: string | null; alerts?: SentAlert[] }) {
  const state = {
    account: initial.account,
    now: 1_000_000,
    fetches: 0,
    published: [] as SearchableSource['items'][],
    respond: (async () => initial.alerts ?? []) as () => Promise<readonly SentAlert[] | null>,
  };
  const source = new SentAlertSearchSource({
    getAccountKey: () => state.account,
    fetchAlerts: () => {
      state.fetches += 1;
      return state.respond();
    },
    publish: (items) => { state.published.push(items); },
    describe: describeAlert,
    now: () => state.now,
  });
  const titles = () => (state.published.at(-1) ?? []).map((item) => item.title);
  return { state, source, titles };
}

describe('sentAlertSearchItems', () => {
  it('shows the title, publisher, sent time and link, newest first', () => {
    const items = sentAlertSearchItems([
      alert('Newer headline', { sentAt: 2, link: 'https://www.reuters.com/a' }),
      alert('Older headline', { sentAt: 1, source: '', link: '' }),
    ], describeAlert);
    assert.deepEqual(items.map((item) => [item.title, item.subtitle]), [
      ['Newer headline', 'Reuters · sent 2 · reuters.com'],
      ['Older headline', ' · sent 1'],
    ]);
    assert.deepEqual(items[0]!.data, { title: 'Newer headline', source: 'Reuters', link: 'https://www.reuters.com/a', sentAt: 2 });
  });

  it('keeps one row for the same headline and link delivered twice', () => {
    const items = sentAlertSearchItems([
      alert('Same headline', { sentAt: 5 }),
      alert('Same headline', { sentAt: 3 }),
      alert('Same headline', { sentAt: 2, link: 'https://example.com/other' }),
    ], describeAlert);
    assert.deepEqual(items.map((item) => (item.data as { sentAt: number }).sentAt), [5, 2]);
    assert.equal(new Set(items.map((item) => item.id)).size, 2);
  });

  it('never carries a link the browser should not open', () => {
    const [item] = sentAlertSearchItems([alert('Odd link', { link: 'javascript:alert(1)' })], describeAlert);
    assert.equal((item!.data as { link: string }).link, '');
    assert.equal(isOpenableAlertLink('javascript:alert(1)'), false);
    assert.equal(isOpenableAlertLink('https://example.com/a'), true);
    assert.equal(isOpenableAlertLink(''), false);
  });

  it('lists an alert without its link when the caller cannot open that link', () => {
    // The desktop passes a predicate that refuses plain http (the native opener's rule).
    const httpsOnly = (link: string) => link.startsWith('https://');
    const [plain, secure] = sentAlertSearchItems([
      alert('Plain http story', { sentAt: 2, link: 'http://example.org/story' }),
      alert('Secure story', { sentAt: 1, link: 'https://example.org/story' }),
    ], describeAlert, httpsOnly);
    assert.equal((plain!.data as { link: string }).link, '');
    assert.equal(plain!.subtitle, 'Reuters · sent 2', 'no host is shown for a link that cannot be opened');
    assert.equal((secure!.data as { link: string }).link, 'https://example.org/story');
  });

  it('is found by a headline the loaded news does not contain', () => {
    const items = sentAlertSearchItems([alert('Iran closes Hormuz strait to tankers')], describeAlert);
    const result = querySearchIndex({
      rawInput: 'Iran closes Hormuz strait to tankers',
      scope: 'all',
      sources: [{ type: 'news', items: [{ id: 'n1', title: 'A loaded headline', data: {} }] }, { type: 'alert', items }],
      commands: [],
      isMobile: false,
      flightPrefixEnabled: true,
      isPanelCommandVisible: () => true,
      isLayerCommandExecutable: () => true,
      isCommandVisible: () => true,
      isResultVisible: () => true,
      resolveCommandLabel: (command) => command.label,
      resolveCommandCategoryLabel: (command) => command.category,
    });
    assert.deepEqual(result.entityMatches.map((match) => [match.result.type, match.result.title]), [
      ['alert', 'Iran closes Hormuz strait to tankers'],
    ]);
  });
});

describe('SentAlertSearchSource', () => {
  it('does not fetch for a visitor with no Pro account', async () => {
    const { state, source } = harness({ account: null });
    await source.refresh();
    assert.equal(state.fetches, 0);
    assert.deepEqual(state.published, []);
  });

  it('publishes the account alerts when search opens', async () => {
    const { state, source, titles } = harness({ account: 'user_a', alerts: [alert('Sent to A')] });
    await source.refresh();
    assert.equal(state.fetches, 1);
    assert.deepEqual(titles(), ['Sent to A']);
  });

  it('reuses a fresh answer and refetches after it ages', async () => {
    const { state, source } = harness({ account: 'user_a', alerts: [alert('Sent to A')] });
    await source.refresh();
    state.now += SENT_ALERTS_REFRESH_MS - 1;
    await source.refresh();
    assert.equal(state.fetches, 1);
    state.now += 1;
    await source.refresh();
    assert.equal(state.fetches, 2);
  });

  it('does not start a second request while one is in flight', async () => {
    const { state, source } = harness({ account: 'user_a' });
    let release!: (alerts: SentAlert[]) => void;
    state.respond = () => new Promise((resolve) => { release = resolve; });
    const first = source.refresh();
    const second = source.refresh();
    release([alert('Sent to A')]);
    await Promise.all([first, second]);
    assert.equal(state.fetches, 1);
  });

  it('drops the previous account alerts at once when another account signs in', async () => {
    const { state, source, titles } = harness({ account: 'user_a', alerts: [alert('Sent to A')] });
    await source.refresh();
    assert.deepEqual(titles(), ['Sent to A']);

    state.account = 'user_b';
    let release!: (alerts: SentAlert[]) => void;
    state.respond = () => new Promise((resolve) => { release = resolve; });
    const pending = source.refresh();
    assert.deepEqual(titles(), [], 'user A alerts are gone before user B answer arrives');
    release([alert('Sent to B')]);
    await pending;
    assert.deepEqual(titles(), ['Sent to B']);
  });

  it('discards an answer that arrives after the account changed', async () => {
    const { state, source, titles } = harness({ account: 'user_a' });
    let releaseA!: (alerts: SentAlert[]) => void;
    state.respond = () => new Promise((resolve) => { releaseA = resolve; });
    const pendingA = source.refresh();

    state.account = null;
    await source.refresh();
    releaseA([alert('Sent to A')]);
    await pendingA;
    assert.deepEqual(titles(), [], 'a late answer for user A is not published after sign-out');
  });

  it('clears on sign-out and on an explicit clear', async () => {
    const { state, source, titles } = harness({ account: 'user_a', alerts: [alert('Sent to A')] });
    await source.refresh();
    state.account = null;
    await source.refresh();
    assert.deepEqual(titles(), []);

    state.account = 'user_a';
    await source.refresh();
    assert.deepEqual(titles(), ['Sent to A']);
    source.clear();
    assert.deepEqual(titles(), []);
  });

  it('keeps the last alerts when a refresh fails, and retries on the next open', async () => {
    const { state, source, titles } = harness({ account: 'user_a', alerts: [alert('Sent to A')] });
    await source.refresh();
    state.now += SENT_ALERTS_REFRESH_MS;
    state.respond = async () => null;
    await source.refresh();
    assert.deepEqual(titles(), ['Sent to A']);
    state.respond = async () => { throw new Error('offline'); };
    await source.refresh();
    assert.equal(state.fetches, 3, 'a failed refresh is retried without waiting out the interval');
    assert.deepEqual(titles(), ['Sent to A']);
  });
});
