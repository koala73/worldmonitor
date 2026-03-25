import { CorrelationPanel } from './CorrelationPanel';
import { t } from '@/services/i18n';

export class MilitaryCorrelationPanel extends CorrelationPanel {
  constructor() {
    super('military-correlation', 'Force Posture', 'military', t('components.militaryCorrelation.infoTooltip'));
  }
}
