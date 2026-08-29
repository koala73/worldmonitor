import { describe, it, expect } from 'vitest';
import { createBootMachine, FINAL_STAGE, STAGES } from './machine';

describe('boot machine', () => {
  it('runs the stages in order', () => {
    const m = createBootMachine();
    const seen = [m.stage()];
    while (!m.done()) seen.push(m.advance());
    expect(seen).toEqual([...STAGES]);
  });

  it('starts powered on and ends at the globe', () => {
    expect(STAGES[0]).toBe('POWER_ON');
    expect(FINAL_STAGE).toBe('GLOBE_REVEAL');
  });

  it('lands on the final stage when skipped from any stage', () => {
    for (let i = 0; i < STAGES.length; i++) {
      const m = createBootMachine();
      for (let j = 0; j < i; j++) m.advance();
      expect(m.skip()).toBe(FINAL_STAGE);
      expect(m.done()).toBe(true);
    }
  });

  it('cannot advance past the end', () => {
    const m = createBootMachine();
    m.skip();
    expect(m.advance()).toBe(FINAL_STAGE);
  });

  it('jumps forward past the stages the short boot does not play', () => {
    const m = createBootMachine();
    expect(m.jumpTo('SHRINK_TO_O')).toBe('SHRINK_TO_O');
    expect(m.advance()).toBe('TITLE');
  });

  it('never jumps backwards', () => {
    // The handoff is the end of the sequence. A jump that could reverse would
    // let a late stage change re-enter the ceremony after the globe is live.
    const m = createBootMachine();
    m.jumpTo('TITLE');
    expect(m.jumpTo('PROMPT')).toBe('TITLE');
    m.skip();
    expect(m.jumpTo('EYE')).toBe(FINAL_STAGE);
  });

  it('jumping to the current stage is a no-op', () => {
    const m = createBootMachine();
    expect(m.jumpTo('POWER_ON')).toBe('POWER_ON');
    expect(m.done()).toBe(false);
  });
});
