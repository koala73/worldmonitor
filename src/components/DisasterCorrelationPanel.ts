import { CorrelationPanel } from './CorrelationPanel';
import { t } from '@/services/i18n';

export class DisasterCorrelationPanel extends CorrelationPanel {
  constructor() {
    super('disaster-correlation', t('panels.disasterCorrelation'), 'disaster', t('components.disasterCorrelation.infoTooltip'));
  }
}
