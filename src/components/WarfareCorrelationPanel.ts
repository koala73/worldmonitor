import { CorrelationPanel } from './CorrelationPanel';

export class WarfareCorrelationPanel extends CorrelationPanel {
  constructor() {
    super('warfare-correlation', 'Warfare Monitor', 'military', 'Cross-stream warfare signal correlation: combat engagements, missile activity, supply disruptions, and territorial changes.');
  }
}
