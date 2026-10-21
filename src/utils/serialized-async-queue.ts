interface QueueEntry {
  reject: (reason?: unknown) => void;
  resolve: (value: unknown) => void;
  task: () => Promise<unknown> | unknown;
}

/**
 * Small FIFO executor for browser-side async work that must not overlap.
 *
 * The first task starts synchronously so unload/visibility handlers can begin
 * a keepalive fetch before returning. Later tasks wait without allowing a
 * rejection to poison the queue.
 */
export class SerializedAsyncQueue {
  private active = false;
  private readonly entries: QueueEntry[] = [];

  get busy(): boolean {
    return this.active || this.entries.length > 0;
  }

  run<T>(task: () => Promise<T> | T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.entries.push({
        task,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.startNext();
    });
  }

  private startNext(): void {
    if (this.active) return;

    const entry = this.entries.shift();
    if (!entry) return;

    this.active = true;
    let result: Promise<unknown> | unknown;
    try {
      result = entry.task();
    } catch (error) {
      this.active = false;
      this.startNext();
      entry.reject(error);
      return;
    }

    void Promise.resolve(result).then(
      (value) => {
        this.active = false;
        this.startNext();
        entry.resolve(value);
      },
      (error) => {
        this.active = false;
        this.startNext();
        entry.reject(error);
      },
    );
  }
}
