import { CorrelationPanel } from './CorrelationPanel';
import { t } from '@/services/i18n';

export class EconomicCorrelationPanel extends CorrelationPanel {
  constructor() {
    super('economic-correlation', t('panels.economicCorrelation'), 'economic', t('components.economicCorrelation.infoTooltip'));
  }
}
