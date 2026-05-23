import { useLicenseStore, shouldShowBanner } from '../store/license';
import { useT } from '../i18n';

/**
 * 라이선스 비정상 상태 (ACTIVE 외) 일 때 상단에 표시되는 banner.
 * EXPIRING → amber / 그 외 (IN_GRACE / READ_ONLY / EXPIRED / MISSING / INVALID) → red.
 */
export function LicenseBanner() {
  const t = useT();
  const lic = useLicenseStore((s) => s.data);
  const status = lic?.status;
  if (!shouldShowBanner(status)) return null;

  const isAmber = status === 'EXPIRING' || status === 'IN_GRACE';
  const tone = isAmber
    ? { bg: 'var(--amber-50)', color: 'var(--amber)', border: 'var(--amber)' }
    : { bg: 'var(--red-50)',   color: 'var(--red)',   border: 'var(--red)'   };

  const days = lic?.daysRemaining ?? 0;
  let msg = '';
  switch (status) {
    case 'EXPIRING':  msg = t('license.banner.expiring',  { days });            break;
    case 'IN_GRACE':  msg = t('license.banner.inGrace',   { days: Math.abs(days) }); break;
    case 'READ_ONLY': msg = t('license.banner.readOnly'); break;
    case 'EXPIRED':   msg = t('license.banner.expired');  break;
    case 'MISSING':   msg = t('license.banner.missing');  break;
    case 'INVALID':   msg = t('license.banner.invalid');  break;
    default:          msg = '';
  }

  return (
    <div style={{
      padding: '8px 16px',
      background: tone.bg,
      color: tone.color,
      borderBottom: `1px solid ${tone.border}`,
      fontSize: 12.5,
      fontWeight: 600,
      display: 'flex',
      alignItems: 'center',
      gap: 8,
    }}>
      <span>{msg}</span>
    </div>
  );
}
