import { debounce } from '@/utils/debounce';

export type DebouncedResizeListener = (() => void) & { cancel(): void };

export function addDebouncedResizeListener(
  target: EventTarget,
  onResize: () => void,
  delayMs = 100,
): DebouncedResizeListener {
  const listener = debounce(() => onResize(), delayMs);
  target.addEventListener('resize', listener);
  return listener;
}

export function removeDebouncedResizeListener(
  target: EventTarget,
  listener: DebouncedResizeListener | null,
): void {
  if (!listener) return;
  target.removeEventListener('resize', listener);
  listener.cancel();
}
