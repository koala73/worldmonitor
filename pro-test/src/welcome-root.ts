export interface WelcomeRootElement {
  replaceChildren?: () => void;
  textContent: string | null;
}

export interface WelcomeRootDatasetElement {
  dataset: {
    wmPrerendered?: string;
    wmPrerenderLang?: string;
  };
}

export type WelcomeMountPlan<T extends WelcomeRootDatasetElement> =
  | { mode: 'hydrate'; root: T }
  | { mode: 'render'; root: T };

/**
 * Decide how to mount the welcome app. A missing `#root` must not throw —
 * Safari reports that as `TypeError: null is not an object (evaluating 't.dataset')`
 * when the non-null assertion is stripped by the bundler.
 */
export function prepareWelcomeRoot<T extends WelcomeRootDatasetElement>(
  rootElement: T | null | undefined,
  contentLanguage: string,
): WelcomeMountPlan<T> | null {
  if (rootElement == null) {
    return null;
  }
  if (
    rootElement.dataset.wmPrerendered === 'welcome' &&
    rootElement.dataset.wmPrerenderLang === contentLanguage
  ) {
    return { mode: 'hydrate', root: rootElement };
  }
  return { mode: 'render', root: rootElement };
}

export function clearWelcomeRoot(rootElement: WelcomeRootElement): void {
  if (typeof rootElement.replaceChildren === 'function') {
    rootElement.replaceChildren();
  } else {
    rootElement.textContent = '';
  }
}
