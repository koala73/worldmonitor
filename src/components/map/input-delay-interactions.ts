export interface CountryIdentity {
  code: string;
  name: string;
}

export interface CountryHoverCache {
  code: string | null;
  name: string | null;
}

export type CancelableFrameTask = (() => void) & { cancel(): void };

export interface CountryHoverQueryController<TPoint> {
  queue(point: TPoint): void;
  cancel(): void;
  isPending(): boolean;
}

export function shouldRunInputSensitiveMapWork(isInputPending: () => boolean): boolean {
  return !isInputPending();
}

export function shouldRenderTradeAnimationFrame(frameCount: number, isInputPending: () => boolean): boolean {
  return frameCount % 2 === 0 && shouldRunInputSensitiveMapWork(isInputPending);
}

export function resolveCountryForPointerInteraction(
  hover: CountryHoverCache,
  hoverQueryPending: boolean,
  resolveFromCoordinate: () => CountryIdentity | null,
): CountryIdentity | null {
  if (!hoverQueryPending && hover.code && hover.name) {
    return { code: hover.code, name: hover.name };
  }
  return resolveFromCoordinate();
}

export function createCountryHoverQueryController<TPoint>(
  scheduleFrame: (run: () => void) => CancelableFrameTask,
  runQuery: (point: TPoint) => void,
): CountryHoverQueryController<TPoint> {
  let pendingPoint: TPoint | null = null;
  let pending = false;
  const frameTask = scheduleFrame(() => {
    const point = pendingPoint;
    pendingPoint = null;
    pending = false;
    if (point !== null) runQuery(point);
  });

  return {
    queue(point: TPoint): void {
      pendingPoint = point;
      pending = true;
      frameTask();
    },
    cancel(): void {
      pendingPoint = null;
      pending = false;
      frameTask.cancel();
    },
    isPending(): boolean {
      return pending;
    },
  };
}
