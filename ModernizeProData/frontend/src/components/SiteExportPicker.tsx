import type { CSSProperties } from 'react';
import { useT, type TranslationKey } from '../i18n';
import type { SelectedFormats } from '../lib/siteExportManifest';
import { Checkbox } from './Checkbox';

/* Site export 좌측 picker — Prototype/src/exporttab.jsx 의 좌측 패널 포트.
 * 300px 고정 폭, 상단 메타, 중간 format 체크박스 + bundle 토글, 하단 CTA 바.
 */

interface FormatRow {
  key: keyof SelectedFormats;
  label: TranslationKey;
  hint: TranslationKey;
  section: 'formats' | 'documents';
}

const ROWS: FormatRow[] = [
  { key: 'migration',  label: 'siteExport.format.migration.label',  hint: 'siteExport.format.migration.hint',  section: 'formats' },
  { key: 'mapping',    label: 'siteExport.format.mapping.label',    hint: 'siteExport.format.mapping.hint',    section: 'formats' },
  { key: 'validation', label: 'siteExport.format.validation.label', hint: 'siteExport.format.validation.hint', section: 'formats' },
  { key: 'summary',    label: 'siteExport.format.summary.label',    hint: 'siteExport.format.summary.hint',    section: 'documents' },
];

interface Props {
  siteName: string;
  tableCount: number;
  fileCount: number;
  selectedFormats: SelectedFormats;
  onSelectedFormatsChange: (next: SelectedFormats) => void;
  busy: boolean;
  onDownload: () => void;
  downloadDisabledReason?: string;
}

export function SiteExportPicker(props: Props) {
  const t = useT();
  const formatsRows = ROWS.filter(r => r.section === 'formats');
  const documentsRows = ROWS.filter(r => r.section === 'documents');

  return (
    <div style={styles.root}>
      {/* 상단 메타 */}
      <div style={styles.header}>
        <div style={styles.scopeLabel}>{t('siteExport.scope')}</div>
        <div style={styles.siteName}>{props.siteName}</div>
        <div style={styles.summary}>
          {t('siteExport.summary', {
            tables: props.tableCount.toLocaleString(),
            files: props.fileCount,
          })}
        </div>
      </div>

      {/* 가운데 — format 체크박스 + bundle 토글 */}
      <div style={styles.body}>
        <SectionHead>{t('siteExport.section.formats')}</SectionHead>
        {formatsRows.map(r => (
          <CheckRow
            key={r.key}
            label={t(r.label)}
            hint={t(r.hint)}
            checked={props.selectedFormats[r.key]}
            onChange={v => props.onSelectedFormatsChange({ ...props.selectedFormats, [r.key]: v })}
          />
        ))}

        <div style={{ height: 10 }} />
        <SectionHead>{t('siteExport.section.documents')}</SectionHead>
        {documentsRows.map(r => (
          <CheckRow
            key={r.key}
            label={t(r.label)}
            hint={t(r.hint)}
            checked={props.selectedFormats[r.key]}
            onChange={v => props.onSelectedFormatsChange({ ...props.selectedFormats, [r.key]: v })}
          />
        ))}

      </div>

      {/* 하단 CTA */}
      <div style={styles.cta}>
        <button
          onClick={props.onDownload}
          disabled={props.busy || !!props.downloadDisabledReason}
          title={props.downloadDisabledReason ?? ''}
          style={{
            ...styles.btnPrimary,
            ...((props.busy || props.downloadDisabledReason) ? styles.btnPrimaryDisabled : {}),
          }}
        >
          <span style={styles.btnIcon}>↓</span>
          {props.busy
            ? t('siteExport.btn.downloading')
            : t('siteExport.btn.download')}
        </button>
      </div>
    </div>
  );
}

function SectionHead({ children }: { children: React.ReactNode }) {
  return <div style={styles.sectionHead}>{children}</div>;
}

interface CheckRowProps {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}

function CheckRow({ label, hint, checked, onChange }: CheckRowProps) {
  return (
    <label style={styles.checkRow} onClick={() => onChange(!checked)}>
      <Checkbox checked={checked} onChange={onChange} />
      <div style={{ flex: 1 }}>
        <div style={styles.checkLabel}>{label}</div>
        <div style={styles.checkHint}>{hint}</div>
      </div>
    </label>
  );
}

const styles: Record<string, CSSProperties> = {
  root: {
    borderRight: '1px solid var(--border)',
    background: 'var(--panel)',
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
  },
  header: {
    padding: '12px 14px 10px',
    borderBottom: '1px solid var(--border)',
  },
  scopeLabel: {
    fontSize: 10,
    color: 'var(--text-3)',
    textTransform: 'uppercase',
    letterSpacing: 0.7,
    fontFamily: 'var(--mono)',
  },
  siteName: { fontSize: 14, fontWeight: 600, marginTop: 2, color: 'var(--text)' },
  summary: { fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--mono)', marginTop: 2 },

  body: { flex: 1, overflow: 'auto', padding: '10px 14px' },
  sectionHead: {
    fontSize: 10,
    fontFamily: 'var(--mono)',
    color: 'var(--text-3)',
    textTransform: 'uppercase',
    letterSpacing: 0.7,
    marginBottom: 6,
  },
  checkRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 7,
    padding: '4px 0',
    cursor: 'pointer',
  },
  checkLabel: { fontSize: 12, color: 'var(--text)' },
  checkHint: { fontSize: 10, color: 'var(--text-3)', fontFamily: 'var(--mono)' },

  cta: {
    padding: '10px 14px',
    borderTop: '1px solid var(--border)',
    background: 'var(--panel-2, var(--panel))',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  btnPrimary: {
    width: '100%',
    height: 32,
    background: 'var(--navy)',
    color: '#fff',
    border: '1px solid var(--navy)',
    borderRadius: 3,
    fontSize: 12.5,
    fontWeight: 600,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  btnPrimaryDisabled: {
    background: 'var(--border-strong)',
    color: 'var(--text-3)',
    borderColor: 'var(--border-strong)',
    cursor: 'not-allowed',
  },
  btnIcon: { fontSize: 13, lineHeight: 1 },
};
