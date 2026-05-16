/**
 * Experimental RNG-based collective coherence monitoring service.
 * Collects local entropy and streams to the central ingestion API.
 */
export interface RngDataPoint {
  timestamp: number;
  z_score: number;
  entropy_value: number;
  node_id: string;
}

export class RngMonitor {
  private static instance: RngMonitor;
  private nodeId: string;
  private buffer: RngDataPoint[] = [];
  private readonly BUFFER_LIMIT = 50;

  private constructor() {
    this.nodeId = crypto.randomUUID();
  }

  public static getInstance(): RngMonitor {
    if (!RngMonitor.instance) RngMonitor.instance = new RngMonitor();
    return RngMonitor.instance;
  }

  /**
   * Generates a pseudo-random value and calculates a basic z-score.
   * In a production scenario, this would interface with a hardware RNG.
   */
  public collect(): void {
    const raw = crypto.getRandomValues(new Uint32Array(1))[0] / 0xFFFFFFFF;
    const point: RngDataPoint = {
      timestamp: Date.now(),
      z_score: (raw - 0.5) * 2, // Normalized deviation
      entropy_value: raw,
      node_id: this.nodeId,
    };

    this.buffer.push(point);
    if (this.buffer.length >= this.BUFFER_LIMIT) {
      this.flush();
    }
  }

  private async flush(): Promise<void> {
    const data = [...this.buffer];
    this.buffer = [];
    try {
      await fetch('/api/v1/rng/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ points: data }),
      });
    } catch (e) {
      console.error('[RngMonitor] Failed to flush data:', e);
    }
  }
}