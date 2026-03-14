import { CorrelationPanel } from './CorrelationPanel';
import { t } from '@/services/i18n';

export class EscalationCorrelationPanel extends CorrelationPanel {
  constructor() {
    super('escalation-correlation', 'Escalation Monitor', 'escalation', t('components.escalationCorrelation.infoTooltip'));
  }
}
