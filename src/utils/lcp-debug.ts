export type LcpDebugDetail = Record<string, string | number | boolean | null | undefined>;

export type LcpMarkSnapshot = {
  detail?: LcpDebugDetail;
  name: string;
  startTime: number;
};

const MAX_MARKS = 120;

type LcpDebugMarkTarget = {
  enabled?: boolean;
  marks?: LcpMarkSnapshot[];
};

export function markLcpDebug(name: string, detail?: LcpDebugDetail): void {
  if (typeof performance !== 'undefined' && typeof performance.mark === 'function') {
    try {
      performance.mark(name);
    } catch {
      // A malformed mark name should never break dashboard startup.
    }
  }

  if (typeof window === 'undefined') return;
  const state = (window as unknown as { __wmLcpDebug?: LcpDebugMarkTarget }).__wmLcpDebug;
  if (!state?.enabled || !Array.isArray(state.marks)) return;
  state.marks.push({
    detail,
    name,
    startTime: Math.round(typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now()),
  });
  if (state.marks.length > MAX_MARKS) state.marks.splice(0, state.marks.length - MAX_MARKS);
}
