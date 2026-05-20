import { useMemo } from 'react';
import { useWorkspaceStore } from '../store/workspace';
import { useT } from '../i18n';

/**
 * Execution tab (project level) — 현재 프로젝트의 실행 상태 read-only.
 * test / rehearsal / cutover 각 단계의 상태를 표시.
 */
export function ExecutionPage() {
  const t = useT();
  const projects = useWorkspaceStore((s) => s.projects);
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const project = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId],
  );

  if (!project) {
    return (
      <div>
        <div style={styles.empty}>
          <div style={styles.emptyTitle}>{t('execution.empty.noProject')}</div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <section style={styles.card}>
        <div style={styles.cardHeader}>
          <div>
            <div style={styles.cardTitle}>{t('execution.phaseStatus')}</div>
          </div>
          <span style={styles.phaseTag}>{project.phase}</span>
          {project.runStatus && project.runStatus !== 'idle' && (
            <span style={{
              ...styles.runTag,
              ...(project.runStatus === 'running' ? styles.runTagRunning : styles.runTagCompleted),
            }}>
              {project.runStatus}
            </span>
          )}
        </div>

        <div style={styles.cardBody}>
          {(project.phase === 'planning' || project.phase === 'analysis') && (
            <div style={styles.bodyDescMuted}>{t('execution.notAtExecution')}</div>
          )}
          {project.phase === 'test' && (
            <div style={styles.bodyDesc}>{t('execution.test.title')}</div>
          )}
          {project.phase === 'sign-off' && (
            <div style={styles.bodyDescMuted}>{t('execution.signoff.title')}</div>
          )}
          {project.phase === 'rehearsal' && (
            <div style={styles.bodyDesc}>{t('execution.rehearsal.title')}</div>
          )}
          {project.phase === 'ready' && (
            <div style={styles.bodyDesc}>{t('execution.ready.title')}</div>
          )}
          {project.phase === 'cutover' && (
            <div style={styles.bodyDesc}>{t('execution.cutover.running.title')}</div>
          )}
          {project.phase === 'hypercare' && (
            <>
              <div style={styles.bodyDesc}>{t('execution.cutover.hypercare.title')}</div>
              <div style={styles.bodyDescSub}>{t('execution.cutover.hypercare.desc')}</div>
            </>
          )}
          {project.phase === 'done' && (
            <div style={styles.bodyDesc}>{t('execution.cutover.done.title')}</div>
          )}
        </div>
      </section>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  header: { marginBottom: 14 },
  h1: { margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--text)', letterSpacing: -0.2 },
  subtitle: { margin: '4px 0 0', fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--mono)' },
  empty: { background: 'var(--panel)', border: '1px dashed var(--border-strong)', borderRadius: 6, padding: '50px 24px', textAlign: 'center' },
  emptyTitle: { fontSize: 13, fontWeight: 600, color: 'var(--text-3)' },

  card: { background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden', marginBottom: 14 },
  cardHeader: {
    padding: '12px 16px',
    borderBottom: '1px solid var(--border)',
    display: 'flex', alignItems: 'center', gap: 12,
  },
  cardTitle: { fontSize: 13, fontWeight: 700, color: 'var(--text)', flex: 1 },
  cardBody: { padding: '14px 16px' },

  phaseTag: {
    padding: '2px 10px', fontSize: 10.5, fontWeight: 700, fontFamily: 'var(--mono)',
    background: 'var(--panel-2)', color: 'var(--text-2)', border: '1px solid var(--border-strong)',
    borderRadius: 3, textTransform: 'uppercase', letterSpacing: 0.4, whiteSpace: 'nowrap',
  },
  runTag: {
    padding: '2px 8px', fontSize: 10, fontWeight: 700, fontFamily: 'var(--mono)',
    borderRadius: 3, textTransform: 'uppercase', letterSpacing: 0.3, whiteSpace: 'nowrap',
  },
  runTagRunning: { background: 'var(--amber-50)', color: 'var(--amber)', border: '1px solid var(--amber)' },
  runTagCompleted: { background: 'var(--phase-done-50)', color: 'var(--phase-done)', border: '1px solid var(--phase-done)' },

  bodyDesc:       { fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 8 },
  bodyDescSub:    { fontSize: 12, color: 'var(--text-2)', marginBottom: 8, lineHeight: 1.5 },
  bodyDescMuted:  { fontSize: 12, color: 'var(--text-3)', fontFamily: 'var(--mono)', marginBottom: 8 },
};
