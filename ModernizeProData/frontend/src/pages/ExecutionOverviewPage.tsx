import { useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useWorkspaceStore, type Project } from '../store/workspace';
import { useUsersStore } from '../store/users';
import { useAuthStore } from '../store/auth';
import { useT } from '../i18n';

const PHASES: Project['phase'][] = ['planning', 'analysis', 'test', 'sign-off', 'rehearsal', 'ready', 'cutover', 'hypercare', 'done'];

/**
 * Execution overview — 사이트 전체 프로젝트의 이행 실행 결과 모니터링.
 *
 * - 좌측 체크박스로 선택, Run/Abort 는 선택된 행만 대상.
 * - Per-row Username dropdown 으로 담당자 지정.
 * - Phase mix 패널은 Site overview 로 이동.
 * - Actions 컬럼 제거 (Run/Abort 는 toolbar 단일 버튼 + 선택).
 *
 * 현재는 run engine 미연결 → rows/progress/errors/warnings 는 placeholder (0).
 */
export function ExecutionOverviewPage() {
  const t = useT();
  const user = useAuthStore((s) => s.user);
  const isMaster = user?.role === 'master';

  const sites = useWorkspaceStore((s) => s.sites);
  const projects = useWorkspaceStore((s) => s.projects);
  const activeSiteId = useWorkspaceStore((s) => s.activeSiteId);
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const setProjectAssignee = useWorkspaceStore((s) => s.setProjectAssignee);

  const site = useMemo(() => sites.find((s) => s.id === activeSiteId) ?? null, [sites, activeSiteId]);
  const siteProjects = useMemo(
    () => projects.filter((p) => p.siteId === activeSiteId),
    [projects, activeSiteId],
  );

  const users = useUsersStore((s) => s.users);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // 필터 — phase · username · errors · warnings. 'has' / 'none' / '' (=all)
  const [phaseFilter, setPhaseFilter] = useState<string>('');
  const [userFilter, setUserFilter] = useState<string>('');
  const [errorFilter, setErrorFilter] = useState<'' | 'has' | 'none'>('');
  const [warningFilter, setWarningFilter] = useState<'' | 'has' | 'none'>('');

  // placeholder — run engine 연결 전. 실제 값은 백엔드에서.
  const errorCount = (_p: Project) => 0;
  const warningCount = (_p: Project) => 0;

  if (activeProjectId) return <Navigate to="/" replace />;
  if (!site) return <Navigate to="/" replace />;

  const filteredProjects = siteProjects.filter((p) => {
    if (phaseFilter && p.phase !== phaseFilter) return false;
    if (userFilter === '__unassigned') {
      if (p.assignee) return false;
    } else if (userFilter && p.assignee !== userFilter) return false;
    const ec = errorCount(p);
    if (errorFilter === 'has'  && ec === 0) return false;
    if (errorFilter === 'none' && ec >  0) return false;
    const wc = warningCount(p);
    if (warningFilter === 'has'  && wc === 0) return false;
    if (warningFilter === 'none' && wc >  0) return false;
    return true;
  });

  // 체크박스 활성 기준: prod stage → ready 만, non-prod → rehearsal / test.
  const isProd = site?.environment === 'production';
  const isSelectable = (p: Project) => {
    if (isProd) return p.phase === 'ready';
    return p.phase === 'rehearsal' || p.phase === 'test';
  };

  const toggleOne = (id: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  // toggleAll 은 현재 필터에 걸린 selectable 프로젝트만 대상.
  const visibleSelectable = filteredProjects.filter(isSelectable);
  const allSelected = visibleSelectable.length > 0 && visibleSelectable.every((p) => selected.has(p.id));
  const toggleAll = () => {
    if (allSelected) {
      setSelected((cur) => {
        const next = new Set(cur);
        for (const p of visibleSelectable) next.delete(p.id);
        return next;
      });
    } else {
      setSelected((cur) => {
        const next = new Set(cur);
        for (const p of visibleSelectable) next.add(p.id);
        return next;
      });
    }
  };

  const runningPhases: Project['phase'][] = ['cutover', 'rehearsal', 'hypercare', 'test'];
  const selectedRunningCount = siteProjects.filter(
    (p) => selected.has(p.id) && runningPhases.includes(p.phase),
  ).length;

  const runCount = selected.size;
  const canRun = runCount > 0;
  const canAbort = selectedRunningCount > 0;

  const handleRefresh = () => {
    // placeholder — run engine 연결 후 실제 fetch.
  };
  const handleRun = () => {
    // placeholder — run engine 연결 후 백엔드 호출.
  };
  const handleAbort = () => {
    // placeholder — run engine 연결 후 abort 호출.
  };

  // KPI 집계 — 현재는 placeholder.
  const status = siteProjects.reduce(
    (a, p) => {
      if (p.phase === 'done') return { ...a, done: a.done + 1 };
      if (runningPhases.includes(p.phase)) return { ...a, running: a.running + 1 };
      return a;
    },
    { running: 0, done: 0 },
  );
  const totalTables = siteProjects.reduce((a, p) => a + p.tableCount, 0);
  // 전체 실행 progress — placeholder (run engine 연결 전).
  const overallProgressPct = 0;

  return (
    <div>
      {/* KPI row — Phase Mix 없음 */}
      <div style={styles.kpiRow}>
        <Kpi label={t('executionOverview.kpi.projects')} value={`${status.done} / ${siteProjects.length}`} tone="info" />
        <Kpi label={t('executionOverview.kpi.running')}  value={status.running} tone={status.running > 0 ? 'warn' : undefined} />
        <Kpi label={t('executionOverview.kpi.tables')}   value={`0 / ${totalTables}`} />
        <Kpi label={t('executionOverview.kpi.rows')}     value="0 / 0" />
        <Kpi label={t('executionOverview.kpi.errors')}   value={0} tone="err" />
        <Kpi label={t('executionOverview.kpi.warnings')} value={0} tone="warn" />
      </div>

      {/* Overall progress bar */}
      <div style={styles.overallProgressBox}>
        <div style={styles.overallProgressHeader}>
          <span style={styles.overallProgressLabel}>{t('executionOverview.overall')}</span>
          <span style={styles.overallProgressPct}>{overallProgressPct.toFixed(1)}%</span>
          <div style={{ flex: 1 }} />
          <span style={styles.overallProgressDim}>{t('executionOverview.noRunYet')}</span>
        </div>
        <div style={styles.overallProgressOuter}>
          <div style={{ ...styles.overallProgressInner, width: `${overallProgressPct}%` }} />
        </div>
      </div>

      {/* Filter bar */}
      <div style={styles.filterBar}>
        <label style={styles.filterLabel}>
          <span style={styles.filterLabelText}>{t('filter.phase')}</span>
          <select value={phaseFilter} onChange={(e) => setPhaseFilter(e.target.value)} style={styles.filterSelect}>
            <option value="">{t('filter.all')}</option>
            {PHASES.map((ph) => <option key={ph} value={ph}>{ph}</option>)}
          </select>
        </label>
        <label style={styles.filterLabel}>
          <span style={styles.filterLabelText}>{t('filter.username')}</span>
          <select value={userFilter} onChange={(e) => setUserFilter(e.target.value)} style={styles.filterSelect}>
            <option value="">{t('filter.all')}</option>
            <option value="__unassigned">— {t('executionOverview.unassigned')} —</option>
            {users.map((u) => <option key={u.id} value={u.username}>{u.username}</option>)}
          </select>
        </label>
        <label style={styles.filterLabel}>
          <span style={styles.filterLabelText}>{t('filter.errors')}</span>
          <select value={errorFilter} onChange={(e) => setErrorFilter(e.target.value as '' | 'has' | 'none')} style={styles.filterSelect}>
            <option value="">{t('filter.all')}</option>
            <option value="has">{t('filter.has')}</option>
            <option value="none">{t('filter.none')}</option>
          </select>
        </label>
        <label style={styles.filterLabel}>
          <span style={styles.filterLabelText}>{t('filter.warnings')}</span>
          <select value={warningFilter} onChange={(e) => setWarningFilter(e.target.value as '' | 'has' | 'none')} style={styles.filterSelect}>
            <option value="">{t('filter.all')}</option>
            <option value="has">{t('filter.has')}</option>
            <option value="none">{t('filter.none')}</option>
          </select>
        </label>
        <div style={{ flex: 1 }} />
        <span style={styles.filterCount}>
          {t('filter.count', { shown: filteredProjects.length, total: siteProjects.length })}
        </span>
      </div>

      {/* Toolbar — Refresh / Run / Abort */}
      <div style={styles.toolbar}>
        <span style={styles.toolbarHint}>{t('executionOverview.noRunYet')}</span>
        <div style={{ flex: 1 }} />
        <button onClick={handleRefresh} style={styles.btnGhost}>
          {t('executionOverview.btn.refresh')}
        </button>
        <button
          onClick={handleRun}
          disabled={!canRun || !isMaster}
          title={canRun ? '' : t('executionOverview.runDisabled')}
          style={{ ...styles.btnPrimary, ...((canRun && isMaster) ? {} : styles.btnDisabled) }}
        >
          {canRun ? t('executionOverview.btn.runN', { n: runCount }) : t('executionOverview.btn.run')}
        </button>
        <button
          onClick={handleAbort}
          disabled={!canAbort || !isMaster}
          title={canAbort ? '' : t('executionOverview.abortDisabled')}
          style={{ ...styles.btnDanger, ...((canAbort && isMaster) ? {} : styles.btnDisabled) }}
        >
          {canAbort ? t('executionOverview.btn.abortN', { n: selectedRunningCount }) : t('executionOverview.btn.abort')}
        </button>
      </div>

      {/* Table */}
      <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={{ ...styles.th, width: 28, paddingLeft: 12 }}>
                <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all" />
              </th>
              <Th>{t('executionOverview.col.project')}</Th>
              <Th>{t('executionOverview.col.phase')}</Th>
              <Th>{t('executionOverview.col.username')}</Th>
              <Th align="right">{t('executionOverview.col.tables')}</Th>
              <Th align="right">{t('executionOverview.col.rows')}</Th>
              <Th>{t('executionOverview.col.progress')}</Th>
              <Th align="right">{t('executionOverview.col.errors')}</Th>
              <Th align="right">{t('executionOverview.col.warnings')}</Th>
            </tr>
          </thead>
          <tbody>
            {filteredProjects.length === 0 ? (
              <tr><td colSpan={9} style={styles.emptyRow}>{t('executionOverview.empty')}</td></tr>
            ) : (
              filteredProjects.map((p, i) => {
                const checked = selected.has(p.id);
                const selectable = isSelectable(p);
                const dimmed = !selectable;
                const rowBg = checked ? 'var(--navy-50)' : i % 2 ? 'var(--zebra)' : 'transparent';
                const dimColor = dimmed ? 'var(--text-4)' : undefined;
                const progress = 0; // placeholder
                return (
                  <tr key={p.id} style={{ background: rowBg, borderBottom: '1px solid var(--border)' }}>
                    <td style={{ ...styles.td, paddingLeft: 12 }}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!selectable}
                        onChange={() => toggleOne(p.id)}
                        title={selectable ? '' : t('executionOverview.notSelectable', { phase: p.phase })}
                        aria-label={p.name}
                      />
                    </td>
                    <td style={styles.td}>
                      <span style={{ ...styles.projName, ...(dimColor ? { color: dimColor } : {}) }}>{p.name}</span>
                    </td>
                    <td style={styles.td}>
                      <span style={{ ...styles.phaseChip, ...phaseChipColor(p.phase, p.runStatus) }}>{p.phase}</span>
                    </td>
                    <td style={styles.td}>
                      {isMaster ? (
                        <select
                          value={p.assignee ?? ''}
                          onChange={(e) => setProjectAssignee(p.id, e.target.value || undefined)}
                          style={styles.assigneeSelect}
                        >
                          <option value="">— {t('executionOverview.unassigned')} —</option>
                          {users.map((u) => (
                            <option key={u.id} value={u.username}>{u.username}</option>
                          ))}
                        </select>
                      ) : (
                        <span style={{ ...styles.assigneeText, color: p.assignee ? 'var(--text)' : 'var(--text-4)' }}>
                          {p.assignee ?? t('executionOverview.unassigned')}
                        </span>
                      )}
                    </td>
                    <td style={{ ...styles.td, textAlign: 'right', fontFamily: 'var(--mono)' }}>{p.tableCount}</td>
                    <td style={{ ...styles.td, textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--text-4)' }}>0 / 0</td>
                    <td style={styles.td}>
                      <div style={styles.progressOuter}>
                        <div style={{ ...styles.progressInner, width: `${progress}%` }} />
                      </div>
                      <span style={styles.progressLabel}>{progress.toFixed(0)}%</span>
                    </td>
                    <td style={{ ...styles.td, textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--text-4)' }}>0</td>
                    <td style={{ ...styles.td, textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--text-4)' }}>0</td>
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

/* ─── Sub-components ─────────────────────────────────── */

function Kpi({ label, value, sub, tone }: { label: string; value: string | number; sub?: string; tone?: 'info' | 'ok' | 'err' | 'warn' }) {
  const color = tone === 'ok'   ? 'var(--green)'
              : tone === 'err'  ? 'var(--red)'
              : tone === 'warn' ? 'var(--amber)'
              : tone === 'info' ? 'var(--navy)'
              : 'var(--text)';
  return (
    <div style={styles.kpiTile}>
      <div style={styles.kpiLabel}>{label}</div>
      <div style={{ ...styles.kpiValue, color }}>{value}</div>
      {sub && <div style={styles.kpiSub}>{sub}</div>}
    </div>
  );
}

function Th({ children, align, width }: { children?: React.ReactNode; align?: 'left' | 'right'; width?: number }) {
  return (
    <th style={{ ...styles.th, textAlign: align ?? 'left', width }}>{children}</th>
  );
}

function phaseChipColor(phase: string, runStatus?: string): React.CSSProperties {
  if (runStatus === 'completed' && (phase === 'test' || phase === 'rehearsal')) {
    return {
      background: 'var(--panel)',
      color:      'var(--text)',
      borderColor:'var(--border-strong)',
    };
  }
  const slugMap: Record<string, string> = {
    planning: 'planning', analysis: 'analysis', test: 'test', rehearsal: 'rehearsal',
    'sign-off': 'signoff', ready: 'ready', cutover: 'cutover', hypercare: 'hypercare', done: 'done',
  };
  const slug = slugMap[phase] ?? 'done';
  return {
    background: `var(--phase-${slug}-50)`,
    color:      `var(--phase-${slug})`,
    borderColor:`var(--phase-${slug})`,
  };
}

const styles: Record<string, React.CSSProperties> = {
  header: { marginBottom: 14 },
  h1: { margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--text)', letterSpacing: -0.2 },
  subtitle: { margin: '4px 0 0', fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--mono)' },

  kpiRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(6, 1fr)',
    gap: 1,
    background: 'var(--border)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    overflow: 'hidden',
    marginBottom: 10,
  },
  kpiTile: { background: 'var(--panel)', padding: '10px 14px 12px' },
  kpiLabel: {
    fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.7,
    fontFamily: 'var(--mono)', marginBottom: 4, fontWeight: 600,
  },
  kpiValue: { fontSize: 22, fontWeight: 600, letterSpacing: -0.4 },
  kpiSub: { fontSize: 10.5, color: 'var(--text-3)', marginTop: 2, fontFamily: 'var(--mono)' },

  /* Filter bar */
  filterBar: {
    display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
    padding: '8px 12px', background: 'var(--panel)',
    border: '1px solid var(--border)', borderRadius: 6, marginBottom: 8,
  },
  filterLabel: { display: 'inline-flex', alignItems: 'center', gap: 6 },
  filterLabelText: {
    fontSize: 10.5, fontWeight: 600, color: 'var(--text-3)',
    textTransform: 'uppercase', letterSpacing: 0.5, fontFamily: 'var(--mono)',
  },
  filterSelect: {
    padding: '4px 8px', border: '1px solid var(--border-strong)', borderRadius: 3,
    background: 'var(--panel)', color: 'var(--text)', fontSize: 12,
    outline: 'none', fontFamily: 'var(--mono)', minWidth: 100,
  },
  filterCount: { fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--mono)' },

  /* Overall progress bar — KPI 스트립과 toolbar 사이 */
  overallProgressBox: {
    padding: '10px 14px', background: 'var(--panel)',
    border: '1px solid var(--border)', borderRadius: 6, marginBottom: 8,
  },
  overallProgressHeader: { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 },
  overallProgressLabel: {
    fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.6, color: 'var(--text-2)',
  },
  overallProgressPct: { fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-3)' },
  overallProgressDim: { fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-4)' },
  overallProgressOuter: {
    height: 8, borderRadius: 4, background: 'var(--panel-2)',
    border: '1px solid var(--border)', overflow: 'hidden',
  },
  overallProgressInner: { height: '100%', background: 'var(--navy)' },

  toolbar: {
    display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8,
    padding: '8px 12px', background: 'var(--panel)',
    border: '1px solid var(--border)', borderRadius: 6,
  },
  toolbarHint: { fontSize: 11, color: 'var(--text-4)', fontFamily: 'var(--mono)' },

  btnGhost: {
    padding: '6px 14px', background: 'var(--panel)', border: '1px solid var(--border-strong)',
    color: 'var(--text-2)', borderRadius: 4, fontSize: 12, fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap',
  },
  btnPrimary: {
    padding: '6px 14px', background: 'var(--navy)', color: '#fff',
    border: '1px solid var(--navy)', borderRadius: 4, fontSize: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
  },
  btnDanger: {
    padding: '6px 14px', background: 'var(--panel)', color: 'var(--red)',
    border: '1px solid var(--red)', borderRadius: 4, fontSize: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
  },
  btnDisabled: { opacity: 0.45, cursor: 'not-allowed' },

  tableWrap: { background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
  th: {
    padding: '7px 12px', fontWeight: 600, color: 'var(--text-3)',
    fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.6,
    background: 'var(--panel-2)', borderBottom: '1px solid var(--border)', fontFamily: 'var(--mono)',
    whiteSpace: 'nowrap',
  },
  td: { padding: '8px 12px', verticalAlign: 'middle' },
  emptyRow: { padding: '40px 12px', textAlign: 'center', color: 'var(--text-3)', fontFamily: 'var(--mono)', fontSize: 12 },

  projName: { fontWeight: 600, color: 'var(--text)', fontSize: 12.5 },

  phaseChip: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 72, padding: '2px 0', fontSize: 10, fontWeight: 700,
    fontFamily: 'var(--mono)', border: '1px solid', borderRadius: 3,
    textTransform: 'uppercase', letterSpacing: 0.3, textAlign: 'center', flexShrink: 0,
  },

  assigneeSelect: {
    padding: '4px 8px', border: '1px solid var(--border-strong)', borderRadius: 3,
    background: 'var(--panel)', color: 'var(--text)', fontSize: 12,
    outline: 'none', fontFamily: 'var(--mono)', minWidth: 110,
  },
  assigneeText: { fontFamily: 'var(--mono)', fontSize: 11.5 },

  progressOuter: {
    width: 140, height: 6, background: 'var(--panel-2)',
    border: '1px solid var(--border)', borderRadius: 3, overflow: 'hidden', display: 'inline-block', verticalAlign: 'middle',
  },
  progressInner: { height: '100%', background: 'var(--navy)' },
  progressLabel: { fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--mono)', marginLeft: 8 },
};
