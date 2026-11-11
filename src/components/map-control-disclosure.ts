import { safeStorageGet, safeStorageSet } from '@/utils/safe-storage';

/** Shared by the SVG, WebGL and globe pickers. Explicit choices win over resize defaults. */
export function bindMapControlDisclosure(
  container: HTMLElement,
  panel: HTMLElement,
  kind: 'layers' | 'legend',
  label: string,
): () => void {
  const key = `worldmonitor-map-${kind}-expanded`;
  let choice: boolean | null = null;
  const saved = safeStorageGet(key);
  if (saved === 'true' || saved === 'false') choice = saved === 'true';

  const header = panel.querySelector<HTMLElement>('.toggle-header');
  const button = header?.querySelector<HTMLButtonElement>('.toggle-collapse') ?? document.createElement('button');
  button.type = 'button';
  button.classList.add('map-control-disclosure');
  button.textContent = label;
  if (header) {
    header.querySelector('span')?.remove();
    header.prepend(button);
  } else panel.prepend(button);
  panel.classList.add('map-control-panel');

  let expanded = false;
  const render = (): void => {
    // Stacked laptop layouts can be wide but too short for the open controls.
    const compact = container.clientWidth < 700 || container.clientHeight < 400;
    expanded = choice ?? !compact;
    panel.classList.toggle('map-control-compact', compact);
    panel.classList.toggle('map-control-collapsed', !expanded);
    button.setAttribute('aria-expanded', String(expanded));
  };
  const toggle = (): void => {
    choice = !expanded;
    safeStorageSet(key, String(choice));
    render();
  };
  button.addEventListener('click', toggle);
  const observer = new ResizeObserver(render);
  observer.observe(container);
  render();
  return () => {
    observer.disconnect();
    button.removeEventListener('click', toggle);
  };
}
