/**
 * Dot colour for a chokepoint status from get-chokepoint-status.
 *
 * The server sends scoreToStatus() levels: 'green' | 'yellow' | 'red'. The
 * strips once matched words like 'critical' or 'disrupted', which the API never
 * sends, so every chip fell through to green, including a red Hormuz.
 */
export function chokepointStatusColor(status: string | undefined): string {
  switch ((status || '').toLowerCase()) {
    case 'red': return '#e74c3c';
    case 'yellow': return '#f39c12';
    case 'green': return '#2ecc71';
    default: return '#7f8c8d';
  }
}
