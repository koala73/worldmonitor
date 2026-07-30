export interface WelcomeRootElement {
  replaceChildren?: () => void;
  textContent: string | null;
}

export function clearWelcomeRoot(rootElement: WelcomeRootElement): void {
  if (typeof rootElement.replaceChildren === 'function') {
    rootElement.replaceChildren();
  } else {
    rootElement.textContent = '';
  }
}
