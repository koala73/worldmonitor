import {
  decideStarPrompt,
  localDayKey,
  readStarPromptDismissed,
  recordVisitDay,
  type StarPromptDecision,
  type StarPromptStorage,
  starPromptStorage,
} from '@/services/github-star-prompt-state';
import {
  PRO_BANNER_ENTITLEMENT_HINT_KEY,
  PRO_BANNER_ENTITLEMENT_HINT_VALUE,
} from '@/services/pro-banner-policy';

/**
 * Eager boot gate for the GitHub star prompt.
 *
 * Counts today's visit, then fetches the controller chunk only when the user is
 * eligible, so nobody else pays for it. Returns a teardown.
 */

function readPremiumHint(storage: StarPromptStorage | null): boolean {
  try {
    return storage?.getItem(PRO_BANNER_ENTITLEMENT_HINT_KEY) === PRO_BANNER_ENTITLEMENT_HINT_VALUE;
  } catch {
    return false;
  }
}

function inIframe(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    // Cross-origin parent access throws: that is an iframe.
    return true;
  }
}

export function bootGitHubStarPrompt(now: Date = new Date()): { decision: StarPromptDecision; destroy: () => void } {
  const storage = starPromptStorage();
  const embedded = inIframe();
  const decision = decideStarPrompt({
    inIframe: embedded,
    dismissed: readStarPromptDismissed(storage),
    // Embeds never ask, so they do not count visits either.
    visitDays: embedded ? 0 : recordVisitDay(storage, localDayKey(now)),
    premium: readPremiumHint(storage),
  });
  if (decision !== 'ask') return { decision, destroy: () => {} };

  let destroyed = false;
  let controller: { destroy(): void } | null = null;
  void import('@/app/github-star-prompt')
    .then(({ GitHubStarPromptController }) => {
      if (destroyed) return;
      const c = new GitHubStarPromptController(storage, () => readPremiumHint(storage));
      controller = c;
      c.start();
    })
    .catch(() => { /* chunk failed to load: no prompt this visit */ });
  return {
    decision,
    destroy: () => {
      destroyed = true;
      controller?.destroy();
      controller = null;
    },
  };
}
