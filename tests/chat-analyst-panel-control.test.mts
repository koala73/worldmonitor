import assert from 'node:assert/strict';
import { after, afterEach, describe, it } from 'node:test';

import { createChatAnalystPanelHarness } from './helpers/chat-analyst-panel-harness.mjs';

const harness = await createChatAnalystPanelHarness();

after(() => {
  harness.cleanup();
});

afterEach(() => {
  const globals = globalThis as typeof globalThis & {
    __wmAppliedAnalystActions?: unknown[];
    __wmAnalystControlTelemetry?: unknown[];
  };
  globals.__wmAppliedAnalystActions = [];
  globals.__wmAnalystControlTelemetry = [];
  globalThis.localStorage?.clear?.();
});

function sseReader(events: unknown[]): ReadableStreamDefaultReader<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n`));
      }
      controller.close();
    },
  }).getReader();
}

async function feedAction(panel: unknown, action: unknown): Promise<HTMLElement> {
  const panelAny = panel as {
    appendStreamingBubble: () => { bubble: HTMLElement; body: HTMLElement };
    readStream: (
      reader: ReadableStreamDefaultReader<Uint8Array>,
      bubble: HTMLElement,
      body: HTMLElement,
      onToken: (text: string) => void,
    ) => Promise<string>;
  };
  const { bubble, body } = panelAny.appendStreamingBubble();
  const status = await panelAny.readStream(
    sseReader([{ action }, { delta: 'Answer continues.' }, { done: true }]),
    bubble,
    body,
    () => {},
  );
  assert.equal(status, 'done');
  assert.ok(body.textContent?.includes('Answer continues.'), 'text stream should continue after action');
  return bubble;
}

describe('ChatAnalystPanel — dashboard control actions', () => {
  it('renders the opt-in and pause control state', () => {
    const panel = harness.createPanel();
    const root = panel.getElement();

    assert.ok(root.querySelector('.chat-analyst-control-bar'), 'control bar present');
    assert.equal(root.querySelector('.chat-control-status')?.textContent, 'Off');

    (panel as never as { setDashboardControlEnabled: (enabled: boolean) => void }).setDashboardControlEnabled(true);
    assert.equal(globalThis.localStorage?.getItem('wm-analyst-dashboard-control-enabled'), 'true');
    assert.equal(root.querySelector('.chat-control-status')?.textContent, 'Active');

    (panel as never as { toggleDashboardControlPause: () => void }).toggleDashboardControlPause();
    assert.equal(root.querySelector('.chat-control-status')?.textContent, 'Paused');
    assert.equal(root.querySelector('.chat-control-pause')?.textContent, 'Resume');
  });

  it('does not apply streamed actions while dashboard control is off', async () => {
    const globals = globalThis as typeof globalThis & {
      __wmAppliedAnalystActions?: unknown[];
      __wmAnalystControlTelemetry?: unknown[];
    };
    globals.__wmAppliedAnalystActions = [];
    globals.__wmAnalystControlTelemetry = [];

    const panel = harness.createPanel();
    panel.setDashboardActionHandler((action: { type: string }) => {
      globals.__wmAppliedAnalystActions?.push({ action });
      return {
        ok: true,
        status: 'applied',
        actionType: action.type,
        label: 'Applied',
        message: 'applied by test handler',
        targets: [{ target: action.type, status: 'applied' }],
      };
    });
    const bubble = await feedAction(panel, {
      type: 'open_panel',
      label: 'Open Forecasts',
      panelId: 'forecast',
    });

    assert.equal(globals.__wmAppliedAnalystActions.length, 0);
    assert.deepEqual(globals.__wmAnalystControlTelemetry, [
      { actionType: 'open_panel', status: 'skipped', reason: 'control_disabled' },
    ]);
    assert.ok(bubble.querySelector('.chat-action-chip--skipped'), 'skipped chip rendered');
  });

  it('applies actions only while enabled and unpaused while tracking all outcomes', async () => {
    const globals = globalThis as typeof globalThis & {
      __wmAppliedAnalystActions?: Array<{ action: { type: string } }>;
      __wmAnalystControlTelemetry?: Array<{ actionType: string; status: string; reason?: string }>;
    };
    globals.__wmAppliedAnalystActions = [];
    globals.__wmAnalystControlTelemetry = [];

    const panel = harness.createPanel();
    panel.setDashboardActionHandler((action: { type: string }) => {
      globals.__wmAppliedAnalystActions?.push({ action });
      return {
        ok: true,
        status: 'applied',
        actionType: action.type,
        label: 'Applied',
        message: 'applied by test handler',
        targets: [{ target: action.type, status: 'applied' }],
      };
    });
    (panel as never as { setDashboardControlEnabled: (enabled: boolean) => void }).setDashboardControlEnabled(true);

    const appliedBubble = await feedAction(panel, {
      type: 'open_panel',
      label: 'Open Forecasts',
      panelId: 'forecast',
    });

    assert.equal(globals.__wmAppliedAnalystActions.length, 1);
    assert.equal(globals.__wmAppliedAnalystActions[0]?.action.type, 'open_panel');
    assert.deepEqual(globals.__wmAnalystControlTelemetry, [
      { actionType: 'open_panel', status: 'applied' },
    ]);
    assert.ok(appliedBubble.querySelector('.chat-action-chip--applied'), 'applied chip rendered');

    (panel as never as { toggleDashboardControlPause: () => void }).toggleDashboardControlPause();
    const pausedBubble = await feedAction(panel, {
      type: 'set_view',
      label: 'Show MENA',
      view: 'mena',
    });

    assert.equal(globals.__wmAppliedAnalystActions.length, 1, 'paused action must not call applier');
    assert.deepEqual(globals.__wmAnalystControlTelemetry, [
      { actionType: 'open_panel', status: 'applied' },
      { actionType: 'set_view', status: 'skipped', reason: 'control_paused' },
    ]);
    assert.ok(pausedBubble.querySelector('.chat-action-chip--skipped'), 'paused chip rendered');
  });

  it('tracks denied handler results with reason context', async () => {
    const globals = globalThis as typeof globalThis & {
      __wmAnalystControlTelemetry?: Array<{ actionType: string; status: string; reason?: string }>;
    };
    globals.__wmAnalystControlTelemetry = [];

    const panel = harness.createPanel();
    panel.setDashboardActionHandler((action: { type: string }) => ({
      ok: false,
      status: 'denied',
      actionType: action.type,
      label: 'Denied',
      reason: 'panel_not_entitled',
      message: 'denied by test handler',
      targets: [{ target: action.type, status: 'denied', reason: 'panel_not_entitled' }],
    }));
    (panel as never as { setDashboardControlEnabled: (enabled: boolean) => void }).setDashboardControlEnabled(true);

    const bubble = await feedAction(panel, {
      type: 'open_panel',
      label: 'Open Forecasts',
      panelId: 'forecast',
    });

    assert.deepEqual(globals.__wmAnalystControlTelemetry, [
      { actionType: 'open_panel', status: 'denied', reason: 'panel_not_entitled' },
    ]);
    assert.ok(bubble.querySelector('.chat-action-chip--denied'), 'denied chip rendered');
  });
});
