import { t } from '../i18n';

export function SoonBadge() {
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        marginLeft: '6px',
        fontSize: '10px',
        fontWeight: 600,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        color: '#fbbf24',
        background: 'rgba(251,191,36,0.12)',
        border: '1px solid rgba(251,191,36,0.3)',
        borderRadius: '4px',
        verticalAlign: 'middle',
      }}
    >
      {t('soonBadge')}
    </span>
  );
}
