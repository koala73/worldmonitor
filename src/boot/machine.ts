export type BootStage =
  | 'POWER_ON' | 'PROMPT' | 'CHARACTER' | 'EYE'
  | 'EYE_3D' | 'SHRINK_TO_O' | 'TITLE' | 'GLOBE_REVEAL';

export const STAGES = [
  'POWER_ON', 'PROMPT', 'CHARACTER', 'EYE',
  'EYE_3D', 'SHRINK_TO_O', 'TITLE', 'GLOBE_REVEAL',
] as const satisfies readonly BootStage[];

export const FINAL_STAGE: BootStage = 'GLOBE_REVEAL';

export interface BootMachine {
  stage(): BootStage;
  advance(): BootStage;
  /** Move straight to `stage`, skipping whatever lies between. Never moves
   *  backwards: the short boot jumps forward past the artwork stages, and a
   *  sequence that could reverse would let a late jump undo the handoff. */
  jumpTo(stage: BootStage): BootStage;
  skip(): BootStage;
  done(): boolean;
}

export function createBootMachine(): BootMachine {
  let i = 0;
  return {
    stage: () => STAGES[i]!,
    advance: () => STAGES[(i = Math.min(i + 1, STAGES.length - 1))]!,
    jumpTo: (stage) => STAGES[(i = Math.max(i, STAGES.indexOf(stage)))]!,
    skip: () => STAGES[(i = STAGES.length - 1)]!,
    done: () => i === STAGES.length - 1,
  };
}
