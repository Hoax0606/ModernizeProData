import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from './Modal';
import { Checkbox } from './Checkbox';
import { useWorkspaceStore } from '../store/workspace';
import { useAuthStore } from '../store/auth';
import { asisDdlApi } from '../api/asisDdl';
import { tobeDdlApi } from '../api/tobeDdl';
import { ApiError } from '../api/client';
import { useT } from '../i18n';

interface Props {
  open: boolean;
  onClose: () => void;
}

type CreateMode = 'single' | 'multiple';

interface ProjectRow {
  id: number;
  name: string;
  asis: File | null;
  tobe: File | null;
}

export function CreateProjectModal({ open, onClose }: Props) {
  const t = useT();
  const createProject = useWorkspaceStore((s) => s.createProject);
  const sites = useWorkspaceStore((s) => s.sites);
  const activeSiteId = useWorkspaceStore((s) => s.activeSiteId);
  const activeSite = useMemo(() => sites.find((s) => s.id === activeSiteId) ?? null, [sites, activeSiteId]);
  const currentUser = useAuthStore((s) => s.user);

  const [mode, setMode] = useState<CreateMode>('single');

  // single 모드 필드
  const [name, setName] = useState('');
  const [asisFile, setAsisFile] = useState<File | null>(null);
  const [tobeFile, setTobeFile] = useState<File | null>(null);

  // multiple 모드 행들
  const rowSeq = useRef(0);
  const newRow = (): ProjectRow => ({ id: ++rowSeq.current, name: '', asis: null, tobe: null });
  const [rows, setRows] = useState<ProjectRow[]>(() => [newRow()]);
  // 생성 실패한 행 id — 강조 표시용.
  const [failedRowIds, setFailedRowIds] = useState<Set<number>>(() => new Set());
  // (B) 전 행 공유 TO-BE — 6개가 같은 TO-BE 스키마면 한 번만 고르게.
  const [applySharedTobe, setApplySharedTobe] = useState(false);
  const [sharedTobe, setSharedTobe] = useState<File | null>(null);
  // AS-IS 폴더/다중파일 자동 생성용 hidden input. webkitdirectory 지원(Chromium)→폴더,
  // 미지원→multiple 파일 선택으로 자동 폴백.
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setMode('single');
    setName('');
    setAsisFile(null);
    setTobeFile(null);
    rowSeq.current = 0;
    setRows([newRow()]);
    setFailedRowIds(new Set());
    setApplySharedTobe(false);
    setSharedTobe(null);
    setError(null);
    setSubmitting(false);
  };

  /** 파일명에서 DDL 확장자 제거 → 프로젝트 이름 후보. */
  const stripDdlExt = (fileName: string) => fileName.replace(/\.(sql|ddl|txt)$/i, '');

  /**
   * AS-IS 폴더(webkitdirectory) 또는 다중파일 선택 → 파일마다 행 자동 생성.
   * 이름 = 파일명(확장자 뗌), AS-IS = 그 파일. TO-BE 는 사용자가 채움(또는 공유 TO-BE).
   * 폴더가 하위 디렉터리까지 재귀로 주므로 확장자로 필터.
   */
  const handleFolderPick = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const exts = ['.sql', '.ddl', '.txt'];
    const picked = Array.from(fileList)
      .filter((f) => exts.some((e) => f.name.toLowerCase().endsWith(e)));
    if (picked.length === 0) {
      setError(t('createProject.error.noDdlInFolder'));
      return;
    }
    const newRows: ProjectRow[] = picked.map((f) => ({
      id: ++rowSeq.current, name: stripDdlExt(f.name), asis: f, tobe: null,
    }));
    // 기존에 의미있는 행(이름/파일 입력됨)은 보존, 빈 기본 행만 대체.
    setRows((cur) => {
      const meaningful = cur.filter((r) => r.name.trim() || r.asis || r.tobe);
      return [...meaningful, ...newRows];
    });
    setError(null);
  };

  // 모달을 열 때마다 폼을 초기화한다 (닫았다 다시 열어도 이전 입력값이 남지 않게).
  useEffect(() => {
    if (open) reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /** 프로젝트 1개 생성 + (선택) DDL 임포트. 성공 true, 실패 false. */
  const createOne = async (projName: string, asis: File | null, tobe: File | null): Promise<boolean> => {
    const project = await createProject({
      name: projName,
      phase: 'planning',
      tableCount: 0,
      tobeTableCount: 0,
      ddlFiles: [],
      owner: currentUser?.username ?? '—',
    });
    if (asis) await asisDdlApi.import(project.id, asis);
    if (tobe) await tobeDdlApi.import(project.id, tobe);
    return true;
  };

  const namedRows = rows.filter((r) => r.name.trim() !== '');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting || !activeSite) return;
    setError(null);

    if (mode === 'single') {
      if (!name.trim()) return;
      setSubmitting(true);
      try {
        const project = await createProject({
          name: name.trim(),
          phase: 'planning',
          tableCount: 0,
          tobeTableCount: 0,
          ddlFiles: [],
          owner: currentUser?.username ?? '—',
        });
        if (asisFile) {
          try {
            await asisDdlApi.import(project.id, asisFile);
          } catch (err) {
            console.error('[createProject] AS-IS DDL import failed', err);
            setError(t('createProject.error.asisDdl'));
            setSubmitting(false);
            return;
          }
        }
        if (tobeFile) {
          try {
            await tobeDdlApi.import(project.id, tobeFile);
          } catch (err) {
            console.error('[createProject] TO-BE DDL import failed', err);
            setError(t('createProject.error.tobeDdl'));
            setSubmitting(false);
            return;
          }
        }
        reset();
        onClose();
      } catch (err) {
        if (err instanceof ApiError && err.code === 'PROJECT_NAME_DUPLICATE') {
          setError(t('createProject.error.duplicate'));
        } else {
          setError(t('createProject.error.generic'));
        }
        setSubmitting(false);
      }
      return;
    }

    // multiple 모드 — 이름이 있는 행만 순차 생성. 실패 행은 강조 후 모달 유지.
    if (namedRows.length === 0) {
      setError(t('createProject.error.empty'));
      return;
    }
    setSubmitting(true);
    const failed = new Set<number>();
    for (const r of namedRows) {
      try {
        const tobe = (applySharedTobe && sharedTobe) ? sharedTobe : r.tobe;
        await createOne(r.name.trim(), r.asis, tobe);
      } catch (err) {
        console.error('[createProject] bulk row failed', r.name, err);
        failed.add(r.id);
      }
    }
    if (failed.size === 0) {
      reset();
      onClose();
      return;
    }
    // 성공한 행은 제거하고 실패한 행만 남겨 재시도 가능하게.
    setRows((cur) => cur.filter((r) => failed.has(r.id) || r.name.trim() === ''));
    setFailedRowIds(failed);
    setError(t('createProject.error.bulkPartial', { n: failed.size }));
    setSubmitting(false);
  };

  if (!activeSite) return null;

  const updateRow = (id: number, patch: Partial<ProjectRow>) =>
    setRows((cur) => cur.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const addRow = () => setRows((cur) => [...cur, newRow()]);
  const removeRow = (id: number) =>
    setRows((cur) => (cur.length <= 1 ? cur : cur.filter((r) => r.id !== id)));

  const submitDisabled = submitting
    || (mode === 'single' ? !name.trim() : namedRows.length === 0);

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={mode === 'multiple' ? 820 : 520}
      title={t('createProject.title')}
    >
      <form onSubmit={handleSubmit} style={styles.form}>
        {/* 생성 모드 선택 */}
        <div style={styles.segmented}>
          <button
            type="button"
            onClick={() => setMode('single')}
            style={{ ...styles.segBtn, ...(mode === 'single' ? styles.segBtnActive : {}) }}
            disabled={submitting}
          >
            {t('createProject.mode.single')}
          </button>
          <button
            type="button"
            onClick={() => setMode('multiple')}
            style={{ ...styles.segBtn, ...(mode === 'multiple' ? styles.segBtnActive : {}) }}
            disabled={submitting}
          >
            {t('createProject.mode.multiple')}
          </button>
        </div>

        {mode === 'single' ? (
          <>
            <Field label={t('createProject.name')}>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                style={styles.input}
                autoFocus
                required
                disabled={submitting}
              />
            </Field>
            <div style={styles.field}>
              <div style={styles.label}>{t('createProject.ddl')}</div>
              <div style={styles.ddlRow}>
                <CompactDdlPicker
                  labelText={t('createProject.ddl.asisLabel')}
                  file={asisFile}
                  onPick={setAsisFile}
                  disabled={submitting}
                />
                <CompactDdlPicker
                  labelText={t('createProject.ddl.tobeLabel')}
                  file={tobeFile}
                  onPick={setTobeFile}
                  disabled={submitting}
                />
              </div>
            </div>
          </>
        ) : (
          <div style={styles.field}>
            <div style={styles.hint}>{t('createProject.multiHint')}</div>

            {/* AS-IS 폴더/다중파일 자동 생성 + 공유 TO-BE 토글 */}
            <div style={styles.multiTools}>
              <input
                ref={(el) => {
                  folderInputRef.current = el;
                  // webkitdirectory 지원 엔진(Chromium)→폴더 선택, 미지원→multiple 파일 선택 폴백.
                  if (el) { el.setAttribute('webkitdirectory', ''); el.setAttribute('directory', ''); }
                }}
                type="file"
                multiple
                accept=".sql,.ddl,.txt"
                style={{ display: 'none' }}
                onChange={(e) => { handleFolderPick(e.target.files); if (e.target) e.target.value = ''; }}
              />
              <button
                type="button"
                onClick={() => folderInputRef.current?.click()}
                style={styles.autoBtn}
                disabled={submitting}
              >
                <i className="fa-solid fa-folder-open" style={{ fontSize: 11 }} />
                <span>{t('createProject.autoFromFolder')}</span>
              </button>

              <label style={styles.sharedToggle}>
                <Checkbox
                  checked={applySharedTobe}
                  onChange={() => setApplySharedTobe((v) => !v)}
                  disabled={submitting}
                  ariaLabel={t('createProject.sharedTobe')}
                />
                <span>{t('createProject.sharedTobe')}</span>
              </label>
              {applySharedTobe && (
                <div style={styles.sharedTobePicker}>
                  <CompactDdlPicker
                    labelText={t('createProject.ddl.tobeLabel')}
                    file={sharedTobe}
                    onPick={setSharedTobe}
                    disabled={submitting}
                  />
                </div>
              )}
            </div>

            <div style={styles.rowList}>
              {rows.map((r, idx) => (
                <div
                  key={r.id}
                  style={{
                    ...styles.projRow,
                    ...(failedRowIds.has(r.id) ? styles.projRowFailed : {}),
                  }}
                >
                  <span style={styles.rowIdx}>{idx + 1}</span>
                  <input
                    value={r.name}
                    onChange={(e) => updateRow(r.id, { name: e.target.value })}
                    style={{ ...styles.input, ...styles.rowNameInput }}
                    placeholder={t('createProject.rowName')}
                    disabled={submitting}
                    autoFocus={idx === rows.length - 1}
                  />
                  <CompactDdlPicker
                    labelText={t('createProject.ddl.asisLabel')}
                    file={r.asis}
                    onPick={(f) => updateRow(r.id, { asis: f })}
                    disabled={submitting}
                  />
                  {applySharedTobe ? (
                    <span style={styles.sharedTobeRowTag}>
                      {t('createProject.ddl.tobeLabel')} · {t('createProject.sharedTobeRow')}
                    </span>
                  ) : (
                    <CompactDdlPicker
                      labelText={t('createProject.ddl.tobeLabel')}
                      file={r.tobe}
                      onPick={(f) => updateRow(r.id, { tobe: f })}
                      disabled={submitting}
                    />
                  )}
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
              ))}
            </div>
            <button
              type="button"
              onClick={addRow}
              style={styles.addRowBtn}
              disabled={submitting}
            >
              + {t('createProject.addRow')}
            </button>
          </div>
        )}

        {error && <div style={styles.errorBox}>{error}</div>}

        <div style={styles.actions}>
          <button
            type="button"
            onClick={onClose}
            style={styles.btnGhost}
            disabled={submitting}
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            style={{ ...styles.btnPrimary, ...(submitDisabled ? styles.btnDisabled : {}) }}
            disabled={submitDisabled}
          >
            {mode === 'multiple'
              ? t('createProject.submitMulti', { n: namedRows.length })
              : t('createProject.submit')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

interface CompactDdlPickerProps {
  labelText: string;
  file: File | null;
  onPick: (f: File | null) => void;
  disabled: boolean;
}

/** 한 줄짜리 DDL picker — 빈 상태는 점선 버튼, 선택 상태는 초록 pill. */
function CompactDdlPicker({ labelText, file, onPick, disabled }: CompactDdlPickerProps) {
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

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={styles.field}>
      <div style={styles.label}>{label}</div>
      {hint && <div style={styles.hint}>{hint}</div>}
      {children}
    </label>
  );
}

const styles: Record<string, React.CSSProperties> = {
  form: { display: 'flex', flexDirection: 'column', gap: 14 },
  field: { display: 'flex', flexDirection: 'column', gap: 6 },
  label: { fontSize: 12.5, fontWeight: 600, color: 'var(--text)' },
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

  /* 모드 선택 segmented control */
  segmented: {
    display: 'flex',
    gap: 0,
    border: '1px solid var(--border-strong)',
    borderRadius: 6,
    overflow: 'hidden',
    alignSelf: 'flex-start',
  },
  segBtn: {
    padding: '6px 16px',
    background: 'var(--panel)',
    color: 'var(--text-2)',
    border: 'none',
    fontSize: 12.5,
    fontWeight: 600,
    cursor: 'pointer',
  },
  segBtnActive: { background: 'var(--navy)', color: '#fff' },

  /* DDL 한 줄 배치 (AS-IS · TO-BE side by side) */
  ddlRow: { display: 'flex', gap: 8 },

  /* multiple 모드 도구줄 (폴더 자동 + 공유 TO-BE) */
  multiTools: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 12,
    padding: '8px 0 2px',
  },
  autoBtn: {
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
  sharedToggle: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 12,
    color: 'var(--text)',
    cursor: 'pointer',
  },
  sharedTobePicker: { display: 'flex', minWidth: 220, flex: 1 },
  sharedTobeRowTag: {
    flex: 1,
    minWidth: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '7px 10px',
    fontSize: 11,
    fontFamily: 'var(--mono)',
    color: 'var(--text-3)',
    background: 'var(--panel-2)',
    border: '1px dashed var(--border-strong)',
    borderRadius: 4,
    whiteSpace: 'nowrap',
  },

  /* multiple 모드 행 리스트 */
  rowList: { display: 'flex', flexDirection: 'column', gap: 8 },
  projRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 10px',
    border: '1px solid var(--border)',
    borderRadius: 6,
    background: 'var(--panel-2)',
  },
  projRowFailed: { borderColor: 'var(--red)', background: 'var(--red-50)' },
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
    marginTop: 4,
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
    background: 'var(--panel)',
    border: '1px dashed var(--border-strong)',
    color: 'var(--text-2)',
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
