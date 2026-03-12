// ── DOM helpers ─────────────────────────────────────────────────────────────
// Tiny vanilla helpers so we don't need a framework

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string>,
  ...children: (string | Node)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'className') node.className = v;
      else if (k === 'htmlFor') (node as HTMLLabelElement).htmlFor = v;
      else node.setAttribute(k, v);
    }
  }
  for (const c of children) {
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function clear(parent: HTMLElement): void {
  parent.innerHTML = '';
}

export function formatRelative(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout>;
  return ((...args: unknown[]) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  }) as T;
}

export function threatColor(level: string): string {
  switch (level) {
    case 'critical': return 'var(--threat-critical)';
    case 'high': return 'var(--threat-high)';
    case 'medium': return 'var(--threat-medium)';
    case 'low': return 'var(--threat-low)';
    default: return 'var(--threat-info)';
  }
}

export function tierLabel(tier: number): string {
  switch (tier) {
    case 1: return 'Wire';
    case 2: return 'Major';
    case 3: return 'Specialty';
    default: return 'Other';
  }
}
