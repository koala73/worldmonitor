// Pure-logic unit tests for the voice-lifecycle size guards (Batch 11, M13).
// These helpers are DOM/WebRTC-free so they pin the screenshot down-scaling and
// payload-byte estimation that keep an oversized dc.send from stranding a turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DataLayerManager } from '../data/manager.js';
import { controlRadio, createGevActionRunner } from './gevActions.js';
import {
  computeDownscale,
  renderFreshCesiumFrame,
  estimateDataUrlBytes,
  GevRealtimeController,
  gateVoiceVisualizerLevel,
  isBenignViewportDeleteError,
  isPushToTalkKey,
  resolveVoiceControlHint,
  resolveVoiceVisualizerSpeaker,
  selectVoiceVisualizerSignal,
  silenceRadioForVoice,
  startPreparedRadioAfterPlaybackReady,
  shouldPauseRadioForVoice,
  shouldHandlePushToTalkKeyDown,
  shouldIgnoreVoiceButtonClick,
  shouldStopVoiceAfterRadioTool,
  readStoredVoiceTier,
  readStoredVoiceLimits,
  writeStoredVoiceTier,
  writeStoredVoiceLimits,
} from './gevRealtime.js';
import { createVoiceCostTracker } from './voiceCost.js';

test('push-to-talk recognizes Space by code or key', () => {
  assert.equal(isPushToTalkKey({ code: 'Space', key: 'Unidentified' }), true);
  assert.equal(isPushToTalkKey({ code: '', key: ' ' }), true);
  assert.equal(isPushToTalkKey({ code: 'KeyM', key: 'm' }), false);
});

test('push-to-talk ignores typing targets and modified shortcuts', () => {
  const plainTarget = { isContentEditable: false, closest: () => null };
  assert.equal(shouldHandlePushToTalkKeyDown({ code: 'Space', target: plainTarget }), true);
  assert.equal(shouldHandlePushToTalkKeyDown({ code: 'Space', target: plainTarget, metaKey: true }), false);
  assert.equal(shouldHandlePushToTalkKeyDown({
    code: 'Space',
    target: { isContentEditable: false, closest: () => ({ tagName: 'INPUT' }) },
  }), false);
  assert.equal(shouldHandlePushToTalkKeyDown({
    code: 'Space',
    target: { isContentEditable: true, closest: () => null },
  }), false);
});

test('mic clicks are ignored while Space is physically held', () => {
  assert.equal(shouldIgnoreVoiceButtonClick(true), true);
  assert.equal(shouldIgnoreVoiceButtonClick(false), false);
});

test('voice control help tray reflects the push-to-talk key state', () => {
  assert.equal(
    resolveVoiceControlHint(false, false),
    'Hold Space to speak · click mic to toggle voice',
  );
  assert.equal(resolveVoiceControlHint(true, true), 'Release Space to send');
  assert.equal(
    resolveVoiceControlHint(true, false),
    'Hold Space to speak · click mic to toggle voice',
  );
});

test('voice visualizer reads assistant output while the assistant is speaking', () => {
  const input = { analyser: { id: 'mic' }, data: new Uint8Array([1]) };
  const output = { analyser: { id: 'speaker' }, data: new Uint8Array([2]) };
  assert.equal(selectVoiceVisualizerSignal('user', input, output), input);
  assert.equal(selectVoiceVisualizerSignal('ai', input, output), output);
  assert.equal(selectVoiceVisualizerSignal('ai', input, { analyser: null, data: null }), null);
});

test('voice visualizer keeps assistant audio selected after response.done', () => {
  assert.equal(resolveVoiceVisualizerSpeaker('ai', 'idle', true), 'ai');
  assert.equal(resolveVoiceVisualizerSpeaker('ai', 'user', false), 'user');
  assert.equal(resolveVoiceVisualizerSpeaker('user', 'idle', true), 'idle');
});

test('voice visualizer noise gate holds room tone at the baseline', () => {
  assert.equal(gateVoiceVisualizerLevel(0.12, 0.12), 0);
  assert.equal(gateVoiceVisualizerLevel(0.06, 0.12), 0);
  assert.ok(gateVoiceVisualizerLevel(0.5, 0.12) > 0);
  assert.equal(gateVoiceVisualizerLevel(1, 0.12), 1);
  assert.equal(gateVoiceVisualizerLevel(NaN, 0.12), 0);
});

test('voice activation, speech, and push-to-talk pause Radio without an idle auto-resume', () => {
  assert.equal(shouldPauseRadioForVoice({ status: 'connecting' }), true);
  assert.equal(shouldPauseRadioForVoice({ status: 'executing' }), true);
  assert.equal(shouldPauseRadioForVoice({ status: 'listening', speaker: 'user' }), true);
  assert.equal(shouldPauseRadioForVoice({ status: 'listening', speaker: 'ai' }), true);
  assert.equal(shouldPauseRadioForVoice({ status: 'listening', pushToTalkKeyHeld: true }), true);
  assert.equal(shouldPauseRadioForVoice({ status: 'listening' }), false);
  assert.equal(shouldPauseRadioForVoice({ status: 'idle' }), false);
  assert.equal(shouldPauseRadioForVoice({ status: 'error' }), false);
});

test('successful Radio activation tools close voice after handing control to Radio', () => {
  for (const radioAction of ['play', 'resume', 'select', 'next', 'previous']) {
    assert.equal(shouldStopVoiceAfterRadioTool({ ok: true, action: 'control_radio', radioAction }), true);
  }
  assert.equal(shouldStopVoiceAfterRadioTool({ ok: true, action: 'control_radio', radioAction: 'enable' }), false);
  assert.equal(shouldStopVoiceAfterRadioTool({ ok: true, action: 'control_radio', radioAction: 'volume' }), false);
  assert.equal(shouldStopVoiceAfterRadioTool({ ok: false, action: 'control_radio', radioAction: 'play' }), false);
  assert.equal(shouldStopVoiceAfterRadioTool({ ok: true, action: 'control_cctv', radioAction: 'play' }), false);
});

test('prepared Radio playback is verified under mute before voice closes', async () => {
  const order = [];
  const handoff = await startPreparedRadioAfterPlaybackReady({
    ok: true,
    action: 'control_radio',
    radioAction: 'select',
    radioPlaybackRequested: true,
  }, {
    prepareRadio: async () => {
      order.push('radio-play-muted');
      return true;
    },
    stopVoice: () => order.push('voice-stop'),
  });
  assert.deepEqual(order, ['radio-play-muted', 'voice-stop']);
  assert.equal(handoff.handled, true);
  assert.equal(handoff.result.ok, true);
  assert.equal(handoff.result.audioState, 'playing');
});

test('failed or superseded Radio preflight keeps voice open and cancels audio', async () => {
  for (const scenario of [
    { started: false, current: true, cancelled: false },
    { started: true, current: false, cancelled: true },
  ]) {
    const order = [];
    const handoff = await startPreparedRadioAfterPlaybackReady({
      ok: true,
      action: 'control_radio',
      radioPlaybackRequested: true,
    }, {
      prepareRadio: async () => scenario.started,
      isCurrent: () => scenario.current,
      cancelRadio: () => order.push('radio-cancel'),
      stopVoice: () => order.push('voice-stop'),
    });
    assert.deepEqual(order, ['radio-cancel']);
    assert.equal(handoff.result.ok, false);
    assert.equal(Boolean(handoff.cancelled), scenario.cancelled);
  }
});

test('replacement input invalidates an in-flight Radio preflight immediately', () => {
  const order = [];
  const controller = new GevRealtimeController({
    ui: {},
    runner: async () => ({}),
    radioLayer: { stopPlayback: () => order.push('radio-stop') },
  });
  controller.pendingRadioPlaybackResult = { ok: true };
  controller.radioHandoffInFlight = true;
  const priorEpoch = controller.radioHandoffEpoch;
  controller.cancelRadioHandoff();
  assert.deepEqual(order, ['radio-stop']);
  assert.equal(controller.pendingRadioPlaybackResult, null);
  assert.equal(controller.radioHandoffInFlight, false);
  assert.equal(controller.radioHandoffEpoch, priorEpoch + 1);
});

test('direct Radio pause or stop cancels a pending voice handoff', async () => {
  const order = [];
  let playbackControl = null;
  const ui = {
    root: { dataset: {}, classList: { remove() {} }, querySelectorAll: () => [] },
    status: { textContent: '' },
    detail: { textContent: '', title: '' },
    errorDetail: { textContent: '' },
  };
  const controller = new GevRealtimeController({
    ui,
    runner: async () => ({ ok: true }),
    radioLayer: {
      subscribePlaybackControls(listener) {
        playbackControl = listener;
        return () => { playbackControl = null; };
      },
      playForVoice: async () => {
        order.push('radio-play');
        return true;
      },
      stopPlayback: () => order.push('radio-stop'),
    },
  });
  controller.debugLog = () => {};
  controller.dc = {
    readyState: 'open',
    send() {},
    close() { order.push('voice-stop'); },
  };
  controller.pendingRadioPlaybackResult = { ok: true, radioPlaybackRequested: true };

  playbackControl('stop');
  await controller.handleRealtimeEvent({
    data: JSON.stringify({ type: 'response.done', response: { status: 'completed' } }),
  });

  assert.equal(controller.pendingRadioPlaybackResult, null);
  assert.deepEqual(order, [], 'the explicit stop remains authoritative');
});

test('confirmed manual Radio playback closes active voice without stopping Radio', () => {
  const order = [];
  let playbackControl = null;
  const ui = {
    root: { dataset: {}, classList: { remove() {} }, querySelectorAll: () => [] },
    status: { textContent: '' },
    detail: { textContent: '', title: '' },
    errorDetail: { textContent: '' },
  };
  const controller = new GevRealtimeController({
    ui,
    runner: async () => ({ ok: true }),
    radioLayer: {
      subscribePlaybackControls(listener) {
        playbackControl = listener;
        return () => { playbackControl = null; };
      },
      setVoiceDucked(ducked) { order.push(ducked ? 'radio-muted' : 'radio-fade-in'); },
      stopPlayback() { order.push('radio-stop'); },
    },
  });
  controller.debugLog = () => {};
  controller.status = 'listening';
  controller.radioVoiceDucked = true;
  controller.dc = {
    readyState: 'open',
    close() { order.push('voice-stop'); },
  };

  playbackControl('play');

  assert.deepEqual(order, ['voice-stop', 'radio-fade-in']);
  assert.equal(controller.status, 'idle');
  assert.equal(controller.dc, null);
});

test('manual playback takeover survives stale voice preflight cleanup', async () => {
  let playbackControl = null;
  let resolvePreflight;
  let activeAttemptId = null;
  const stopRequests = [];
  const ui = {
    root: { dataset: {}, classList: { remove() {} }, querySelectorAll: () => [] },
    status: { textContent: '' },
    detail: { textContent: '', title: '' },
    errorDetail: { textContent: '' },
  };
  const radioLayer = {
    subscribePlaybackControls(listener) {
      playbackControl = listener;
      return () => { playbackControl = null; };
    },
    setVoiceDucked() {},
    async playForVoice({ attemptId }) {
      activeAttemptId = attemptId;
      return new Promise((resolve) => { resolvePreflight = resolve; });
    },
    stopPlayback({ attemptId, origin }) {
      const owned = activeAttemptId === attemptId;
      stopRequests.push({ attemptId, origin, owned });
      if (owned) activeAttemptId = null;
      return owned;
    },
  };
  const controller = new GevRealtimeController({
    ui,
    runner: async () => ({ ok: true }),
    radioLayer,
  });
  controller.debugLog = () => {};
  controller.status = 'listening';
  controller.dc = { readyState: 'open', send() {}, close() {} };
  controller.pendingRadioPlaybackResult = { ok: true, radioPlaybackRequested: true };

  const pending = controller.handleRealtimeEvent({
    data: JSON.stringify({ type: 'response.done', response: { status: 'completed' } }),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const voiceAttemptId = activeAttemptId;
  assert.match(voiceAttemptId, /^voice-radio-/);

  activeAttemptId = 'manual-attempt';
  playbackControl({ action: 'play', origin: 'user', attemptId: activeAttemptId });
  resolvePreflight(true);
  await pending;

  assert.equal(activeAttemptId, 'manual-attempt');
  assert.deepEqual(stopRequests, [{
    attemptId: voiceAttemptId,
    origin: 'voice-cleanup',
    owned: false,
  }]);
  assert.equal(controller.status, 'idle');
});

test('internal Radio cleanup controls do not masquerade as newer user input', () => {
  let playbackControl = null;
  const controller = new GevRealtimeController({
    ui: {},
    runner: async () => ({}),
    radioLayer: {
      subscribePlaybackControls(listener) {
        playbackControl = listener;
        return () => {};
      },
      stopPlayback() {},
    },
  });
  controller.pendingRadioPlaybackResult = { ok: true };
  controller.radioHandoffInFlight = true;
  controller.radioHandoffAttemptId = 'voice-attempt';

  playbackControl({ action: 'stop', origin: 'voice-cleanup', attemptId: 'voice-attempt' });

  assert.ok(controller.pendingRadioPlaybackResult);
  assert.equal(controller.radioHandoffInFlight, true);
  assert.equal(controller.radioHandoffAttemptId, 'voice-attempt');
});

test('manual Radio playback does not close voice when voice is already idle', () => {
  let playbackControl = null;
  let voiceStops = 0;
  const controller = new GevRealtimeController({
    ui: {},
    runner: async () => ({}),
    radioLayer: {
      subscribePlaybackControls(listener) {
        playbackControl = listener;
        return () => { playbackControl = null; };
      },
    },
  });
  controller.dc = { readyState: 'open', close() { voiceStops += 1; } };

  playbackControl('play');

  assert.equal(voiceStops, 0);
  assert.equal(controller.dc?.readyState, 'open');
});

test('active-response Realtime errors invalidate pending and in-flight Radio handoffs', async () => {
  const order = [];
  let playbackControl = null;
  const ui = {
    root: { dataset: {}, classList: { remove() {} }, querySelectorAll: () => [] },
    status: { textContent: '' },
    detail: { textContent: '', title: '' },
    errorDetail: { textContent: '' },
  };
  const controller = new GevRealtimeController({
    ui,
    runner: async () => ({ ok: true }),
    radioLayer: {
      subscribePlaybackControls(listener) {
        playbackControl = listener;
        return () => { playbackControl = null; };
      },
      stopPlayback() {
        order.push('radio-stop');
        playbackControl?.('stop');
      },
    },
  });
  controller.debugLog = () => {};
  controller.dc = { readyState: 'open', send() {}, close() { order.push('voice-stop'); } };
  controller.pendingRadioPlaybackResult = { ok: true, radioPlaybackRequested: true };
  controller.radioHandoffInFlight = true;

  await controller.handleRealtimeEvent({
    data: JSON.stringify({
      type: 'error',
      error: { code: 'conversation_already_has_active_response', message: 'response active' },
    }),
  });

  assert.equal(controller.pendingRadioPlaybackResult, null);
  assert.equal(controller.radioHandoffInFlight, false);
  assert.deepEqual(order, ['radio-stop']);
});

test('voice ownership ducks tuner static before pausing broadcaster audio', () => {
  const order = [];
  const paused = silenceRadioForVoice({
    duckRadio: () => order.push('duck-static'),
    pauseRadio: () => {
      order.push('pause-stream');
      return false;
    },
  });
  assert.deepEqual(order, ['duck-static', 'pause-stream']);
  assert.equal(paused, false, 'a stopped stream can remain stopped while static is still silenced');
});

test('Radio handoff waits for response.done so later multi-intent tools execute before voice closes', async () => {
  const order = [];
  const confirmationInstructions = [];
  const ui = {
    root: {
      dataset: {},
      classList: { remove() {} },
      querySelectorAll: () => [],
    },
    status: { textContent: '' },
    detail: { textContent: '', title: '' },
    errorDetail: { textContent: '' },
  };
  const runner = async (name) => {
    order.push(`tool:${name}`);
    if (name === 'control_radio') {
      return {
        ok: true,
        action: 'control_radio',
        radioAction: 'select',
        radioPlaybackRequested: true,
      };
    }
    return { ok: true, action: name };
  };
  const radioLayer = {
    setVoiceDucked() {},
    pause: () => false,
    playForVoice: async () => {
      order.push('radio-play');
      return true;
    },
    stopPlayback() { order.push('radio-stop'); },
  };
  const controller = new GevRealtimeController({ runner, ui, radioLayer });
  controller.debugLog = () => {};
  controller.sendVisualContextIfUseful = async () => false;
  controller.dc = {
    readyState: 'open',
    send(message) {
      const payload = JSON.parse(message);
      if (payload.type === 'response.create') {
        order.push('assistant-confirmation-requested');
        confirmationInstructions.push(payload.response?.instructions || '');
      }
    },
    close() { order.push('voice-stop'); },
  };
  const event = (payload) => ({ data: JSON.stringify(payload) });

  await controller.handleRealtimeEvent(event({ type: 'response.created', response: { id: 'response-1' } }));
  await controller.handleRealtimeEvent(event({
    type: 'response.function_call_arguments.done',
    response_id: 'response-1',
    call_id: 'radio-call',
    name: 'control_radio',
    arguments: '{"action":"select"}',
  }));
  assert.deepEqual(order, ['tool:control_radio'], 'prepared playback keeps the response channel open');

  await controller.handleRealtimeEvent(event({
    type: 'response.function_call_arguments.done',
    response_id: 'response-1',
    call_id: 'style-call',
    name: 'set_visual_style',
    arguments: '{"style":"night-vision"}',
  }));
  assert.deepEqual(order, ['tool:control_radio', 'tool:set_visual_style']);

  await controller.handleRealtimeEvent(event({
    type: 'response.done',
    response: { id: 'response-1', status: 'completed' },
  }));
  assert.deepEqual(order, [
    'tool:control_radio',
    'tool:set_visual_style',
    'assistant-confirmation-requested',
  ]);
  assert.match(confirmationInstructions[0], /Turning on the radio/);

  await controller.handleRealtimeEvent(event({ type: 'response.created', response: { id: 'response-confirm' } }));
  await controller.handleRealtimeEvent(event({
    type: 'response.done',
    response: { id: 'response-confirm', status: 'completed' },
  }));
  assert.deepEqual(order, [
    'tool:control_radio',
    'tool:set_visual_style',
    'assistant-confirmation-requested',
    'radio-play',
    'voice-stop',
  ]);
});

test('Radio playback failure leaves voice connected and speaks a correction', async () => {
  const sent = [];
  const order = [];
  const ui = {
    root: { dataset: {}, classList: { remove() {} }, querySelectorAll: () => [] },
    status: { textContent: '' },
    detail: { textContent: '', title: '' },
    errorDetail: { textContent: '' },
  };
  const controller = new GevRealtimeController({
    ui,
    runner: async () => ({
      ok: true,
      action: 'control_radio',
      radioAction: 'play',
      radioPlaybackRequested: true,
    }),
    radioLayer: {
      setVoiceDucked() {},
      pause: () => false,
      playForVoice: async () => false,
      stopPlayback: () => order.push('radio-stop'),
    },
  });
  controller.debugLog = () => {};
  controller.sendVisualContextIfUseful = async () => false;
  controller.dc = {
    readyState: 'open',
    send(message) { sent.push(JSON.parse(message)); },
    close() { order.push('voice-stop'); },
  };
  const event = (payload) => ({ data: JSON.stringify(payload) });

  await controller.handleRealtimeEvent(event({ type: 'response.created', response: { id: 'response-fail' } }));
  await controller.handleRealtimeEvent(event({
    type: 'response.function_call_arguments.done',
    response_id: 'response-fail',
    call_id: 'radio-fail',
    name: 'control_radio',
    arguments: '{"action":"play"}',
  }));
  await controller.handleRealtimeEvent(event({
    type: 'response.done',
    response: { id: 'response-fail', status: 'completed' },
  }));
  await controller.handleRealtimeEvent(event({ type: 'response.created', response: { id: 'response-fail-confirm' } }));
  await controller.handleRealtimeEvent(event({
    type: 'response.done',
    response: { id: 'response-fail-confirm', status: 'completed' },
  }));

  assert.deepEqual(order, ['radio-stop']);
  assert.equal(controller.dc?.readyState, 'open');
  assert.ok(sent.some((message) => (
    message.type === 'response.create'
    && message.response?.instructions?.includes('Voice is still on')
  )));
});

test('detected speech cancels a prepared Radio handoff before a cancelled response completes', async () => {
  const order = [];
  const ui = {
    root: {
      dataset: {},
      classList: { remove() {} },
      querySelectorAll: () => [],
    },
    status: { textContent: '' },
    detail: { textContent: '', title: '' },
    errorDetail: { textContent: '' },
  };
  const controller = new GevRealtimeController({
    ui,
    runner: async () => ({
      ok: true,
      action: 'control_radio',
      radioAction: 'select',
      radioPlaybackRequested: true,
    }),
    radioLayer: {
      setVoiceDucked() {},
      pause: () => false,
      playForVoice: async () => {
        order.push('radio-play');
        return true;
      },
      stopPlayback: () => order.push('radio-stop'),
    },
  });
  controller.debugLog = () => {};
  controller.sendVisualContextIfUseful = async () => false;
  controller.dc = {
    readyState: 'open',
    send() {},
    close() { order.push('voice-stop'); },
  };
  const event = (payload) => ({ data: JSON.stringify(payload) });

  await controller.handleRealtimeEvent(event({ type: 'response.created', response: { id: 'response-2' } }));
  await controller.handleRealtimeEvent(event({
    type: 'response.function_call_arguments.done',
    response_id: 'response-2',
    call_id: 'radio-call-2',
    name: 'control_radio',
    arguments: '{"action":"select"}',
  }));
  assert.ok(controller.pendingRadioPlaybackResult);

  await controller.handleRealtimeEvent(event({
    type: 'response.done',
    response: { id: 'response-2', status: 'completed' },
  }));
  await controller.handleRealtimeEvent(event({ type: 'response.created', response: { id: 'response-2-confirm' } }));

  await controller.handleRealtimeEvent(event({ type: 'input_audio_buffer.speech_started' }));
  assert.equal(controller.pendingRadioPlaybackResult, null);
  await controller.handleRealtimeEvent(event({
    type: 'response.done',
    response: { id: 'response-2-confirm', status: 'cancelled' },
  }));

  assert.deepEqual(order, [], 'the new user turn keeps voice open and Radio silent');
  assert.equal(controller.dc?.readyState, 'open');
});

test('a Radio tool result that resolves after speech interruption cannot re-arm playback', async () => {
  let resolveRunner;
  const runnerResult = new Promise((resolve) => { resolveRunner = resolve; });
  let receivedSignal = null;
  const ui = {
    root: { dataset: {}, classList: { remove() {} }, querySelectorAll: () => [] },
    status: { textContent: '' },
    detail: { textContent: '', title: '' },
    errorDetail: { textContent: '' },
  };
  const controller = new GevRealtimeController({
    ui,
    runner: async (_name, _args, options) => {
      receivedSignal = options.signal;
      return runnerResult;
    },
    radioLayer: {
      setVoiceDucked() {},
      pause: () => false,
      stopPlayback() {},
    },
  });
  controller.debugLog = () => {};
  controller.sendVisualContextIfUseful = async () => false;
  const sent = [];
  controller.dc = {
    readyState: 'open',
    send(message) { sent.push(JSON.parse(message)); },
    close() {},
  };
  const event = (payload) => ({ data: JSON.stringify(payload) });

  const pendingTool = controller.handleRealtimeEvent(event({
    type: 'response.function_call_arguments.done',
    response_id: 'response-stale-radio',
    call_id: 'radio-stale-call',
    name: 'control_radio',
    arguments: '{"action":"select"}',
  }));
  await Promise.resolve();
  assert.equal(receivedSignal?.aborted, false);
  await controller.handleRealtimeEvent(event({ type: 'input_audio_buffer.speech_started' }));
  assert.equal(receivedSignal.aborted, true, 'barge-in aborts the underlying tool work');
  resolveRunner({
    ok: true,
    action: 'control_radio',
    radioAction: 'select',
    radioPlaybackRequested: true,
  });
  await pendingTool;

  assert.equal(controller.pendingRadioPlaybackResult, null);
  const output = sent.find((message) => message.type === 'conversation.item.create');
  const result = JSON.parse(output.item.output);
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.equal(result.radioPlaybackRequested, false);
  assert.equal(sent.some((message) => message.type === 'response.create'), false);
});

test('sibling tool calls in one response do not abort an in-flight Radio action', async () => {
  let resolveRadio;
  let radioSignal = null;
  const radioResult = new Promise((resolve) => { resolveRadio = resolve; });
  const ui = {
    root: { dataset: {}, classList: { remove() {} }, querySelectorAll: () => [] },
    status: { textContent: '' },
    detail: { textContent: '', title: '' },
    errorDetail: { textContent: '' },
  };
  const controller = new GevRealtimeController({
    ui,
    runner: async (name, _args, options) => {
      if (name === 'control_radio') {
        radioSignal = options.signal;
        return radioResult;
      }
      return { ok: true, action: name };
    },
  });
  controller.debugLog = () => {};
  controller.sendVisualContextIfUseful = async () => false;
  controller.dc = { readyState: 'open', send() {}, close() {} };
  const event = (payload) => ({ data: JSON.stringify(payload) });

  const pendingRadio = controller.handleRealtimeEvent(event({
    type: 'response.function_call_arguments.done',
    response_id: 'response-multi-tool',
    call_id: 'radio-sibling',
    name: 'control_radio',
    arguments: '{"action":"select","locationId":"austin"}',
  }));
  await Promise.resolve();
  await controller.handleRealtimeEvent(event({
    type: 'response.function_call_arguments.done',
    response_id: 'response-multi-tool',
    call_id: 'style-sibling',
    name: 'set_visual_style',
    arguments: '{"style":"normal"}',
  }));
  assert.equal(radioSignal?.aborted, false);
  resolveRadio({ ok: true, action: 'control_radio', radioAction: 'status' });
  await pendingRadio;
  assert.equal(radioSignal.aborted, false);
});

test('Radio stop does not abort an unrelated sibling tool from the same response', async () => {
  let releaseStyle;
  let styleSignal = null;
  const styleResult = new Promise((resolve) => { releaseStyle = resolve; });
  const ui = {
    root: { dataset: {}, classList: { remove() {} }, querySelectorAll: () => [] },
    status: { textContent: '' },
    detail: { textContent: '', title: '' },
    errorDetail: { textContent: '' },
  };
  const controller = new GevRealtimeController({
    ui,
    runner: async (name, _args, options) => {
      if (name === 'set_visual_style') {
        styleSignal = options.signal;
        return styleResult;
      }
      return { ok: true, action: 'control_radio', radioAction: 'stop' };
    },
  });
  controller.debugLog = () => {};
  controller.sendVisualContextIfUseful = async () => false;
  controller.dc = { readyState: 'open', send() {}, close() {} };
  const event = (payload) => ({ data: JSON.stringify(payload) });

  const pendingStyle = controller.handleRealtimeEvent(event({
    type: 'response.function_call_arguments.done',
    response_id: 'response-multi-tool-stop',
    call_id: 'style-sibling-stop',
    name: 'set_visual_style',
    arguments: '{"style":"normal"}',
  }));
  await Promise.resolve();
  await controller.handleRealtimeEvent(event({
    type: 'response.function_call_arguments.done',
    response_id: 'response-multi-tool-stop',
    call_id: 'radio-stop-sibling',
    name: 'control_radio',
    arguments: '{"action":"stop"}',
  }));
  assert.equal(styleSignal?.aborted, false);
  releaseStyle({ ok: true, action: 'set_visual_style' });
  await pendingStyle;
  assert.equal(styleSignal.aborted, false);
});

test('real Radio Select cannot enable or play after a same-response Disable completes', async () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  let releaseLookup;
  let announceLookupStarted;
  const lookupGate = new Promise((resolve) => { releaseLookup = resolve; });
  const lookupStarted = new Promise((resolve) => { announceLookupStarted = resolve; });
  const sent = [];
  const managerCalls = [];
  const selectionCalls = [];
  let voiceClosed = false;
  let enabled = true;
  const state = {
    stationCount: 1,
    selected: null,
    audioState: 'playing',
    volume: 0.8,
    voiceDucked: true,
  };
  const radioLayer = {
    getUIState: () => ({ ...state, enabled }),
    selectRequestedStation(criteria) {
      selectionCalls.push(criteria);
      state.selected = { id: 'late-austin', name: 'Late Austin' };
      return state.selected;
    },
  };
  const dataManager = {
    layers: new Map([['radio', { module: radioLayer }]]),
    isEnabled: () => enabled,
    async setEnabled(_layerId, nextEnabled) {
      managerCalls.push(nextEnabled);
      enabled = nextEnabled;
      if (!nextEnabled) state.audioState = 'stopped';
      return true;
    },
  };
  const ui = {
    root: { dataset: {}, classList: { remove() {} }, querySelectorAll: () => [] },
    status: { textContent: '' },
    detail: { textContent: '', title: '' },
    errorDetail: { textContent: '' },
  };
  globalThis.window = { __GOOGLE_MAPS_API_KEY__: 'test-key' };
  globalThis.fetch = async () => {
    announceLookupStarted();
    await lookupGate;
    return {
      json: async () => ({
        status: 'OK',
        results: [{
          formatted_address: 'Austin, TX',
          geometry: { location: { lat: 30.2672, lng: -97.7431 } },
        }],
      }),
    };
  };
  const controller = new GevRealtimeController({
    ui,
    dataManager,
    radioLayer,
    runner: (_name, args, options) => controlRadio({}, dataManager, args, options),
  });
  controller.debugLog = () => {};
  controller.sendVisualContextIfUseful = async () => false;
  controller.dc = {
    readyState: 'open',
    send(message) { sent.push(JSON.parse(message)); },
    close() { voiceClosed = true; },
  };
  const event = (payload) => ({ data: JSON.stringify(payload) });

  try {
    const pendingSelect = controller.handleRealtimeEvent(event({
      type: 'response.function_call_arguments.done',
      response_id: 'same-radio-response',
      call_id: 'radio-select-sibling',
      name: 'control_radio',
      arguments: '{"action":"select","locationQuery":"Delayed place"}',
    }));
    await lookupStarted;
    await controller.handleRealtimeEvent(event({
      type: 'response.function_call_arguments.done',
      response_id: 'same-radio-response',
      call_id: 'radio-disable-sibling',
      name: 'control_radio',
      arguments: '{"action":"disable"}',
    }));

    assert.equal(enabled, false);
    releaseLookup();
    await pendingSelect;
    const selectOutput = sent
      .map((message) => message.item?.output)
      .filter(Boolean)
      .map(JSON.parse)
      .find((result) => result.radioAction === 'select');
    assert.equal(selectOutput?.ok, false, JSON.stringify({ selectOutput, epoch: controller.radioHandoffEpoch }));
    assert.equal(selectOutput?.cancelled, true);
    assert.equal(selectOutput?.enabled, false);
    assert.equal(selectOutput?.audioState, 'stopped');
    assert.equal(selectOutput?.radioPlaybackRequested, undefined);
    assert.deepEqual(managerCalls, [false]);
    assert.deepEqual(selectionCalls, []);
    assert.equal(controller.pendingRadioPlaybackResult, null);
    assert.equal(voiceClosed, false);
    assert.equal(sent.some((message) => (
      message.type === 'response.create'
      && message.response?.instructions?.includes('Turning on the radio')
    )), false);
  } finally {
    globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
  }
});

test('generic same-response Radio visibility disable supersedes delayed Select', async () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  let releaseLookup;
  let announceLookupStarted;
  const lookupGate = new Promise((resolve) => { releaseLookup = resolve; });
  const lookupStarted = new Promise((resolve) => { announceLookupStarted = resolve; });
  const sent = [];
  const visibilityEvents = [];
  const selectionCalls = [];
  let dataManager = null;
  const state = {
    stationCount: 1,
    selected: null,
    audioState: 'playing',
    volume: 0.8,
    voiceDucked: true,
  };
  const radioLayer = {
    id: 'radio',
    name: 'Radio',
    updateInterval: -1,
    init: async () => true,
    enable: async () => true,
    disable: async () => {
      state.audioState = 'stopped';
      return true;
    },
    update: async () => true,
    destroy: async () => true,
    getStats: () => ({}),
    getUIState: () => ({ ...state, enabled: dataManager?.isEnabled('radio') || false }),
    selectRequestedStation(criteria) {
      selectionCalls.push(criteria);
      state.selected = { id: 'late-generic', name: 'Late generic station' };
      return state.selected;
    },
  };
  dataManager = new DataLayerManager({});
  dataManager.register(radioLayer);
  await dataManager.setEnabled('radio', true);
  dataManager.subscribe((change) => {
    if (change.type === 'visibility') {
      visibilityEvents.push({ enabled: change.enabled, origin: change.origin });
    }
  });
  const viewer = {
    clock: { onTick: { addEventListener: () => () => {} } },
    scene: { canvas: { addEventListener() {}, removeEventListener() {} } },
    camera: { moveEnd: { addEventListener() {} } },
  };
  const genericRunner = createGevActionRunner({ viewer, styleManager: {}, dataManager });
  const ui = {
    root: { dataset: {}, classList: { remove() {} }, querySelectorAll: () => [] },
    status: { textContent: '' },
    detail: { textContent: '', title: '' },
    errorDetail: { textContent: '' },
  };
  globalThis.window = { __GOOGLE_MAPS_API_KEY__: 'test-key' };
  globalThis.fetch = async () => {
    announceLookupStarted();
    await lookupGate;
    return {
      json: async () => ({
        status: 'OK',
        results: [{
          formatted_address: 'Austin, TX',
          geometry: { location: { lat: 30.2672, lng: -97.7431 } },
        }],
      }),
    };
  };
  const controller = new GevRealtimeController({
    ui,
    radioLayer,
    runner: (name, args, options) => (
      name === 'control_radio'
        ? controlRadio({}, dataManager, args, options)
        : genericRunner(name, args, options)
    ),
  });
  controller.debugLog = () => {};
  controller.sendVisualContextIfUseful = async () => false;
  controller.dc = {
    readyState: 'open',
    send(message) { sent.push(JSON.parse(message)); },
    close() {},
  };
  const event = (payload) => ({ data: JSON.stringify(payload) });

  try {
    const pendingSelect = controller.handleRealtimeEvent(event({
      type: 'response.function_call_arguments.done',
      response_id: 'same-radio-generic-response',
      call_id: 'radio-select-before-generic-disable',
      name: 'control_radio',
      arguments: '{"action":"select","locationQuery":"Delayed place"}',
    }));
    await lookupStarted;
    await controller.handleRealtimeEvent(event({
      type: 'response.function_call_arguments.done',
      response_id: 'same-radio-generic-response',
      call_id: 'generic-radio-disable',
      name: 'set_layer_visibility',
      arguments: '{"layerId":"radio","enabled":false}',
    }));
    assert.equal(dataManager.isEnabled('radio'), false);
    releaseLookup();
    await pendingSelect;

    const outputs = sent
      .map((message) => message.item?.output)
      .filter(Boolean)
      .map(JSON.parse);
    const visibilityOutput = outputs.find((result) => result.action === 'set_layer_visibility');
    const selectOutput = outputs.find((result) => result.radioAction === 'select');
    assert.equal(visibilityOutput?.ok, true);
    assert.equal(visibilityOutput?.enabled, false);
    assert.equal(visibilityOutput?.lifecycleState, 'disabled');
    assert.equal(visibilityOutput?.lifecycleUncertain, false);
    assert.equal(selectOutput?.cancelled, true);
    assert.equal(selectOutput?.enabled, false);
    assert.equal(selectOutput?.lifecycleState, 'disabled');
    assert.equal(selectOutput?.lifecycleUncertain, false);
    assert.equal(selectOutput?.radioPlaybackRequested, undefined);
    assert.deepEqual(visibilityEvents, [{ enabled: false, origin: 'voice' }]);
    assert.deepEqual(selectionCalls, []);
    assert.equal(controller.pendingRadioPlaybackResult, null);
  } finally {
    globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
  }
});

test('same-response Pause aborts a real manager enable already in flight', async () => {
  let releaseEnable;
  let announceEnableStarted;
  const enableGate = new Promise((resolve) => { releaseEnable = resolve; });
  const enableStarted = new Promise((resolve) => { announceEnableStarted = resolve; });
  const trace = [];
  const sent = [];
  const state = {
    stationCount: 1,
    selected: null,
    audioState: 'stopped',
    volume: 0.8,
  };
  const radioLayer = {
    id: 'radio',
    name: 'Radio',
    updateInterval: -1,
    init: async () => true,
    enable: async () => {
      trace.push('enable:start');
      announceEnableStarted();
      await enableGate;
      trace.push('enable:finish');
      return true;
    },
    disable: async () => {
      trace.push('disable');
      state.audioState = 'stopped';
      return true;
    },
    update: async () => {
      trace.push('update');
      return true;
    },
    destroy: async () => true,
    getStats: () => ({}),
    getUIState: () => ({ ...state }),
    pause: ({ origin } = {}) => {
      trace.push(`pause:${origin || 'unknown'}`);
      if (origin === 'voice') state.audioState = 'paused';
      return true;
    },
    selectRequestedStation: () => {
      trace.push('select');
      state.selected = { id: 'late', name: 'Late station' };
      return state.selected;
    },
  };
  const dataManager = new DataLayerManager({});
  dataManager.register(radioLayer);
  dataManager.subscribe((change) => {
    if (change.type === 'visibility') trace.push(`visibility:${change.enabled}`);
  });
  const ui = {
    root: { dataset: {}, classList: { remove() {} }, querySelectorAll: () => [] },
    status: { textContent: '' },
    detail: { textContent: '', title: '' },
    errorDetail: { textContent: '' },
  };
  const controller = new GevRealtimeController({
    ui,
    dataManager,
    radioLayer,
    runner: (_name, args, options) => controlRadio({}, dataManager, args, options),
  });
  controller.debugLog = () => {};
  controller.sendVisualContextIfUseful = async () => false;
  controller.dc = {
    readyState: 'open',
    send(message) { sent.push(JSON.parse(message)); },
    close() {},
  };
  const event = (payload) => ({ data: JSON.stringify(payload) });
  const responseId = 'same-response-real-manager-pause';

  const pendingSelect = controller.handleRealtimeEvent(event({
    type: 'response.function_call_arguments.done',
    response_id: responseId,
    call_id: 'select-enabling',
    name: 'control_radio',
    arguments: '{"action":"select"}',
  }));
  await enableStarted;
  const pendingPause = controller.handleRealtimeEvent(event({
    type: 'response.function_call_arguments.done',
    response_id: responseId,
    call_id: 'pause-owner',
    name: 'control_radio',
    arguments: '{"action":"pause"}',
  }));
  await pendingPause;
  trace.push('pause:return');
  releaseEnable();
  await pendingSelect;

  const outputs = sent
    .map((message) => message.item?.output)
    .filter(Boolean)
    .map(JSON.parse);
  const selectOutput = outputs.find((result) => result.radioAction === 'select');
  const pauseOutput = outputs.find((result) => result.radioAction === 'pause');
  assert.equal(dataManager.isEnabled('radio'), false);
  assert.equal(selectOutput?.cancelled, true);
  assert.equal(selectOutput?.enabled, false);
  assert.equal(pauseOutput?.ok, true);
  assert.equal(pauseOutput?.changed, false);
  assert.equal(pauseOutput?.enabled, false);
  assert.equal(pauseOutput?.audioState, 'stopped');
  // The successful Pause may touch the current player before its reservation
  // commits. Its commit then aborts the pending auto-enable synchronously, and
  // the reconciled tool output reports the authoritative stopped/OFF result.
  assert.equal(trace.includes('pause:voice'), true, trace.join(' → '));
  assert.equal(trace.includes('select'), false, trace.join(' → '));
  assert.equal(trace.includes('update'), false, trace.join(' → '));
  assert.equal(trace.includes('visibility:true'), false, trace.join(' → '));
  assert.ok(trace.indexOf('disable') < trace.indexOf('enable:finish'), trace.join(' → '));
});

test('Pause and Stop preserve independent dedicated and generic Radio ON across manager phases', async (t) => {
  for (const onRoute of ['dedicated', 'generic']) {
    for (const controlAction of ['pause', 'stop']) {
      for (const heldPhase of ['init', 'enable', 'update']) {
        for (const controlSucceeds of [true, false]) {
          await t.test(
            `${onRoute} ON + ${controlAction} ${controlSucceeds ? 'success' : 'failure'} during ${heldPhase}`,
            async () => {
              let releasePhase;
              let markPhaseStarted;
              const phaseGate = new Promise((resolve) => { releasePhase = resolve; });
              const phaseStarted = new Promise((resolve) => { markPhaseStarted = resolve; });
              const sent = [];
              const visibility = [];
              const trace = [];
              let dataManager;
              const runPhase = (phase) => async () => {
                trace.push(`${phase}:start`);
                if (phase === heldPhase) {
                  markPhaseStarted();
                  await phaseGate;
                }
                trace.push(`${phase}:finish`);
                return true;
              };
              const state = { audioState: 'playing', volume: 0.8 };
              const radioLayer = {
                id: 'radio',
                name: 'Radio',
                updateInterval: -1,
                init: runPhase('init'),
                enable: runPhase('enable'),
                update: runPhase('update'),
                disable: async () => true,
                destroy: async () => true,
                getStats: () => ({}),
                getUIState: () => ({
                  ...state,
                  enabled: dataManager?.isEnabled('radio') || false,
                }),
                pause: () => {
                  trace.push(`pause:${controlSucceeds}`);
                  if (controlSucceeds) state.audioState = 'paused';
                  return controlSucceeds;
                },
                stopPlayback: () => {
                  trace.push(`stop:${controlSucceeds}`);
                  if (controlSucceeds) state.audioState = 'stopped';
                  return controlSucceeds;
                },
              };
              dataManager = new DataLayerManager({});
              dataManager.register(radioLayer);
              dataManager.subscribe((change) => {
                if (change.type === 'visibility') visibility.push(change.enabled);
              });
              const viewer = {
                clock: { onTick: { addEventListener: () => () => {} } },
                scene: { canvas: { addEventListener() {}, removeEventListener() {} } },
                camera: { moveEnd: { addEventListener() {} } },
              };
              const genericRunner = createGevActionRunner({
                viewer,
                styleManager: {},
                dataManager,
              });
              const ui = {
                root: { dataset: {}, classList: { remove() {} }, querySelectorAll: () => [] },
                status: { textContent: '' },
                detail: { textContent: '', title: '' },
                errorDetail: { textContent: '' },
              };
              const controller = new GevRealtimeController({
                ui,
                dataManager,
                radioLayer,
                runner: (name, args, options) => (
                  name === 'control_radio'
                    ? controlRadio({}, dataManager, args, options)
                    : genericRunner(name, args, options)
                ),
              });
              controller.debugLog = () => {};
              controller.sendVisualContextIfUseful = async () => false;
              controller.dc = {
                readyState: 'open',
                send(message) { sent.push(JSON.parse(message)); },
                close() {},
              };
              const event = (payload) => ({ data: JSON.stringify(payload) });
              const responseId = `${onRoute}-${controlAction}-${heldPhase}-${controlSucceeds}`;

              const pendingOn = controller.handleRealtimeEvent(event({
                type: 'response.function_call_arguments.done',
                response_id: responseId,
                call_id: `${responseId}-on`,
                name: onRoute === 'dedicated' ? 'control_radio' : 'set_layer_visibility',
                arguments: onRoute === 'dedicated'
                  ? '{"action":"enable"}'
                  : '{"layerId":"radio","enabled":true}',
              }));
              await phaseStarted;
              await controller.handleRealtimeEvent(event({
                type: 'response.function_call_arguments.done',
                response_id: responseId,
                call_id: `${responseId}-${controlAction}`,
                name: 'control_radio',
                arguments: JSON.stringify({ action: controlAction }),
              }));
              releasePhase();
              await pendingOn;

              const outputs = sent
                .map((message) => message.item?.output)
                .filter(Boolean)
                .map(JSON.parse);
              const onOutput = outputs.find((result) => onRoute === 'dedicated'
                ? result.radioAction === 'enable'
                : result.action === 'set_layer_visibility');
              const controlOutput = outputs.find((result) => result.radioAction === controlAction);
              assert.equal(onOutput?.ok, true, trace.join(' → '));
              assert.notEqual(onOutput?.cancelled, true, trace.join(' → '));
              assert.equal(controlOutput?.ok, controlSucceeds, trace.join(' → '));
              assert.equal(dataManager.isEnabled('radio'), true, trace.join(' → '));
              assert.deepEqual(visibility, [true], trace.join(' → '));
              assert.equal(visibility.includes(false), false, trace.join(' → '));
              assert.equal(
                state.audioState,
                controlSucceeds ? (controlAction === 'pause' ? 'paused' : 'stopped') : 'playing',
              );
              await dataManager.destroyAll();
            },
          );
        }
      }
    }
  }
});

test('successful same- or newer-response Stop aborts Select across real manager lifecycle phases', async (t) => {
  for (const responseMode of ['same-response', 'newer-response']) {
    for (const heldPhase of ['init', 'enable', 'update']) {
      await t.test(`${responseMode} ${heldPhase}`, async () => {
      let releasePhase;
      let announcePhaseStarted;
      const phaseGate = new Promise((resolve) => { releasePhase = resolve; });
      const phaseStarted = new Promise((resolve) => { announcePhaseStarted = resolve; });
      const trace = [];
      const sent = [];
      const persistenceWrites = [];
      const state = {
        stationCount: 1,
        selected: null,
        audioState: 'stopped',
        volume: 0.8,
      };
      let dataManager = null;
      const runPhase = async (phase) => {
        trace.push(`${phase}:start`);
        if (heldPhase === phase) {
          announcePhaseStarted();
          await phaseGate;
        }
        trace.push(`${phase}:finish`);
        return true;
      };
      const radioLayer = {
        id: 'radio',
        name: 'Radio',
        updateInterval: -1,
        init: () => runPhase('init'),
        enable: () => runPhase('enable'),
        update: () => runPhase('update'),
        disable: async () => {
          trace.push('disable');
          state.audioState = 'stopped';
          return true;
        },
        destroy: async () => true,
        getStats: () => ({}),
        getUIState: () => ({ ...state, enabled: dataManager?.isEnabled('radio') || false }),
        stopPlayback: ({ origin } = {}) => {
          trace.push(`stop:${origin || 'unknown'}`);
          state.audioState = 'stopped';
          return true;
        },
        selectRequestedStation: () => {
          trace.push('select');
          state.selected = { id: 'late-stop', name: 'Late stop station' };
          return state.selected;
        },
      };
      dataManager = new DataLayerManager({});
      dataManager.register(radioLayer);
      dataManager.subscribe((change) => {
        if (change.type === 'visibility') {
          trace.push(`visibility:${change.enabled}`);
          if (change.origin === 'voice') persistenceWrites.push(change.enabled);
        }
      });
      const ui = {
        root: { dataset: {}, classList: { remove() {} }, querySelectorAll: () => [] },
        status: { textContent: '' },
        detail: { textContent: '', title: '' },
        errorDetail: { textContent: '' },
      };
      const controller = new GevRealtimeController({
        ui,
        radioLayer,
        runner: (_name, args, options) => controlRadio({}, dataManager, args, options),
      });
      controller.debugLog = () => {};
      controller.sendVisualContextIfUseful = async () => false;
      controller.dc = {
        readyState: 'open',
        send(message) { sent.push(JSON.parse(message)); },
        close() {},
      };
      const event = (payload) => ({ data: JSON.stringify(payload) });
      const selectResponseId = `${responseMode}-real-manager-select-${heldPhase}`;
      const stopResponseId = responseMode === 'same-response'
        ? selectResponseId
        : `${responseMode}-real-manager-stop-${heldPhase}`;

      const pendingSelect = controller.handleRealtimeEvent(event({
        type: 'response.function_call_arguments.done',
        response_id: selectResponseId,
        call_id: `select-${heldPhase}`,
        name: 'control_radio',
        arguments: '{"action":"select"}',
      }));
      await phaseStarted;
      await controller.handleRealtimeEvent(event({
        type: 'response.function_call_arguments.done',
        response_id: stopResponseId,
        call_id: `stop-${heldPhase}`,
        name: 'control_radio',
        arguments: '{"action":"stop"}',
      }));
      trace.push('stop:return');
      assert.equal(dataManager.isEnabled('radio'), false, trace.join(' → '));
      releasePhase();
      await pendingSelect;

      const outputs = sent
        .map((message) => message.item?.output)
        .filter(Boolean)
        .map(JSON.parse);
      const selectOutput = outputs.find((result) => result.radioAction === 'select');
      const stopOutput = outputs.find((result) => result.radioAction === 'stop');
      assert.equal(stopOutput?.ok, true);
      assert.equal(stopOutput?.audioState, 'stopped');
      assert.equal(selectOutput?.cancelled, true);
      assert.equal(selectOutput?.enabled, false);
      assert.equal(dataManager.isEnabled('radio'), false);
      assert.deepEqual(persistenceWrites, []);
      assert.equal(trace.includes('select'), false, trace.join(' → '));
      assert.equal(trace.includes('visibility:true'), false, trace.join(' → '));
      assert.equal(controller.pendingRadioPlaybackResult, null);
      });
    }
  }
});

test('same-response pause and disable suppress play/select handoffs without cancelling results', async (t) => {
  for (const [playbackAction, stopAction] of [['play', 'pause'], ['select', 'disable']]) {
    await t.test(`${playbackAction} + ${stopAction}`, async () => {
      let releasePlayback;
      const playbackGate = new Promise((resolve) => { releasePlayback = resolve; });
      const sent = [];
      const radioState = { enabled: true, audioState: 'playing' };
      const ui = {
        root: { dataset: {}, classList: { remove() {} }, querySelectorAll: () => [] },
        status: { textContent: '' },
        detail: { textContent: '', title: '' },
        errorDetail: { textContent: '' },
      };
      const controller = new GevRealtimeController({
        ui,
        radioLayer: { getUIState: () => ({ ...radioState }) },
        runner: async (_name, args) => {
          if (args.action === playbackAction) {
            await playbackGate;
            return {
              ok: true,
              action: 'control_radio',
              radioAction: playbackAction,
              radioPlaybackRequested: true,
            };
          }
          if (stopAction === 'pause') radioState.audioState = 'paused';
          else {
            radioState.enabled = false;
            radioState.audioState = 'stopped';
          }
          return { ok: true, action: 'control_radio', radioAction: stopAction };
        },
      });
      controller.debugLog = () => {};
      controller.sendVisualContextIfUseful = async () => false;
      controller.dc = {
        readyState: 'open',
        send(message) { sent.push(JSON.parse(message)); },
        close() {},
      };
      const event = (payload) => ({ data: JSON.stringify(payload) });
      const responseId = `same-response-${playbackAction}-${stopAction}`;

      const pendingPlayback = controller.handleRealtimeEvent(event({
        type: 'response.function_call_arguments.done',
        response_id: responseId,
        call_id: `${playbackAction}-call`,
        name: 'control_radio',
        arguments: JSON.stringify({ action: playbackAction }),
      }));
      await Promise.resolve();
      await controller.handleRealtimeEvent(event({
        type: 'response.function_call_arguments.done',
        response_id: responseId,
        call_id: `${stopAction}-call`,
        name: 'control_radio',
        arguments: JSON.stringify({ action: stopAction }),
      }));
      releasePlayback();
      await pendingPlayback;

      const playbackOutput = sent
        .map((message) => message.item?.output)
        .filter(Boolean)
        .map(JSON.parse)
        .find((result) => result.radioAction === playbackAction);
      assert.equal(playbackOutput?.ok, true);
      assert.equal(playbackOutput?.cancelled, undefined);
      assert.equal(playbackOutput?.radioPlaybackRequested, false);
      assert.equal(playbackOutput?.radioPlaybackSuppressed, true);
      assert.equal(playbackOutput?.audioState, stopAction === 'pause' ? 'paused' : 'stopped');
      assert.equal(playbackOutput?.enabled, stopAction !== 'disable');
      assert.equal(playbackOutput?.lifecycleState, stopAction === 'disable' ? 'disabled' : 'enabled');
      assert.equal(playbackOutput?.lifecycleUncertain, false);
      assert.match(
        controller.pendingResponseInstructions,
        stopAction === 'pause' ? /remains paused/ : /remains disabled/,
      );
      assert.equal(controller.pendingRadioPlaybackResult, null);
    });
  }
});

test('Realtime Radio route exceptions preserve the authoritative lifecycle summary', async () => {
  for (const route of ['dedicated', 'generic']) {
    const sent = [];
    const lifecycle = { enabled: true, lifecycleState: 'disabling', uncertain: true };
    const ui = {
      root: { dataset: {}, classList: { remove() {} }, querySelectorAll: () => [] },
      status: { textContent: '' },
      detail: { textContent: '', title: '' },
      errorDetail: { textContent: '' },
    };
    const controller = new GevRealtimeController({
      ui,
      dataManager: {
        getLayerLifecycleState: () => ({ ...lifecycle }),
        isEnabled: () => false,
      },
      radioLayer: { getUIState: () => ({ enabled: false, audioState: 'stopped' }) },
      runner: async () => { throw new Error('route failed'); },
    });
    controller.debugLog = () => {};
    controller.sendVisualContextIfUseful = async () => false;
    controller.dc = {
      readyState: 'open',
      send(message) { sent.push(JSON.parse(message)); },
      close() {},
    };

    await controller.handleRealtimeEvent({
      data: JSON.stringify({
        type: 'response.function_call_arguments.done',
        response_id: `exception-${route}`,
        call_id: `exception-${route}-call`,
        name: route === 'dedicated' ? 'control_radio' : 'set_layer_visibility',
        arguments: route === 'dedicated'
          ? '{"action":"disable"}'
          : '{"layerId":"radio","enabled":false}',
      }),
    });

    const output = sent
      .map((message) => message.item?.output)
      .filter(Boolean)
      .map(JSON.parse)
      .find((result) => result.tool);
    assert.equal(output?.ok, false);
    assert.equal(output?.error, 'route failed');
    assert.equal(output?.enabled, true);
    assert.equal(output?.lifecycleState, 'disabling');
    assert.equal(output?.lifecycleUncertain, true);
  }
});

test('different-response Radio stop remains a cancellation authority for an older playback tool', async () => {
  let releaseSelect;
  const selectGate = new Promise((resolve) => { releaseSelect = resolve; });
  const sent = [];
  const ui = {
    root: { dataset: {}, classList: { remove() {} }, querySelectorAll: () => [] },
    status: { textContent: '' },
    detail: { textContent: '', title: '' },
    errorDetail: { textContent: '' },
  };
  const controller = new GevRealtimeController({
    ui,
    runner: async (_name, args) => {
      if (args.action === 'select') {
        await selectGate;
        return {
          ok: true,
          action: 'control_radio',
          radioAction: 'select',
          radioPlaybackRequested: true,
        };
      }
      return { ok: true, action: 'control_radio', radioAction: 'stop' };
    },
  });
  controller.debugLog = () => {};
  controller.sendVisualContextIfUseful = async () => false;
  controller.dc = {
    readyState: 'open',
    send(message) { sent.push(JSON.parse(message)); },
    close() {},
  };
  const event = (payload) => ({ data: JSON.stringify(payload) });

  const pendingSelect = controller.handleRealtimeEvent(event({
    type: 'response.function_call_arguments.done',
    response_id: 'older-response',
    call_id: 'older-select',
    name: 'control_radio',
    arguments: '{"action":"select"}',
  }));
  await Promise.resolve();
  await controller.handleRealtimeEvent(event({
    type: 'response.function_call_arguments.done',
    response_id: 'newer-response',
    call_id: 'newer-stop',
    name: 'control_radio',
    arguments: '{"action":"stop"}',
  }));
  releaseSelect();
  await pendingSelect;

  const selectOutput = sent
    .map((message) => message.item?.output)
    .filter(Boolean)
    .map(JSON.parse)
    .find((result) => result.radioAction === 'select');
  assert.equal(selectOutput?.ok, false);
  assert.equal(selectOutput?.cancelled, true);
  assert.equal(selectOutput?.radioPlaybackRequested, false);
  assert.equal(controller.pendingRadioPlaybackResult, null);
});

test('failed same-response stop does not suppress a successful playback request', async () => {
  let releasePlay;
  const playGate = new Promise((resolve) => { releasePlay = resolve; });
  const sent = [];
  const state = {
    stationCount: 1,
    selected: { id: 'station-1', name: 'Station 1' },
    audioState: 'playing',
    volume: 0.8,
  };
  const dataManager = {
    layers: new Map([['radio', {
      module: {
        getUIState: () => ({ ...state }),
        stopPlayback: () => false,
      },
    }]]),
    isEnabled: () => true,
  };
  const ui = {
    root: { dataset: {}, classList: { remove() {} }, querySelectorAll: () => [] },
    status: { textContent: '' },
    detail: { textContent: '', title: '' },
    errorDetail: { textContent: '' },
  };
  const controller = new GevRealtimeController({
    ui,
    runner: async (_name, args) => {
      const result = await controlRadio({}, dataManager, args);
      if (args.action === 'play') await playGate;
      return result;
    },
  });
  controller.debugLog = () => {};
  controller.sendVisualContextIfUseful = async () => false;
  controller.dc = {
    readyState: 'open',
    send(message) { sent.push(JSON.parse(message)); },
    close() {},
  };
  const event = (payload) => ({ data: JSON.stringify(payload) });

  const pendingPlay = controller.handleRealtimeEvent(event({
    type: 'response.function_call_arguments.done',
    response_id: 'failed-stop-response',
    call_id: 'play-before-failed-stop',
    name: 'control_radio',
    arguments: '{"action":"play"}',
  }));
  await Promise.resolve();
  await controller.handleRealtimeEvent(event({
    type: 'response.function_call_arguments.done',
    response_id: 'failed-stop-response',
    call_id: 'failed-stop',
    name: 'control_radio',
    arguments: '{"action":"stop"}',
  }));
  releasePlay();
  await pendingPlay;

  const playOutput = sent
    .map((message) => message.item?.output)
    .filter(Boolean)
    .map(JSON.parse)
    .find((result) => result.radioAction === 'play');
  const stopOutput = sent
    .map((message) => message.item?.output)
    .filter(Boolean)
    .map(JSON.parse)
    .find((result) => result.radioAction === 'stop');
  assert.equal(stopOutput?.ok, false);
  assert.equal(stopOutput?.audioState, 'playing');
  assert.equal(playOutput?.ok, true);
  assert.equal(playOutput?.radioPlaybackRequested, true);
  assert.equal(playOutput?.radioPlaybackSuppressed, undefined);
  assert.equal(controller.pendingRadioPlaybackResult?.radioAction, 'play');
});

test('failed same-response Stop preserves Select auto-enable held inside real manager init', async () => {
  let releaseInit;
  let markInitStarted;
  const initGate = new Promise((resolve) => { releaseInit = resolve; });
  const initStarted = new Promise((resolve) => { markInitStarted = resolve; });
  const sent = [];
  const trace = [];
  const state = {
    selected: null,
    audioState: 'playing',
    volume: 0.8,
  };
  let dataManager;
  const radioLayer = {
    id: 'radio',
    name: 'Radio',
    updateInterval: -1,
    init: async () => {
      trace.push('init:start');
      markInitStarted();
      await initGate;
      trace.push('init:finish');
      return true;
    },
    enable: async () => true,
    update: async () => true,
    disable: async () => {
      trace.push('disable');
      return true;
    },
    destroy: async () => true,
    getStats: () => ({}),
    getUIState: () => ({
      ...state,
      enabled: dataManager?.isEnabled('radio') || false,
      stationCount: 1,
    }),
    stopPlayback: () => {
      trace.push('stop:false');
      return false;
    },
    selectRequestedStation: () => {
      trace.push('select');
      state.selected = { id: 'station-1', name: 'Station 1' };
      return state.selected;
    },
  };
  dataManager = new DataLayerManager({});
  dataManager.register(radioLayer);
  const ui = {
    root: { dataset: {}, classList: { remove() {} }, querySelectorAll: () => [] },
    status: { textContent: '' },
    detail: { textContent: '', title: '' },
    errorDetail: { textContent: '' },
  };
  const controller = new GevRealtimeController({
    ui,
    dataManager,
    radioLayer,
    runner: (_name, args, options) => controlRadio({}, dataManager, args, options),
  });
  controller.debugLog = () => {};
  controller.sendVisualContextIfUseful = async () => false;
  controller.dc = {
    readyState: 'open',
    send(message) { sent.push(JSON.parse(message)); },
    close() {},
  };
  const event = (payload) => ({ data: JSON.stringify(payload) });
  const responseId = 'failed-stop-during-select-init';

  const pendingSelect = controller.handleRealtimeEvent(event({
    type: 'response.function_call_arguments.done',
    response_id: responseId,
    call_id: 'select-held-in-init',
    name: 'control_radio',
    arguments: '{"action":"select","category":"all"}',
  }));
  await initStarted;
  await controller.handleRealtimeEvent(event({
    type: 'response.function_call_arguments.done',
    response_id: responseId,
    call_id: 'failed-stop-during-init',
    name: 'control_radio',
    arguments: '{"action":"stop"}',
  }));
  releaseInit();
  await pendingSelect;

  const outputs = sent
    .map((message) => message.item?.output)
    .filter(Boolean)
    .map(JSON.parse);
  const selectOutput = outputs.find((result) => result.radioAction === 'select');
  const stopOutput = outputs.find((result) => result.radioAction === 'stop');
  assert.equal(stopOutput?.ok, false, trace.join(' → '));
  assert.equal(selectOutput?.ok, true, trace.join(' → '));
  assert.notEqual(selectOutput?.cancelled, true, trace.join(' → '));
  assert.equal(dataManager.isEnabled('radio'), true, trace.join(' → '));
  assert.equal(state.selected?.id, 'station-1', trace.join(' → '));
  assert.equal(controller.pendingRadioPlaybackResult?.radioAction, 'select');
  assert.equal(trace.includes('disable'), false, trace.join(' → '));
  await dataManager.destroyAll();
});

test('failed same-response Pause and Disable do not suppress valid older playback', async (t) => {
  for (const action of ['pause', 'disable']) {
    await t.test(action, async () => {
      let releasePlay;
      const playGate = new Promise((resolve) => { releasePlay = resolve; });
      const sent = [];
      const state = {
        stationCount: 1,
        selected: { id: 'station-1', name: 'Station 1' },
        audioState: 'playing',
        volume: 0.8,
      };
      const requestListeners = new Set();
      const visibilityListeners = new Set();
      const dataManager = {
        layers: new Map([['radio', {
          module: {
            getUIState: () => ({ ...state }),
            pause: () => false,
          },
        }]]),
        isEnabled: () => true,
        setEnabled: async () => false,
        subscribeVisibilityRequests(listener) {
          requestListeners.add(listener);
          return () => requestListeners.delete(listener);
        },
        subscribe(listener) {
          visibilityListeners.add(listener);
          return () => visibilityListeners.delete(listener);
        },
      };
      const ui = {
        root: { dataset: {}, classList: { remove() {} }, querySelectorAll: () => [] },
        status: { textContent: '' },
        detail: { textContent: '', title: '' },
        errorDetail: { textContent: '' },
      };
      const controller = new GevRealtimeController({
        ui,
        dataManager,
        radioLayer: dataManager.layers.get('radio').module,
        runner: async (_name, args) => {
          const result = await controlRadio({}, dataManager, args);
          if (args.action === 'play') await playGate;
          return result;
        },
      });
      controller.debugLog = () => {};
      controller.sendVisualContextIfUseful = async () => false;
      controller.dc = {
        readyState: 'open',
        send(message) { sent.push(JSON.parse(message)); },
        close() {},
      };
      const event = (payload) => ({ data: JSON.stringify(payload) });
      const responseId = `failed-${action}-response`;

      const pendingPlay = controller.handleRealtimeEvent(event({
        type: 'response.function_call_arguments.done',
        response_id: responseId,
        call_id: `play-before-${action}`,
        name: 'control_radio',
        arguments: '{"action":"play"}',
      }));
      await Promise.resolve();
      await controller.handleRealtimeEvent(event({
        type: 'response.function_call_arguments.done',
        response_id: responseId,
        call_id: `failed-${action}`,
        name: 'control_radio',
        arguments: JSON.stringify({ action }),
      }));
      releasePlay();
      await pendingPlay;

      const outputs = sent
        .map((message) => message.item?.output)
        .filter(Boolean)
        .map(JSON.parse);
      const strongerOutput = outputs.find((result) => result.radioAction === action);
      const playOutput = outputs.find((result) => result.radioAction === 'play');
      assert.equal(strongerOutput?.ok, false);
      assert.equal(playOutput?.ok, true);
      assert.equal(playOutput?.radioPlaybackRequested, true);
      assert.equal(playOutput?.radioPlaybackSuppressed, undefined);
      assert.equal(controller.pendingRadioPlaybackResult?.radioAction, 'play');
    });
  }
});

test('failed generic same-response Radio OFF does not suppress valid older playback', async () => {
  let releaseSelect;
  const selectGate = new Promise((resolve) => { releaseSelect = resolve; });
  const sent = [];
  const ui = {
    root: { dataset: {}, classList: { remove() {} }, querySelectorAll: () => [] },
    status: { textContent: '' },
    detail: { textContent: '', title: '' },
    errorDetail: { textContent: '' },
  };
  const controller = new GevRealtimeController({
    ui,
    runner: async (name, args) => {
      if (name === 'set_layer_visibility') {
        return { ok: false, action: 'set_layer_visibility', layerId: 'radio', enabled: true };
      }
      await selectGate;
      return {
        ok: true,
        action: 'control_radio',
        radioAction: args.action,
        radioPlaybackRequested: true,
      };
    },
  });
  controller.debugLog = () => {};
  controller.sendVisualContextIfUseful = async () => false;
  controller.dc = {
    readyState: 'open',
    send(message) { sent.push(JSON.parse(message)); },
    close() {},
  };
  const event = (payload) => ({ data: JSON.stringify(payload) });

  const pendingSelect = controller.handleRealtimeEvent(event({
    type: 'response.function_call_arguments.done',
    response_id: 'failed-generic-off',
    call_id: 'select-before-generic-off',
    name: 'control_radio',
    arguments: '{"action":"select"}',
  }));
  await Promise.resolve();
  await controller.handleRealtimeEvent(event({
    type: 'response.function_call_arguments.done',
    response_id: 'failed-generic-off',
    call_id: 'generic-off-fails',
    name: 'set_layer_visibility',
    arguments: '{"layerId":"radio","enabled":false}',
  }));
  releaseSelect();
  await pendingSelect;

  const selectOutput = sent
    .map((message) => message.item?.output)
    .filter(Boolean)
    .map(JSON.parse)
    .find((result) => result.radioAction === 'select');
  assert.equal(selectOutput?.ok, true);
  assert.equal(selectOutput?.radioPlaybackRequested, true);
  assert.equal(selectOutput?.radioPlaybackSuppressed, undefined);
});

test('direct user Radio OFF aborts an in-flight voice enable before settled publication', async () => {
  let releaseInit;
  let markInitStarted;
  const initGate = new Promise((resolve) => { releaseInit = resolve; });
  const initStarted = new Promise((resolve) => { markInitStarted = resolve; });
  const sent = [];
  const visibility = [];
  let dataManager;
  const state = { selected: null, audioState: 'stopped', volume: 0.8 };
  const radioLayer = {
    id: 'radio',
    name: 'Radio',
    icon: '',
    source: 'test',
    updateInterval: 0,
    init: async () => {
      markInitStarted();
      await initGate;
      return true;
    },
    enable: async () => true,
    update: async () => true,
    disable: async () => true,
    destroy: async () => true,
    getStats: () => ({}),
    getUIState: () => ({ ...state, enabled: dataManager?.isEnabled('radio') || false }),
    selectRequestedStation: () => {
      state.selected = { id: 'late', name: 'Late station' };
      return state.selected;
    },
  };
  dataManager = new DataLayerManager({});
  dataManager.register(radioLayer);
  dataManager.subscribe((change) => {
    if (change.type === 'visibility') visibility.push(`${change.origin}:${change.enabled}`);
  });
  const ui = {
    root: { dataset: {}, classList: { remove() {} }, querySelectorAll: () => [] },
    status: { textContent: '' },
    detail: { textContent: '', title: '' },
    errorDetail: { textContent: '' },
  };
  const controller = new GevRealtimeController({
    ui,
    dataManager,
    radioLayer,
    runner: (_name, args, options) => controlRadio({}, dataManager, args, options),
  });
  controller.debugLog = () => {};
  controller.sendVisualContextIfUseful = async () => false;
  controller.dc = {
    readyState: 'open',
    send(message) { sent.push(JSON.parse(message)); },
    close() {},
  };
  const event = (payload) => ({ data: JSON.stringify(payload) });

  const pendingSelect = controller.handleRealtimeEvent(event({
    type: 'response.function_call_arguments.done',
    response_id: 'voice-select-before-ui-off',
    call_id: 'voice-select',
    name: 'control_radio',
    arguments: '{"action":"select"}',
  }));
  await initStarted;
  const userOff = dataManager.setEnabled('radio', false, { origin: 'user' });
  releaseInit();
  await Promise.all([pendingSelect, userOff]);

  const selectOutput = sent
    .map((message) => message.item?.output)
    .filter(Boolean)
    .map(JSON.parse)
    .find((result) => result.radioAction === 'select');
  assert.equal(selectOutput?.cancelled, true);
  assert.equal(dataManager.isEnabled('radio'), false);
  assert.deepEqual(
    visibility,
    ['user:false'],
    'voice ON never settles and the latest direct OFF alone owns publication',
  );
  assert.equal(state.selected, null);
  await dataManager.destroyAll();
});

test('direct user Radio OFF freezes a prepared handoff until disable success or failure settles', async (t) => {
  for (const disableSucceeds of [true, false]) {
    await t.test(disableSucceeds ? 'success commits cancellation' : 'failure resumes prepared playback', async () => {
      let releaseDisable;
      let markDisableStarted;
      const disableGate = new Promise((resolve) => { releaseDisable = resolve; });
      const disableStarted = new Promise((resolve) => { markDisableStarted = resolve; });
      const trace = [];
      let dataManager;
      const radioLayer = {
        id: 'radio',
        name: 'Radio',
        updateInterval: -1,
        init: async () => true,
        enable: async () => true,
        update: async () => true,
        disable: async () => {
          trace.push('disable:start');
          markDisableStarted();
          await disableGate;
          trace.push(`disable:${disableSucceeds}`);
          return disableSucceeds;
        },
        destroy: async () => true,
        getStats: () => ({}),
        getUIState: () => ({
          enabled: dataManager?.isEnabled('radio') || false,
          audioState: 'stopped',
        }),
        setVoiceDucked: () => trace.push('duck'),
        playForVoice: async () => {
          trace.push('playForVoice');
          return true;
        },
        stopPlayback: () => {
          trace.push('stopPlayback');
          return true;
        },
      };
      dataManager = new DataLayerManager({});
      dataManager.register(radioLayer);
      await dataManager.setEnabled('radio', true);
      const ui = {
        root: { dataset: {}, classList: { remove() {} }, querySelectorAll: () => [] },
        status: { textContent: '' },
        detail: { textContent: '', title: '' },
        errorDetail: { textContent: '' },
      };
      const controller = new GevRealtimeController({
        ui,
        dataManager,
        radioLayer,
        runner: async () => ({ ok: true }),
      });
      controller.debugLog = () => {};
      controller.pendingRadioPlaybackResult = {
        ok: true,
        action: 'control_radio',
        radioAction: 'select',
        radioPlaybackRequested: true,
      };
      controller.dc = {
        readyState: 'open',
        send() {},
        close() { trace.push('voice:close'); },
      };
      const event = (payload) => ({ data: JSON.stringify(payload) });

      const userOff = dataManager.setEnabled('radio', false, { origin: 'user' });
      await disableStarted;
      await controller.handleRealtimeEvent(event({
        type: 'response.done',
        response: { id: `prepared-off-${disableSucceeds}`, status: 'completed' },
      }));
      assert.equal(trace.includes('playForVoice'), false, trace.join(' → '));
      assert.equal(trace.includes('voice:close'), false, trace.join(' → '));
      assert.equal(controller.pendingRadioPlaybackResult?.radioAction, 'select');

      releaseDisable();
      const disabled = await userOff;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(disabled, disableSucceeds ? true : false);
      assert.equal(trace.includes('playForVoice'), !disableSucceeds, trace.join(' → '));
      assert.equal(trace.includes('voice:close'), !disableSucceeds, trace.join(' → '));
      assert.equal(controller.pendingRadioPlaybackResult, null);
    });
  }
});

test('dedicated and generic Radio OFF reservations freeze an in-flight playback handoff', async (t) => {
  for (const route of ['dedicated-disable', 'dedicated-stop', 'generic-off']) {
    for (const controlSucceeds of [true, false]) {
      await t.test(`${route} ${controlSucceeds ? 'success commits' : 'failure resumes'}`, async () => {
        let releaseFirstPlay;
        let markFirstPlayStarted;
        let releaseControl;
        let markControlStarted;
        const firstPlayGate = new Promise((resolve) => { releaseFirstPlay = resolve; });
        const firstPlayStarted = new Promise((resolve) => { markFirstPlayStarted = resolve; });
        const controlGate = new Promise((resolve) => { releaseControl = resolve; });
        const controlStarted = new Promise((resolve) => { markControlStarted = resolve; });
        const trace = [];
        let playCalls = 0;
        const radioLayer = {
          setVoiceDucked: () => trace.push('duck'),
          playForVoice: async () => {
            playCalls++;
            trace.push(`play:${playCalls}:start`);
            if (playCalls === 1) {
              markFirstPlayStarted();
              await firstPlayGate;
            }
            trace.push(`play:${playCalls}:finish`);
            return true;
          },
          stopPlayback: () => {
            trace.push('stopPlayback');
            return true;
          },
          getUIState: () => ({ enabled: true, audioState: 'stopped' }),
        };
        const ui = {
          root: { dataset: {}, classList: { remove() {} }, querySelectorAll: () => [] },
          status: { textContent: '' },
          detail: { textContent: '', title: '' },
          errorDetail: { textContent: '' },
        };
        const controller = new GevRealtimeController({
          ui,
          radioLayer,
          dataManager: { isEnabled: () => true },
          runner: async (name, args) => {
            const isDedicatedControl = route.startsWith('dedicated-');
            const radioAction = route.replace('dedicated-', '');
            const isStrongerControl = isDedicatedControl
              ? name === 'control_radio' && args.action === radioAction
              : name === 'set_layer_visibility' && args.enabled === false;
            if (!isStrongerControl) return { ok: false, error: 'unexpected route' };
            trace.push('control:start');
            markControlStarted();
            await controlGate;
            trace.push(`control:${controlSucceeds}`);
            return isDedicatedControl
              ? {
                ok: controlSucceeds,
                action: 'control_radio',
                radioAction,
              }
              : {
                ok: controlSucceeds,
                action: 'set_layer_visibility',
                enabled: !controlSucceeds,
              };
          },
        });
        controller.debugLog = () => {};
        controller.sendVisualContextIfUseful = async () => false;
        controller.pendingRadioPlaybackResult = {
          ok: true,
          action: 'control_radio',
          radioAction: 'select',
          radioPlaybackRequested: true,
        };
        controller.dc = {
          readyState: 'open',
          send() {},
          close() { trace.push('voice:close'); },
        };
        const event = (payload) => ({ data: JSON.stringify(payload) });

        const pendingHandoff = controller.handleRealtimeEvent(event({
          type: 'response.done',
          response: { id: `${route}-handoff`, status: 'completed' },
        }));
        await firstPlayStarted;
        const pendingControl = controller.handleRealtimeEvent(event({
          type: 'response.function_call_arguments.done',
          response_id: `${route}-control`,
          call_id: `${route}-call`,
          name: route.startsWith('dedicated-') ? 'control_radio' : 'set_layer_visibility',
          arguments: route.startsWith('dedicated-')
            ? JSON.stringify({ action: route.replace('dedicated-', '') })
            : '{"layerId":"radio","enabled":false}',
        }));
        await controlStarted;
        assert.equal(trace.includes('stopPlayback'), true, trace.join(' → '));

        releaseFirstPlay();
        await pendingHandoff;
        assert.equal(trace.includes('voice:close'), false, trace.join(' → '));
        assert.equal(controller.pendingRadioPlaybackResult?.radioAction, 'select');

        releaseControl();
        await pendingControl;
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(playCalls, controlSucceeds ? 1 : 2, trace.join(' → '));
        assert.equal(trace.includes('voice:close'), !controlSucceeds, trace.join(' → '));
        assert.equal(controller.pendingRadioPlaybackResult, null);
      });
    }
  }
});

test('delayed Stop reports its result before committing or resuming a prepared handoff', async (t) => {
  for (const outcome of ['success', 'false', 'reject']) {
    await t.test(outcome, async () => {
      let releaseStop;
      let markStopStarted;
      const stopGate = new Promise((resolve) => { releaseStop = resolve; });
      const stopStarted = new Promise((resolve) => { markStopStarted = resolve; });
      const trace = [];
      const radioLayer = {
        setVoiceDucked: () => trace.push('duck'),
        playForVoice: async () => {
          trace.push('play:start');
          return true;
        },
        stopPlayback: () => {
          trace.push('stopPlayback');
          return true;
        },
        getUIState: () => ({ enabled: true, audioState: 'stopped' }),
      };
      const ui = {
        root: { dataset: {}, classList: { remove() {} }, querySelectorAll: () => [] },
        status: { textContent: '' },
        detail: { textContent: '', title: '' },
        errorDetail: { textContent: '' },
      };
      const controller = new GevRealtimeController({
        ui,
        radioLayer,
        dataManager: { isEnabled: () => true },
        runner: async () => {
          trace.push('stop:start');
          markStopStarted();
          await stopGate;
          if (outcome === 'reject') throw new Error('Stop rejected');
          return {
            ok: outcome === 'success',
            action: 'control_radio',
            radioAction: 'stop',
          };
        },
      });
      controller.debugLog = () => {};
      controller.sendVisualContextIfUseful = async () => false;
      controller.pendingRadioPlaybackResult = {
        ok: true,
        action: 'control_radio',
        radioAction: 'select',
        radioPlaybackRequested: true,
      };
      controller.dc = {
        readyState: 'open',
        send(message) {
          const payload = JSON.parse(message);
          if (payload.item?.call_id === `delayed-stop-${outcome}`) trace.push('output:stop');
        },
        close() { trace.push('voice:close'); },
      };
      const event = (payload) => ({ data: JSON.stringify(payload) });

      const pendingStop = controller.handleRealtimeEvent(event({
        type: 'response.function_call_arguments.done',
        response_id: `delayed-stop-response-${outcome}`,
        call_id: `delayed-stop-${outcome}`,
        name: 'control_radio',
        arguments: '{"action":"stop"}',
      }));
      await stopStarted;
      await controller.handleRealtimeEvent(event({
        type: 'response.done',
        response: { id: `delayed-stop-response-${outcome}`, status: 'completed' },
      }));
      assert.equal(trace.includes('play:start'), false, trace.join(' → '));

      releaseStop();
      await pendingStop;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(trace.includes('output:stop'), true, trace.join(' → '));
      assert.equal(trace.includes('play:start'), outcome !== 'success', trace.join(' → '));
      if (outcome !== 'success') {
        assert.ok(
          trace.indexOf('output:stop') < trace.indexOf('play:start'),
          trace.join(' → '),
        );
      }
    });
  }
});

test('stale handoff cleanup cannot erase a resumed successor across repeated failed reservations', async () => {
  const playbackAttempts = [];
  const trace = [];
  const radioLayer = {
    setVoiceDucked: () => trace.push('duck'),
    playForVoice: ({ attemptId }) => new Promise((resolve) => {
      playbackAttempts.push({ attemptId, resolve });
      trace.push(`play:${attemptId}`);
    }),
    stopPlayback: ({ attemptId }) => {
      trace.push(`stop:${attemptId}`);
      return true;
    },
  };
  const ui = {
    root: { dataset: {}, classList: { remove() {} }, querySelectorAll: () => [] },
    status: { textContent: '' },
    detail: { textContent: '', title: '' },
    errorDetail: { textContent: '' },
  };
  const controller = new GevRealtimeController({
    ui,
    radioLayer,
    runner: async () => ({ ok: false }),
  });
  controller.debugLog = () => {};
  controller.queueResponseCreate = () => {};
  controller.dc = { readyState: 'open', send() {}, close() {} };
  const preparedResult = {
    ok: true,
    action: 'control_radio',
    radioAction: 'select',
    radioPlaybackRequested: true,
  };
  controller.pendingRadioPlaybackResult = preparedResult;

  const handoffA = controller.startPendingRadioHandoff();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(playbackAttempts.length, 1);

  const reservationA = controller.reserveRadioToolHandoff();
  controller.settleRadioToolHandoffReservation(reservationA, { commit: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(playbackAttempts.length, 2, trace.join(' → '));
  const resumedAttemptId = playbackAttempts[1].attemptId;

  playbackAttempts[0].resolve(true);
  await handoffA;
  assert.equal(controller.radioHandoffInFlight, true);
  assert.equal(controller.radioHandoffAttemptId, resumedAttemptId);
  assert.equal(controller.radioHandoffInFlightResult, preparedResult);

  const reservationB = controller.reserveRadioToolHandoff();
  controller.settleRadioToolHandoffReservation(reservationB, { commit: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(playbackAttempts.length, 3, trace.join(' → '));
  assert.equal(controller.radioHandoffInFlight, true);
  assert.notEqual(controller.radioHandoffAttemptId, resumedAttemptId);
  assert.equal(controller.radioHandoffInFlightResult, preparedResult);

  playbackAttempts[1].resolve(true);
  playbackAttempts[2].resolve(true);
  await new Promise((resolve) => setImmediate(resolve));
});

test('a later same-response stop clears an already prepared playback result', async () => {
  const ui = {
    root: { dataset: {}, classList: { remove() {} }, querySelectorAll: () => [] },
    status: { textContent: '' },
    detail: { textContent: '', title: '' },
    errorDetail: { textContent: '' },
  };
  const controller = new GevRealtimeController({
    ui,
    runner: async (_name, args) => args.action === 'select'
      ? {
        ok: true,
        action: 'control_radio',
        radioAction: 'select',
        radioPlaybackRequested: true,
      }
      : { ok: true, action: 'control_radio', radioAction: 'stop' },
  });
  controller.debugLog = () => {};
  controller.sendVisualContextIfUseful = async () => false;
  controller.dc = { readyState: 'open', send() {}, close() {} };
  const event = (payload) => ({ data: JSON.stringify(payload) });

  await controller.handleRealtimeEvent(event({
    type: 'response.function_call_arguments.done',
    response_id: 'prepared-then-stop',
    call_id: 'prepared-select',
    name: 'control_radio',
    arguments: '{"action":"select"}',
  }));
  assert.equal(controller.pendingRadioPlaybackResult?.radioAction, 'select');
  await controller.handleRealtimeEvent(event({
    type: 'response.function_call_arguments.done',
    response_id: 'prepared-then-stop',
    call_id: 'stop-prepared',
    name: 'control_radio',
    arguments: '{"action":"stop"}',
  }));
  assert.equal(controller.pendingRadioPlaybackResult, null);
});

test('computeDownscale leaves an already-small frame untouched', () => {
  assert.deepEqual(computeDownscale(800, 600, 1200 * 900), { width: 800, height: 600 });
});

test('computeDownscale clamps a huge landscape frame under the pixel budget', () => {
  const maxPx = 1200 * 900; // 1,080,000
  const out = computeDownscale(3840, 2160, maxPx); // 4K, 8.29 MP
  assert.ok(out.width * out.height <= maxPx, `pixels ${out.width * out.height} <= ${maxPx}`);
  // aspect ratio preserved (16:9) within rounding
  assert.ok(Math.abs(out.width / out.height - 3840 / 2160) < 0.01);
});

test('computeDownscale clamps a TALL PORTRAIT frame too (the width-only bug)', () => {
  const maxPx = 1200 * 900;
  // A narrow-but-very-tall portrait window: width alone (1080) would have
  // passed the old 1200px width clamp untouched, but its 1080*3000 = 3.24 MP
  // total blows the budget and must be scaled down.
  const out = computeDownscale(1080, 3000, maxPx);
  assert.ok(out.width * out.height <= maxPx, `portrait pixels ${out.width * out.height} <= ${maxPx}`);
  assert.ok(out.height < 3000, 'height was reduced');
  assert.ok(out.width < 1080, 'width was reduced');
  assert.ok(Math.abs(out.width / out.height - 1080 / 3000) < 0.01, 'aspect preserved');
});

test('computeDownscale never upscales and never returns a zero dimension', () => {
  assert.deepEqual(computeDownscale(10, 10, 1_000_000), { width: 10, height: 10 });
  const tiny = computeDownscale(1, 1, 1);
  assert.ok(tiny.width >= 1 && tiny.height >= 1);
});

test('computeDownscale is defensive against garbage input', () => {
  const out = computeDownscale(0, 0, 0);
  assert.ok(out.width >= 1 && out.height >= 1);
  const nan = computeDownscale(NaN, NaN, NaN);
  assert.ok(nan.width >= 1 && nan.height >= 1);
});

test('estimateDataUrlBytes decodes base64 length minus the data-URL prefix', () => {
  // "AAAA" (4 base64 chars, no padding) = 3 bytes.
  assert.equal(estimateDataUrlBytes('data:image/jpeg;base64,AAAA'), 3);
  // one '=' pad => 2 bytes; two '==' pads => 1 byte
  assert.equal(estimateDataUrlBytes('data:image/jpeg;base64,AAA='), 2);
  assert.equal(estimateDataUrlBytes('data:image/jpeg;base64,AA=='), 1);
});

test('estimateDataUrlBytes handles a raw base64 string with no comma prefix', () => {
  assert.equal(estimateDataUrlBytes('AAAA'), 3);
});

test('estimateDataUrlBytes is safe on non-strings', () => {
  assert.equal(estimateDataUrlBytes(null), 0);
  assert.equal(estimateDataUrlBytes(undefined), 0);
  assert.equal(estimateDataUrlBytes(12345), 0);
});

test('estimateDataUrlBytes flags a payload over the 200KB ceiling', () => {
  const LIMIT = 200 * 1024;
  // ~300 KB of base64 (each char ~0.75 bytes) decodes well over the ceiling.
  const big = 'data:image/jpeg;base64,' + 'A'.repeat(300 * 1024);
  assert.ok(estimateDataUrlBytes(big) > LIMIT);
  // A small one stays under.
  const small = 'data:image/jpeg;base64,' + 'A'.repeat(1024);
  assert.ok(estimateDataUrlBytes(small) < LIMIT);
});

// --- M14: item_not_found from a stale viewport-delete must be non-fatal ---

test('isBenignViewportDeleteError matches an item_not_found by code', () => {
  const payload = { type: 'error', error: { code: 'item_not_found' } };
  assert.equal(isBenignViewportDeleteError(payload, new Set()), true);
});

test('isBenignViewportDeleteError matches an echoed delete event_id even without the code', () => {
  const pending = new Set(['evt_del_abc']);
  const payload = { type: 'error', event_id: 'evt_del_abc', error: { code: 'server_error' } };
  assert.equal(isBenignViewportDeleteError(payload, pending), true);
});

test('isBenignViewportDeleteError does NOT swallow unrelated errors', () => {
  const pending = new Set(['evt_del_abc']);
  // Different code, event_id we never issued → must stay fatal.
  const payload = { type: 'error', event_id: 'evt_other', error: { code: 'invalid_request_error' } };
  assert.equal(isBenignViewportDeleteError(payload, pending), false);
});

test('isBenignViewportDeleteError is false for non-error payloads and junk', () => {
  assert.equal(isBenignViewportDeleteError({ type: 'response.done' }, new Set()), false);
  assert.equal(isBenignViewportDeleteError(null, new Set()), false);
  assert.equal(isBenignViewportDeleteError(undefined), false);
  assert.equal(isBenignViewportDeleteError({ type: 'error' }, new Set()), false);
});


test('hidden document yields no fresh frame — capture must not label a stale canvas Current', async () => {
  const originalDocument = globalThis.document;
  let requested = 0;
  const scene = {
    postRender: { addEventListener() { return () => {}; } },
    requestRender() { requested += 1; },
  };
  try {
    globalThis.document = { hidden: true };
    const fresh = await renderFreshCesiumFrame({ scene });
    assert.equal(fresh, false, 'hidden capture reports non-fresh');
    assert.equal(requested, 0, 'no secret render restart while hidden');
  } finally {
    globalThis.document = originalDocument;
  }
});

test('visible document with a rendering scene reports a fresh frame', async () => {
  const originalDocument = globalThis.document;
  try {
    globalThis.document = { hidden: false };
    let fire = null;
    const scene = {
      postRender: { addEventListener(listener) { fire = listener; return () => { fire = null; }; } },
      requestRender() { queueMicrotask(() => fire?.()); },
    };
    const fresh = await renderFreshCesiumFrame({ scene });
    assert.equal(fresh, true);
  } finally {
    globalThis.document = originalDocument;
  }
});

test('a tab switch during the bounded render wait invalidates freshness', async () => {
  const originalDocument = globalThis.document;
  try {
    const doc = { hidden: false };
    globalThis.document = doc;
    let fire = null;
    const scene = {
      postRender: { addEventListener(listener) { fire = listener; return () => { fire = null; }; } },
      requestRender() { doc.hidden = true; queueMicrotask(() => fire?.()); },
    };
    const fresh = await renderFreshCesiumFrame({ scene });
    assert.equal(fresh, false, 'freshness rechecked after the await');
  } finally {
    globalThis.document = originalDocument;
  }
});

// ---------------------------------------------------------------------------
// Voice cost control — persistence.
// The stored tier picks the OpenAI model id for the next session and the stored
// limits arm the spend cap, so both must survive corruption without either
// throwing or silently disarming the guard.
// ---------------------------------------------------------------------------

/** Minimal in-memory localStorage stand-in. */
function fakeVoiceStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    dump: () => Object.fromEntries(map),
  };
}

test('voice tier round-trips through storage', () => {
  const storage = fakeVoiceStorage();
  assert.equal(writeStoredVoiceTier('mini', storage), 'mini');
  assert.equal(readStoredVoiceTier(storage), 'mini');
  assert.equal(writeStoredVoiceTier('standard', storage), 'standard');
  assert.equal(readStoredVoiceTier(storage), 'standard');
});

test('an unset or hand-edited tier reads back as standard', () => {
  assert.equal(readStoredVoiceTier(fakeVoiceStorage()), 'standard');
  assert.equal(
    readStoredVoiceTier(fakeVoiceStorage({ 'godsEyeView.voiceCost.tier': 'gpt-4o' })),
    'standard'
  );
  assert.equal(
    readStoredVoiceTier(fakeVoiceStorage({ 'godsEyeView.voiceCost.tier': '__proto__' })),
    'standard'
  );
});

test('writing a bogus tier persists the safe fallback, not the bogus value', () => {
  const storage = fakeVoiceStorage();
  assert.equal(writeStoredVoiceTier('turbo', storage), 'standard');
  assert.equal(storage.dump()['godsEyeView.voiceCost.tier'], 'standard');
});

test('a storage that throws never breaks the mic', () => {
  const hostile = {
    getItem() {
      throw new Error('SecurityError');
    },
    setItem() {
      throw new Error('SecurityError');
    },
  };
  assert.equal(readStoredVoiceTier(hostile), 'standard');
  assert.equal(writeStoredVoiceTier('mini', hostile), 'mini');
  assert.deepEqual(readStoredVoiceLimits(hostile), { warnUsd: 2, capUsd: 5 });
});

test('spend limits round-trip as one object', () => {
  const storage = fakeVoiceStorage();
  writeStoredVoiceLimits({ warnUsd: 1, capUsd: 3 }, storage);
  assert.deepEqual(readStoredVoiceLimits(storage), { warnUsd: 1, capUsd: 3 });
});

test('corrupt stored limits fall back to defaults rather than disarming the cap', () => {
  // A disarmed cap is the dangerous failure — assert we land on the default,
  // not on Infinity.
  const limits = readStoredVoiceLimits(
    fakeVoiceStorage({ 'godsEyeView.voiceCost.limits': '{oops' })
  );
  assert.deepEqual(limits, { warnUsd: 2, capUsd: 5 });
});

test('partially stored limits keep the default for the missing threshold', () => {
  const limits = readStoredVoiceLimits(
    fakeVoiceStorage({ 'godsEyeView.voiceCost.limits': '{"warnUsd":0.5}' })
  );
  assert.deepEqual(limits, { warnUsd: 0.5, capUsd: 5 });
});

test('a disabled threshold survives the storage round-trip', () => {
  // Infinity JSON-serializes to null, which reads back as "absent" and restores
  // the DEFAULT — silently re-arming a cap the user turned off. The 'off'
  // sentinel is what makes disabling persist.
  const storage = fakeVoiceStorage();
  writeStoredVoiceLimits({ warnUsd: 0, capUsd: 0 }, storage);
  const raw = storage.dump()['godsEyeView.voiceCost.limits'];
  assert.ok(!raw.includes('null'), `must not persist null: ${raw}`);
  const restored = readStoredVoiceLimits(storage);
  assert.equal(restored.warnUsd, Infinity);
  assert.equal(restored.capUsd, Infinity);
});

test('one disabled and one live threshold both round-trip', () => {
  const storage = fakeVoiceStorage();
  writeStoredVoiceLimits({ warnUsd: 0, capUsd: 7 }, storage);
  const restored = readStoredVoiceLimits(storage);
  assert.equal(restored.warnUsd, Infinity);
  assert.equal(restored.capUsd, 7);
});

// ---------------------------------------------------------------------------
// Voice cost control — REAL handlers driven by a mocked Realtime event stream.
// These exercise updateResponseState / handleRealtimeEvent / stop() rather than
// the pure module, because the bugs they pin were all in the wiring.
// ---------------------------------------------------------------------------

/** Usage worth exactly $`usd` on STANDARD rates (audio out is $64/1M). */
const usdUsage = (usd) => ({
  input_tokens: 0,
  output_tokens: 15625 * usd,
  output_token_details: { text_tokens: 0, audio_tokens: 15625 * usd },
});

/** A controller wired to inert UI stubs, with the cost surface present. */
function costControllerHarness({ runner } = {}) {
  const toolCalls = [];
  const ui = {
    root: { dataset: {}, classList: { remove() {}, add() {} }, querySelectorAll: () => [] },
    status: { textContent: '' },
    detail: { textContent: '', title: '' },
    errorDetail: { textContent: '' },
    button: { dataset: {} },
    buttonLabel: { textContent: '' },
    tierButton: {
      textContent: '',
      title: '',
      attrs: {},
      setAttribute(key, value) { this.attrs[key] = value; },
      getAttribute(key) { return this.attrs[key] ?? null; },
    },
    costValue: { textContent: '', title: '', dataset: {} },
  };
  const controller = new GevRealtimeController({
    ui,
    runner: runner || (async (name) => { toolCalls.push(name); return { ok: true }; }),
  });
  controller.debugLog = () => {};
  controller.updateVoiceButtonLabel = () => {};
  return { controller, ui, toolCalls };
}

const doneEvent = (usage) => ({
  data: JSON.stringify({
    type: 'response.done',
    response: { id: 'r1', status: 'completed', usage },
  }),
});

const fnCallEvent = (name, itemId, callId) => ({
  data: JSON.stringify({
    type: 'response.function_call_arguments.done',
    item_id: itemId,
    call_id: callId,
    name,
    arguments: '{}',
  }),
});

test('F1: toggling tier mid-session does not erase accrued spend', () => {
  const { controller } = costControllerHarness();
  controller.status = 'listening'; // live session
  controller.costTracker = createVoiceCostTracker({
    modelId: 'gpt-realtime-2',
    limits: { warnUsd: 2, capUsd: 5 },
  });
  controller.recordUsage(usdUsage(3));
  assert.ok(Math.abs(controller.costTracker.state().totalUsd - 3) < 1e-9);

  controller.setVoiceTier('mini');

  const after = controller.costTracker.state();
  assert.ok(Math.abs(after.totalUsd - 3) < 1e-9, `accrued spend survived: ${after.totalUsd}`);
  assert.equal(after.modelId, 'gpt-realtime-2', 'session keeps its original model binding');
});

test('F1: the cap still fires after a mid-session toggle, at the original rates', () => {
  // The bug this pins: rebuilding the tracker on toggle reset the meter, so
  // repeated toggles could hold a session under the cap forever.
  const { controller } = costControllerHarness();
  controller.status = 'listening';
  controller.costTracker = createVoiceCostTracker({
    modelId: 'gpt-realtime-2',
    limits: { warnUsd: 2, capUsd: 5 },
  });
  for (let i = 0; i < 4; i += 1) {
    controller.recordUsage(usdUsage(1));
    controller.setVoiceTier(i % 2 === 0 ? 'mini' : 'standard'); // toggle spam
  }
  assert.equal(controller.costTracker.state().capReached, false, '$4 is under the cap');
  controller.recordUsage(usdUsage(1)); // $5 — crosses
  assert.equal(controller.costTracker.state().capReached, true);
  assert.equal(controller.isSessionEnding(), true);
});

test('F1: the toggle still records the next-session preference while live', () => {
  const { controller, ui } = costControllerHarness();
  controller.status = 'listening';
  controller.setVoiceTier('mini');
  assert.equal(controller.voiceTier, 'mini');
  assert.equal(ui.tierButton.textContent, 'MINI');
  // ...and says so, rather than implying the live session switched.
  assert.match(ui.tierButton.title, /this session stays on/i);
});

test('F1: when idle, toggling does re-price the preview meter', () => {
  const { controller } = costControllerHarness();
  controller.status = 'idle';
  controller.setVoiceTier('mini');
  assert.equal(controller.costTracker.state().modelId, 'gpt-realtime-2.1-mini');
});

test('F4: once the cap latches, queued function calls do not execute', async () => {
  const { controller, toolCalls } = costControllerHarness();
  controller.status = 'listening';
  controller.costCapStopped = true; // latched by a prior cap
  await controller.handleRealtimeEvent({
    data: JSON.stringify({
      type: 'response.function_call_arguments.done',
      item_id: 'i1',
      call_id: 'c1',
      name: 'fly_to_location',
      arguments: '{"query":"London"}',
    }),
  });
  assert.deepEqual(toolCalls, [], 'no map mutation after the session ended');
});

test('F4: a cap between tool events stops every later tool', async () => {
  // The real sequence this guards. Function-call events arrive BEFORE the
  // response.done that carries usage, so tool N runs, the cap then trips, and
  // tool N+1 must not dispatch. extractFunctionCalls yields at most one call
  // per event, so this across-events path is the only reachable one — the
  // single pre-loop gate covers it, and there is no per-iteration check.
  const executed = [];
  const { controller } = costControllerHarness({
    runner: async (name) => { executed.push(name); return { ok: true }; },
  });
  controller.status = 'listening';
  controller.dc = { readyState: 'open', send() {}, close() {} };
  controller.costTracker = createVoiceCostTracker({
    modelId: 'gpt-realtime-2',
    limits: { warnUsd: 2, capUsd: 5 },
  });

  await controller.handleRealtimeEvent(fnCallEvent('set_hud', 'i1', 'c1'));
  assert.deepEqual(executed, ['set_hud'], 'healthy session executes normally');

  await controller.handleRealtimeEvent(doneEvent(usdUsage(9))); // trips the cap
  assert.equal(controller.isSessionEnding(), true);

  await controller.handleRealtimeEvent(fnCallEvent('fly_to_location', 'i2', 'c2'));
  assert.deepEqual(executed, ['set_hud'], 'no map mutation dispatched after the cap');
});

test('F4: tools DO execute normally while the session is healthy', async () => {
  // Guards the gate against being trivially always-on.
  const { controller, toolCalls } = costControllerHarness();
  controller.status = 'listening';
  controller.dc = { readyState: 'open', send() {}, close() {} };
  await controller.handleRealtimeEvent({
    data: JSON.stringify({
      type: 'response.function_call_arguments.done',
      item_id: 'i2',
      call_id: 'c2',
      name: 'fly_to_location',
      arguments: '{"query":"London"}',
    }),
  });
  assert.deepEqual(toolCalls, ['fly_to_location']);
});

test('F4: an output_item.done arriving after the cap does not execute either', async () => {
  // The other extractor path (response.output_item.done), same guarantee.
  const { controller, toolCalls } = costControllerHarness();
  controller.status = 'listening';
  controller.dc = { readyState: 'open', send() {}, close() {} };
  controller.costCapStopped = true;
  await controller.handleRealtimeEvent({
    data: JSON.stringify({
      type: 'response.output_item.done',
      item: {
        type: 'function_call',
        id: 'i4',
        call_id: 'c4',
        name: 'set_layer_visibility',
        arguments: '{"layerId":"flights","enabled":true}',
      },
    }),
  });
  assert.deepEqual(toolCalls, []);
});

test('F5: teardown always closes the channel, in one step', () => {
  // The drain that used to live here could not work: stop() closes the peer
  // connection immediately after, which closes the data channels a drain would
  // listen on. Teardown is now unconditional and single-step.
  const { controller } = costControllerHarness();
  controller.status = 'listening';
  let closed = false;
  let pcClosed = false;
  controller.responseActive = true;
  controller.dc = { readyState: 'open', send() {}, close() { closed = true; } };
  controller.pc = { close() { pcClosed = true; } };
  controller.stop();
  assert.equal(closed, true, 'data channel closed');
  assert.equal(pcClosed, true, 'peer connection closed');
  assert.equal(controller.dc, null);
  assert.equal(controller.pc, null);
});

test('F5: a response in flight at teardown marks the accounting INCOMPLETE', () => {
  // We have no token telemetry for an unfinished response, so we flag the
  // accounting as partial rather than inventing a number for it. Deliberately
  // not framed as a floor — the estimate can also run high.
  const { controller } = costControllerHarness();
  controller.status = 'listening';
  controller.costTracker = createVoiceCostTracker({
    modelId: 'gpt-realtime-2',
    limits: { warnUsd: 2, capUsd: 5 },
  });
  controller.recordUsage(usdUsage(1));
  controller.responseActive = true;
  controller.dc = { readyState: 'open', send() {}, close() {} };
  controller.stop();
  const state = controller.costTracker.state();
  assert.equal(state.incomplete, true);
  assert.equal(state.display, '~$1.00*', 'see-note mark, not a direction claim');
  assert.match(state.note, /incomplete/i, 'the tooltip explains why');
  assert.doesNotMatch(state.note, /at least|lower bound|floor/i, 'no floor claim');
});

test('F5: a clean teardown does not mark the total incomplete', () => {
  const { controller } = costControllerHarness();
  controller.status = 'listening';
  controller.costTracker = createVoiceCostTracker({ modelId: 'gpt-realtime-2' });
  controller.recordUsage(usdUsage(1));
  controller.responseActive = false;
  controller.dc = { readyState: 'open', send() {}, close() {} };
  controller.stop();
  assert.equal(controller.costTracker.state().incomplete, false);
  assert.equal(controller.costTracker.state().display, '~$1.00');
  assert.equal(controller.costTracker.state().note, null, 'no note when complete');
});

test('F2/F5: no stray message listener survives teardown to double-meter', () => {
  // The removed drain attached a SECOND 'message' listener while the normal
  // handler stayed attached, so a late response.done was metered twice.
  const { controller } = costControllerHarness();
  controller.status = 'listening';
  const added = [];
  controller.responseActive = true;
  controller.dc = {
    readyState: 'open',
    send() {},
    close() {},
    addEventListener(type) { added.push(type); },
    removeEventListener() {},
  };
  controller.stop();
  assert.deepEqual(added, [], 'teardown attaches no new listeners');
});

test('F3: setVoiceTier does NOT rebuild the tracker while transport is live', () => {
  // 'error' reports !isActive() but can still hold an open channel delivering a
  // late response.done — rebuilding there sends that usage to a preview tracker.
  const { controller } = costControllerHarness();
  controller.costTracker = createVoiceCostTracker({
    modelId: 'gpt-realtime-2',
    limits: { warnUsd: 2, capUsd: 5 },
  });
  controller.recordUsage(usdUsage(3));
  controller.status = 'error';
  controller.dc = { readyState: 'open', send() {}, close() {} };
  assert.equal(controller.isVoiceSessionSettled(), false);

  controller.setVoiceTier('mini');

  const state = controller.costTracker.state();
  assert.ok(Math.abs(state.totalUsd - 3) < 1e-9, `spend survived: ${state.totalUsd}`);
  assert.equal(state.modelId, 'gpt-realtime-2');
});

test('F3: once fully settled, setVoiceTier does rebuild the preview tracker', () => {
  const { controller } = costControllerHarness();
  controller.status = 'idle';
  controller.dc = null;
  controller.pc = null;
  assert.equal(controller.isVoiceSessionSettled(), true);
  controller.setVoiceTier('mini');
  assert.equal(controller.costTracker.state().modelId, 'gpt-realtime-2.1-mini');
});

test('F4: two clicks during a live session return to the original preference', () => {
  // The bug: toggleVoiceTier() derived the next tier from the immutable live
  // TRACKER, so every click during a standard session selected 'mini' again.
  const { controller, ui } = costControllerHarness();
  controller.status = 'listening';
  controller.costTracker = createVoiceCostTracker({ modelId: 'gpt-realtime-2' });
  controller.voiceTier = 'standard';

  controller.toggleVoiceTier();
  assert.equal(controller.voiceTier, 'mini', 'first click switches to mini');

  controller.toggleVoiceTier();
  assert.equal(controller.voiceTier, 'standard', 'second click switches back');
  assert.equal(ui.tierButton.textContent, 'STD');
});

test('F4: the toggle alternates across many clicks mid-session', () => {
  const { controller } = costControllerHarness();
  controller.status = 'listening';
  controller.costTracker = createVoiceCostTracker({ modelId: 'gpt-realtime-2' });
  controller.voiceTier = 'standard';
  const seen = [];
  for (let i = 0; i < 4; i += 1) seen.push(controller.toggleVoiceTier());
  assert.deepEqual(seen, ['mini', 'standard', 'mini', 'standard']);
});

test('F3: an unrecognised session model bills at the most expensive known rates', () => {
  // An env override can point a tier at any model id; pricing it cheap (or
  // free) is what lets a cap be overrun.
  const tracker = createVoiceCostTracker({
    modelId: 'gpt-realtime-9-experimental',
    limits: { warnUsd: 2, capUsd: 5 },
  });
  assert.equal(tracker.state().ratesRecognized, false);
  const standard = createVoiceCostTracker({ modelId: 'gpt-realtime-2' });
  const unknownCost = tracker.record(usdUsage(1)).totalUsd;
  const standardCost = standard.record(usdUsage(1)).totalUsd;
  assert.ok(unknownCost >= standardCost, 'never cheaper than the priciest known model');
});

/**
 * The Realtime API rejects a second concurrent `response.create`
 * (`conversation_already_has_active_response`) and the rejected turn is lost.
 * Every client trigger goes through the in-flight guard except the typed-command
 * path, which fired straight out — so a typed command landing mid-answer was
 * silently dropped instead of answered.
 */
function textCommandController() {
  const sent = [];
  const controller = new GevRealtimeController({
    ui: {},
    runner: async () => ({}),
  });
  controller.dc = { readyState: 'open' };
  controller.sendRealtimeEvent = (event, label) => {
    sent.push(label || event?.type);
    return true;
  };
  controller.debugLog = () => {};
  controller.cancelRadioHandoff = () => {};
  return { controller, sent };
}

test('a typed command mid-response defers its turn instead of colliding', () => {
  const { controller, sent } = textCommandController();
  controller.responseActive = true;
  controller.sendTextCommand('zoom to the globe');
  assert.deepEqual(sent, ['client.user_text'], 'no second response.create while one is active');
  assert.equal(controller.pendingUserTextResponse, true);
});

test('the deferred typed turn is answered once when the active response finishes', () => {
  const { controller, sent } = textCommandController();
  controller.responseActive = true;
  controller.sendTextCommand('zoom to the globe');
  controller.setVoiceSpeaker = () => {};
  controller.recordUsage = () => {};
  controller.updateResponseState({ type: 'response.done', response: { status: 'completed' } });
  assert.deepEqual(sent, ['client.user_text', 'client.response_create.user_text']);
  assert.equal(controller.pendingUserTextResponse, false);
  // A second completion must not produce a second answer to the same command.
  controller.updateResponseState({ type: 'response.done', response: { status: 'completed' } });
  assert.deepEqual(sent, ['client.user_text', 'client.response_create.user_text']);
});

test('a typed command with nothing in flight is answered immediately', () => {
  const { controller, sent } = textCommandController();
  controller.sendTextCommand('zoom to the globe');
  assert.deepEqual(sent, ['client.user_text', 'client.response_create.user_text']);
  assert.equal(controller.responseCreatePending, true);
});

test('an overlapping-response rejection is dropped, never replayed', () => {
  const { controller, sent } = textCommandController();
  controller.responseActive = true;
  controller.sendTextCommand('zoom to the globe');
  controller.setStatus = () => {};
  controller.handleRealtimeEvent({
    data: JSON.stringify({
      type: 'error',
      error: { type: 'invalid_request_error', code: 'conversation_already_has_active_response' },
    }),
  });
  assert.equal(controller.pendingUserTextResponse, false, 'a rejected turn must not re-arm itself');
  controller.setVoiceSpeaker = () => {};
  controller.recordUsage = () => {};
  controller.updateResponseState({ type: 'response.done', response: { status: 'completed' } });
  assert.deepEqual(sent, ['client.user_text'], 'and must not speak the same turn again');
});

/** A late function call from response `responseId`, as the server sends it. */
function lateToolEvent(responseId, callId) {
  return {
    data: JSON.stringify({
      type: 'response.function_call_arguments.done',
      response_id: responseId,
      call_id: callId,
      name: 'fly_to_location',
      arguments: '{"query":"Paris"}',
    }),
  };
}

/** Wire the dispatch collaborators a bare controller does not have in a unit test. */
function toolDispatchController() {
  const { controller, sent } = textCommandController();
  const dispatched = [];
  controller.runner = async (name) => { dispatched.push(name); return { ok: true }; };
  controller.setStatus = () => {};
  controller.setVoiceSpeaker = () => {};
  controller.recordUsage = () => {};
  controller.captureViewportScreenshot = async () => null;
  return { controller, sent, dispatched };
}

test('CONTROL: a live response’s function call is dispatched normally', async () => {
  const { controller, dispatched } = toolDispatchController();
  controller.updateResponseState({ type: 'response.created', response: { id: 'resp_live' } });
  await controller.handleRealtimeEvent(lateToolEvent('resp_live', 'call_live'));
  assert.deepEqual(dispatched, ['fly_to_location'], 'the guard must not block ordinary tool calls');
});

test('a typed command supersedes the old response, so its late tools never fire', async () => {
  const { controller, sent, dispatched } = toolDispatchController();
  controller.updateResponseState({ type: 'response.created', response: { id: 'resp_old' } });
  assert.equal(controller.activeResponseId, 'resp_old');

  controller.sendTextCommand('stop');
  assert.equal(controller.isSupersededResponse('resp_old'), true);

  // The same event the control case dispatched, now belonging to a turn the
  // operator has replaced.
  await controller.handleRealtimeEvent(lateToolEvent('resp_old', 'call_stale'));
  assert.deepEqual(dispatched, [], 'a stale turn must not mutate the map after a newer command');
  // The call is REFUSED, not ignored: it is still answered (see the terminal
  // output pin below), but nothing about it creates a response.
  assert.deepEqual(sent, ['client.user_text', 'client.function_call_output']);
  assert.equal(
    sent.filter((label) => label.startsWith('client.response_create')).length,
    0,
    'the refusal must not produce an answer of its own',
  );
});

test('a typed command drops the old response’s queued follow-up confirmation', () => {
  const { controller, sent } = textCommandController();
  controller.setVoiceSpeaker = () => {};
  controller.recordUsage = () => {};
  controller.updateResponseState({ type: 'response.created', response: { id: 'resp_old' } });
  controller.queueResponseCreate('Briefly confirm the completed GEV action once.');
  assert.ok(controller.pendingResponseInstructions, 'a follow-up is queued behind the active response');

  controller.sendTextCommand('stop');
  assert.equal(
    controller.pendingResponseInstructions,
    null,
    'the stale confirmation is dropped — the typed turn is the single answer now',
  );

  controller.updateResponseState({ type: 'response.done', response: { status: 'completed' } });
  assert.deepEqual(
    sent,
    ['client.user_text', 'client.response_create.user_text'],
    'exactly one response follows, and it answers the newest command',
  );
});

test('a burst of typed commands coalesces into one answer, keeping both items', () => {
  // Deliberate policy, pinned so it cannot drift: both commands stay in the
  // conversation so the model sees the full intent, but they share one
  // response rather than racing two.
  const { controller, sent } = textCommandController();
  controller.setVoiceSpeaker = () => {};
  controller.recordUsage = () => {};
  controller.responseActive = true;
  controller.sendTextCommand('zoom to the globe');
  controller.sendTextCommand('actually, show me Texas');
  assert.deepEqual(sent, ['client.user_text', 'client.user_text'], 'both items are kept');

  controller.updateResponseState({ type: 'response.done', response: { status: 'completed' } });
  assert.deepEqual(sent, [
    'client.user_text',
    'client.user_text',
    'client.response_create.user_text',
  ], 'and exactly one response covers the burst');
});

test('a live response is untouched when no typed command superseded it', () => {
  const { controller } = textCommandController();
  controller.setVoiceSpeaker = () => {};
  controller.recordUsage = () => {};
  controller.updateResponseState({ type: 'response.created', response: { id: 'resp_live' } });
  assert.equal(controller.isSupersededResponse('resp_live'), false);
  assert.equal(controller.isSupersededResponse(null), false, 'an unattributed call is not stale');
});

test('a refused superseded call is still answered with a terminal output', async () => {
  // Every function call must be answered. Leaving one unanswered strands a
  // pending call in the conversation and deadlocks the model — the same hazard
  // callDedupeKeys is written to avoid. Refusing is not ignoring.
  const { controller, sent, dispatched } = toolDispatchController();
  const outputs = [];
  controller.sendToolOutput = (callId, result) => {
    outputs.push({ callId, result });
    sent.push('client.function_call_output');
    return true;
  };
  controller.updateResponseState({ type: 'response.created', response: { id: 'resp_old' } });
  controller.sendTextCommand('stop');
  await controller.handleRealtimeEvent(lateToolEvent('resp_old', 'call_stale'));

  assert.deepEqual(dispatched, [], 'the stale tool still must not run');
  assert.equal(outputs.length, 1, 'exactly one terminal output for the refused call');
  assert.equal(outputs[0].callId, 'call_stale');
  assert.equal(outputs[0].result.ok, false);
  assert.equal(outputs[0].result.superseded, true);
  assert.equal(outputs[0].result.action, 'fly_to_location');
  assert.ok(/superseded/i.test(outputs[0].result.error), 'and it says plainly why');
  assert.equal(
    sent.filter((label) => label === 'client.response_create.tool_followup').length,
    0,
    'a refused call must not create a response of its own',
  );
});

/** The OTHER server surface for the same call: response.output_item.done. */
function lateToolItemEvent(responseId, callId, itemId = 'item_stale') {
  return {
    data: JSON.stringify({
      type: 'response.output_item.done',
      response_id: responseId,
      item: {
        type: 'function_call',
        id: itemId,
        call_id: callId,
        name: 'fly_to_location',
        arguments: '{"query":"Paris"}',
      },
    }),
  };
}

test('the two server surfaces of one refused call collapse to a single output', async () => {
  // The same call arrives as BOTH response.function_call_arguments.done and
  // response.output_item.done. Replaying one type twice would only prove the
  // event is idempotent; the collapse that matters is across surfaces, since
  // two outputs for one call_id is its own protocol error.
  const { controller } = toolDispatchController();
  const outputs = [];
  controller.sendToolOutput = (callId) => { outputs.push(callId); return true; };
  controller.updateResponseState({ type: 'response.created', response: { id: 'resp_old' } });
  controller.sendTextCommand('stop');
  await controller.handleRealtimeEvent(lateToolEvent('resp_old', 'call_stale'));
  await controller.handleRealtimeEvent(lateToolItemEvent('resp_old', 'call_stale'));
  assert.deepEqual(outputs, ['call_stale'], 'exactly one output across both surfaces');
});

test('a genuinely different refused call still gets its own output', async () => {
  // The collapse must key on call identity, not on "we already refused one".
  const { controller } = toolDispatchController();
  const outputs = [];
  controller.sendToolOutput = (callId) => { outputs.push(callId); return true; };
  controller.updateResponseState({ type: 'response.created', response: { id: 'resp_old' } });
  controller.sendTextCommand('stop');
  await controller.handleRealtimeEvent(lateToolEvent('resp_old', 'call_one'));
  await controller.handleRealtimeEvent(lateToolItemEvent('resp_old', 'call_two', 'item_two'));
  assert.deepEqual(outputs, ['call_one', 'call_two'], 'each distinct call is answered');
});
