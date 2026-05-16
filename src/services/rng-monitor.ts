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
  private buffer: RngDataPoint[] = [];
  private readonly BUFFER_LIMIT = 50;

  private constructor() {
  }

  public static getInstance(): RngMonitor {
    if (!RngMonitor.instance) RngMonitor.instance = new RngMonitor();
    return RngMonitor.instance;
  }

  /**
   * Generates a pseudo-random value and calculates a basic z-score.
   * In a production scenario, this would interface with a hardware RNG.
   */
  public async collect(): Promise<void> {
    const raw = crypto.getRandomValues(new Uint32Array(1))[0]! / 0xFFFFFFFF;
    const stdDev = Math.sqrt(1 / 12);
    const point: RngDataPoint = {
      timestamp: Date.now(),
      z_score: (raw - 0.5) / stdDev, // Standard z-score for uniform distribution
      entropy_value: raw,
      node_id: 'anonymous',
    };

    this.buffer.push(point);
    if (this.buffer.length >= this.BUFFER_LIMIT) {
      await this.flush();
    }
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    
    const data = [...this.buffer];
    try {
      const response = await fetch('/api/v1/rng/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ points: data }),
      });
      
      if (response.ok) {
        // Only clear buffer if network request succeeds
        this.buffer = this.buffer.slice(data.length);
      } else {
        console.warn('[RngMonitor] Server rejected data, retaining buffer');
      }
    } catch (e) {
      console.error('[RngMonitor] Failed to flush data, retaining buffer:', e);
    }
  }
}