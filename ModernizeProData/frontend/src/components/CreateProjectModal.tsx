import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from './Modal';
import { useWorkspaceStore } from '../store/workspace';
import { useAuthStore } from '../store/auth';
import { asisDdlApi } from '../api/asisDdl';
import { tobeDdlApi } from '../api/tobeDdl';
import { mappingImportApi } from '../api/mappingImport';
import { ApiError } from '../api/client';
import { useT } from '../i18n';
import { detectDialectOfFile } from '../lib/detectDialect';

interface Props {
  open: boolean;
  onClose: () => void;
}

interface ProjectRow {
  id: number;
  name: string;
  asis: File | null;
  tobe: File | null;
  /** #71-A — 파일 내용 휴리스틱으로 추정한 DB 종류 라벨 (Oracle/PostgreSQL/…). */
  asisDialect?: string;
  tobeDialect?: string;
  /** #67 — 생성 실패 사유 (localized). 있으면 행을 빨강+사유 표시. */
  failReason?: string;
}

const DDL_EXTS = ['.sql', '.ddl', '.txt'];

/**
 * 프로젝트 생성 모달 — 통합 행-리스트 UI (#68: Single/Multiple 구분 제거).
 * 행 1개 = 프로젝트 1개. 1개만 만들면 행 1개. 모달 폭 고정.
 *  - Auto-create from AS-IS DDL folder: 폴더/다중파일 → 파일마다 행 (#69 라벨).
 *  - Match TO-BE with AS-IS: TO-BE 폴더에서 AS-IS 파일명과 같은 이름 찾아 자동 매칭 (#70).
 *  - 각 DDL 파일은 추정 DB 종류 배지 표시 (#71-A).
 *  - 생성 실패 행은 사유와 함께 빨강 표시 후 유지 (#67).
 */
export function CreateProjectModal({ open, onClose }: Props) {
  const t = useT();
  const createProject = useWorkspaceStore((s) => s.createProject);
  const sites = useWorkspaceStore((s) => s.sites);
  const activeSiteId = useWorkspaceStore((s) => s.activeSiteId);
  const activeSite = useMemo(() => sites.find((s) => s.id === activeSiteId) ?? null, [sites, activeSiteId]);
  const currentUser = useAuthStore((s) => s.user);

  const rowSeq = useRef(0);
  const newRow = (): ProjectRow => ({ id: ++rowSeq.current, name: '', asis: null, tobe: null });
  const [rows, setRows] = useState<ProjectRow[]>(() => [newRow()]);
  const [error, setError] = useState<string | null>(null);
  const [matchNote, setMatchNote] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // 사이트 매핑정의서 (선택) — 생성된 프로젝트들에 일괄 분배. per-project import 재사용.
  const [smCol, setSmCol] = useState<File | null>(null);
  const [smCode, setSmCode] = useState<File | null>(null);
  const [smNote, setSmNote] = useState<string | null>(null);
  const smColRef = useRef<HTMLInputElement | null>(null);
  const smCodeRef = useRef<HTMLInputElement | null>(null);

  // AS-IS 자동생성 폴더 input + TO-BE 매칭 폴더 input. webkitdirectory 지원(Chromium)→폴더,
  // 미지원→multiple 파일 선택으로 자동 폴백.
  const asisFolderRef = useRef<HTMLInputElement | null>(null);
  const tobeFolderRef = useRef<HTMLInputElement | null>(null);

  const reset = () => {
    rowSeq.current = 0;
    setRows([newRow()]);
    setError(null);
    setMatchNote(null);
    setSmCol(null);
    setSmCode(null);
    setSmNote(null);
    setSubmitting(false);
  };

  useEffect(() => {
    if (open) reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const stripDdlExt = (fileName: string) => fileName.replace(/\.(sql|ddl|txt)$/i, '');

  const updateRow = (id: number, patch: Partial<ProjectRow>) =>
    setRows((cur) => cur.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const addRow = () => setRows((cur) => [...cur, newRow()]);
  const removeRow = (id: number) =>
    setRows((cur) => (cur.length <= 1 ? cur : cur.filter((r) => r.id !== id)));

  /** AS-IS 선택 — name 비면 파일명으로 자동 + dialect 추정(비동기). */
  const pickAsis = (id: number, f: File | null) => {
    setRows((cur) => cur.map((r) => (r.id === id
      ? { ...r, asis: f, asisDialect: undefined, failReason: undefined,
          name: (f && !r.name.trim()) ? stripDdlExt(f.name) : r.name }
      : r)));
    if (f) detectDialectOfFile(f).then((d) => updateRow(id, { asisDialect: d.label }));
  };

  /** TO-BE 선택 — dialect 추정(비동기). */
  const pickTobe = (id: number, f: File | null) => {
    updateRow(id, { tobe: f, tobeDialect: undefined, failReason: undefined });
    if (f) detectDialectOfFile(f).then((d) => updateRow(id, { tobeDialect: d.label }));
  };

  /** Auto-create from AS-IS DDL folder — 파일마다 행 추가. 이름=파일명, AS-IS=그 파일. */
  const handleAsisFolderPick = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const picked = Array.from(fileList).filter((f) => DDL_EXTS.some((e) => f.name.toLowerCase().endsWith(e)));
    if (picked.length === 0) { setError(t('createProject.error.noDdlInFolder')); return; }
    const added: ProjectRow[] = picked.map((f) => ({
      id: ++rowSeq.current, name: stripDdlExt(f.name), asis: f, tobe: null,
    }));
    setRows((cur) => {
      const meaningful = cur.filter((r) => r.name.trim() || r.asis || r.tobe);
      return [...meaningful, ...added];
    });
    setError(null);
    for (const nr of added) {
      if (nr.asis) detectDialectOfFile(nr.asis).then((d) => updateRow(nr.id, { asisDialect: d.label }));
    }
  };

  /** Match TO-BE with AS-IS (#70) — 고른 폴더에서 각 행 AS-IS 파일명(stem)과 같은 TO-BE 찾아 매칭. */
  const handleTobeFolderMatch = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList).filter((f) => DDL_EXTS.some((e) => f.name.toLowerCase().endsWith(e)));
    // stem(소문자) → 파일. .sql 우선.
    const byStem = new Map<string, File>();
    for (const f of files) {
      const stem = stripDdlExt(f.name).toLowerCase();
      const cur = byStem.get(stem);
      if (!cur || (f.name.toLowerCase().endsWith('.sql') && !cur.name.toLowerCase().endsWith('.sql'))) {
        byStem.set(stem, f);
      }
    }
    const matches: { id: number; file: File }[] = [];
    for (const r of rows) {
      if (!r.asis) continue;
      const m = byStem.get(stripDdlExt(r.asis.name).toLowerCase());
      if (m) matches.push({ id: r.id, file: m });
    }
    const matchedIds = new Map(matches.map((m) => [m.id, m.file] as const));
    setRows((cur) => cur.map((r) => (matchedIds.has(r.id)
      ? { ...r, tobe: matchedIds.get(r.id)!, tobeDialect: undefined, failReason: undefined }
      : r)));
    for (const m of matches) detectDialectOfFile(m.file).then((d) => updateRow(m.id, { tobeDialect: d.label }));
    setMatchNote(matches.length > 0
      ? t('createProject.matchTobeResult', { n: matches.length })
      : t('createProject.matchTobeNone'));
  };

  /** 프로젝트 1개 생성 + DDL import. 성공={ id }, 실패={ reason }. */
  const createOne = async (row: ProjectRow): Promise<{ id: string } | { reason: string }> => {
    let projectId: string;
    try {
      const project = await createProject({
        name: row.name.trim(),
        phase: 'planning',
        tableCount: 0,
        tobeTableCount: 0,
        ddlFiles: [],
        owner: currentUser?.username ?? '—',
      });
      projectId = project.id;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PROJECT_NAME_DUPLICATE') return { reason: 'duplicate' };
      return { reason: 'generic' };
    }
    if (row.asis) {
      try { await asisDdlApi.import(projectId, row.asis); }
      catch (err) { console.error('[createProject] AS-IS import failed', err); return { reason: 'asisDdl' }; }
    }
    if (row.tobe) {
      try { await tobeDdlApi.import(projectId, row.tobe); }
      catch (err) { console.error('[createProject] TO-BE import failed', err); return { reason: 'tobeDdl' }; }
    }
    return { id: projectId };
  };

  const reasonText = (key: string): string => {
    switch (key) {
      case 'duplicate': return t('createProject.error.duplicate');
      case 'asisDdl':   return t('createProject.error.asisDdl');
      case 'tobeDdl':   return t('createProject.error.tobeDdl');
      default:          return t('createProject.error.generic');
    }
  };

  const namedRows = rows.filter((r) => r.name.trim() !== '');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting || !activeSite) return;
    setError(null);
    setMatchNote(null);
    if (namedRows.length === 0) { setError(t('createProject.error.empty')); return; }

    setSubmitting(true);
    setSmNote(null);
    const reasons = new Map<number, string>();
    const createdIds: string[] = [];
    for (const r of namedRows) {
      const res = await createOne(r);
      if ('id' in res) createdIds.push(res.id);
      else reasons.set(r.id, res.reason);
    }

    // 사이트 매핑정의서 분배 (선택) — 생성 성공한 프로젝트들에만 적용.
    const hasSpec = !!smCol || !!smCode;
    let smFailed = false;
    if (hasSpec && createdIds.length > 0 && activeSite) {
      try {
        const res = await mappingImportApi.importSite(activeSite.id, createdIds, smCol, smCode);
        setSmNote(t('siteMapping.summary', { ok: res.succeeded, total: res.total }));
        smFailed = res.succeeded !== res.total;
      } catch (err) {
        setSmNote(err instanceof Error ? err.message : String(err));
        smFailed = true;
      }
    }

    if (reasons.size === 0) {
      // 프로젝트 생성 + 매핑 분배 모두 성공 → 모달 닫기.
      // 매핑 분배에 일부 실패가 있을 때만 결과(smNote)를 보여주려 열어둔다(생성행은 비움).
      if (hasSpec && smFailed) {
        rowSeq.current = 0;
        setRows([newRow()]);
        setSmCol(null);
        setSmCode(null);
        setSubmitting(false);
        return;
      }
      reset(); onClose(); return;
    }
    // 성공 행 제거, 실패 행만 사유와 함께 남겨 재시도 가능하게 (#67 — 왜 안 됐는지 행별 표시).
    setRows((cur) => cur
      .filter((r) => reasons.has(r.id) || r.name.trim() === '')
      .map((r) => (reasons.has(r.id) ? { ...r, failReason: reasonText(reasons.get(r.id)!) } : r)));
    setError(t('createProject.error.bulkPartial', { n: reasons.size }));
    setSubmitting(false);
  };

  if (!activeSite) return null;

  const submitDisabled = submitting || namedRows.length === 0;

  // 숨김 다중파일 input — 폴더(webkitdirectory)는 Chromium 이 "N개 파일 업로드?" 보안
  // 확인창(브라우저 느낌)을 강제로 띄워서 안 쓴다. 대신 multiple 파일 선택(여러 DDL 한 번에).
  const folderInput = (ref: React.MutableRefObject<HTMLInputElement | null>,
                       onPick: (fl: FileList | null) => void) => (
    <input
      ref={ref}
      type="file"
      multiple
      accept=".sql,.ddl,.txt"
      style={{ display: 'none' }}
      onChange={(e) => { onPick(e.target.files); if (e.target) e.target.value = ''; }}
    />
  );

  return (
    <Modal open={open} onClose={onClose} width={820} title={t('createProject.title')}>
      <form onSubmit={handleSubmit} style={styles.form}>
        {/* 도구줄 — AS-IS 폴더 자동생성 / TO-BE 이름매칭 */}
        <div style={styles.tools}>
          {folderInput(asisFolderRef, handleAsisFolderPick)}
          {folderInput(tobeFolderRef, handleTobeFolderMatch)}
          <button type="button" onClick={() => asisFolderRef.current?.click()} style={styles.toolBtn} disabled={submitting}>
            <i className="fa-solid fa-folder-open" style={{ fontSize: 11 }} />
            <span>{t('createProject.autoFromFolder')}</span>
          </button>
          <button type="button" onClick={() => tobeFolderRef.current?.click()} style={styles.toolBtn} disabled={submitting}>
            <i className="fa-solid fa-link" style={{ fontSize: 11 }} />
            <span>{t('createProject.matchTobe')}</span>
          </button>
          {matchNote && <span style={styles.matchNote}>{matchNote}</span>}
        </div>

        <div style={styles.rowList}>
          {rows.map((r, idx) => (
            <div key={r.id} style={{ ...styles.projRow, ...(r.failReason ? styles.projRowFailed : {}) }}>
              <div style={styles.projRowMain}>
                <span style={styles.rowIdx}>{idx + 1}</span>
                <input
                  value={r.name}
                  onChange={(e) => updateRow(r.id, { name: e.target.value, failReason: undefined })}
                  style={{ ...styles.input, ...styles.rowNameInput }}
                  placeholder={t('createProject.rowName')}
                  disabled={submitting}
                  autoFocus={idx === rows.length - 1}
                />
                <CompactDdlPicker
                  labelText={t('createProject.ddl.asisLabel')}
                  file={r.asis}
                  dialect={r.asisDialect}
                  onPick={(f) => pickAsis(r.id, f)}
                  disabled={submitting}
                />
                <CompactDdlPicker
                  labelText={t('createProject.ddl.tobeLabel')}
                  file={r.tobe}
                  dialect={r.tobeDialect}
                  onPick={(f) => pickTobe(r.id, f)}
                  disabled={submitting}
                />
                <button
                  type="button"
                  onClick={() => removeRow(r.id)}
                  style={styles.rowRemoveBtn}
                  title={t('createProject.ddlRemove')}
                  disabled={submitting || rows.length <= 1}
                >
                  ×
                </button>
              </div>
              {r.failReason && <div style={styles.rowFailText}>{r.failReason}</div>}
            </div>
          ))}
        </div>

        <button type="button" onClick={addRow} style={styles.addRowBtn} disabled={submitting}>
          + {t('createProject.addRow')}
        </button>

        {/* 사이트 매핑정의서 (선택) — 생성된 전 프로젝트에 일괄 분배 */}
        <div style={styles.smBox}>
          <div style={styles.smHead}>
            <span style={styles.smTitle}>Site Mapping Import</span>
          </div>
          <p style={styles.smDesc}>{t('siteMapping.desc')}</p>
          <div style={styles.smFiles}>
            <SmFile
              label={t('siteMapping.columnFile')}
              file={smCol}
              inputRef={smColRef}
              onPick={setSmCol}
              disabled={submitting}
            />
            <SmFile
              label={t('siteMapping.codeFile')}
              file={smCode}
              inputRef={smCodeRef}
              onPick={setSmCode}
              disabled={submitting}
            />
          </div>
          {smNote && <div style={styles.smNote}>{smNote}</div>}
        </div>

        {error && <div style={styles.errorBox}>{error}</div>}

        <div style={styles.actions}>
          <button type="button" onClick={onClose} style={styles.btnGhost} disabled={submitting}>
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            style={{ ...styles.btnPrimary, ...(submitDisabled ? styles.btnDisabled : {}) }}
            disabled={submitDisabled}
          >
            {t('createProject.submitMulti', { n: namedRows.length })}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** 배지용 짧은 DB 코드 — 파일명 공간 확보 (#71-A 배지가 너무 길어 파일명 가리던 문제). */
function shortDialect(label: string): string {
  switch (label.toLowerCase()) {
    case 'oracle': return 'ORA';
    case 'postgresql': return 'PG';
    case 'mysql': return 'MySQL';
    case 'sql server': return 'MSSQL';
    case '?': return '?';
    default: return label.slice(0, 4).toUpperCase();
  }
}

interface CompactDdlPickerProps {
  labelText: string;
  file: File | null;
  dialect?: string;
  onPick: (f: File | null) => void;
  disabled: boolean;
}

/** 한 줄짜리 DDL picker — 미선택=빨강 점선 버튼(#66), 선택=초록 pill + 추정 DB 배지(#71-A). */
function CompactDdlPicker({ labelText, file, dialect, onPick, disabled }: CompactDdlPickerProps) {
  const ref = useRef<HTMLInputElement | null>(null);
  const selected = !!file;
  return (
    <div style={selected ? styles.compactSel : styles.compactEmpty}>
      <input
        ref={ref}
        type="file"
        accept=".sql,.ddl,.txt"
        onChange={(e) => onPick(e.target.files?.[0] ?? null)}
        style={{ display: 'none' }}
      />
      {selected ? (
        <>
          <button
            type="button"
            onClick={() => ref.current?.click()}
            style={styles.compactPillBody}
            disabled={disabled}
            title={file!.name}
          >
            <span style={styles.compactTag}>{labelText}</span>
            <span style={styles.compactName}>{file!.name}</span>
          </button>
          {dialect && <span style={styles.compactDialect} title={dialect}>{shortDialect(dialect)}</span>}
          <button
            type="button"
            onClick={() => { onPick(null); if (ref.current) ref.current.value = ''; }}
            style={styles.compactClear}
            disabled={disabled}
          >
            ×
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => ref.current?.click()}
          style={styles.compactImport}
          disabled={disabled}
        >
          <i className="fa-solid fa-plus" style={{ fontSize: 9 }} />
          <span>{labelText}</span>
        </button>
      )}
    </div>
  );
}

/** 사이트 매핑정의서 파일 1개 picker (Create 모달용). */
function SmFile({
  label, file, inputRef, onPick, disabled,
}: {
  label: string;
  file: File | null;
  inputRef: React.MutableRefObject<HTMLInputElement | null>;
  onPick: (f: File | null) => void;
  disabled: boolean;
}) {
  return (
    <div style={styles.smRow}>
      <div style={styles.smFieldLabel}>{label}</div>
      <div style={styles.smFileBox}>
        <div style={file ? styles.smFileName : styles.smFilePlaceholder}>{file ? file.name : '—'}</div>
        <button
          type="button"
          onClick={() => { onPick(null); if (inputRef.current) inputRef.current.value = ''; }}
          style={{ ...styles.smIconBtn, ...(file ? {} : styles.smIconBtnDisabled) }}
          disabled={disabled || !file}
        >
          <i className="fa-solid fa-trash" />
        </button>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          style={styles.smIconBtn}
          disabled={disabled}
        >
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
  form: { display: 'flex', flexDirection: 'column', gap: 14 },
  hint: { fontSize: 11, color: 'var(--text-3)' },
  input: {
    padding: '8px 10px',
    border: '1px solid var(--border-strong)',
    borderRadius: 4,
    background: 'var(--panel)',
    color: 'var(--text)',
    fontSize: 13,
    outline: 'none',
  },

  /* 도구줄 */
  tools: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 10,
    padding: '2px 0',
  },
  toolBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 12px',
    background: 'var(--panel)',
    border: '1px solid var(--navy)',
    color: 'var(--navy)',
    borderRadius: 4,
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  matchNote: { fontSize: 11, color: 'var(--text-2)', fontFamily: 'var(--mono)' },

  /* 행 리스트 */
  rowList: { display: 'flex', flexDirection: 'column', gap: 8 },
  projRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    padding: '8px 10px',
    border: '1px solid var(--border)',
    borderRadius: 6,
    background: 'var(--panel-2)',
  },
  projRowMain: { display: 'flex', alignItems: 'center', gap: 8 },
  projRowFailed: { borderColor: 'var(--red)', background: 'var(--red-50)' },
  rowFailText: { fontSize: 11, color: 'var(--red)', paddingLeft: 22 },
  rowIdx: {
    fontSize: 11,
    fontFamily: 'var(--mono)',
    color: 'var(--text-3)',
    minWidth: 14,
    textAlign: 'center',
  },
  rowNameInput: { flex: 1, minWidth: 0 },
  rowRemoveBtn: {
    width: 24,
    height: 24,
    background: 'transparent',
    border: 'none',
    color: 'var(--text-3)',
    cursor: 'pointer',
    fontSize: 17,
    lineHeight: 1,
    padding: 0,
    flexShrink: 0,
  },
  addRowBtn: {
    alignSelf: 'flex-start',
    padding: '6px 12px',
    background: 'var(--panel)',
    border: '1px dashed var(--border-strong)',
    color: 'var(--navy)',
    borderRadius: 4,
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  },

  /* 한 줄 DDL picker */
  compactEmpty: { flex: 1, minWidth: 0, display: 'flex' },
  compactSel: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    border: '1px solid var(--green)',
    background: 'var(--green-50)',
    borderRadius: 4,
    overflow: 'hidden',
  },
  compactImport: {
    flex: 1,
    minWidth: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: '7px 10px',
    background: 'var(--red-50)',
    border: '1px dashed var(--red)',
    color: 'var(--red)',
    borderRadius: 4,
    fontSize: 11.5,
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  compactPillBody: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '7px 4px 7px 10px',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    overflow: 'hidden',
  },
  compactTag: {
    fontSize: 10,
    fontWeight: 700,
    color: 'var(--green)',
    fontFamily: 'var(--mono)',
    flexShrink: 0,
  },
  compactName: {
    fontSize: 11.5,
    color: 'var(--text)',
    fontFamily: 'var(--mono)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  // #71-A 추정 DB 종류 배지 (초록 pill 안, 파일명 뒤).
  compactDialect: {
    flexShrink: 0,
    fontSize: 9.5,
    fontWeight: 700,
    fontFamily: 'var(--mono)',
    color: 'var(--navy)',
    background: 'var(--navy-50)',
    border: '1px solid var(--navy)',
    borderRadius: 3,
    padding: '0 4px',
    marginRight: 4,
  },
  compactClear: {
    width: 22,
    height: 22,
    flexShrink: 0,
    background: 'transparent',
    border: 'none',
    color: 'var(--text-3)',
    cursor: 'pointer',
    fontSize: 15,
    lineHeight: 1,
    padding: 0,
  },

  errorBox: {
    padding: '8px 10px',
    background: 'var(--red-50)',
    border: '1px solid var(--red)',
    borderRadius: 4,
    color: 'var(--red)',
    fontSize: 12,
    fontWeight: 500,
  },

  /* 사이트 매핑정의서 (선택) 섹션 */
  smBox: {
    border: '1px dashed var(--border-strong)',
    borderRadius: 6,
    padding: '10px 12px',
    background: 'var(--panel-2)',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  smHead: { display: 'flex', alignItems: 'center', gap: 8 },
  smTitle: { fontSize: 12, fontWeight: 700, color: 'var(--text)' },
  smDesc: { fontSize: 11, color: 'var(--text-3)', margin: 0, lineHeight: 1.45 },
  smFiles: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 2 },
  smRow: { display: 'flex', alignItems: 'center', gap: 10 },
  smFieldLabel: { width: 150, flexShrink: 0, fontSize: 11.5, color: 'var(--text-2)' },
  smFileBox: {
    flex: 1, minWidth: 0,
    display: 'flex', alignItems: 'center', gap: 4,
    padding: '6px 10px',
    background: 'var(--panel)',
    border: '1px solid var(--border-strong)',
    borderRadius: 4,
    minHeight: 30,
  },
  smFileName: {
    flex: 1, minWidth: 0, fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text)',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  smFilePlaceholder: { flex: 1, minWidth: 0, fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-4)' },
  smIconBtn: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 22, height: 22, background: 'transparent', border: 'none', borderRadius: 3,
    cursor: 'pointer', color: 'var(--text-3)', fontSize: 12,
  },
  smIconBtnDisabled: { color: 'var(--text-4)', opacity: 0.45, cursor: 'not-allowed' },
  smNote: { fontSize: 11.5, fontWeight: 600, color: 'var(--text)', marginTop: 2 },

  actions: { display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 4 },
  btnGhost: {
    padding: '7px 14px',
    background: 'transparent',
    border: '1px solid var(--border-strong)',
    color: 'var(--text-2)',
    borderRadius: 4,
    fontSize: 12.5,
    cursor: 'pointer',
  },
  btnPrimary: {
    padding: '7px 14px',
    background: 'var(--navy)',
    color: '#fff',
    border: '1px solid var(--navy)',
    borderRadius: 4,
    fontSize: 12.5,
    fontWeight: 600,
    cursor: 'pointer',
  },
  btnDisabled: { opacity: 0.5, cursor: 'not-allowed' },
};
