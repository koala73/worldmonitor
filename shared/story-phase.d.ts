export type StoryPhase = 'breaking' | 'developing' | 'sustained' | 'fading';

export declare const STORY_PHASES: readonly StoryPhase[];

export declare const PHASE_COLOR: Readonly<Record<StoryPhase, string>>;

export declare function isStoryPhase(phase: unknown): phase is StoryPhase;

export declare function deriveCoreStoryPhase(
  track: { mentionCount?: number; firstSeen: number },
  nowMs?: number,
): 'breaking' | 'developing' | 'sustained';

export declare function deriveNotificationStoryPhase(
  track: { mentionCount?: number; firstSeen: number; lastSeen: number },
  nowMs?: number,
): StoryPhase;

export declare function formatStoryPhaseBadge(
  phase: unknown,
  options?: { strict?: boolean },
): { label: string; color: string } | null;
