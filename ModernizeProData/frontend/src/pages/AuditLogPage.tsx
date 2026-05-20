import { useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useWorkspaceStore } from '../store/workspace';
import { useT } from '../i18n';

/**
 * Site 단위 audit log 화면.
 * 백엔드 audit 테이블이 아직 없어 placeholder — 필터 UI 만 구현, 결과는 empty state.
 */
export function AuditLogPage() {
  const t = useT();
  const sites = useWorkspaceStore((s) => s.sites);
  const activeSiteId = useWorkspaceStore((s) => s.activeSiteId);
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const site = useMemo(() => sites.find((s) => s.id === activeSiteId) ?? null, [sites, activeSiteId]);

  const [timeRange, setTimeRange] = useState<'24h' | '7d' | '30d' | 'all'>('7d');
  const [user, setUser] = useState<'all'>('all');
  const [action, setAction] = useState<'all'>('all');
  const [search, setSearch] = useState('');

  if (activeProjectId) return <Navigate to="/" replace />;
  if (!site) return <Navigate to="/" replace />;

  return (
    <div>
      <div style={styles.header}>
        <div style={{ flex: 1 }} />
        <button disabled title={t('auditLog.empty.title')} style={styles.btnGhostDisabled}>
          {t('auditLog.export')}
        </button>
      </div>

      {/* Filter bar */}
      <div style={styles.filterBar}>
        <Filter label={t('auditLog.filter.timeRange')}>
          <select value={timeRange} onChange={(e) => setTimeRange(e.target.value as never)} style={styles.select}>
            <option value="24h">{t('auditLog.filter.last24h')}</option>
            <option value="7d">{t('auditLog.filter.last7d')}</option>
            <option value="30d">{t('auditLog.filter.last30d')}</option>
            <option value="all">{t('auditLog.filter.allTime')}</option>
          </select>
        </Filter>
        <Filter label={t('auditLog.filter.user')}>
          <select value={user} onChange={(e) => setUser(e.target.value as never)} style={styles.select}>
            <option value="all">{t('auditLog.filter.allUsers')}</option>
          </select>
        </Filter>
        <Filter label={t('auditLog.filter.action')}>
          <select value={action} onChange={(e) => setAction(e.target.value as never)} style={styles.select}>
            <option value="all">{t('auditLog.filter.allActions')}</option>
          </select>
        </Filter>
        <div style={{ flex: 1, minWidth: 200 }}>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('auditLog.filter.search')}
            style={styles.search}
          />
        </div>
      </div>

      {/* Table */}
      <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr style={styles.theadRow}>
              <Th>{t('auditLog.col.time')}</Th>
              <Th>{t('auditLog.col.user')}</Th>
              <Th>{t('auditLog.col.role')}</Th>
              <Th>{t('auditLog.col.action')}</Th>
              <Th>{t('auditLog.col.target')}</Th>
              <Th>{t('auditLog.col.status')}</Th>
              <Th>{t('auditLog.col.details')}</Th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colSpan={7} style={styles.emptyRow}>
                <div style={styles.emptyIcon}>
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="4" y="4" width="16" height="16" rx="2" />
                    <line x1="8" y1="9" x2="16" y2="9" />
                    <line x1="8" y1="13" x2="16" y2="13" />
                    <line x1="8" y1="17" x2="12" y2="17" />
                  </svg>
                </div>
                <div style={styles.emptyTitle}>{t('auditLog.empty.title')}</div>
                <div style={styles.emptyHint}>{t('auditLog.empty.hint')}</div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Filter({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={styles.filter}>
      <div style={styles.filterLabel}>{label}</div>
      {children}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th style={styles.th}>{children}</th>
  );
}

const styles: Record<string, React.CSSProperties> = {
  header: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 12,
    marginBottom: 14,
  },
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
  btnGhostDisabled: {
    padding: '6px 12px',
    background: 'var(--panel)',
    border: '1px solid var(--border-strong)',
    color: 'var(--text-3)',
    borderRadius: 4,
    fontSize: 12,
    cursor: 'not-allowed',
    opacity: 0.6,
    whiteSpace: 'nowrap',
  },

  filterBar: {
    display: 'flex',
    gap: 10,
    alignItems: 'flex-end',
    padding: 12,
    background: 'var(--panel)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    marginBottom: 10,
  },
  filter: { display: 'flex', flexDirection: 'column', gap: 4 },
  filterLabel: {
    fontSize: 10,
    color: 'var(--text-3)',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    fontFamily: 'var(--mono)',
    fontWeight: 600,
  },
  select: {
    padding: '6px 10px',
    border: '1px solid var(--border-strong)',
    borderRadius: 4,
    background: 'var(--panel)',
    color: 'var(--text)',
    fontSize: 12,
    outline: 'none',
    minWidth: 140,
  },
  search: {
    width: '100%',
    padding: '6px 10px',
    border: '1px solid var(--border-strong)',
    borderRadius: 4,
    background: 'var(--panel)',
    color: 'var(--text)',
    fontSize: 12,
    fontFamily: 'var(--mono)',
    outline: 'none',
  },

  tableWrap: {
    background: 'var(--panel)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    overflow: 'hidden',
  },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
  theadRow: { background: 'var(--panel-2)', borderBottom: '1px solid var(--border)' },
  th: {
    padding: '7px 12px',
    textAlign: 'left',
    fontSize: 10,
    fontWeight: 600,
    color: 'var(--text-3)',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    fontFamily: 'var(--mono)',
    whiteSpace: 'nowrap',
  },
  emptyRow: {
    padding: '60px 20px',
    textAlign: 'center',
    background: 'var(--zebra)',
  },
  emptyIcon: {
    color: 'var(--text-4)',
    marginBottom: 10,
    display: 'inline-flex',
  },
  emptyTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--text-3)',
    marginBottom: 4,
  },
  emptyHint: {
    fontSize: 11,
    color: 'var(--text-4)',
    fontFamily: 'var(--mono)',
  },
};
