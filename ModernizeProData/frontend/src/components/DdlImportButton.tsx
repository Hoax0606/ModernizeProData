import { useRef, useState } from 'react';
import { useAsisDdlStore } from '../store/asisDdl';
import { useTobeDdlStore } from '../store/tobeDdl';
import { useWorkspaceStore } from '../store/workspace';
import type { DdlImport } from '../api/asisDdl';
import { useT } from '../i18n';

interface Props {
  projectId: string;
  siteId: string;
  side: 'asis' | 'tobe';
  label?: string;
  disabled?: boolean;
  /** 'navy' (default) for Dashboard / re-import; 'red' / 'green' for panel emphasis. */
  tone?: 'navy' | 'red' | 'green';
  onSuccess?: (result: DdlImport) => void;
}

/**
 * AS-IS / TO-BE 양측에서 사용 가능한 DDL 인포트 버튼.
 * side 에 따라 useAsisDdlStore / useTobeDdlStore 를 분기 사용.
 */
export function DdlImportButton({ projectId, siteId, side, label, disabled, tone = 'navy', onSuccess }: Props) {
  const t = useT();

  const asisImport = useAsisDdlStore((s) => s.import);
  const asisLoading = useAsisDdlStore((s) => s.loadingByProject[projectId] ?? false);
  const tobeImport = useTobeDdlStore((s) => s.import);
  const tobeLoading = useTobeDdlStore((s) => s.loadingByProject[projectId] ?? false);

  const importDdl = side === 'asis' ? asisImport : tobeImport;
  const loading = side === 'asis' ? asisLoading : tobeLoading;
  const defaultLabel = side === 'asis' ? t('asisDdl.button.import') : t('tobeDdl.button.import');
  const loadingLabel = side === 'asis' ? t('asisDdl.button.loading') : t('tobeDdl.button.loading');
  const errorPrefix = side === 'asis' ? t('asisDdl.error.prefix') : t('tobeDdl.error.prefix');

  const fetchProjects = useWorkspaceStore((s) => s.fetchProjects);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (!file) return;
    setError(null);
    try {
      const result = await importDdl(projectId, file);
      await fetchProjects(siteId);
      onSuccess?.(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const isDisabled = !!disabled || loading;
  const accent = tone === 'red'   ? 'var(--red)'
                : tone === 'green' ? 'var(--green)'
                : 'var(--navy)';

  // position: relative + 에러 absolute — 에러 메시지가 버튼 박스(폭/높이)에 전혀 영향 안 주게.
  // 이전엔 에러가 컨테이너를 넓히거나(폭) 아래로 밀어(높이) 버튼 배치가 흔들렸다(#72 후속).
  return (
    <div style={{ position: 'relative', display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start' }}>
      <input
        ref={fileInputRef}
        type="file"
        accept=".sql,.ddl,.txt"
        onChange={onChange}
        style={{ display: 'none' }}
      />
      <button
        type="button"
        disabled={isDisabled}
        onClick={() => fileInputRef.current?.click()}
        style={{
          padding: '6px 12px',
          minWidth: 148,
          background: isDisabled ? 'var(--panel-2)' : accent,
          color: isDisabled ? 'var(--text-3)' : '#fff',
          border: '1px solid ' + (isDisabled ? 'var(--border)' : accent),
          borderRadius: 4,
          fontSize: 12,
          fontWeight: 600,
          cursor: isDisabled ? 'not-allowed' : 'pointer',
          whiteSpace: 'nowrap',
          textAlign: 'center',
        }}
      >
        {loading ? loadingLabel : label ?? defaultLabel}
      </button>
      {error && (
        <div style={{
          position: 'absolute',
          top: '100%',
          left: 0,
          marginTop: 6,
          fontSize: 11,
          color: 'var(--red)',
          // 버튼 아래에 띄우되 layout 비차지(absolute) — 폭 고정, 줄바꿈.
          width: 240,
          whiteSpace: 'normal',
          wordBreak: 'break-word',
          textAlign: 'left',
          zIndex: 1,
        }}>
          {errorPrefix}: {error}
        </div>
      )}
    </div>
  );
}
