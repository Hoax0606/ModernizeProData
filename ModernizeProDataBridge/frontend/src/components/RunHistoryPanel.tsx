/**
 * Run History 패널 — 全 project 횡단 run 이력 (active site 로 필터), drill-down + abort.
 *
 * 원래 SchedulerPage 안에 inline 으로 있던 블록을 추출 (#5, 2026-06-05). 이제
 *  - "Run Results" 페이지(구 Site Quarantine)의 Run History 탭에서 사용,
 *  - Scheduler 에서는 제거 (스케줄 설정 기능만 남김).
 *
 * 자체적으로 workspace store(active site / projects) + runsApi 를 읽는 self-contained 컴포넌트.
 */
import { Fragment, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useWorkspaceStore } from '../store/workspace';
import { ApiError } from '../api/client';
import { runsApi, type RunHistoryDto, type RunTableResult } from '../api/runs';
import { useT } from '../i18n';
import { formatTimestamp, formatTimeMs, formatDuration } from '../lib/formatters';

export function RunHistoryPanel() {
  const t = useT();
  const allProjects = useWorkspaceStore((s) => s.projects);
  const activeSiteId = useWorkspaceStore((s) => s.activeSiteId);

  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<RunHistoryDto[]>([]);
  const [historyStatusFilter, setHistoryStatusFilter] = useState<string>('');
  const [historyTypeFilter, setHistoryTypeFilter] = useState<string>('');
  const [historyTriggerFilter, setHistoryTriggerFilter] = useState<string>('');
  const [expandedRunIds, setExpandedRunIds] = useState<Set<string>>(new Set());
  const toggleExpandedRun = (runId: string) => setExpandedRunIds((cur) => {
    const next = new Set(cur);
    if (next.has(runId)) next.delete(runId); else next.add(runId);
    return next;
  });

  const refreshHistory = async () => {
    setError(null);
    try {
      const h = await runsApi.listAll();
      setHistory(h);
    } catch (e) {
      setError(formatError(e));
    }
  };

  useEffect(() => {
    void refreshHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleAbort = async (runId: string) => {
    try { await runsApi.devAbort(runId, 'aborted from Run Results (manual reset)'); await refreshHistory(); }
    catch (e) { setError(formatError(e)); }
  };

  /* Page scope = active site. runsApi.listAll() 은 전 site 횡단이라 FE 에서 project.siteId 照合. */
  const activeSiteProjectIds = useMemo(
    () => new Set(allProjects.filter((p) => p.siteId === activeSiteId).map((p) => p.id)),
    [allProjects, activeSiteId],
  );
  const historyForSite = useMemo(
    () => history.filter((r) => activeSiteProjectIds.has(r.projectId)),
    [history, activeSiteProjectIds],
  );

  const historyStatusOptions = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of historyForSite) m.set(r.status, (m.get(r.status) ?? 0) + 1);
    return [...m.entries()];
  }, [historyForSite]);
  const historyTypeOptions = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of historyForSite) m.set(r.runType, (m.get(r.runType) ?? 0) + 1);
    return [...m.entries()];
  }, [historyForSite]);
  const historyTriggerOptions = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of historyForSite) m.set(r.triggerSource, (m.get(r.triggerSource) ?? 0) + 1);
    return [...m.entries()];
  }, [historyForSite]);
  const filteredHistory = useMemo(() => historyForSite.filter((r) => {
    if (historyStatusFilter && r.status !== historyStatusFilter) return false;
    if (historyTypeFilter && r.runType !== historyTypeFilter) return false;
    if (historyTriggerFilter && r.triggerSource !== historyTriggerFilter) return false;
    return true;
  }), [historyForSite, historyStatusFilter, historyTypeFilter, historyTriggerFilter]);

  useEffect(() => {
    if (historyStatusFilter && !historyStatusOptions.some(([v]) => v === historyStatusFilter)) setHistoryStatusFilter('');
  }, [historyStatusOptions, historyStatusFilter]);
  useEffect(() => {
    if (historyTypeFilter && !historyTypeOptions.some(([v]) => v === historyTypeFilter)) setHistoryTypeFilter('');
  }, [historyTypeOptions, historyTypeFilter]);
  useEffect(() => {
    if (historyTriggerFilter && !historyTriggerOptions.some(([v]) => v === historyTriggerFilter)) setHistoryTriggerFilter('');
  }, [historyTriggerOptions, historyTriggerFilter]);

  return (
    <div>
      {error && <div style={styles.errorBox}>Error: {error}</div>}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8, flexWrap: 'wrap' }}>
        <h3 style={{ ...styles.h3, margin: 0 }}>
          {t('scheduler.section.history')}
          {(historyStatusFilter || historyTypeFilter || historyTriggerFilter) && (
            <span style={styles.historyFilterCount}>
              {filteredHistory.length} / {historyForSite.length}
            </span>
          )}
        </h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <label style={styles.historyFilterLabel}>
            <span style={styles.historyFilterLabelText}>Status</span>
            <select
              value={historyStatusFilter}
              onChange={(e) => setHistoryStatusFilter(e.target.value)}
              style={styles.historyFilterSelect}
              disabled={historyStatusOptions.length === 0}
            >
              <option value="">All ({historyForSite.length})</option>
              {historyStatusOptions.map(([v, n]) => (
                <option key={v} value={v}>{v} ({n})</option>
              ))}
            </select>
          </label>
          <label style={styles.historyFilterLabel}>
            <span style={styles.historyFilterLabelText}>Type</span>
            <select
              value={historyTypeFilter}
              onChange={(e) => setHistoryTypeFilter(e.target.value)}
              style={styles.historyFilterSelect}
              disabled={historyTypeOptions.length === 0}
            >
              <option value="">All ({historyForSite.length})</option>
              {historyTypeOptions.map(([v, n]) => (
                <option key={v} value={v}>{v} ({n})</option>
              ))}
            </select>
          </label>
          <label style={styles.historyFilterLabel}>
            <span style={styles.historyFilterLabelText}>Trigger</span>
            <select
              value={historyTriggerFilter}
              onChange={(e) => setHistoryTriggerFilter(e.target.value)}
              style={styles.historyFilterSelect}
              disabled={historyTriggerOptions.length === 0}
            >
              <option value="">All ({historyForSite.length})</option>
              {historyTriggerOptions.map(([v, n]) => (
                <option key={v} value={v}>{v} ({n})</option>
              ))}
            </select>
          </label>
          <button
            onClick={refreshHistory}
            style={{
              padding: '4px 10px', fontSize: 11,
              border: '1px solid var(--border)', borderRadius: 3,
              background: 'var(--panel)', color: 'var(--text-2)',
              cursor: 'pointer',
            }}
          >
            {t('scheduler.button.refresh')}
          </button>
        </div>
      </div>
      {filteredHistory.length === 0 ? (
        <div style={{ color: 'var(--text-3)' }}>{t('scheduler.history.empty')}</div>
      ) : (
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={{ ...styles.th, width: 22 }} aria-label="expand"></th>
              <th style={styles.th}>{t('scheduler.history.col.runId')}</th>
              <th style={styles.th}>{t('scheduler.history.col.project')}</th>
              <th style={styles.th}>{t('scheduler.history.col.type')}</th>
              <th style={styles.th}>{t('scheduler.history.col.trigger')}</th>
              <th style={styles.th}>{t('scheduler.history.col.worker')}</th>
              <th style={styles.th}>{t('scheduler.history.col.tables')}</th>
              <th style={styles.th}>{t('scheduler.history.col.status')}</th>
              <th style={styles.th}>{t('scheduler.history.col.started')}</th>
              <th style={styles.th}>{t('scheduler.history.col.finished')}</th>
              <th style={styles.th} title={t('projectSettings.schedule.history.col.duration.tooltip')}>
                {t('scheduler.history.col.duration')}
              </th>
              <th style={styles.th}>{t('scheduler.history.col.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {filteredHistory.map((h) => {
              const expanded = expandedRunIds.has(h.id);
              const canExpand = h.tableSummary.total > 0;
              const s = h.tableSummary;
              return (
                <Fragment key={h.id}>
                  <tr
                    onClick={canExpand ? () => toggleExpandedRun(h.id) : undefined}
                    style={{ cursor: canExpand ? 'pointer' : 'default' }}
                  >
                    <td style={{ ...styles.td, textAlign: 'center', padding: '4px 4px' }}>
                      {canExpand && (
                        <span style={{ color: 'var(--text-3)', fontSize: 11, userSelect: 'none' }}>
                          {expanded ? '▾' : '▸'}
                        </span>
                      )}
                    </td>
                    <td style={styles.td}><code>{h.id}</code></td>
                    <td style={styles.td}>
                      <div>{h.projectName}</div>
                      <div style={{ fontSize: 9, color: 'var(--text-4)' }}><code>{h.projectId}</code></div>
                    </td>
                    <td style={styles.td}>{h.runType}</td>
                    <td style={styles.td}>{h.triggerSource}</td>
                    <td style={styles.td}>{h.workerId ?? '-'}</td>
                    <td style={styles.td}>
                      {s.total === 0 ? (
                        <span
                          title={h.tables == null
                            ? t('scheduler.history.tables.all')
                            : `partial: ${h.tables.length}\n${h.tables.join('\n')}`}
                          style={{ color: 'var(--text-4)', fontFamily: 'var(--mono)', fontSize: 11 }}
                        >
                          —
                        </span>
                      ) : (
                        <span
                          title={h.tables == null
                            ? t('scheduler.history.tables.all')
                            : `partial: ${h.tables.length}\n${h.tables.join('\n')}`}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'var(--mono)', fontSize: 11 }}
                        >
                          <span style={{ color: 'var(--text-3)' }}>{s.total}</span>
                          {s.success > 0 && <span style={summaryBadge('#166534', '#dcfce7', '#86efac')}>{s.success}✓</span>}
                          {s.failed > 0 && <span style={summaryBadge('#991b1b', '#fee2e2', '#fca5a5')}>{s.failed}✗</span>}
                          {s.running > 0 && <span style={summaryBadge('#92400e', '#fef3c7', '#fcd34d')}>{s.running}</span>}
                        </span>
                      )}
                    </td>
                    <td style={styles.td}>
                      <span style={statusStyle(h.status)}>{h.status}</span>
                    </td>
                    <td style={styles.td}>{formatTimestamp(h.startedAt)}</td>
                    <td style={styles.td}>{h.finishedAt ? formatTimestamp(h.finishedAt) : '-'}</td>
                    <td style={styles.td} title={t('projectSettings.schedule.history.col.duration.tooltip')}>
                      {formatDuration(h.durationMs)}
                    </td>
                    <td style={styles.td}>
                      {h.status === 'running' && (
                        <button
                          onClick={(e) => { e.stopPropagation(); handleAbort(h.id); }}
                          style={styles.iconBtn}
                          title={t('scheduler.tooltip.abort')}
                          aria-label={t('scheduler.action.abort')}
                        >
                          ⏹
                        </button>
                      )}
                    </td>
                  </tr>
                  {expanded && (
                    <tr>
                      <td colSpan={12} style={{ padding: 0, background: 'var(--panel-2)' }}>
                        <RunDrilldown runId={h.id} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function formatError(e: unknown): string {
  if (e instanceof ApiError) return `${e.code}: ${e.message}`;
  if (e instanceof Error) return e.message;
  return String(e);
}

const summaryBadge = (color: string, bg: string, border: string): React.CSSProperties => ({
  display: 'inline-block', padding: '0 5px', borderRadius: 3,
  fontSize: 10, fontWeight: 700, border: `1px solid ${border}`,
  color, background: bg, lineHeight: '14px',
});

/** per-table drill-down sub-row. BE /runs/{id}/table-results 를 가져와 표시. */
function RunDrilldown({ runId }: { runId: string }) {
  const t = useT();
  const { data, isLoading, isError } = useQuery<RunTableResult[]>({
    queryKey: ['run-table-results', runId],
    queryFn: () => runsApi.tableResults(runId),
    staleTime: 5_000,
  });
  if (isLoading) return <div style={drillStyles.note}>{t('projectSettings.schedule.history.drilldown.loading')}</div>;
  if (isError) return <div style={{ ...drillStyles.note, color: 'var(--red)' }}>{t('projectSettings.schedule.history.drilldown.error')}</div>;
  if (!data || data.length === 0) return <div style={drillStyles.note}>{t('projectSettings.schedule.history.drilldown.empty')}</div>;
  return (
    <div style={drillStyles.wrap}>
      <table style={drillStyles.table}>
        <thead>
          <tr>
            <th style={drillStyles.th}>{t('projectSettings.schedule.history.drilldown.col.status')}</th>
            <th style={drillStyles.th}>{t('projectSettings.schedule.history.drilldown.col.table')}</th>
            <th style={{ ...drillStyles.th, textAlign: 'right' }}>{t('projectSettings.schedule.history.drilldown.col.rows')}</th>
            <th style={drillStyles.th}>{t('projectSettings.schedule.history.drilldown.col.started')}</th>
            <th style={drillStyles.th}>{t('projectSettings.schedule.history.drilldown.col.finished')}</th>
            <th style={{ ...drillStyles.th, textAlign: 'right' }}>{t('projectSettings.schedule.history.drilldown.col.duration')}</th>
          </tr>
        </thead>
        <tbody>
          {data.map((r) => {
            const fullName = r.tobeSchema ? `${r.tobeSchema}.${r.tobeTable}` : r.tobeTable;
            const color = r.status === 'success' ? '#166534'
              : r.status === 'failed' ? '#991b1b'
              : '#92400e';
            const icon = r.status === 'success' ? '✓' : r.status === 'failed' ? '✗' : '';
            return (
              <tr key={fullName}>
                <td style={{ ...drillStyles.td, color, fontWeight: 700 }}>{icon} {r.status}</td>
                <td style={drillStyles.td}>{fullName}</td>
                <td style={{ ...drillStyles.td, textAlign: 'right' }}>{r.rows.toLocaleString()}</td>
                <td style={drillStyles.td}>{r.startedAt ? formatTimeMs(r.startedAt) : '—'}</td>
                <td style={drillStyles.td}>{r.finishedAt ? formatTimeMs(r.finishedAt) : '—'}</td>
                <td style={{ ...drillStyles.td, textAlign: 'right' }}>{formatDuration(r.durationMs)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function statusStyle(status: string): React.CSSProperties {
  const base: React.CSSProperties = { padding: '2px 6px', borderRadius: 3, fontSize: 11 };
  switch (status) {
    case 'running': return { ...base, background: '#fef3c7', color: '#92400e' };
    case 'success':
    case 'STARTED': return { ...base, background: '#dcfce7', color: '#166534' };
    case 'failed':
    case 'aborted':
    case 'timed_out':
    case 'rejected':
    case 'locked':
    case 'REJECTED':
    case 'LOCKED': return { ...base, background: '#fee2e2', color: '#991b1b' };
    default: return { ...base, background: 'var(--panel-2)', color: 'var(--text-2)' };
  }
}

const drillStyles: Record<string, React.CSSProperties> = {
  wrap: { padding: '8px 12px 12px 36px', background: 'var(--panel-2)' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: 'var(--mono)' },
  th: {
    textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid var(--border)',
    color: 'var(--text-3)', fontWeight: 600, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5,
  },
  td: { padding: '3px 8px', borderBottom: '1px dashed var(--border)', color: 'var(--text-2)' },
  note: { padding: '8px 12px 8px 36px', color: 'var(--text-3)', fontSize: 11, fontStyle: 'italic' },
};

const styles: Record<string, React.CSSProperties> = {
  errorBox: { padding: '8px 12px', background: '#fee2e2', border: '1px solid #dc2626', color: '#991b1b', borderRadius: 3, fontSize: 11, marginBottom: 10 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 11 },
  th: { textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--border)', color: 'var(--text-2)' },
  td: { padding: '6px 8px', borderBottom: '1px solid var(--border)' },
  h3: { fontSize: 14, marginTop: 0, marginBottom: 8 },
  iconBtn: {
    padding: '2px 8px', fontSize: 14, lineHeight: 1,
    border: '1px solid var(--border)', borderRadius: 3,
    background: 'var(--panel-2)', color: 'var(--text-2)',
    cursor: 'pointer',
  },
  historyFilterLabel: { display: 'inline-flex', alignItems: 'center', gap: 5 },
  historyFilterLabelText: {
    fontSize: 10, fontWeight: 700, color: 'var(--text-3)', fontFamily: 'var(--mono)',
    letterSpacing: 0.8, textTransform: 'uppercase',
  },
  historyFilterSelect: {
    padding: '4px 8px', border: '1px solid var(--border-strong)', borderRadius: 3,
    background: 'var(--panel)', color: 'var(--text)',
    fontSize: 11, fontFamily: 'var(--mono)', cursor: 'pointer',
    minWidth: 130,
  },
  historyFilterCount: {
    marginLeft: 8, fontSize: 11, fontWeight: 500,
    color: 'var(--text-3)', fontFamily: 'var(--mono)',
  },
};
