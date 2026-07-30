/**
 * Race a promise against a deadline.
 *
 * If `promise` resolves or rejects within `ms`, the original outcome is
 * returned. If not, the returned promise rejects with a `TimeoutError`
 * whose `.label` matches the `label` argument so callers can identify
 * which budget tripped without parsing the message string.
 *
 * Why this exists: a try/catch only handles REJECTIONS — a promise that
 * never resolves never reaches catch. UI panels and seeders that `await`
 * an unbounded network/LLM call without a per-call timeout can sit on a
 * loading state forever when the upstream hangs (Vercel default function
 * limits + TCP keepalive can keep a fetch pending indefinitely from the
 * client's perspective). Wrap such awaits in `withTimeout`.
 *
 * The pending source promise is NOT cancelled — JS has no general way to
 * cancel a Promise. If you need true cancellation (release the socket,
 * stop the LLM cost meter), wire an `AbortController` and pass its
 * `signal` to the underlying fetch — `withTimeout` is the budget,
 * `AbortSignal` is the cancellation.
 */

export class TimeoutError extends Error {
  public readonly label: string;
  public readonly timeoutMs: number;
  constructor(label: string, timeoutMs: number) {
    super(`[${label}] timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      if (onTimeout) {
        try {
          onTimeout();
        } catch {
          // Don't let an onTimeout callback hijack the reject path.
        }
      }
      reject(new TimeoutError(label, ms));
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
