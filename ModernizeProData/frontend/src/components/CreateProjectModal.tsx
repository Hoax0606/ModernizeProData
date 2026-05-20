import { useMemo, useRef, useState } from 'react';
import { Modal } from './Modal';
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

export function CreateProjectModal({ open, onClose }: Props) {
  const t = useT();
  const createProject = useWorkspaceStore((s) => s.createProject);
  const sites = useWorkspaceStore((s) => s.sites);
  const activeSiteId = useWorkspaceStore((s) => s.activeSiteId);
  const activeSite = useMemo(() => sites.find((s) => s.id === activeSiteId) ?? null, [sites, activeSiteId]);
  const currentUser = useAuthStore((s) => s.user);

  const [name, setName] = useState('');
  const [asisFile, setAsisFile] = useState<File | null>(null);
  const [tobeFile, setTobeFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const asisInputRef = useRef<HTMLInputElement | null>(null);
  const tobeInputRef = useRef<HTMLInputElement | null>(null);

  const reset = () => {
    setName('');
    setAsisFile(null);
    setTobeFile(null);
    setError(null);
    setSubmitting(false);
    if (asisInputRef.current) asisInputRef.current.value = '';
    if (tobeInputRef.current) tobeInputRef.current.value = '';
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !activeSite || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const project = await createProject({
        name: name.trim(),
        phase: 'planning',
        tableCount: 0,
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

      // 양쪽 DDL 임포트가 끝났으면 백엔드가 phase 를 analysis 로 자동 전환했을 수 있다.
      // workspace store 의 다음 fetch 에서 갱신되므로 여기선 별도 처리 불필요.

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
  };

  if (!activeSite) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={520}
      title={t('createProject.title')}
    >
      <form onSubmit={handleSubmit} style={styles.form}>
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

        <Field label={t('createProject.ddl')}>
          <div style={styles.ddlPairs}>
            <DdlPicker
              side="asis"
              labelText={t('createProject.ddl.asisLabel')}
              file={asisFile}
              onPick={setAsisFile}
              inputRef={asisInputRef}
              importLabel={t('asisDdl.button.import')}
              changeLabel={t('createProject.ddl.change')}
              selectedLabel={t('createProject.ddl.selected')}
              notSelectedLabel={t('createProject.ddl.notSelected')}
              removeLabel={t('createProject.ddlRemove')}
              disabled={submitting}
            />
            <DdlPicker
              side="tobe"
              labelText={t('createProject.ddl.tobeLabel')}
              file={tobeFile}
              onPick={setTobeFile}
              inputRef={tobeInputRef}
              importLabel={t('tobeDdl.button.import')}
              changeLabel={t('createProject.ddl.change')}
              selectedLabel={t('createProject.ddl.selected')}
              notSelectedLabel={t('createProject.ddl.notSelected')}
              removeLabel={t('createProject.ddlRemove')}
              disabled={submitting}
            />
          </div>
        </Field>

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
            style={{ ...styles.btnPrimary, ...(submitting ? styles.btnDisabled : {}) }}
            disabled={submitting}
          >
            {t('createProject.submit')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

interface DdlPickerProps {
  side: 'asis' | 'tobe';
  labelText: string;
  file: File | null;
  onPick: (f: File | null) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  importLabel: string;
  changeLabel: string;
  selectedLabel: string;
  notSelectedLabel: string;
  removeLabel: string;
  disabled: boolean;
}

function DdlPicker({
  side, labelText, file, onPick, inputRef,
  importLabel, changeLabel, selectedLabel, notSelectedLabel,
  removeLabel, disabled,
}: DdlPickerProps) {
  const isSelected = !!file;
  void side;
  return (
    <div style={isSelected ? styles.ddlPickerSelected : styles.ddlPickerEmpty}>
      <div style={{ ...styles.ddlPickerHeader, borderBottom: isSelected ? '1px solid var(--border)' : 'none' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={styles.ddlPickerTitleRow}>
            <span style={styles.ddlPickerTitle}>{labelText}</span>
            {isSelected
              ? <span style={styles.ddlPickerBadgeOk}>{selectedLabel}</span>
              : <span style={styles.ddlPickerBadgeWarn}>{notSelectedLabel}</span>}
          </div>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".sql,.ddl,.txt"
          onChange={(e) => onPick(e.target.files?.[0] ?? null)}
          style={{ display: 'none' }}
        />
        {!isSelected && (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            style={styles.btnImportNavy}
            disabled={disabled}
          >
            {importLabel}
          </button>
        )}
      </div>
      {isSelected && file && (
        <div style={styles.ddlPickerBody}>
          <span style={styles.ddlFileName}>{file.name}</span>
          <span style={styles.ddlFileSize}>{formatSize(file.size)}</span>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            style={styles.btnChangeNavy}
            disabled={disabled}
          >
            {changeLabel}
          </button>
          <button
            type="button"
            onClick={() => {
              onPick(null);
              if (inputRef.current) inputRef.current.value = '';
            }}
            style={styles.ddlRemoveBtn}
            title={removeLabel}
            disabled={disabled}
          >
            ×
          </button>
        </div>
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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const styles: Record<string, React.CSSProperties> = {
  subtitle: {
    fontSize: 11,
    color: 'var(--text-3)',
    fontFamily: 'var(--mono)',
    fontWeight: 400,
    marginTop: 2,
  },
  form: { display: 'flex', flexDirection: 'column', gap: 14 },
  field: { display: 'flex', flexDirection: 'column', gap: 4 },
  label: { fontSize: 12.5, fontWeight: 600, color: 'var(--text)' },
  hint: { fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--mono)' },
  input: {
    padding: '8px 10px',
    border: '1px solid var(--border-strong)',
    borderRadius: 4,
    background: 'var(--panel)',
    color: 'var(--text)',
    fontSize: 13,
    outline: 'none',
  },

  /* DDL pickers — DdlSchemaPanel 과 동일한 헤더 + 배지 + 우측 버튼 패턴 */
  ddlPairs: { display: 'flex', flexDirection: 'column', gap: 10 },
  ddlPickerEmpty: {
    border: '1px solid var(--red)',
    background: 'var(--red-50)',
    borderRadius: 4,
  },
  ddlPickerSelected: {
    border: '1px solid var(--green)',
    background: 'var(--green-50)',
    borderRadius: 4,
  },
  ddlPickerHeader: {
    padding: '10px 14px 9px',
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },
  ddlPickerTitleRow: { display: 'flex', alignItems: 'center', gap: 8 },
  ddlPickerTitle: { fontSize: 12, fontWeight: 600, color: 'var(--text)' },
  ddlPickerBadgeOk: {
    padding: '1px 6px',
    fontSize: 10,
    fontWeight: 600,
    background: 'var(--green-50)',
    color: 'var(--green)',
    border: '1px solid var(--green)',
    borderRadius: 3,
  },
  ddlPickerBadgeWarn: {
    padding: '1px 6px',
    fontSize: 10,
    fontWeight: 600,
    background: 'var(--red-50)',
    color: 'var(--red)',
    border: '1px solid var(--red)',
    borderRadius: 3,
  },
  ddlPickerBody: {
    padding: '8px 14px',
    background: 'var(--panel)',
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },
  ddlFileName: {
    flex: 1,
    color: 'var(--text)',
    fontFamily: 'var(--mono)',
    fontSize: 11.5,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  ddlFileSize: { fontSize: 10.5, color: 'var(--text-3)', fontFamily: 'var(--mono)' },
  ddlRemoveBtn: {
    width: 22,
    height: 22,
    background: 'transparent',
    border: 'none',
    color: 'var(--text-3)',
    cursor: 'pointer',
    fontSize: 16,
    lineHeight: 1,
    padding: 0,
  },
  btnImportNavy: {
    padding: '6px 12px',
    minWidth: 148,
    background: 'var(--navy)',
    color: '#fff',
    border: '1px solid var(--navy)',
    borderRadius: 4,
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    textAlign: 'center',
  },
  btnChangeNavy: {
    padding: '4px 10px',
    background: 'var(--panel)',
    color: 'var(--navy)',
    border: '1px solid var(--navy)',
    borderRadius: 3,
    fontSize: 11.5,
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
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
  btnGhostSmall: {
    padding: '4px 10px',
    background: 'var(--panel)',
    border: '1px solid var(--border-strong)',
    color: 'var(--text-2)',
    borderRadius: 3,
    fontSize: 11.5,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
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
