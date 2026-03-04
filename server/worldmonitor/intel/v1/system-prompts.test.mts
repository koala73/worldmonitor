import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_SYSTEM_PROMPT, BRIEFING_SYSTEM_PROMPT, INTEL_DISCLAIMER } from './system-prompts.ts';

describe('system-prompts', () => {
  it('CHAT_SYSTEM_PROMPT is non-empty and contains key instructions', () => {
    assert.ok(CHAT_SYSTEM_PROMPT.length > 100, 'Chat prompt should be substantial');
    assert.ok(CHAT_SYSTEM_PROMPT.includes('中文'), 'Should mention Chinese language');
    assert.ok(CHAT_SYSTEM_PROMPT.includes('数据'), 'Should mention data');
  });

  it('BRIEFING_SYSTEM_PROMPT contains all 5 framework sections', () => {
    assert.ok(BRIEFING_SYSTEM_PROMPT.includes('热点地区'), 'Should have hotspot section');
    assert.ok(BRIEFING_SYSTEM_PROMPT.includes('金融市场'), 'Should have financial section');
    assert.ok(BRIEFING_SYSTEM_PROMPT.includes('旅行安全'), 'Should have travel safety section');
    assert.ok(BRIEFING_SYSTEM_PROMPT.includes('预测市场'), 'Should have prediction section');
    assert.ok(BRIEFING_SYSTEM_PROMPT.includes('值得关注'), 'Should have watchlist section');
  });

  it('INTEL_DISCLAIMER mentions AI-generated', () => {
    assert.ok(INTEL_DISCLAIMER.includes('AI'), 'Disclaimer should mention AI');
    assert.ok(INTEL_DISCLAIMER.length > 20, 'Disclaimer should be meaningful');
  });
});
