/**
 * Mission picker reach (plan 2026-08-30-001, U3 / KTD4).
 *
 * Source-extraction guards, same pattern as funnel-analytics-policy: these
 * wiring invariants are cheap to delete in a refactor and expensive to notice
 * — each one going missing silently closes a path onto the mission picker or
 * blinds a funnel segment.
 *
 * Contract under test:
 *  1. Auto-open stays conservative (KTD4): desktop-only, clean-URL-only,
 *     never over a stored preset or a dismissal.
 *  2. Manual desktop access is unconditional — the #missionPresetBtn click
 *     handler carries no device or query-string gate, so campaign-link
 *     visitors can still open the picker by hand.
 *  3. Mobile access exists: panel-layout renders #mobileMenuMission and
 *     mobile-primary-nav routes its click to the openMission callback.
 *  4. Every open path emits mission-picker-shown from the single emission
 *     site, with the auto-open tagged 'auto' and the WebMCP entry 'agent'.
 *  5. Preset application emits mission-selected, with the WebMCP apply
 *     tagged 'agent' so the human funnel reads clean.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

const eventHandlers = read('src/app/event-handlers.ts');
const panelLayout = read('src/app/panel-layout.ts');
const mobileNav = read('src/app/mobile-primary-nav.ts');

function section(src: string, startMarker: string, length = 1200): string {
  const start = src.indexOf(startMarker);
  assert.ok(start >= 0, `marker not found: ${startMarker}`);
  return src.slice(start, start + length);
}

describe('auto-open gate stays conservative (KTD4)', () => {
  it('prompts only on desktop, clean URLs, no stored preset, no dismissal', () => {
    const gate = section(eventHandlers, 'const shouldPrompt =', 300);
    for (const condition of [
      '!this.ctx.isMobile',
      '!window.location.search',
      '!loadStoredMissionPreset()',
      '!isMissionPresetPromptDismissed()',
    ]) {
      assert.ok(gate.includes(condition), `auto-open gate lost condition: ${condition}`);
    }
  });

  it('tags the deferred auto-open as trigger "auto"', () => {
    assert.ok(
      eventHandlers.includes("this.openMissionPresetPopover(document.getElementById('missionPresetBtn'), false, 'auto')"),
      'auto-open no longer passes the auto trigger — funnel cannot separate auto from manual opens',
    );
  });
});

describe('manual reach', () => {
  it('desktop button toggles the picker with no query-string or device gate', () => {
    const wiring = section(eventHandlers, "getElementById('missionPresetBtn')?.addEventListener('click'", 300);
    assert.ok(wiring.includes('toggleMissionPresetPopover'), 'desktop manual trigger lost');
    assert.ok(!wiring.includes('location.search'), 'manual open must not be gated on query strings');
    assert.ok(!wiring.includes('isMobile'), 'manual open must not be gated on device class');
  });

  it('mobile menu renders a mission item and routes it to the picker', () => {
    assert.ok(panelLayout.includes('id="mobileMenuMission"'), 'mobile menu mission item no longer rendered');
    const wiring = section(mobileNav, "getElementById('mobileMenuMission')?.addEventListener('click'", 300);
    assert.ok(wiring.includes('openMission'), 'mobile mission item no longer opens the picker');
  });
});

describe('funnel emission sites', () => {
  it('openMissionPresetPopover is the single mission-picker-shown emitter', () => {
    const open = section(eventHandlers, 'private openMissionPresetPopover(', 900);
    assert.ok(open.includes('trackMissionPickerShown(trigger'), 'picker-shown emission lost from the open path');
    assert.equal(
      eventHandlers.split('trackMissionPickerShown(').length - 1,
      1,
      'picker-shown must have exactly one emission site (the open path) so triggers stay consistent',
    );
  });

  it('the WebMCP picker entry is tagged agent', () => {
    const webmcp = section(eventHandlers, 'openMissionPresetPickerForWebMcp', 500);
    assert.ok(webmcp.includes("'agent'"), 'WebMCP picker open must be tagged agent');
  });

  it('applyMissionPreset emits mission-selected once, after the preset is saved', () => {
    const apply = section(eventHandlers, 'private applyMissionPreset(', 1600);
    assert.ok(apply.includes('trackMissionSelected(applied.preset.id, source)'),
      'mission-selected emission lost from the apply pipeline');
    const saveIdx = apply.indexOf('saveMissionPreset(');
    const trackIdx = apply.indexOf('trackMissionSelected(');
    assert.ok(saveIdx >= 0 && trackIdx > saveIdx, 'mission-selected must fire after the preset persists');
  });

  it('the WebMCP apply passes source "agent"', () => {
    assert.ok(eventHandlers.includes("this.applyMissionPreset(presetId, 'agent')"),
      'WebMCP-applied presets must be tagged agent so the human funnel reads clean');
  });

  it('late-mounted panels join the panel-view observer', () => {
    const tracking = section(eventHandlers, 'setupPanelViewTracking(): void', 1400);
    assert.ok(tracking.includes('MutationObserver'),
      'panel-view tracking lost its late-mount observer — mission-applied panels would leave the denominator');
  });
});
