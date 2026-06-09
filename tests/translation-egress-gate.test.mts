import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';

// Guardrail (source-grep, mirrors finance-guide-briefs fail-open tests) for the
// cloud-translation egress gate. Codex security review (2026-06-09) flagged that
// the gate must run BEFORE any remote translation so that turning the setting off
// stops ALL external egress (LLM providers + Google public endpoint), not just gtx.
const summarizationSource = readFileSync(
  new URL('../src/services/summarization.ts', import.meta.url),
  'utf8',
);

describe('cloud-translation egress gate', () => {
  it('gates translateText on AiFlowSettings.cloudTranslation', () => {
    assert.match(summarizationSource, /export async function translateText\(/);
    assert.match(summarizationSource, /if \(!getAiFlowSettings\(\)\.cloudTranslation\) \{/);
  });

  it('places the gate BEFORE the cloud provider loop and the public-translate call', () => {
    const gateIdx = summarizationSource.indexOf(
      'if (!getAiFlowSettings().cloudTranslation) {',
    );
    const providerLoopIdx = summarizationSource.indexOf(
      'for (const [i, providerDef] of API_PROVIDERS.entries())',
    );
    const publicTranslateCallIdx = summarizationSource.indexOf(
      'await tryPublicTranslate(text, targetLang)',
    );
    assert.ok(gateIdx > 0, 'translateText gate must exist');
    assert.ok(providerLoopIdx > 0, 'provider loop must exist');
    assert.ok(publicTranslateCallIdx > 0, 'public translate call must exist');
    // Gate must precede ALL remote translation paths.
    assert.ok(
      gateIdx < providerLoopIdx,
      'cloudTranslation gate must run before the LLM provider loop',
    );
    assert.ok(
      gateIdx < publicTranslateCallIdx,
      'cloudTranslation gate must run before the public (gtx) translate call',
    );
  });

  it('falls back to on-device translation only (no remote egress) when disabled', () => {
    // The disabled branch returns tryBrowserTranslate (local mlWorker), never a
    // remote fetch / provider RPC.
    assert.match(
      summarizationSource,
      /if \(!getAiFlowSettings\(\)\.cloudTranslation\) \{[\s\S]*?return tryBrowserTranslate\(text, targetLang\);[\s\S]*?\}/,
    );
  });

  it('keeps a defense-in-depth gate + length guard inside tryPublicTranslate', () => {
    // Even if reached directly, the gtx call is independently gated and bounded.
    const fnIdx = summarizationSource.indexOf('async function tryPublicTranslate(');
    const gtxIdx = summarizationSource.indexOf('translate.googleapis.com');
    const innerGateIdx = summarizationSource.indexOf(
      'if (!getAiFlowSettings().cloudTranslation) return null;',
    );
    const lenGuardIdx = summarizationSource.indexOf('if (text.length > 5000) return null;');
    assert.ok(innerGateIdx > fnIdx && innerGateIdx < gtxIdx, 'inner cloudTranslation gate precedes the gtx fetch');
    assert.ok(lenGuardIdx > fnIdx && lenGuardIdx < gtxIdx, 'length guard precedes the gtx fetch');
  });
});
