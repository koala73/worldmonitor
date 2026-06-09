import { CorrelationPanel } from './CorrelationPanel';
import { t } from '@/services/i18n';

export class MilitaryCorrelationPanel extends CorrelationPanel {
  constructor() {
    super('military-correlation', t('panels.militaryCorrelation'), 'military', t('components.militaryCorrelation.infoTooltip'));
  }
}
