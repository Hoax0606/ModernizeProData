import { useMemo, useRef, useState } from 'react';
import { useT } from '../i18n';
import { mappingImportApi, type SiteMappingImportResult } from '../api/mappingImport';

interface SiteProjectLite {
  id: string;
  name: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  siteId: string;
  projects: SiteProjectLite[];
  /** import 성공 후 콜백 (대시보드 갱신 등). */
  onImported?: (result: SiteMappingImportResult) => void;
}

/**
 * 사이트 단위 맵핑정의서 일괄 import 모달.
 *
 * 하나의 column/code CSV 를 선택한 프로젝트들(기본 전체)에 분배한다. 백엔드
 * SiteMappingImportService 가 per-project import 를 재사용 — 각 프로젝트는 자기 DDL
 * 슬라이스만 가져가고 기존 rules 는 전체 교체된다.
 */
export function SiteMappingImportModal({ open, onClose, siteId, projects, onImported }: Props) {
  const t = useT();
  const [columnFile, setColumnFile] = useState<File | null>(null);
  const [codeFile, setCodeFile] = useState<File | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(projects.map((p) => p.id)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SiteMappingImportResult | null>(null);
  const colRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  const allSelected = projects.length > 0 && selected.size === projects.length;
  const canImport = !busy && (!!columnFile || !!codeFile) && selected.size > 0;

  const outcomeById = useMemo(() => {
    const m = new Map<string, SiteMappingImportResult['projects'][number]>();
    if (result) for (const o of result.projects) m.set(o.projectId, o);
    return m;
  }, [result]);

  if (!open) return null;

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected((prev) => (prev.size === projects.length ? new Set() : new Set(projects.map((p) => p.id))));
  };

  const runImport = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const ids = selected.size === projects.length ? [] : Array.from(selected);
      const res = await mappingImportApi.importSite(siteId, ids, columnFile, codeFile);
      setResult(res);
      onImported?.(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={styles.overlay} onClick={busy ? undefined : onClose}>
      <div style={styles.card} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <span style={styles.title}>Site Mapping Import</span>
          <button type="button" style={styles.x} onClick={onClose} disabled={busy}>×</button>
        </div>
        <p style={styles.desc}>{t('siteMapping.desc')}</p>

        {/* File pickers */}
        <div style={styles.fileStack}>
          <FileField
            label={t('siteMapping.columnFile')}
            file={columnFile}
            inputRef={colRef}
            onPick={(f) => setColumnFile(f)}
          />
          <FileField
            label={t('siteMapping.codeFile')}
            file={codeFile}
            inputRef={codeRef}
            onPick={(f) => setCodeFile(f)}
          />
        </div>

        {/* Project checklist */}
        <div style={styles.listHead}>
          <label style={styles.checkLabel}>
            <input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={busy} />
            <span>{t('siteMapping.selectAll')} ({selected.size}/{projects.length})</span>
          </label>
        </div>
        <div style={styles.list}>
          {projects.map((p) => {
            const o = outcomeById.get(p.id);
            return (
              <label key={p.id} style={styles.row}>
                <input
                  type="checkbox"
                  checked={selected.has(p.id)}
                  onChange={() => toggle(p.id)}
                  disabled={busy}
                />
                <span style={styles.rowName}>{p.name}</span>
                {o && (
                  o.status === 'success'
                    ? <span style={styles.ok}>{t('siteMapping.rulesN', { n: o.ruleCount, c: o.codeMapCount })}</span>
                    : <span style={styles.fail} title={o.error ?? ''}>{t('siteMapping.failed')}</span>
                )}
              </label>
            );
          })}
        </div>

        {error && <div style={styles.errorBox}>{error}</div>}
        {result && (
          <div style={styles.summary}>
            {t('siteMapping.summary', { ok: result.succeeded, total: result.total })}
          </div>
        )}

        <div style={styles.actions}>
          <button type="button" style={styles.btnGhost} onClick={onClose} disabled={busy}>
            {result ? t('common.close') : t('common.cancel')}
          </button>
          <button
            type="button"
            style={{ ...styles.btnPrimary, ...(canImport ? {} : styles.btnDisabled) }}
            onClick={runImport}
            disabled={!canImport}
          >
            {busy ? t('siteMapping.importing') : t('siteMapping.import')}
          </button>
        </div>
      </div>
    </div>
  );
}

function FileField({
  label, file, inputRef, onPick,
}: {
  label: string;
  file: File | null;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onPick: (f: File | null) => void;
}) {
  return (
    <div style={styles.fileRow}>
      <div style={styles.fieldLabel}>{label}</div>
      <div style={styles.fileBox}>
        <div style={file ? styles.fileName : styles.filePlaceholder}>{file ? file.name : '—'}</div>
        <button
          type="button"
          onClick={() => { onPick(null); if (inputRef.current) inputRef.current.value = ''; }}
          style={{ ...styles.iconBtn, ...(file ? {} : styles.iconBtnDisabled) }}
          disabled={!file}
        >
          <i className="fa-solid fa-trash" />
        </button>
        <button type="button" onClick={() => inputRef.current?.click()} style={styles.iconBtn}>
          <i className="fa-solid fa-folder" />
        </button>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".csv"
        style={{ display: 'none' }}
        onChange={(e) => onPick(e.target.files?.[0] ?? null)}
      />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(10,20,18,0.4)',
    display: 'grid', placeItems: 'center', zIndex: 4000,
  },
  card: {
    width: 560, maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 48px)',
    overflow: 'auto', background: 'var(--panel)', border: '1px solid var(--border-strong)',
    borderRadius: 6, padding: 18, boxShadow: '0 20px 60px rgba(10,20,18,0.18)',
  },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  title: { fontSize: 14, fontWeight: 800, color: 'var(--text)' },
  x: { background: 'none', border: 'none', fontSize: 20, lineHeight: 1, cursor: 'pointer', color: 'var(--text-3)' },
  desc: { fontSize: 12, color: 'var(--text-3)', margin: '0 0 12px', lineHeight: 1.5 },
  fileStack: { display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 14 },
  fileRow: { display: 'flex', alignItems: 'center', gap: 10 },
  fieldLabel: { width: 150, flexShrink: 0, fontSize: 11.5, color: 'var(--text-2)' },
  fileBox: {
    flex: 1, minWidth: 0,
    display: 'flex', alignItems: 'center', gap: 4,
    padding: '6px 10px',
    background: 'var(--panel)',
    border: '1px solid var(--border-strong)',
    borderRadius: 4,
    minHeight: 30,
  },
  fileName: {
    flex: 1, minWidth: 0, fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text)',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  filePlaceholder: { flex: 1, minWidth: 0, fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-4)' },
  iconBtn: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 22, height: 22, background: 'transparent', border: 'none', borderRadius: 3,
    cursor: 'pointer', color: 'var(--text-3)', fontSize: 12,
  },
  iconBtnDisabled: { color: 'var(--text-4)', opacity: 0.45, cursor: 'not-allowed' },
  listHead: { marginBottom: 4 },
  checkLabel: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: 'var(--text)', cursor: 'pointer' },
  list: {
    border: '1px solid var(--border)', borderRadius: 4, maxHeight: 220, overflow: 'auto',
    background: 'var(--panel-2)',
  },
  row: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
    borderBottom: '1px solid var(--border)', fontSize: 12, color: 'var(--text)', cursor: 'pointer',
  },
  rowName: { flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  ok: { fontSize: 11, color: 'var(--green)', fontWeight: 600, whiteSpace: 'nowrap' },
  fail: { fontSize: 11, color: 'var(--red)', fontWeight: 600, whiteSpace: 'nowrap' },
  errorBox: {
    marginTop: 10, padding: '8px 10px', background: 'rgba(220,50,50,0.08)',
    border: '1px solid var(--red)', borderRadius: 4, fontSize: 11.5, color: 'var(--red)',
    maxWidth: '100%', wordBreak: 'break-word',
  },
  summary: { marginTop: 10, fontSize: 12, fontWeight: 600, color: 'var(--text)' },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 },
  btnGhost: {
    padding: '6px 14px', background: 'transparent', color: 'var(--text)',
    border: '1px solid var(--border-strong)', borderRadius: 3, fontSize: 12, cursor: 'pointer',
  },
  btnPrimary: {
    padding: '6px 16px', background: 'var(--navy)', color: '#fff',
    border: '1px solid var(--navy)', borderRadius: 3, fontSize: 12, fontWeight: 600, cursor: 'pointer',
  },
  btnDisabled: { opacity: 0.5, cursor: 'not-allowed' },
};
