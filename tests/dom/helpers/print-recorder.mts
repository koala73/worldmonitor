/**
 * `window.print()` shim for the DOM-behavioral gate tests (#5634).
 *
 * happy-dom does not implement `window.print()`, so `printReportDocument`
 * would always take its reject path and the "PDF succeeded" branch of the
 * export click cycle would never be exercised — a silent coverage hole in the
 * exact behaviour the cycle test exists to prove.
 */

export interface PrintRecorder {
  /** `document.body.innerHTML` of every document `print()` was called on. */
  readonly printed: string[];
  /** Make the next `print()` throw, to exercise the failure path. */
  failNext(error: Error): void;
  restore(): void;
}

/**
 * Give happy-dom a `window.print()`.
 *
 * The shim lands on the prototype shared by every iframe's `contentWindow`,
 * so it covers the iframe `printReportDocument` creates internally — no
 * dependency injection, which is the point: the composed click cycle must be
 * provable through the same call path production uses. (The top-level vitest
 * `window` is a proxy with a different prototype, hence the probe iframe.)
 */
export function installPrintRecorder(): PrintRecorder {
  const probeFrame = document.createElement('iframe');
  document.body.appendChild(probeFrame);
  const probeWindow = probeFrame.contentWindow;
  probeFrame.remove();
  if (!probeWindow) {
    throw new Error('[dom-harness] iframe exposed no contentWindow — cannot shim print()');
  }
  const windowProto = Object.getPrototypeOf(probeWindow) as Record<string, unknown>;

  const hadOwn = Object.prototype.hasOwnProperty.call(windowProto, 'print');
  const previous = windowProto.print;

  const printed: string[] = [];
  let pendingError: Error | null = null;

  windowProto.print = function print(this: Window): void {
    if (pendingError) {
      const err = pendingError;
      pendingError = null;
      throw err;
    }
    printed.push(this.document.body.innerHTML);
  };

  return {
    printed,
    failNext(error: Error) {
      pendingError = error;
    },
    restore() {
      if (hadOwn) windowProto.print = previous;
      else delete windowProto.print;
    },
  };
}
