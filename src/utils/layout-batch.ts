type LayoutBatchCallback = () => void;

export type CancelLayoutBatch = () => void;

interface QueuedCallback {
  callback: LayoutBatchCallback;
  cancelled: boolean;
}

const measureQueue: QueuedCallback[] = [];
const mutateQueue: QueuedCallback[] = [];

let scheduled = false;
let flushing = false;

function requestFrame(callback: FrameRequestCallback): void {
  const raf =
    typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'
      ? window.requestAnimationFrame.bind(window)
      : typeof globalThis.requestAnimationFrame === 'function'
        ? globalThis.requestAnimationFrame.bind(globalThis)
        : undefined;

  if (raf) {
    raf(callback);
    return;
  }

  setTimeout(() => callback(Date.now()), 0);
}

function scheduleFlush(): void {
  if (scheduled || flushing) return;
  scheduled = true;
  requestFrame(flushQueues);
}

function enqueue(queue: QueuedCallback[], callback: LayoutBatchCallback): CancelLayoutBatch {
  const entry: QueuedCallback = { callback, cancelled: false };
  queue.push(entry);
  scheduleFlush();
  return () => {
    entry.cancelled = true;
  };
}

function reportLayoutBatchError(error: unknown): void {
  if (typeof globalThis.reportError === 'function') {
    globalThis.reportError(error);
    return;
  }

  setTimeout(() => {
    throw error;
  }, 0);
}

function flushQueue(queue: QueuedCallback[]): void {
  const errors: unknown[] = [];

  for (const entry of queue) {
    if (entry.cancelled) continue;
    try {
      entry.callback();
    } catch (error) {
      errors.push(error);
    }
  }

  for (const error of errors) reportLayoutBatchError(error);
}

function flushQueues(): void {
  scheduled = false;
  flushing = true;

  try {
    const measures = measureQueue.splice(0);
    flushQueue(measures);

    const mutates = mutateQueue.splice(0);
    flushQueue(mutates);
  } finally {
    flushing = false;
    if (measureQueue.length > 0 || mutateQueue.length > 0) scheduleFlush();
  }
}

export function __resetForTest(): void {
  measureQueue.length = 0;
  mutateQueue.length = 0;
  scheduled = false;
  flushing = false;
}

export function measure(callback: LayoutBatchCallback): CancelLayoutBatch {
  return enqueue(measureQueue, callback);
}

export function mutate(callback: LayoutBatchCallback): CancelLayoutBatch {
  return enqueue(mutateQueue, callback);
}
