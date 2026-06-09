import { CorrelationPanel } from './CorrelationPanel';
import { t } from '@/services/i18n';

export class EscalationCorrelationPanel extends CorrelationPanel {
  constructor() {
    super('escalation-correlation', t('panels.escalationCorrelation'), 'escalation', t('components.escalationCorrelation.infoTooltip'));
  }
}
