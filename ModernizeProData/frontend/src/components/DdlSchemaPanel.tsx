import { useEffect, useRef, useState } from 'react';
import { useAsisDdlStore } from '../store/asisDdl';
import { useTobeDdlStore } from '../store/tobeDdl';
import { useWorkspaceStore, type Project } from '../store/workspace';
import { DdlImportButton } from './DdlImportButton';
import { useT } from '../i18n';

interface Props {
  project: Project;
  side: 'asis' | 'tobe';
  /** true 면 amber 색 펄스 — 1 초후 자동 소거. 부모가 토글. */
  highlight?: boolean;
}

/**
 * AS-IS / TO-BE 共通の DDL 인포트 패널.
 * 미 인포트 = 빨강, 인포트 완료 = 초록 베이스의 외곽 카드 + Import / Re-import / Delete 액션.
 * 삭제는 inline confirm bar (UserManagement 패턴) 로 확인.
 */
export function DdlSchemaPanel({ project, side, highlight }: Props) {
  const t = useT();

  const asisFetch = useAsisDdlStore((s) => s.fetch);
  const asisRemove = useAsisDdlStore((s) => s.remove);
  const asisSchema = useAsisDdlStore((s) => s.schemasByProject[project.id]);
  const asisLoading = useAsisDdlStore((s) => s.loadingByProject[project.id] ?? false);
  const tobeFetch = useTobeDdlStore((s) => s.fetch);
  const tobeRemove = useTobeDdlStore((s) => s.remove);
  const tobeSchema = useTobeDdlStore((s) => s.schemasByProject[project.id]);
  const tobeLoading = useTobeDdlStore((s) => s.loadingByProject[project.id] ?? false);

  const fetchProjects = useWorkspaceStore((s) => s.fetchProjects);

  const fetch = side === 'asis' ? asisFetch : tobeFetch;
  const remove = side === 'asis' ? asisRemove : tobeRemove;
  const schema = side === 'asis' ? asisSchema : tobeSchema;
  const loading = side === 'asis' ? asisLoading : tobeLoading;
  const tableCount = side === 'asis' ? project.tableCount : project.tobeTableCount;

  const titleKey = side === 'asis' ? 'asisDdl.panel.title' : 'tobeDdl.panel.title';
  const descKey = side === 'asis' ? 'asisDdl.panel.desc' : 'tobeDdl.panel.desc';
  const reimportKey = side === 'asis' ? 'asisDdl.panel.reimport' : 'tobeDdl.panel.reimport';
  const deleteKey = side === 'asis' ? 'asisDdl.panel.delete' : 'tobeDdl.panel.delete';
  const deletingKey = side === 'asis' ? 'asisDdl.panel.deleting' : 'tobeDdl.panel.deleting';
  const loadingKey = side === 'asis' ? 'asisDdl.panel.loading' : 'tobeDdl.panel.loading';
  const confirmPreKey = side === 'asis' ? 'asisDdl.confirmDeletePre' : 'tobeDdl.confirmDeletePre';
  const confirmPostKey = side === 'asis' ? 'asisDdl.confirmDeletePost' : 'tobeDdl.confirmDeletePost';

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (tableCount > 0) {
      fetch(project.id).catch(() => {});
    }
  }, [project.id, tableCount, fetch]);

  // 램프 클릭으로 들어왔을 때 패널이 화면 가운데에 오도록 자동 스크롤.
  useEffect(() => {
    if (highlight && panelRef.current) {
      panelRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [highlight]);

  const imported = schema?.latestImport;
  const hasSchema = tableCount > 0 || !!imported;

  const handleConfirmedDelete = async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      await remove(project.id);
      await fetchProjects(project.siteId);
      setConfirmDelete(false);
    } finally {
      setDeleting(false);
    }
  };

  // imported = green, not imported = red.
  // highlight (램프 클릭으로 들어왔을 때) 는 양쪽과 겹치지 않도록 teal pulse.
  const HIGHLIGHT_BORDER = '#0E7C7B'; // deep teal
  const HIGHLIGHT_BG = '#D0EAEA';     // 薄 teal
  const outer: React.CSSProperties = {
    border: `${highlight ? 2 : 1}px solid ${highlight ? HIGHLIGHT_BORDER : hasSchema ? 'var(--green)' : 'var(--red)'}`,
    borderRadius: 4,
    background: highlight
      ? HIGHLIGHT_BG
      : hasSchema ? 'var(--green-50)' : 'var(--red-50)',
    boxShadow: highlight ? `0 0 0 4px rgba(14, 124, 123, 0.22)` : undefined,
    transition: 'border-color 0.4s ease, background-color 0.4s ease, box-shadow 0.4s ease',
    marginBottom: 14,
  };
  // not-imported 상태에선 body 도 외곽 빨간 패널과 같은 red-50 으로 통일.
  // imported 상태(상세 정보 표시)는 가독성을 위해 패널 화이트 그대로.
  const bodyStyle: React.CSSProperties = {
    ...styles.body,
    background: highlight
      ? HIGHLIGHT_BG
      : hasSchema ? 'var(--panel)' : 'var(--red-50)',
    transition: 'background-color 0.4s ease',
  };

  // not-imported 상태에선 body 박스를 그리지 않고 헤더만 단일 행으로.
  // imported / loading 일 때만 body 표시.
  const showBody = hasSchema;
  const headerStyle: React.CSSProperties = {
    ...styles.header,
    borderBottom: showBody ? '1px solid var(--border)' : 'none',
  };

  return (
    <div ref={panelRef} style={outer}>
      <div style={headerStyle}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={styles.titleRow}>
            <span style={styles.title}>{t(titleKey)}</span>
            {hasSchema
              ? <span style={styles.badgeOk}>imported</span>
              : <span style={styles.badgeWarn}>not imported</span>}
          </div>
          <div style={styles.desc}>{t(descKey)}</div>
        </div>
        {!hasSchema && (
          <DdlImportButton
            projectId={project.id}
            siteId={project.siteId}
            side={side}
          />
        )}
      </div>

      {showBody && (
        <div style={bodyStyle}>
          {imported ? (
            <>
              <div style={styles.row}>
                <div style={styles.label}>{t('asisDdl.panel.file')}</div>
                <div style={styles.mono}>{imported.filename}</div>
              </div>
              <div style={styles.row}>
                <div style={styles.label}>{t('asisDdl.panel.detected')}</div>
                <div style={styles.mono}>
                  {imported.tableCount} tables · {imported.columnCount} columns
                </div>
              </div>
              <div style={styles.row}>
                <div style={styles.label}>{t('asisDdl.panel.importedAt')}</div>
                <div style={styles.mono}>{new Date(imported.importedAt).toLocaleString()}</div>
              </div>

              {confirmDelete ? (
                <div style={styles.confirmBar}>
                  <span style={styles.confirmText}>
                    {t(confirmPreKey)}<b>{imported.filename}</b>{t(confirmPostKey)}
                  </span>
                  <div style={{ flex: 1 }} />
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(false)}
                    disabled={deleting}
                    style={styles.miniBtn}
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    type="button"
                    onClick={handleConfirmedDelete}
                    disabled={deleting}
                    style={styles.miniBtnDanger}
                  >
                    {deleting ? t(deletingKey) : t(deleteKey)}
                  </button>
                </div>
              ) : (
                <div style={styles.actions}>
                  <DdlImportButton
                    projectId={project.id}
                    siteId={project.siteId}
                    side={side}
                    label={t(reimportKey)}
                  />
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(true)}
                    style={styles.deleteBtn}
                  >
                    {t(deleteKey)}
                  </button>
                </div>
              )}
            </>
          ) : loading ? (
            <div style={styles.emptyHint}>{t(loadingKey)}</div>
          ) : null}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  header: {
    padding: '10px 14px 9px',
    borderBottom: '1px solid var(--border)',
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },
  titleRow: { display: 'flex', alignItems: 'center', gap: 8 },
  title: { fontSize: 12, fontWeight: 600, color: 'var(--text)' },
  desc: { fontSize: 10.5, color: 'var(--text-3)', marginTop: 2 },
  badgeOk: {
    padding: '1px 6px',
    fontSize: 10,
    fontWeight: 600,
    background: 'var(--green-50)',
    color: 'var(--green)',
    border: '1px solid var(--green)',
    borderRadius: 3,
  },
  badgeWarn: {
    padding: '1px 6px',
    fontSize: 10,
    fontWeight: 600,
    background: 'var(--red-50)',
    color: 'var(--red)',
    border: '1px solid var(--red)',
    borderRadius: 3,
  },
  body: { padding: '12px 14px', background: 'var(--panel)' },
  row: {
    display: 'grid',
    gridTemplateColumns: '160px 1fr',
    padding: '4px 0',
    borderBottom: '1px dashed var(--border)',
  },
  label: { fontSize: 11.5, fontWeight: 500 },
  mono: { fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--text-2)' },
  actions: { marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' },
  deleteBtn: {
    padding: '8px 14px',
    background: 'transparent',
    color: 'var(--red)',
    border: '1px solid var(--red)',
    borderRadius: 4,
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
  },
  emptyHint: { fontSize: 10.5, color: 'var(--text-3)' },
  confirmBar: {
    marginTop: 12,
    padding: '8px 10px',
    background: 'var(--red-50)',
    border: '1px solid var(--red)',
    borderRadius: 4,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  confirmText: { fontSize: 11.5, color: 'var(--text)', fontFamily: 'var(--sans)' },
  miniBtn: {
    padding: '4px 10px',
    background: 'var(--panel)',
    color: 'var(--text-2)',
    border: '1px solid var(--border-strong)',
    borderRadius: 3,
    fontSize: 11,
    fontWeight: 500,
    cursor: 'pointer',
  },
  miniBtnDanger: {
    padding: '4px 10px',
    background: 'var(--red)',
    color: '#fff',
    border: '1px solid var(--red)',
    borderRadius: 3,
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
  },
};
