/**
 * #5609 — a browser-denied notification permission must move the activation
 * wizard's alerts step into the BLOCKED state (site-settings instructions +
 * "Continue"), never the generic failed note with a "Try again" button.
 * Browsers never re-prompt once permission is `denied`, so a retry CTA there is
 * a dead end: it fails identically forever.
 *
 * Both halves run against the real module:
 *   1. flow  — `openProActivationFlow`'s `onConfirmStep('alerts')` classifies a
 *              push-subscribe rejection by the LIVE permission (denied →
 *              'blocked', anything else → retryable 'failed').
 *   2. shell — `openProActivationInterstitial` renders the blocked state when a
 *              confirm resolves 'blocked', and still offers retry on 'failed'.
 *
 * The shell half needs a DOM that PARSES assigned `innerHTML` — the wizard
 * re-renders by assigning an HTML string and then wires its buttons through
 * `querySelector`. `tests/helpers/mini-dom.mts` deliberately stores the string
 * without parsing it, so this file layers a small tag-soup parser onto
 * MiniElement rather than pulling JSDOM into the suite.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { MiniDocument, MiniElement, MiniText } from './helpers/mini-dom.mts';

// ---------------------------------------------------------------------------
// Minimal parsing DOM
// ---------------------------------------------------------------------------

const TAG_RE = /<(\/)?([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*"[^"]*")?)*)\s*(\/)?>/g;
const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*"([^"]*)")?/g;
/** Tags the wizard never closes explicitly (it emits none today; guard anyway). */
const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link']);

function applyAttributes(element: MiniElement, raw: string): void {
  ATTR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR_RE.exec(raw)) !== null) {
    element.setAttribute(match[1]!, match[2] ?? '');
  }
}

/**
 * Parse the wizard's own generated markup into MiniElements. Scope is exactly
 * what the wizard emits: balanced tags, double-quoted attributes, text nodes.
 */
function parseChildren(html: string, doc: MiniDocument): Array<MiniElement | MiniText> {
  const roots: Array<MiniElement | MiniText> = [];
  const stack: MiniElement[] = [];
  const push = (node: MiniElement | MiniText): void => {
    const parent = stack.at(-1);
    if (parent) parent.appendChild(node);
    else roots.push(node);
  };

  let cursor = 0;
  TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_RE.exec(html)) !== null) {
    if (match.index > cursor) push(new MiniText(html.slice(cursor, match.index)));
    cursor = TAG_RE.lastIndex;
    const [, closing, tagName, attributes, selfClosing] = match;
    if (closing) {
      const index = stack.map((el) => el.tagName).lastIndexOf(tagName!.toUpperCase());
      if (index >= 0) stack.length = index;
      continue;
    }
    const element = doc.createElement(tagName!);
    applyAttributes(element, attributes ?? '');
    push(element);
    if (!selfClosing && !VOID_TAGS.has(tagName!.toLowerCase())) stack.push(element);
  }
  if (cursor < html.length) push(new MiniText(html.slice(cursor)));
  return roots;
}

/** Attribute-faithful serializer — MiniElement's own `outerHTML` drops attributes. */
function serializeNode(node: MiniElement | MiniText): string {
  if (!(node instanceof MiniElement)) return node.textContent ?? '';
  const tag = node.tagName.toLowerCase();
  let attributes = '';
  for (const [name, value] of node.attributes) attributes += ` ${name}="${value}"`;
  const children = node.childNodes
    .map((child) => serializeNode(child as MiniElement | MiniText))
    .join('');
  return `<${tag}${attributes}>${children}</${tag}>`;
}

/**
 * MiniElement whose `innerHTML` setter also builds the child tree, so
 * `querySelector` after a render finds the wizard's freshly written buttons.
 * The getter serializes that LIVE tree rather than replaying the assigned
 * string: a snapshot would go silently vacuous the moment anything mutates the
 * subtree after render (the brief step's preview already does exactly that),
 * turning a `doesNotMatch` assertion into a pass-by-blindness.
 */
class ParsingElement extends MiniElement {
  override get innerHTML(): string {
    return this.childNodes.map((child) => serializeNode(child as MiniElement | MiniText)).join('');
  }

  override set innerHTML(value: string) {
    this.childNodes = [];
    const doc = (this.ownerDocument ?? null) as ParsingDocument | null;
    if (!doc) return;
    for (const child of parseChildren(String(value), doc)) super.appendChild(child);
  }
}

class ParsingDocument extends MiniDocument {
  override createElement(tagName: string): MiniElement {
    const element = new ParsingElement(tagName);
    element.ownerDocument = this;
    return element;
  }
}

interface DomHandles {
  document: ParsingDocument;
  restore: () => void;
}

const GLOBAL_KEYS = ['document', 'window', 'HTMLElement', 'requestAnimationFrame'] as const;

function installDom(): DomHandles {
  const saved = GLOBAL_KEYS.map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  const document = new ParsingDocument();
  const define = (key: string, value: unknown): void => {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  define('document', document);
  define('HTMLElement', MiniElement);
  define('requestAnimationFrame', (callback: (t: number) => void) => {
    callback(0);
    return 1;
  });
  define('window', { setTimeout, clearTimeout, document, location: { origin: 'https://test' } });
  return {
    document,
    restore: () => {
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Module loader (esbuild + stubs, mirroring pro-activation-controller.test.mts)
// ---------------------------------------------------------------------------

type InterstitialModule = typeof import('../src/components/ProActivationInterstitial.ts');

async function loadInterstitial(): Promise<InterstitialModule> {
  const tempDir = mkdtempSync(join(tmpdir(), 'wm-pro-activation-alerts-'));
  const outfile = join(tempDir, 'interstitial.bundle.mjs');
  // `t` returns the KEY so assertions pin the copy the wizard chose rather than
  // its English wording (which can be reworded without changing behaviour).
  const stubs = new Map([
    ['i18n-stub', 'export function t(key) { return key; }'],
    ['auth-stub', `
      export function getAuthState() { return { user: { id: globalThis.__alertsUserId } }; }
      export function subscribeAuthState() { return () => {}; }
    `],
    ['billing-stub', `
      export async function claimProActivationPresentation() { return 'claimed'; }
      export async function confirmProActivationPresentation() { return true; }
      export async function openProActivationDay0Presentation() { return 'opened'; }
      export async function recordProActivationOutcome() { return true; }
    `],
    ['channels-stub', `
      export async function getChannelsData() { return globalThis.__alertsChannelsData; }
      export async function setEmailChannel() { return true; }
      export async function setNotificationConfig(config) {
        globalThis.__alertsConfigWrites.push(config);
        if (globalThis.__alertsConfigWriteThrows) throw new Error('rule write rejected');
        return true;
      }
    `],
    ['push-stub', `
      export function isWebPushSupported() { return true; }
      export function getPushPermission() { return globalThis.__alertsPushPermission; }
      export async function subscribeToPush() {
        globalThis.__alertsSubscribeCalls += 1;
        if (globalThis.__alertsSubscribeThrows) {
          throw new Error('Notifications are blocked. Enable them in your browser settings.');
        }
        return { endpoint: 'https://push.test/x', p256dh: 'k', auth: 'a', userAgent: 'test' };
      }
    `],
    ['insights-stub', `
      export function getServerInsights() { return null; }
      export async function fetchServerInsights() { return null; }
    `],
    ['widgets-stub', `
      export function loadWidgets() { return []; }
      export function loadWidgetsStrict() { return []; }
    `],
    ['variant-stub', "export const SITE_VARIANT = 'full';"],
    ['chip-stub', 'export function showFinishSetupChipForResults() {}'],
    ['sentry-stub', `
      export async function scheduleSentryInit() {}
      export function enqueueSentryCall(fn) {
        fn({ captureException: (err, ctx) => globalThis.__alertsSentry.push({ err, ctx }) });
      }
    `],
  ]);
  const aliases = new Map([
    ['@/services/i18n', 'i18n-stub'],
    ['@/services/auth-state', 'auth-stub'],
    ['@/services/billing', 'billing-stub'],
    ['@/services/notification-channels', 'channels-stub'],
    ['@/services/push-notifications', 'push-stub'],
    ['@/services/insights-loader', 'insights-stub'],
    ['@/services/widget-store', 'widgets-stub'],
    ['@/config/variant', 'variant-stub'],
    ['@/components/ProActivationChip', 'chip-stub'],
    ['@/bootstrap/sentry-defer', 'sentry-stub'],
  ]);

  const result = await build({
    entryPoints: [resolve(process.cwd(), 'src/components/ProActivationInterstitial.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    write: false,
    plugins: [{
      name: 'pro-activation-alerts-test-stubs',
      setup(buildApi) {
        buildApi.onResolve({ filter: /.*/ }, (args) => {
          const target = aliases.get(args.path);
          return target ? { path: target, namespace: 'stub' } : null;
        });
        buildApi.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
          contents: stubs.get(args.path),
          loader: 'js',
        }));
      },
    }],
  });

  writeFileSync(outfile, result.outputFiles![0]!.text, 'utf8');
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  rmSync(tempDir, { recursive: true, force: true });
  return mod as InterstitialModule;
}

function installPushState(permission: 'default' | 'granted' | 'denied', throws: boolean): void {
  Object.assign(globalThis, {
    __alertsUserId: 'user_alerts',
    __alertsPushPermission: permission,
    __alertsSubscribeThrows: throws,
    __alertsSubscribeCalls: 0,
    __alertsConfigWrites: [] as unknown[],
    __alertsConfigWriteThrows: false,
    __alertsChannelsData: { channels: [], alertRules: [] },
    __alertsSentry: [] as unknown[],
  });
}

/** Confirmable-everywhere context: the alerts step is offered, not pre-blocked. */
function activationContext() {
  return {
    config: {
      hasVerifiedEmailChannel: false,
      hasEmailDelivery: false,
      hasEnabledDigestRule: false,
      hasTunedDigestHour: false,
      hasWebPushChannel: false,
      hasWebPushDelivery: false,
      hasUsedPowerFeature: false,
    },
    capabilities: { webPushSupported: true, pushPermission: 'default' as const },
    channels: [] as string[],
    channelsKnown: true,
    hasEnabledRule: false,
  };
}

let activeDom: DomHandles | null = null;
let activeClose: (() => void) | null = null;

afterEach(() => {
  activeClose?.();
  activeClose = null;
  activeDom?.restore();
  activeDom = null;
});

// ---------------------------------------------------------------------------
// 1. Flow — classify the subscribe rejection by the live permission
// ---------------------------------------------------------------------------

describe('alerts confirm classification (#5609)', () => {
  const events: Array<{ event: string; stepId?: string }> = [];

  async function captureConfirm(mod: InterstitialModule) {
    events.length = 0;
    let captured: Parameters<typeof mod.openProActivationInterstitial>[0] | null = null;
    const opened = await mod.openProActivationFlow(
      {
        accountUserId: 'user_alerts',
        accountEmail: 'pro@worldmonitor.test',
        isAccountCurrent: () => true,
        onEvent: (event, stepId) => events.push({ event, stepId }),
      },
      {
        readContext: async () => activationContext(),
        openInterstitial: (interstitialOptions) => {
          captured = interstitialOptions;
        },
      },
    );
    assert.equal(opened, 'opened');
    assert.ok(captured, 'flow must open the interstitial');
    return captured!;
  }

  it('returns "blocked" when the browser denied the permission mid-flow', async () => {
    installPushState('denied', true);
    const mod = await loadInterstitial();
    const options = await captureConfirm(mod);

    const result = await options.onConfirmStep('alerts');

    assert.equal(result, 'blocked', 'a denied permission is a dead end, not a retryable failure');
    assert.equal((globalThis as Record<string, number>).__alertsSubscribeCalls, 1);

    // The flow must map the shell's block signal onto its own funnel event, or
    // the denial cohort disappears into skippedSteps.
    options.onBlockStep?.('alerts');
    assert.deepEqual(events.filter((e) => e.event.includes('blocked')), [
      { event: 'pro-activation-step-blocked', stepId: 'alerts' },
    ]);
  });

  it('returns retryable "declined" when the prompt was merely dismissed', async () => {
    // Permission stays 'default' — the browser WILL prompt again, so "Try
    // again" remains meaningful and must not be swallowed by the blocked state.
    // That intent is unchanged; only the vocabulary widened (#5600). 'declined'
    // renders the SAME retryable state as 'failed' (see the shell test below)
    // but keeps a dismissed prompt out of the pro-activation-step-failed metric,
    // which exists to surface OUR writes erroring — a dismissed prompt is the
    // most common alerts-step outcome and is a user choice, not our failure.
    installPushState('default', true);
    const mod = await loadInterstitial();
    const options = await captureConfirm(mod);

    assert.equal(await options.onConfirmStep('alerts'), 'declined');
  });


  // Both post-subscribe failure paths must stay retryable: the permission was
  // granted, so the step is recoverable and "Try again" is the right CTA.
  it('still returns "failed" when the post-subscribe config read fails', async () => {
    installPushState('granted', false);
    const mod = await loadInterstitial();
    const options = await captureConfirm(mod);
    (globalThis as Record<string, unknown>).__alertsChannelsData = null;

    assert.equal(await options.onConfirmStep('alerts'), 'failed');
    assert.deepEqual((globalThis as Record<string, unknown[]>).__alertsConfigWrites, []);
  });

  it('still returns "failed" when the alert-rule write itself is rejected', async () => {
    installPushState('granted', false);
    const mod = await loadInterstitial();
    const options = await captureConfirm(mod);
    (globalThis as Record<string, unknown>).__alertsConfigWriteThrows = true;

    assert.equal(await options.onConfirmStep('alerts'), 'failed');
    assert.equal(
      (globalThis as Record<string, unknown[]>).__alertsConfigWrites.length,
      1,
      'the rule write must actually be attempted before it can fail',
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Shell — a 'blocked' confirm must render the blocked state, not a retry
// ---------------------------------------------------------------------------

describe('activation interstitial blocked transition (#5609)', () => {
  function renderedHtml(dom: DomHandles): string {
    const modal = dom.document.body.querySelector('.pro-activation-modal');
    assert.ok(modal, 'interstitial must mount a modal');
    return modal!.innerHTML;
  }

  function clickPrimary(dom: DomHandles): string {
    const primary = dom.document.body.querySelector('.pro-activation-primary');
    assert.ok(primary, 'step must render a primary action');
    const action = primary!.dataset.action ?? '';
    primary!.dispatchEvent(new Event('click'));
    return action;
  }

  function openAlertsStep(
    mod: InterstitialModule,
    onConfirmStep: () => Promise<'verified' | 'failed' | 'blocked' | 'declined'>,
    state: 'confirmable' | 'blocked' = 'confirmable',
  ): {
    dom: DomHandles;
    skips: string[];
    blocks: string[];
    exits: Array<Array<{ id: string; outcome: string }>>;
  } {
    const dom = activeDom!;
    const skips: string[] = [];
    const blocks: string[] = [];
    const exits: Array<Array<{ id: string; outcome: string }>> = [];
    mod.openProActivationInterstitial({
      steps: [{ id: 'alerts', state }],
      accountEmail: 'pro@worldmonitor.test',
      onConfirmStep: onConfirmStep as never,
      onSkipStep: (stepId) => skips.push(stepId),
      onBlockStep: (stepId) => blocks.push(stepId),
      onExit: (results) => exits.push(results as never),
    });
    activeClose = mod.closeProActivationInterstitial;
    return { dom, skips, blocks, exits };
  }

  it('renders the blocked state (no retry) once the confirm resolves blocked', async () => {
    installPushState('denied', true);
    activeDom = installDom();
    const mod = await loadInterstitial();
    const { dom, skips, blocks, exits } = openAlertsStep(mod, async () => 'blocked');

    assert.equal(clickPrimary(dom), 'confirm', 'the step starts on the confirm CTA');
    await new Promise<void>((r) => setImmediate(r));

    const html = renderedHtml(dom);
    assert.match(html, /status-blocked/, 'status badge must flip to blocked');
    assert.match(
      html,
      /steps\.alerts\.declinedNote/,
      'must point the user at their browser site settings',
    );
    assert.doesNotMatch(html, /status\.retry/, 'a denied permission must not offer "Try again"');
    assert.doesNotMatch(html, /data-action="confirm"/, 'the dead-end confirm CTA must be gone');
    assert.doesNotMatch(html, /pro-activation-skip/, 'blocked steps expose one action, not two');
    assert.match(html, /data-action="advance-skip"/, 'blocked steps advance with Continue');

    // The block is reported live the moment it happens, independent of the
    // durable `blocked` outcome asserted below — without this signal a browser
    // refusal reads as user disinterest on the event stream.
    assert.deepEqual(blocks, ['alerts'], 'the blocked transition must be observable');

    // Continuing resolves the step exactly like one blocked at mount — and,
    // since #5617, as its own 'blocked' outcome rather than 'skipped', so the
    // durable record can still separate a browser refusal from a real skip. It
    // is never 'failed' (which the summary reports as "we couldn't set up").
    assert.equal(clickPrimary(dom), 'advance-skip');
    assert.deepEqual(
      skips,
      [],
      'a browser refusal must not also be counted as a voluntary skip, or the ' +
        'funnel and the durable buckets report different denial cohorts',
    );
    assert.deepEqual(
      blocks,
      ['alerts'],
      'and it must be announced exactly once — the confirm already reported it',
    );
    assert.equal(clickPrimary(dom), 'finish', 'continuing lands on the exit summary');
    assert.deepEqual(exits, [[{ id: 'alerts', outcome: 'blocked' }]]);
  });

  it('records a blocked step as blocked when the user escapes instead of continuing', async () => {
    installPushState('denied', true);
    activeDom = installDom();
    const mod = await loadInterstitial();
    const { dom, skips, exits } = openAlertsStep(mod, async () => 'blocked');

    clickPrimary(dom);
    await new Promise<void>((r) => setImmediate(r));
    assert.match(renderedHtml(dom), /status-blocked/);

    // finalizeAndShowSummary preserves a 'failed' transient but nothing else.
    // A blocked step must land in blockedSteps, not the failedSteps bucket the
    // summary renders as "we couldn't set this up" — the browser refused, we
    // did not fail. Abandoning the flow is the SAME refusal as continuing past
    // it, so both paths must record it identically or the durable bucket
    // becomes a sample of "denied users who clicked Continue" (#5617).
    dom.document.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }));
    assert.match(renderedHtml(dom), /pro-activation-summary/, 'Escape rolls into the summary');
    assert.doesNotMatch(renderedHtml(dom), /summary-line status-failed/);
    assert.match(
      renderedHtml(dom),
      /summary-line status-pending/,
      'a blocked step still reads as pending to the user',
    );
    assert.deepEqual(skips, [], 'abandoning on a refusal is not a voluntary skip either');

    assert.equal(clickPrimary(dom), 'finish');
    assert.deepEqual(exits, [[{ id: 'alerts', outcome: 'blocked' }]]);
  });

  // A step denied BEFORE the wizard opened is the larger half of the same
  // cohort — permission was already 'denied' when the steps were built, so the
  // user was never even offered the action. It must record identically (#5617).
  it('records a step blocked at mount as blocked, not skipped', async () => {
    installPushState('denied', true);
    activeDom = installDom();
    const mod = await loadInterstitial();
    const { dom, skips, blocks, exits } = openAlertsStep(mod, async () => 'blocked', 'blocked');

    assert.equal(clickPrimary(dom), 'advance-skip', 'mount-blocked advances with Continue');
    assert.equal(clickPrimary(dom), 'finish');
    assert.deepEqual(exits, [[{ id: 'alerts', outcome: 'blocked' }]]);

    // A step already denied before the wizard opened never runs a confirm, so
    // nothing reported it: before #5617 it emitted only `stepSkipped` and the
    // whole mount-denied cohort was invisible on the event stream.
    assert.deepEqual(blocks, ['alerts'], 'a mount-time denial must announce itself too');
    assert.deepEqual(skips, [], 'and must not be double-counted as a skip');
  });

  // The denial must become durable the INSTANT the browser refuses, not when
  // the user next interacts. Being refused and then closing the tab is a likely
  // reaction, and a snapshot written only on advance would leave that account
  // recorded as a voluntary skip forever -- losing precisely the cohort the
  // blocked bucket exists to size (#5617). Driven through the REAL shell: the
  // assertion is that `handleConfirm` itself flushes, not that a hand-called
  // onProgress does what it is told.
  it('flushes a mid-flow denial immediately, before the user advances past it', async () => {
    installPushState('denied', true);
    activeDom = installDom();
    const mod = await loadInterstitial();
    const dom = activeDom!;
    const progress: Array<Array<{ id: string; outcome: string }>> = [];
    mod.openProActivationInterstitial({
      steps: [{ id: 'alerts', state: 'confirmable' }],
      accountEmail: 'pro@worldmonitor.test',
      onConfirmStep: (async () => 'blocked') as never,
      onSkipStep: () => {},
      onBlockStep: () => {},
      onProgress: (results) => progress.push(results as never),
      onExit: () => {},
    });
    activeClose = mod.closeProActivationInterstitial;

    const primary = dom.document.body.querySelector('.pro-activation-primary');
    assert.ok(primary, 'step must render a primary action');
    primary!.dispatchEvent(new Event('click'));
    await new Promise<void>((r) => setImmediate(r));

    // No Continue, no Escape -- the user is refused and stops here.
    assert.deepEqual(
      progress,
      [[{ id: 'alerts', outcome: 'blocked' }]],
      'the refusal itself must emit a progress snapshot recording it as blocked',
    );
  });

  // `defaultOutcome` classifies steps the user has NOT reached yet, and every
  // other test here mounts a single step, so this look-ahead never ran. It
  // matters: permission is already denied at mount, so the alerts step is
  // genuinely blocked before the subscriber ever sees it, and a progress
  // snapshot written while they are still on step 1 must say so rather than
  // pre-labelling it a voluntary skip.
  it('classifies a not-yet-reached mount-blocked step as blocked in progress snapshots', async () => {
    installPushState('denied', true);
    activeDom = installDom();
    const mod = await loadInterstitial();
    const dom = activeDom!;
    const progress: Array<Array<{ id: string; outcome: string }>> = [];
    mod.openProActivationInterstitial({
      steps: [
        { id: 'brief', state: 'confirmable' },
        { id: 'alerts', state: 'blocked' },
        { id: 'power', state: 'confirmable' },
      ],
      accountEmail: 'pro@worldmonitor.test',
      onConfirmStep: (async () => 'verified') as never,
      onSkipStep: () => {},
      onBlockStep: () => {},
      onProgress: (results) => progress.push(results as never),
      onExit: () => {},
    });
    activeClose = mod.closeProActivationInterstitial;

    // Confirm step 1 only. Steps 2 and 3 are still unvisited.
    const primary = dom.document.body.querySelector('.pro-activation-primary');
    primary!.dispatchEvent(new Event('click'));
    await new Promise<void>((r) => setImmediate(r));

    assert.deepEqual(progress[0], [
      { id: 'brief', outcome: 'confirmed' },
      { id: 'alerts', outcome: 'blocked' },
      { id: 'power', outcome: 'skipped' },
    ]);
  });

  it('keeps the pre-denied copy for a step already blocked at mount', async () => {
    installPushState('denied', true);
    activeDom = installDom();
    const mod = await loadInterstitial();
    const { dom } = openAlertsStep(mod, async () => 'blocked', 'blocked');

    const html = renderedHtml(dom);
    assert.match(html, /status-blocked/);
    assert.match(html, /steps\.alerts\.blockedNote/, 'mount-blocked keeps its own copy');
    assert.doesNotMatch(html, /steps\.alerts\.declinedNote/);
  });

  it('keeps offering "Try again" when the confirm merely failed', async () => {
    installPushState('default', true);
    activeDom = installDom();
    const mod = await loadInterstitial();
    const { dom } = openAlertsStep(mod, async () => 'failed');

    clickPrimary(dom);
    await new Promise<void>((r) => setImmediate(r));

    const html = renderedHtml(dom);
    assert.match(html, /status-failed/, 'a retryable failure keeps the failed badge');
    assert.match(html, /status\.retry/, 'retry must survive for recoverable failures');
    assert.match(html, /data-action="confirm"/);
    assert.doesNotMatch(html, /status-blocked/);
  });

  it('renders a dismissed prompt as retryable too, and reports it as a skip not a failure', async () => {
    // #5600: 'declined' is a dismissed permission prompt. It must render exactly
    // like 'failed' — the browser re-prompts, so "Try again" is meaningful — while
    // resolving as a SKIP rather than landing in the failed bucket. Splitting the
    // two is the whole point: pro-activation-step-failed exists to surface our
    // writes erroring, and a dismissed prompt is the alerts step's most common
    // user outcome.
    installPushState('default', true);
    activeDom = installDom();
    const mod = await loadInterstitial();
    const { dom, skips, exits } = openAlertsStep(mod, async () => 'declined');

    clickPrimary(dom);
    await new Promise<void>((r) => setImmediate(r));

    const html = renderedHtml(dom);
    assert.match(html, /status-failed/, 'a dismissed prompt stays in the retryable state');
    assert.match(html, /status\.retry/, '"Try again" must still be offered');
    assert.doesNotMatch(html, /status-blocked/, 'it must not become the blocked dead end');

    // Moving on via the secondary Skip button records a skip, not a failure —
    // the outcome a genuine write error would land in.
    const skip = dom.document.body.querySelector('.pro-activation-skip');
    assert.ok(skip, 'a dismissed prompt must still offer Skip alongside Try again');
    skip!.dispatchEvent(new Event('click'));
    assert.deepEqual(skips, ['alerts']);
    assert.equal(clickPrimary(dom), 'finish');
    assert.deepEqual(exits, [[{ id: 'alerts', outcome: 'skipped' }]]);
  });
});

// ---------------------------------------------------------------------------
// 3. Durable record — the blocked outcome must reach Convex in its own bucket
// ---------------------------------------------------------------------------

/**
 * #5617. The event stream can already separate a browser denial from a
 * voluntary skip; the persisted per-account record could not. This covers the
 * handoff the leaf's bucket test cannot see: the flow must actually SEND
 * `blockedSteps` on the outcome snapshot. A dropped field here leaves every
 * unit test green while the durable record stays collapsed.
 */
describe('durable activation outcome carries the blocked bucket (#5617)', () => {
  type Snapshot = {
    confirmedSteps: string[];
    skippedSteps: string[];
    blockedSteps: string[];
    failedSteps: string[];
    revision: number;
    finalized: boolean;
  };

  async function captureOutcomeWrites(): Promise<{
    interstitial: Parameters<InterstitialModule['openProActivationInterstitial']>[0];
    writes: Snapshot[];
  }> {
    installPushState('denied', true);
    const mod = await loadInterstitial();
    const writes: Snapshot[] = [];
    let captured: Parameters<InterstitialModule['openProActivationInterstitial']>[0] | null = null;
    const opened = await mod.openProActivationFlow(
      {
        accountUserId: 'user_alerts',
        accountEmail: 'pro@worldmonitor.test',
        isAccountCurrent: () => true,
        // The durable snapshot is written only for the markerless cohort, which
        // is the one holding a server-side presentation row to write it onto.
        onlyIfUnactivated: true,
        expectedActivationKey: 'sub_activation_key',
        activationClaimNonce: 'device-a',
      },
      {
        readContext: async () => activationContext(),
        recordOutcome: async (_key, _nonce, snapshot) => {
          writes.push(snapshot as Snapshot);
          return true;
        },
        openInterstitial: (interstitialOptions) => {
          captured = interstitialOptions;
        },
      },
    );
    assert.equal(opened, 'opened');
    assert.ok(captured, 'flow must open the interstitial');
    return { interstitial: captured!, writes };
  }

  /** The write is fire-and-forget; let its microtask chain settle. */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) await new Promise<void>((r) => setImmediate(r));
  };

  it('persists a blocked step in blockedSteps, leaving skippedSteps for real skips', async () => {
    const { interstitial, writes } = await captureOutcomeWrites();

    interstitial.onExit([
      { id: 'brief', outcome: 'confirmed' },
      { id: 'alerts', outcome: 'blocked' },
      { id: 'power', outcome: 'skipped' },
    ]);
    await settle();

    assert.equal(writes.length, 1, 'exit must persist exactly one finalized snapshot');
    const snapshot = writes[0]!;
    assert.deepEqual(snapshot.blockedSteps, ['alerts']);
    assert.deepEqual(
      snapshot.skippedSteps,
      ['power'],
      'a browser refusal must not be counted as a voluntary skip',
    );
    assert.deepEqual(
      snapshot.failedSteps,
      [],
      'we never attempted the write, so nothing failed',
    );
    assert.deepEqual(snapshot.confirmedSteps, ['brief']);
    assert.equal(snapshot.finalized, true);
  });

  // A durable write that fails permanently leaves the account's activation
  // outcome invisible server-side. Before this, the only trace was a
  // console.warn in the user's own browser -- i.e. nobody is told. The retry
  // schedule is real time (250ms + 750ms), so this test is deliberately slow.
  it('reports a permanently failing outcome write to Sentry, not just the console', async () => {
    installPushState('denied', true);
    // Unlike its siblings here, this test reaches the retry branch, which
    // schedules through `window.setTimeout` -- so it needs the DOM installed.
    activeDom = installDom();
    const mod = await loadInterstitial();
    let captured: Parameters<InterstitialModule['openProActivationInterstitial']>[0] | null = null;
    let attempts = 0;
    await mod.openProActivationFlow(
      {
        accountUserId: 'user_alerts',
        accountEmail: 'pro@worldmonitor.test',
        isAccountCurrent: () => true,
        onlyIfUnactivated: true,
        expectedActivationKey: 'sub_activation_key',
        activationClaimNonce: 'device-a',
      },
      {
        readContext: async () => activationContext(),
        recordOutcome: async () => {
          attempts += 1;
          // Mirrors an old Convex deployment rejecting an argument its
          // validator does not yet declare: it fails identically forever.
          throw new Error('ArgumentValidationError: blockedSteps');
        },
        openInterstitial: (interstitialOptions) => {
          captured = interstitialOptions;
        },
      },
    );
    assert.ok(captured, 'flow must open the interstitial');

    captured!.onExit([{ id: 'alerts', outcome: 'blocked' }]);
    await new Promise<void>((r) => setTimeout(r, 1500)); // outlast [250, 750]

    assert.equal(attempts, 3, 'initial attempt plus both scheduled retries');
    const sentry = (globalThis as Record<string, unknown[]>).__alertsSentry!;
    assert.equal(sentry.length, 1, 'a permanent failure must reach Sentry exactly once');
    const { ctx } = sentry[0] as { ctx: { tags: Record<string, string> } };
    assert.deepEqual(ctx.tags, { component: 'pro-activation', action: 'recordOutcome' });
  });

  it('retries a rejected day-0 row open with one identity, then reports one terminal failure', async () => {
    installPushState('denied', true);
    activeDom = installDom();
    const mod = await loadInterstitial();
    let captured: Parameters<InterstitialModule['openProActivationInterstitial']>[0] | null = null;
    const attempts: Array<{
      activationKey: string;
      claimNonce: string;
      sessionStartedAt: number;
    }> = [];
    let outcomeAttempts = 0;

    const opened = await mod.openProActivationFlow(
      {
        accountUserId: 'user_alerts',
        accountEmail: 'pro@worldmonitor.test',
        isAccountCurrent: () => true,
        onlyIfUnactivated: false,
        expectedActivationKey: 'sub_activation_key',
        activationClaimNonce: 'device-a',
        activationSessionStartedAt: 1_725_000_000_000,
      },
      {
        readContext: async () => activationContext(),
        openDay0Presentation: async (activationKey, claimNonce, sessionStartedAt) => {
          attempts.push({ activationKey, claimNonce, sessionStartedAt });
          throw new Error('day-0 row rejected');
        },
        recordOutcome: async () => {
          outcomeAttempts += 1;
          return true;
        },
        openInterstitial: (interstitialOptions) => {
          captured = interstitialOptions;
        },
        operationTimeoutMs: 20,
      },
    );

    assert.equal(opened, 'opened', 'durable telemetry failure must not block onboarding');
    assert.ok(captured, 'the welcome interstitial must still open');
    captured!.onExit([{ id: 'alerts', outcome: 'blocked' }]);
    await new Promise<void>((r) => setTimeout(r, 1_200)); // outlast [250, 750]

    assert.deepEqual(attempts, Array.from({ length: 3 }, () => ({
      activationKey: 'sub_activation_key',
      claimNonce: 'device-a',
      sessionStartedAt: 1_725_000_000_000,
    })));
    assert.equal(outcomeAttempts, 0, 'snapshots must be dropped when no row was opened');
    const sentry = (globalThis as Record<string, unknown[]>).__alertsSentry!;
    assert.equal(sentry.length, 1, 'only exhausted rejection must reach Sentry');
    const { ctx } = sentry[0] as { ctx: { tags: Record<string, string> } };
    assert.deepEqual(ctx.tags, {
      component: 'pro-activation',
      action: 'openDay0Presentation',
    });
  });

  it('flushes queued snapshots after a slow open without reporting the observation timeout', async () => {
    installPushState('denied', true);
    activeDom = installDom();
    const mod = await loadInterstitial();
    let captured: Parameters<InterstitialModule['openProActivationInterstitial']>[0] | null = null;
    const writes: Snapshot[] = [];

    const opened = await mod.openProActivationFlow(
      {
        accountUserId: 'user_alerts',
        accountEmail: 'pro@worldmonitor.test',
        isAccountCurrent: () => true,
        onlyIfUnactivated: false,
        expectedActivationKey: 'sub_activation_key',
        activationClaimNonce: 'device-a',
        activationSessionStartedAt: 1_725_000_000_000,
      },
      {
        readContext: async () => activationContext(),
        openDay0Presentation: async () => {
          await new Promise<void>((r) => setTimeout(r, 40));
          return 'opened';
        },
        recordOutcome: async (_key, _nonce, snapshot) => {
          writes.push(snapshot as Snapshot);
          return true;
        },
        openInterstitial: (interstitialOptions) => {
          captured = interstitialOptions;
        },
        operationTimeoutMs: 10,
      },
    );

    assert.equal(opened, 'opened');
    assert.ok(captured, 'the welcome interstitial must open before persistence settles');
    captured!.onProgress?.([{ id: 'brief', outcome: 'confirmed' }]);
    captured!.onExit([{ id: 'brief', outcome: 'confirmed' }]);
    await new Promise<void>((r) => setTimeout(r, 100));

    assert.deepEqual(writes.map(({ revision, finalized }) => ({ revision, finalized })), [
      { revision: 1, finalized: false },
      { revision: 2, finalized: true },
    ]);
    assert.deepEqual(
      (globalThis as Record<string, unknown[]>).__alertsSentry,
      [],
      'a non-cancelling observation timeout is not a terminal failure',
    );
  });

  it('does not retry terminal day-0 refusal statuses', async () => {
    installPushState('denied', true);
    activeDom = installDom();
    const mod = await loadInterstitial();

    for (const status of ['already_recorded', 'not_eligible', 'superseded'] as const) {
      let captured: Parameters<InterstitialModule['openProActivationInterstitial']>[0] | null = null;
      let attempts = 0;
      let outcomeAttempts = 0;
      const opened = await mod.openProActivationFlow(
        {
          accountUserId: 'user_alerts',
          accountEmail: 'pro@worldmonitor.test',
          isAccountCurrent: () => true,
          onlyIfUnactivated: false,
          expectedActivationKey: 'sub_activation_key',
          activationClaimNonce: `device-${status}`,
          activationSessionStartedAt: 1_725_000_000_000,
        },
        {
          readContext: async () => activationContext(),
          openDay0Presentation: async () => {
            attempts += 1;
            return status;
          },
          recordOutcome: async () => {
            outcomeAttempts += 1;
            return true;
          },
          openInterstitial: (interstitialOptions) => {
            captured = interstitialOptions;
          },
          operationTimeoutMs: 10,
        },
      );
      assert.equal(opened, 'opened');
      assert.ok(captured);
      captured!.onExit([{ id: 'brief', outcome: 'skipped' }]);
      await settle();
      assert.equal(attempts, 1, `${status} must be a terminal refusal`);
      assert.equal(outcomeAttempts, 0, `${status} owns no writable row`);
    }

    assert.deepEqual((globalThis as Record<string, unknown[]>).__alertsSentry, []);
  });

  it('leaves a hung day-0 open pending without blocking or false terminal telemetry', async () => {
    installPushState('denied', true);
    activeDom = installDom();
    const mod = await loadInterstitial();
    let captured: Parameters<InterstitialModule['openProActivationInterstitial']>[0] | null = null;
    let attempts = 0;
    let outcomeAttempts = 0;

    const opened = await mod.openProActivationFlow(
      {
        accountUserId: 'user_alerts',
        accountEmail: 'pro@worldmonitor.test',
        isAccountCurrent: () => true,
        onlyIfUnactivated: false,
        expectedActivationKey: 'sub_activation_key',
        activationClaimNonce: 'device-a',
        activationSessionStartedAt: 1_725_000_000_000,
      },
      {
        readContext: async () => activationContext(),
        openDay0Presentation: async () => {
          attempts += 1;
          return await new Promise<never>(() => {});
        },
        recordOutcome: async () => {
          outcomeAttempts += 1;
          return true;
        },
        openInterstitial: (interstitialOptions) => {
          captured = interstitialOptions;
        },
        operationTimeoutMs: 10,
      },
    );
    assert.equal(opened, 'opened');
    assert.ok(captured, 'the welcome UI must open without awaiting the ledger');
    captured!.onExit([{ id: 'brief', outcome: 'skipped' }]);
    await new Promise<void>((r) => setTimeout(r, 30));

    assert.equal(attempts, 1, 'a pending request is not duplicated');
    assert.equal(outcomeAttempts, 0, 'snapshots remain queued behind readiness');
    assert.deepEqual((globalThis as Record<string, unknown[]>).__alertsSentry, []);
  });

  it('stops retrying when the activation account is no longer current', async () => {
    installPushState('denied', true);
    activeDom = installDom();
    const mod = await loadInterstitial();
    let accountChecks = 0;
    let attempts = 0;

    const opened = await mod.openProActivationFlow(
      {
        accountUserId: 'user_alerts',
        accountEmail: 'pro@worldmonitor.test',
        isAccountCurrent: () => {
          accountChecks += 1;
          return accountChecks < 4;
        },
        onlyIfUnactivated: false,
        expectedActivationKey: 'sub_activation_key',
        activationClaimNonce: 'device-a',
        activationSessionStartedAt: 1_725_000_000_000,
      },
      {
        readContext: async () => activationContext(),
        openDay0Presentation: async () => {
          attempts += 1;
          throw new Error('day-0 row rejected after account switch');
        },
        openInterstitial: () => {},
        operationTimeoutMs: 10,
      },
    );
    // Outlast the first retry delay: if the ownership check did not stop the
    // loop, a second mutation would have fired by now.
    await new Promise<void>((r) => setTimeout(r, 350));

    assert.equal(opened, 'opened');
    assert.equal(accountChecks, 4, 'ownership is rechecked immediately after rejection');
    assert.equal(attempts, 1);
    assert.deepEqual(
      (globalThis as Record<string, unknown[]>).__alertsSentry,
      [],
      'an obsolete account must not create terminal persistence telemetry',
    );
  });

  it('sends an explicit empty blockedSteps when nothing was blocked', async () => {
    const { interstitial, writes } = await captureOutcomeWrites();

    interstitial.onProgress?.([{ id: 'brief', outcome: 'confirmed' }]);
    await settle();

    assert.equal(writes.length, 1);
    // Present-and-empty, never omitted: a progress snapshot is a full
    // replacement, so a missing bucket would leave a stale one behind.
    assert.deepEqual(writes[0]!.blockedSteps, []);
    assert.equal(writes[0]!.finalized, false);
  });
});
