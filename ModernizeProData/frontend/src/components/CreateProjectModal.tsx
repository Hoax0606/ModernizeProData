import { useMemo, useRef, useState } from 'react';
import { Modal } from './Modal';
import { useWorkspaceStore, type DdlFile } from '../store/workspace';
import { useAuthStore } from '../store/auth';
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
  const [ddlFiles, setDdlFiles] = useState<DdlFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const reset = () => {
    setName('');
    setDdlFiles([]);
    setError(null);
  };

  const handleFilesPicked = (filesList: FileList | null) => {
    if (!filesList) return;
    const now = new Date().toISOString();
    const incoming: DdlFile[] = Array.from(filesList).map((f) => ({
      name: f.name,
      size: f.size,
      uploadedAt: now,
    }));
    // 같은 이름은 새 항목으로 덮어쓰기
    setDdlFiles((cur) => [...cur.filter((f) => !incoming.some((nf) => nf.name === f.name)), ...incoming]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !activeSite) return;
    setError(null);
    try {
      await createProject({
        name: name.trim(),
        phase: 'planning',
        tableCount: 0,
        ddlFiles,
        owner: currentUser?.username ?? '—',
      });
      reset();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PROJECT_NAME_DUPLICATE') {
        setError(t('createProject.error.duplicate'));
      } else {
        setError(t('createProject.error.generic'));
      }
    }
  };

  if (!activeSite) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={480}
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
          />
        </Field>

        <Field label={t('createProject.ddl')} hint={t('createProject.ddlHint')}>
          <input
            ref={fileInputRef}
            type="file"
            accept=".sql,.ddl,.txt"
            multiple
            onChange={(e) => handleFilesPicked(e.target.files)}
            style={{ display: 'none' }}
          />
          <div style={styles.ddlBox}>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              style={styles.btnGhostSmall}
            >
              {t('createProject.ddlPick')}
            </button>
            {ddlFiles.length === 0 ? (
              <span style={styles.ddlEmpty}>{t('createProject.ddlEmpty')}</span>
            ) : (
              <ul style={styles.ddlList}>
                {ddlFiles.map((f) => (
                  <li key={f.name} style={styles.ddlItem}>
                    <span style={styles.ddlName}>{f.name}</span>
                    <span style={styles.ddlSize}>{formatSize(f.size)}</span>
                    <button
                      type="button"
                      onClick={() => setDdlFiles((cur) => cur.filter((x) => x.name !== f.name))}
                      style={styles.ddlRemoveBtn}
                      title={t('createProject.ddlRemove')}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Field>

        {error && <div style={styles.errorBox}>{error}</div>}

        <div style={styles.actions}>
          <button type="button" onClick={onClose} style={styles.btnGhost}>{t('common.cancel')}</button>
          <button type="submit" style={styles.btnPrimary}>{t('createProject.submit')}</button>
        </div>
      </form>
    </Modal>
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
  pillRow: { display: 'flex', flexWrap: 'wrap', gap: 4, border: '1px solid var(--border-strong)', borderRadius: 4, padding: 2, background: 'var(--panel)' },
  pill: {
    flex: 1,
    minWidth: 0,
    padding: '6px 10px',
    background: 'transparent',
    border: 'none',
    color: 'var(--text-2)',
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
    borderRadius: 3,
    whiteSpace: 'nowrap',
  },
  pillActive: {
    background: 'var(--navy-50)',
    color: 'var(--navy)',
    fontWeight: 600,
  },

  /* DDL file picker */
  ddlBox: {
    border: '1px dashed var(--border-strong)',
    borderRadius: 4,
    padding: 10,
    background: 'var(--panel)',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  ddlEmpty: { fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--mono)' },
  ddlList: { margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4 },
  ddlItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '4px 8px',
    background: 'var(--panel-2)',
    border: '1px solid var(--border)',
    borderRadius: 3,
    fontSize: 11.5,
  },
  ddlName: { flex: 1, color: 'var(--text)', fontFamily: 'var(--mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  ddlSize: { fontSize: 10.5, color: 'var(--text-3)', fontFamily: 'var(--mono)' },
  ddlRemoveBtn: {
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
    alignSelf: 'flex-start',
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
};
