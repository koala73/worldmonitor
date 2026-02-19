/**
 * PERF-051: Client-side performance metrics / debug dashboard.
 * PERF-052: Web Vitals tracking (LCP, FID, CLS).
 * PERF-055: Per-panel render time logging.
 *
 * Lightweight performance monitoring that runs in production.
 * Debug panel only shown when `?debug=perf` is in the URL.
 */

interface PerfMetric {
    name: string;
    value: number;
    timestamp: number;
}

interface PanelRenderTiming {
    panelId: string;
    duration: number;
    timestamp: number;
}

const panelTimings: PanelRenderTiming[] = [];
const metrics: PerfMetric[] = [];
let debugPanelEl: HTMLElement | null = null;
let rafId = 0;

/**
 * PERF-055: Wrap a panel render to measure its duration.
 */
export function measurePanelRender(panelId: string, fn: () => void): void {
    const start = performance.now();
    fn();
    const duration = performance.now() - start;

    panelTimings.push({ panelId, duration, timestamp: Date.now() });

    // Keep only last 200 timings
    if (panelTimings.length > 200) panelTimings.splice(0, panelTimings.length - 200);

    // Warn for slow renders
    if (duration > 16) {
        console.warn(`[PERF] Slow panel render: ${panelId} took ${duration.toFixed(1)}ms`);
    }
}

/**
 * Record a named performance metric.
 */
export function recordMetric(name: string, value: number): void {
    metrics.push({ name, value, timestamp: Date.now() });
    if (metrics.length > 500) metrics.splice(0, metrics.length - 500);
}

/**
 * PERF-052: Track Web Vitals using Performance Observer API.
 */
export function initWebVitals(): void {
    if (typeof PerformanceObserver === 'undefined') return;

    // Largest Contentful Paint
    try {
        const lcpObserver = new PerformanceObserver((list) => {
            const entries = list.getEntries();
            const lastEntry = entries[entries.length - 1];
            if (lastEntry) {
                recordMetric('LCP', lastEntry.startTime);
                console.log(`[WebVitals] LCP: ${lastEntry.startTime.toFixed(0)}ms`);
            }
        });
        lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true });
    } catch { /* browser doesn't support LCP */ }

    // First Input Delay
    try {
        const fidObserver = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
                const fid = (entry as PerformanceEventTiming).processingStart - entry.startTime;
                recordMetric('FID', fid);
                console.log(`[WebVitals] FID: ${fid.toFixed(0)}ms`);
            }
        });
        fidObserver.observe({ type: 'first-input', buffered: true });
    } catch { /* browser doesn't support FID */ }

    // Cumulative Layout Shift
    try {
        let clsValue = 0;
        const clsObserver = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
                if (!(entry as any).hadRecentInput) {
                    clsValue += (entry as any).value;
                }
            }
            recordMetric('CLS', clsValue);
        });
        clsObserver.observe({ type: 'layout-shift', buffered: true });
    } catch { /* browser doesn't support CLS */ }

    // Long Tasks (>50ms)
    try {
        const longTaskObserver = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
                if (entry.duration > 50) {
                    recordMetric('LongTask', entry.duration);
                    if (entry.duration > 100) {
                        console.warn(`[PERF] Long task: ${entry.duration.toFixed(0)}ms`);
                    }
                }
            }
        });
        longTaskObserver.observe({ type: 'longtask', buffered: true });
    } catch { /* browser doesn't support long tasks */ }
}

/**
 * PERF-051: Show debug performance panel (activated by ?debug=perf).
 */
export function maybeShowDebugPanel(): void {
    if (!location.search.includes('debug=perf')) return;

    debugPanelEl = document.createElement('div');
    debugPanelEl.id = 'perf-debug-panel';
    debugPanelEl.style.cssText = `
    position: fixed; bottom: 0; right: 0; z-index: 99999;
    background: rgba(0,0,0,0.85); color: #0f0; font-family: monospace;
    font-size: 11px; padding: 8px 12px; border-top-left-radius: 6px;
    pointer-events: none; min-width: 200px; line-height: 1.6;
  `;
    document.body.appendChild(debugPanelEl);

    const update = () => {
        if (!debugPanelEl) return;
        const mem = (performance as any).memory;
        const dom = document.querySelectorAll('*').length;
        const fps = estimateFPS();

        let html = `<b>⚡ PERF</b><br>`;
        html += `FPS: ${fps} | DOM: ${dom}`;
        if (mem) {
            html += ` | Heap: ${(mem.usedJSHeapSize / 1048576).toFixed(0)}MB`;
        }

        // Last 5 panel timings
        const recentTimings = panelTimings.slice(-5);
        if (recentTimings.length) {
            html += `<br><b>Panel renders:</b>`;
            for (const t of recentTimings) {
                const color = t.duration > 16 ? '#f44' : t.duration > 8 ? '#ff0' : '#0f0';
                html += `<br><span style="color:${color}">${t.panelId}: ${t.duration.toFixed(1)}ms</span>`;
            }
        }

        // Web Vitals
        const lcp = metrics.filter(m => m.name === 'LCP').pop();
        const fid = metrics.filter(m => m.name === 'FID').pop();
        const cls = metrics.filter(m => m.name === 'CLS').pop();
        if (lcp || fid || cls) {
            html += `<br><b>Vitals:</b>`;
            if (lcp) html += ` LCP:${lcp.value.toFixed(0)}ms`;
            if (fid) html += ` FID:${fid.value.toFixed(0)}ms`;
            if (cls) html += ` CLS:${cls.value.toFixed(3)}`;
        }

        debugPanelEl.innerHTML = html;
        rafId = requestAnimationFrame(update);
    };
    rafId = requestAnimationFrame(update);
}

let lastFrameTime = performance.now();
let frameCount = 0;
let currentFPS = 60;

function estimateFPS(): number {
    frameCount++;
    const now = performance.now();
    if (now - lastFrameTime >= 1000) {
        currentFPS = Math.round(frameCount * 1000 / (now - lastFrameTime));
        frameCount = 0;
        lastFrameTime = now;
    }
    return currentFPS;
}

/**
 * Clean up debug panel.
 */
export function destroyDebugPanel(): void {
    if (rafId) cancelAnimationFrame(rafId);
    debugPanelEl?.remove();
    debugPanelEl = null;
}
