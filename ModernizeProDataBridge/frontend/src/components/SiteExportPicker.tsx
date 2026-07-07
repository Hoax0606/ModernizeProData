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

/** 현재 미리보기 중인 포맷 — picker 의 라벨 클릭으로 변경. 체크박스(다운로드 선택) 와 독립. */
export type PreviewedFormat = keyof SelectedFormats | null;

/** 각 포맷의 사용 가능 여부 — null = 가능, string = 사유 (hint 자리에 표시 + 체크박스 disabled). */
export interface FormatAvailability {
  migration:  string | null;
  mapping:    string | null;
  validation: string | null;
  summary:    string | null;
}

interface Props {
  siteName: string;
  tableCount: number;
  fileCount: number;
  selectedFormats: SelectedFormats;
  onSelectedFormatsChange: (next: SelectedFormats) => void;
  /** 현재 미리보기 중인 포맷 (행 라벨 클릭으로 변경). 체크 상태와 독립. */
  previewedFormat: PreviewedFormat;
  /** 라벨/힌트 클릭 시 호출 — 미리보기 포맷 변경. */
  onPreviewSelect: (k: PreviewedFormat) => void;
  /** 각 포맷의 사용 가능 여부 (선택된 프로젝트의 snapshot status 기준). */
  availability: FormatAvailability;
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

      {/* 가운데 — format 체크박스. 다중 선택 가능. 체크박스 클릭 = 다운로드 선택, 라벨 클릭 = 미리보기 선택.
          ARTIFACT FORMATS 첫 행: ALL 체크박스 (가능한 모든 포맷 일괄 토글). */}
      <div style={styles.body}>
        <SectionHead>{t('siteExport.section.formats')}</SectionHead>
        {/* ALL 체크박스 — 4 박스 모두 토글. 라벨은 미리보기 동작 없음. */}
        <AllCheckRow
          selectedFormats={props.selectedFormats}
          availability={props.availability}
          onChange={(v) => {
            // available 한 것만 토글 — disabled 는 false 유지.
            props.onSelectedFormatsChange({
              mapping:    props.availability.mapping    === null ? v : false,
              migration:  props.availability.migration  === null ? v : false,
              validation: props.availability.validation === null ? v : false,
              summary:    props.availability.summary    === null ? v : false,
            });
          }}
        />
        {formatsRows.map(r => {
          const reason = props.availability[r.key];
          const disabled = reason !== null;
          return (
            <CheckRow
              key={r.key}
              label={t(r.label)}
              hint={disabled ? reason ?? '' : t(r.hint)}
              checked={!disabled && props.selectedFormats[r.key]}
              disabled={disabled}
              highlighted={props.previewedFormat === r.key}
              onChange={v => {
                if (disabled) return;
                props.onSelectedFormatsChange({ ...props.selectedFormats, [r.key]: v });
              }}
              onPreview={() => { if (!disabled) props.onPreviewSelect(r.key); }}
            />
          );
        })}

        <div style={{ height: 10 }} />
        <SectionHead>{t('siteExport.section.documents')}</SectionHead>
        {documentsRows.map(r => {
          const reason = props.availability[r.key];
          const disabled = reason !== null;
          return (
            <CheckRow
              key={r.key}
              label={t(r.label)}
              hint={disabled ? reason ?? '' : t(r.hint)}
              checked={!disabled && props.selectedFormats[r.key]}
              disabled={disabled}
              highlighted={props.previewedFormat === r.key}
              onChange={v => {
                if (disabled) return;
                props.onSelectedFormatsChange({ ...props.selectedFormats, [r.key]: v });
              }}
              onPreview={() => { if (!disabled) props.onPreviewSelect(r.key); }}
            />
          );
        })}

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
  disabled?: boolean;
  /** 미리보기 중인 행이면 라벨 영역 강조 — '지금 어느 항목 보고 있는지' 식별. */
  highlighted?: boolean;
  /** 체크박스 영역 클릭 시 — 다운로드 선택 토글. */
  onChange: (v: boolean) => void;
  /** 라벨/힌트 영역 클릭 시 — 미리보기 선택 (체크박스 영향 X). */
  onPreview?: () => void;
}

function CheckRow({ label, hint, checked, disabled, highlighted, onChange, onPreview }: CheckRowProps) {
  return (
    <div
      style={{
        ...styles.checkRow,
        ...(disabled ? styles.checkRowDisabled : {}),
        ...(highlighted ? styles.checkRowHighlighted : {}),
      }}
    >
      {/* 체크박스 영역 — 클릭 시 다운로드 선택만 토글. disabled 시 무시. */}
      <span
        style={{ display: 'flex', alignItems: 'center', cursor: disabled ? 'not-allowed' : 'pointer' }}
        onClick={(e) => { e.stopPropagation(); if (!disabled) onChange(!checked); }}
      >
        <Checkbox checked={checked} onChange={(v) => { if (!disabled) onChange(v); }} />
      </span>
      {/* 라벨/힌트 영역 — 클릭 시 미리보기 선택만 변경. disabled 시 무시. */}
      <div
        style={{ flex: 1, cursor: disabled ? 'not-allowed' : 'pointer' }}
        onClick={() => { if (!disabled) onPreview?.(); }}
      >
        <div style={{ ...styles.checkLabel, ...(disabled ? styles.checkLabelDisabled : {}) }}>{label}</div>
        <div style={{ ...styles.checkHint, ...(disabled ? styles.checkHintDisabled : {}) }}>{hint}</div>
      </div>
    </div>
  );
}

/** ALL 체크박스 — ARTIFACT FORMATS 헤더 바로 아래. available 한 포맷만 일괄 토글. */
interface AllCheckRowProps {
  selectedFormats: SelectedFormats;
  availability: FormatAvailability;
  onChange: (v: boolean) => void;
}
function AllCheckRow({ selectedFormats, availability, onChange }: AllCheckRowProps) {
  const availableKeys = (['mapping', 'migration', 'validation', 'summary'] as const)
    .filter((k) => availability[k] === null);
  // ALL 체크 상태 — 사용 가능한 모든 포맷이 체크됐을 때 true.
  const allChecked = availableKeys.length > 0 && availableKeys.every((k) => selectedFormats[k]);
  return (
    <label
      style={{ ...styles.checkRow, fontWeight: 600 }}
      onClick={() => onChange(!allChecked)}
    >
      <Checkbox checked={allChecked} onChange={onChange} />
      <div style={{ flex: 1 }}>
        <div style={{ ...styles.checkLabel, fontWeight: 700 }}>ALL</div>
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
  /* 비활성 상태 — 선택 프로젝트의 snapshot status 가 그 포맷을 허용 안 할 때. */
  checkRowDisabled: { cursor: 'not-allowed', opacity: 0.55 },
  /* 현재 미리보기 중인 행 — 좌측 navy accent line + 옅은 배경. */
  checkRowHighlighted: {
    background: '#eef2fa',
    borderLeft: '3px solid var(--navy)',
    marginLeft: -3,
    paddingLeft: 3,
  },
  checkLabel: { fontSize: 12, color: 'var(--text)' },
  checkLabelDisabled: { color: 'var(--text-3)' },
  checkHint: { fontSize: 10, color: 'var(--text-3)', fontFamily: 'var(--mono)' },
  checkHintDisabled: { color: 'var(--text-3)', fontStyle: 'italic' },

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
