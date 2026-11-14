const HOLD_MS = 600;
const SLOP_PX = 10;

/**
 * Turns a stationary one-finger touch hold into a `contextmenu` event on the target, for touch
 * browsers (iOS Safari) that never fire one. Holds where the browser fires its own are left alone.
 */
export function installLongPressContextMenu(target: HTMLElement, options: { ignore?: (start: EventTarget | null) => boolean } = {}): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let start: { id: number; x: number; y: number } | null = null;
  /** The click some browsers send when the held finger lifts would dismiss the menu it opened. */
  let swallowReleaseClick = false;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    start = null;
  };
  const onDown = (e: PointerEvent) => {
    swallowReleaseClick = false;
    if (e.pointerType !== 'touch' || start || options.ignore?.(e.target)) return cancel();
    start = { id: e.pointerId, x: e.clientX, y: e.clientY };
    timer = setTimeout(() => {
      const at = start;
      cancel();
      if (!at) return;
      swallowReleaseClick = true;
      target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y }));
    }, HOLD_MS);
  };
  const onMove = (e: PointerEvent) => {
    if (start?.id === e.pointerId && Math.hypot(e.clientX - start.x, e.clientY - start.y) > SLOP_PX) cancel();
  };
  const onClick = (e: MouseEvent) => {
    if (!swallowReleaseClick) return;
    swallowReleaseClick = false;
    e.preventDefault();
    e.stopPropagation();
  };
  const onNativeMenu = (e: MouseEvent) => {
    if (e.isTrusted) cancel();
  };
  const listeners: Array<[string, EventListener]> = [
    ['pointerdown', onDown as EventListener],
    ['pointermove', onMove as EventListener],
    ['pointerup', cancel],
    ['pointercancel', cancel],
    ['click', onClick as EventListener],
    ['contextmenu', onNativeMenu as EventListener],
  ];
  for (const [type, listener] of listeners) target.addEventListener(type, listener, { capture: true });
  return () => {
    cancel();
    for (const [type, listener] of listeners) target.removeEventListener(type, listener, { capture: true });
  };
}
