import { useMemo } from 'react';
import { useWorkspaceStore } from '../store/workspace';
import { useT } from '../i18n';

/**
 * Site export — 사이트 단위 일괄 export.
 * 프로젝트가 선택되어 있으면 본문 미렌더 (sidebar 클릭 핸들러가 redirect 처리).
 */
export function SiteExportPage() {
  const t = useT();
  const sites = useWorkspaceStore((s) => s.sites);
  const projects = useWorkspaceStore((s) => s.projects);
  const activeSiteId = useWorkspaceStore((s) => s.activeSiteId);
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);

  const site = useMemo(() => sites.find((s) => s.id === activeSiteId) ?? null, [sites, activeSiteId]);
  const siteProjects = useMemo(() => projects.filter((p) => p.siteId === activeSiteId), [projects, activeSiteId]);

  // redirect 는 sidebar 프로젝트 클릭 핸들러가 직접 처리 (race 회피).
  if (activeProjectId || !site) return null;

  return (
    <div>
      <section style={styles.card}>
        <div style={styles.cardHeader}>
          <div>
            <div style={styles.cardTitle}>{t('siteExport.downloadAll')}</div>
            <div style={styles.cardDesc}>
              {siteProjects.length} projects · all mappings, snapshots, audit logs
            </div>
          </div>
          <button disabled title={t('siteExport.notImpl')} style={styles.btnPrimaryDisabled}>
            {t('siteExport.downloadAll')}
          </button>
        </div>
        <div style={styles.notImpl}>{t('siteExport.notImpl')}</div>
      </section>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  header: { marginBottom: 18 },
  h1: {
    margin: 0,
    fontSize: 18,
    fontWeight: 600,
    color: 'var(--text)',
    letterSpacing: -0.2,
  },
  subtitle: {
    margin: '4px 0 0',
    fontSize: 11,
    color: 'var(--text-3)',
    fontFamily: 'var(--mono)',
  },
  card: {
    background: 'var(--panel)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    overflow: 'hidden',
  },
  cardHeader: {
    padding: '12px 16px',
    borderBottom: '1px solid var(--border)',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
  },
  cardTitle: { fontSize: 13, fontWeight: 700, color: 'var(--text)' },
  cardDesc: { fontSize: 11.5, color: 'var(--text-3)', marginTop: 3, lineHeight: 1.5 },
  btnPrimaryDisabled: {
    padding: '6px 14px',
    background: 'var(--border-strong)',
    color: 'var(--text-3)',
    border: '1px solid var(--border-strong)',
    borderRadius: 4,
    fontSize: 12,
    fontWeight: 600,
    cursor: 'not-allowed',
    whiteSpace: 'nowrap',
  },
  notImpl: {
    padding: '16px',
    fontSize: 11.5,
    color: 'var(--amber)',
    fontFamily: 'var(--mono)',
    background: 'var(--amber-50)',
  },
};
