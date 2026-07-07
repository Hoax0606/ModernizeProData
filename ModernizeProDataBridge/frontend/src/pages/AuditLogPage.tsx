import { useMemo, useState } from 'react';
import { useWorkspaceStore } from '../store/workspace';
import { useAuditLogStore } from '../store/auditLog';
import { useT } from '../i18n';

export function AuditLogPage() {
  const t = useT();
  const sites = useWorkspaceStore((s) => s.sites);
  const allProjects = useWorkspaceStore((s) => s.projects);
  const activeSiteId = useWorkspaceStore((s) => s.activeSiteId);
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const site = useMemo(() => sites.find((s) => s.id === activeSiteId) ?? null, [sites, activeSiteId]);

  // redirect 는 sidebar 프로젝트 클릭 핸들러가 직접 처리 (race 회피).

  const allLogs = useAuditLogStore((s) => s.logs);

  const siteProjectIds = useMemo(
    () => new Set(allProjects.filter((p) => p.siteId === activeSiteId).map((p) => p.id)),
    [allProjects, activeSiteId],
  );

  const siteProjects = useMemo(
    () => allProjects.filter((p) => p.siteId === activeSiteId),
    [allProjects, activeSiteId],
  );

  const siteLogs = useMemo(
    () => allLogs.filter((l) => siteProjectIds.has(l.projectId)),
    [allLogs, siteProjectIds],
  );

  const uniqueUsers = useMemo(
    () => Array.from(new Set(siteLogs.map((l) => l.user))).sort(),
    [siteLogs],
  );

  const uniqueActions = useMemo(
    () => Array.from(new Set(siteLogs.map((l) => l.action))).sort(),
    [siteLogs],
  );

  const [timeRange, setTimeRange] = useState<'24h' | '7d' | '30d' | 'all'>('7d');
  const [userFilter, setUserFilter] = useState<string>('all');
  const [actionFilter, setActionFilter] = useState<string>('all');
  const [projectFilter, setProjectFilter] = useState<string>('all');
  const [search, setSearch] = useState('');

  // redirect 중에는 데이터 작업을 건너뜀 (effect 가 다음 tick 에 navigate 수행)
  if (activeProjectId || !site) return null;

  const now = Date.now();
  const timeRangeMs: Record<string, number> = {
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
  };

  const filtered = siteLogs.filter((log) => {
    if (timeRange !== 'all') {
      const age = now - new Date(log.timestamp).getTime();
      if (age > timeRangeMs[timeRange]) return false;
    }
    if (userFilter !== 'all' && log.user !== userFilter) return false;
    if (actionFilter !== 'all' && log.action !== actionFilter) return false;
    if (projectFilter !== 'all' && log.projectId !== projectFilter) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      if (
        !log.user.toLowerCase().includes(q) &&
        !log.action.toLowerCase().includes(q) &&
        !log.description.toLowerCase().includes(q) &&
        !(log.snapshotName ?? '').toLowerCase().includes(q)
      ) return false;
    }
    return true;
  });

  return (
    <div>
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
        <Filter label="Project">
          <select value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)} style={styles.select}>
            <option value="all">All Projects</option>
            {siteProjects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </Filter>
        <Filter label={t('auditLog.filter.user')}>
          <select value={userFilter} onChange={(e) => setUserFilter(e.target.value)} style={styles.select}>
            <option value="all">{t('auditLog.filter.allUsers')}</option>
            {uniqueUsers.map((u) => (
              <option key={u} value={u}>{u}</option>
            ))}
          </select>
        </Filter>
        <Filter label={t('auditLog.filter.action')}>
          <select value={actionFilter} onChange={(e) => setActionFilter(e.target.value)} style={styles.select}>
            <option value="all">{t('auditLog.filter.allActions')}</option>
            {uniqueActions.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
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
              <Th>Project</Th>
              <Th>{t('auditLog.col.user')}</Th>
              <Th>{t('auditLog.col.action')}</Th>
              <Th>Snapshot</Th>
              <Th>{t('auditLog.col.details')}</Th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={6} style={styles.emptyRow}>
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
            ) : (
              filtered.map((log) => {
                const proj = siteProjects.find((p) => p.id === log.projectId);
                return (
                  <tr key={log.id} style={styles.tr}>
                    <td style={styles.td}>
                      <div style={styles.mono}>{new Date(log.timestamp).toLocaleDateString()}</div>
                      <div style={{ ...styles.mono, color: 'var(--text-4)', fontSize: 10 }}>
                        {new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </div>
                    </td>
                    <td style={styles.td}>
                      <span style={styles.projName}>{proj?.name ?? '—'}</span>
                    </td>
                    <td style={{ ...styles.td, ...styles.mono }}>{log.user}</td>
                    <td style={styles.td}>
                      {renderActionCell(log.action)}
                    </td>
                    <td style={{ ...styles.td, ...styles.mono }}>{log.snapshotName ?? '—'}</td>
                    <td style={{ ...styles.td, whiteSpace: 'pre-wrap', ...styles.mono }}>{log.description}</td>
                  </tr>
                );
              })
            )}
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
  return <th style={styles.th}>{children}</th>;
}

// action 별 색상 — VersionsPage / Approvals / Notification 의 snapshot 상태 색과 통일.
function actionTagColor(action: string): React.CSSProperties {
  const a = action.toLowerCase();
  if (a.includes('cutover')) {
    return { background: 'var(--red-50)', color: 'var(--red)', borderColor: 'var(--red)' };
  }
  if (a.includes('approve')) {
    return { background: 'var(--green-50)', color: 'var(--green)', borderColor: 'var(--green)' };
  }
  if (a.includes('reject')) {
    return { background: 'var(--red-50)', color: 'var(--red)', borderColor: 'var(--red)' };
  }
  if (a.includes('request') || a.includes('pending')) {
    return { background: 'var(--amber-50)', color: 'var(--amber)', borderColor: 'var(--amber)' };
  }
  if (a.includes('snapshot') || a.includes('created') || a.includes('create')) {
    // snapshot 전용 파랑 (--snapshot) — phase-analysis 의 하늘색과 구분
    return { background: 'var(--snapshot-50)', color: 'var(--snapshot)', borderColor: 'var(--snapshot)' };
  }
  return {};
}

// action 별 chip 표시 — notification panel 의 type chip 톤과 일치.
// snapshot deleted = chip 없이 빨간 'DELETED' plain text. 그 외는 짧은 키워드 chip.
function renderActionCell(action: string): React.ReactNode {
  const a = action.toLowerCase();
  if (a.includes('delete')) {
    return <span style={styles.actionDeleted}>DELETED</span>;
  }
  return (
    <span style={{ ...styles.actionTag, ...actionTagColor(action) }}>
      {actionChipLabel(a)}
    </span>
  );
}

function actionChipLabel(a: string): string {
  if (a.includes('cutover')) return 'CUTOVER';
  if (a.includes('approve')) return 'APPROVED';
  if (a.includes('reject'))  return 'REJECTED';
  if (a.includes('request') || a.includes('pending')) return 'PENDING';
  if (a.includes('snapshot') || a.includes('created') || a.includes('create')) return 'SNAPSHOT';
  if (a.includes('phase'))    return 'PHASE';
  if (a.includes('assignee')) return 'ASSIGN';
  return a.toUpperCase();
}

const styles: Record<string, React.CSSProperties> = {
  header: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 12,
    marginBottom: 14,
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
    flexWrap: 'wrap',
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
  tr: {
    borderBottom: '1px solid var(--border-light)',
  },
  td: {
    padding: '7px 12px',
    fontSize: 11,
    color: 'var(--text-2)',
    verticalAlign: 'top',
  },
  mono: {
    fontFamily: 'var(--mono)',
    fontSize: 11,
    color: 'var(--text-3)',
  },
  projName: {
    fontSize: 11.5,
    fontWeight: 700,
    color: 'var(--text)',
    whiteSpace: 'nowrap',
  },
  actionDeleted: {
    color: 'var(--red)',
    fontFamily: 'var(--mono)',
    fontWeight: 700,
    fontSize: 11,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  actionTag: {
    display: 'inline-block',
    padding: '1px 7px',
    background: 'var(--panel-2)',
    color: 'var(--text-2)',
    border: '1px solid var(--border-strong)',
    borderRadius: 3,
    fontSize: 10,
    fontWeight: 600,
    fontFamily: 'var(--mono)',
    whiteSpace: 'nowrap',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
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
