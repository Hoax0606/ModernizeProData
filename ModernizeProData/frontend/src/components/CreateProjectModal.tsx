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
      title={
        <div>
          <div>{t('createProject.title')}</div>
          <div style={styles.subtitle}>{activeSite.name} · {t('createProject.subtitle')}</div>
        </div>
      }
    >
      <form onSubmit={handleSubmit} style={styles.form}>
        <Field label={t('createProject.name')} hint={t('createProject.nameHint')}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={styles.input}
            autoFocus
            required
            disabled={submitting}
          />
        </Field>

        <Field label={t('createProject.ddl')} hint={t('createProject.ddl.optional')}>
          <div style={styles.ddlPairs}>
            <DdlPicker
              labelText={t('createProject.ddl.asisLabel')}
              file={asisFile}
              onPick={setAsisFile}
              inputRef={asisInputRef}
              chooseLabel={t('createProject.ddl.choose')}
              emptyLabel={t('createProject.ddl.noFile')}
              removeLabel={t('createProject.ddlRemove')}
              disabled={submitting}
            />
            <DdlPicker
              labelText={t('createProject.ddl.tobeLabel')}
              file={tobeFile}
              onPick={setTobeFile}
              inputRef={tobeInputRef}
              chooseLabel={t('createProject.ddl.choose')}
              emptyLabel={t('createProject.ddl.noFile')}
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
  labelText: string;
  file: File | null;
  onPick: (f: File | null) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  chooseLabel: string;
  emptyLabel: string;
  removeLabel: string;
  disabled: boolean;
}

function DdlPicker({
  labelText, file, onPick, inputRef,
  chooseLabel, emptyLabel, removeLabel, disabled,
}: DdlPickerProps) {
  return (
    <div style={styles.ddlSide}>
      <div style={styles.ddlSideLabel}>{labelText}</div>
      <input
        ref={inputRef}
        type="file"
        accept=".sql,.ddl,.txt"
        onChange={(e) => onPick(e.target.files?.[0] ?? null)}
        style={{ display: 'none' }}
      />
      <div style={styles.ddlSideBody}>
        {file ? (
          <div style={styles.ddlChip}>
            <span style={styles.ddlChipName}>{file.name}</span>
            <span style={styles.ddlChipSize}>{formatSize(file.size)}</span>
            <button
              type="button"
              onClick={() => {
                onPick(null);
                if (inputRef.current) inputRef.current.value = '';
              }}
              style={styles.ddlChipRemove}
              title={removeLabel}
              disabled={disabled}
            >
              ×
            </button>
          </div>
        ) : (
          <div style={styles.ddlChipEmpty}>{emptyLabel}</div>
        )}
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          style={styles.btnGhostSmall}
          disabled={disabled}
        >
          {chooseLabel}
        </button>
      </div>
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

  /* DDL pickers — AS-IS / TO-BE side-by-side as two distinct chips */
  ddlPairs: { display: 'flex', flexDirection: 'column', gap: 8 },
  ddlSide: {
    border: '1px solid var(--border-strong)',
    borderRadius: 4,
    padding: '8px 10px',
    background: 'var(--panel)',
  },
  ddlSideLabel: {
    fontSize: 10.5,
    fontWeight: 700,
    color: 'var(--navy)',
    fontFamily: 'var(--mono)',
    letterSpacing: 0.4,
    marginBottom: 6,
    textTransform: 'uppercase',
  },
  ddlSideBody: { display: 'flex', alignItems: 'center', gap: 8 },
  ddlChip: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '4px 8px',
    background: 'var(--panel-2)',
    border: '1px solid var(--border)',
    borderRadius: 3,
    fontSize: 11.5,
  },
  ddlChipName: {
    flex: 1,
    color: 'var(--text)',
    fontFamily: 'var(--mono)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  ddlChipSize: { fontSize: 10.5, color: 'var(--text-3)', fontFamily: 'var(--mono)' },
  ddlChipRemove: {
    width: 18,
    height: 18,
    background: 'transparent',
    border: 'none',
    color: 'var(--text-3)',
    cursor: 'pointer',
    fontSize: 14,
    lineHeight: 1,
    padding: 0,
  },
  ddlChipEmpty: {
    flex: 1,
    fontSize: 11,
    color: 'var(--text-3)',
    fontFamily: 'var(--mono)',
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
