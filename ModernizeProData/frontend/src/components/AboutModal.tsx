import { Modal } from './Modal';
import { BrandName } from './BrandName';
import { useT } from '../i18n';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function AboutModal({ open, onClose }: Props) {
  const t = useT();
  return (
    <Modal open={open} onClose={onClose} title={<>{t('about.title')} <BrandName /></>} width={420}>
      <div style={styles.row}>
        <img src="/mpd.png" alt="" width={48} height={48} style={{ display: 'block' }} />
        <div>
          <div style={styles.brandText}><BrandName /></div>
          <div style={styles.versionText}>v0.1.0-dev</div>
        </div>
      </div>

      <p style={styles.desc}>{t('about.desc')}</p>

      <table style={styles.kv}>
        <tbody>
          <Row k={t('about.build')} v="0.1.0-dev" mono />
          <Row k={t('about.backend')} v="Spring Boot 3.5 · Java 21" mono />
          <Row k={t('about.frontend')} v="React 19 · Vite 8 · TypeScript 6" mono />
          <Row k={t('about.engine')} v={t('about.engineVal')} mono />
          <Row k={t('about.metaDb')} v={t('about.metaDbVal')} mono />
          <Row k={t('about.scheduler')} v={t('about.schedulerVal')} mono />
          <Row k={t('about.vendor')} v="KS Info System Co., Ltd." />
        </tbody>
      </table>

      <div style={styles.footer}>
        © 2026 KS Info System Co., Ltd. All rights reserved.
      </div>
    </Modal>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <tr>
      <td style={styles.kvKey}>{k}</td>
      <td style={{ ...styles.kvVal, ...(mono ? { fontFamily: 'var(--mono)' } : {}) }}>{v}</td>
    </tr>
  );
}

const styles: Record<string, React.CSSProperties> = {
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 14,
    marginBottom: 14,
  },
  brandText: { fontSize: 15, fontWeight: 700, color: 'var(--text)', letterSpacing: -0.2 },
  versionText: {
    fontSize: 11,
    color: 'var(--text-3)',
    fontFamily: 'var(--mono)',
    marginTop: 2,
  },
  desc: {
    fontSize: 12,
    color: 'var(--text-2)',
    lineHeight: 1.6,
    margin: '0 0 14px',
  },
  kv: {
    fontSize: 11.5,
    borderCollapse: 'collapse',
    width: '100%',
    marginBottom: 14,
  },
  kvKey: {
    padding: '5px 10px',
    color: 'var(--text-3)',
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    fontWeight: 500,
    width: 90,
    borderBottom: '1px dashed var(--border)',
  },
  kvVal: {
    padding: '5px 10px',
    color: 'var(--text)',
    borderBottom: '1px dashed var(--border)',
  },
  footer: {
    fontSize: 10.5,
    color: 'var(--text-4)',
    fontFamily: 'var(--mono)',
    textAlign: 'center',
    paddingTop: 6,
  },
};
