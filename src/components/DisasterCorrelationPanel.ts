import { CorrelationPanel } from './CorrelationPanel';
import { t } from '@/services/i18n';

export class DisasterCorrelationPanel extends CorrelationPanel {
  constructor() {
    super('disaster-correlation', 'Disaster Cascade', 'disaster', t('components.disasterCorrelation.infoTooltip'));
  }
}
