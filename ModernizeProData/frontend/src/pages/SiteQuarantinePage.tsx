import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWorkspaceStore } from '../store/workspace';
import { useT } from '../i18n';
import {
  humanizeQuarantineDetail,
  quarantineRowAsIs,
  quarantineRowToBe,
  quarantineRowPk,
  quarantinePkColumnName,
  quarantineViolatedColumnName,
  buildSiteQuarantineGroups,
  type SiteQuarantineGroup,
  type QuarantineSeverity,
} from './quarantineMock';
import { quarantineApi } from '../api/quarantine';
import { RunHistoryPanel } from '../components/RunHistoryPanel';

/**
 * Site Quarantine — site 전체의 모든 프로젝트에서 모인 quarantine group 을 한 화면에 표시.
 *
 *  - 카드 한 장 = (project × validation rule group). project 컬럼 추가가 LogViewer 의 카드와의 유일한 차이.
 *  - severity 탭 (All / Errors / Warnings) + project 필터 + group dropdown 으로 검색 좁히기.
 *  - 카드 클릭하면 sample 표 + 액션바 펼침. 액션은 LogViewer 와 동일 동작 (Open mapping 만 navigate).
 *  - BE 가 들어오면 buildSiteQuarantineGroups 자리에 `/api/v1/sites/{siteId}/quarantine` fetch 로 swap.
 */
export function SiteQuarantinePage() {
  const t = useT();
  const navigate = useNavigate();
  const activeSiteId = useWorkspaceStore((s) => s.activeSiteId);
  const allProjects = useWorkspaceStore((s) => s.projects);
  const setActiveProject = useWorkspaceStore((s) => s.setActiveProject);
  // Go to Execution — group 의 projectId 로 activeProject 세팅 후 그 프로젝트의 Execution 으로 이동.
  // (All 뷰는 Skip 을 직접 안 하고 해당 프로젝트로 이동만. 2026-06-09 Open Mapping → Execution.)
  const goToExecution = (projectId: string) => {
    setActiveProject(projectId);
    navigate('/execution', { state: { activateProjectId: projectId } });
  };

  const siteProjects = useMemo(
    () => allProjects.filter((p) => p.siteId === activeSiteId),
    [allProjects, activeSiteId],
  );
  /** activeSiteId 의 site 전체 quarantine. quarantineApi.bySite 로 fetch.
   * Demo / UI 검증용 — localStorage flag 'mpd_demo_quarantine' = 'true' 이고 backend 가 empty 일 때
   * mock buildSiteQuarantineGroups 결과 사용. console 에서 toggle:
   *   localStorage.setItem('mpd_demo_quarantine','true')   // 켜기
   *   localStorage.removeItem('mpd_demo_quarantine')        // 끄기 */
  const [allGroups, setAllGroups] = useState<SiteQuarantineGroup[]>([]);
  const fetchGroups = useCallback(() => {
    if (!activeSiteId) { setAllGroups([]); return; }
    quarantineApi.bySite(activeSiteId)
      .then((data) => {
        if ((data?.length ?? 0) === 0
            && typeof window !== 'undefined'
            && window.localStorage?.getItem('mpd_demo_quarantine') === 'true') {
          setAllGroups(buildSiteQuarantineGroups(siteProjects.map((p) => ({ id: p.id, name: p.name }))));
        } else {
          setAllGroups(data ?? []);
        }
      })
      .catch((e) => {
        console.error('site quarantine fetch failed', e);
        if (typeof window !== 'undefined'
            && window.localStorage?.getItem('mpd_demo_quarantine') === 'true') {
          setAllGroups(buildSiteQuarantineGroups(siteProjects.map((p) => ({ id: p.id, name: p.name }))));
        } else {
          setAllGroups([]);
        }
      });
  }, [activeSiteId, siteProjects]);

  // 최초 + 주기 refetch — 다음 run 이 시작되면 latest run 이 바뀌므로, 이전 run 의 quarantine 이
  // 곧바로 history 로 내려가고 현재 카드가 새 run 기준으로 갱신되게 한다 (stale 방지).
  useEffect(() => {
    fetchGroups();
    const id = setInterval(fetchGroups, 7000);
    return () => clearInterval(id);
  }, [fetchGroups]);

  /** 페이지 내 탭 — Quarantine | Run History (#5: 구 Scheduler Run History 통합). */
  const [view, setView] = useState<'quarantine' | 'history'>('quarantine');
  const [severityFilter, setSeverityFilter] = useState<'all' | 'skip' | QuarantineSeverity>('all');
  const [projectFilter,  setProjectFilter]  = useState<string | null>(null);   // null = 모든 프로젝트
  const [pickedGroupId,  setPickedGroupId]  = useState<string | null>(null);
  const [openGroupId,    setOpenGroupId]    = useState<string | null>(null);

  /* 현재(=최신 run) quarantine 만 카드/통계에 쓴다. fromLatestRun===false (새 run 이 이미
     시작돼 옛 run 것) 은 카드에서 빼고 아래 "과거 발생 이력(archive)" 으로만 보낸다 (엄격 B).
     mock(fromLatestRun undefined) 은 active 로 취급. */
  const activeGroups = useMemo(
    () => allGroups.filter((g) => g.fromLatestRun !== false),
    [allGroups],
  );

  /* ── 통계 ───────────────────────────────────────── */
  /* ack 된 WARN 은 'skip' 으로 분리 카운트 (LogViewerPage 와 동일 규칙).
     error 는 ack 무관 — error 는 ack 시스템 X. */
  const groupStats = useMemo(() => {
    let errRows = 0, warnRows = 0, skipRows = 0;
    for (const g of activeGroups) {
      if (g.severity === 'error') errRows += g.rowCount;
      else if (g.ack) skipRows += g.rowCount;
      else warnRows += g.rowCount;
    }
    const errGroups  = activeGroups.filter((g) => g.severity === 'error').length;
    const warnGroups = activeGroups.filter((g) => g.severity === 'warning' && !g.ack).length;
    const skipGroups = activeGroups.filter((g) => g.severity === 'warning' && !!g.ack).length;
    return {
      total: activeGroups.length,
      errGroups, warnGroups, skipGroups,
      errRows, warnRows, skipRows,
      totalRows: errRows + warnRows + skipRows,
    };
  }, [activeGroups]);

  /* ── 필터링 ─────────────────────────────────────── */
  const afterSeverity = useMemo(() => {
    if (severityFilter === 'all')     return activeGroups;
    if (severityFilter === 'skip')    return activeGroups.filter((g) => g.severity === 'warning' && !!g.ack);
    if (severityFilter === 'warning') return activeGroups.filter((g) => g.severity === 'warning' && !g.ack);
    return activeGroups.filter((g) => g.severity === severityFilter);
  }, [activeGroups, severityFilter]);

  const afterProject = useMemo(() => (
    projectFilter ? afterSeverity.filter((g) => g.projectId === projectFilter) : afterSeverity
  ), [afterSeverity, projectFilter]);

  /* archive 에 넘길 group — active + 과거run(fromLatestRun=false) 모두 포함, project 필터만 적용.
     과거run group 은 archive 안에서 self-occurrence 로 렌더된다. */
  const archiveGroups = useMemo(() => (
    projectFilter ? allGroups.filter((g) => g.projectId === projectFilter) : allGroups
  ), [allGroups, projectFilter]);

  /* All 이 기본이므로 dropdown 미선택 시 (severity + project 만 적용된) 모든 카드 표시.
     dropdown 으로 group 하나 고르면 그 카드만 보이고 나머지는 hide. */
  const filteredGroups = useMemo(() => (
    pickedGroupId ? afterProject.filter((g) => g.id === pickedGroupId) : afterProject
  ), [afterProject, pickedGroupId]);

  /* severity / project 가 좁아져서 picked 가 사라지면 picked 초기화. */
  useEffect(() => {
    if (pickedGroupId && !afterProject.some((g) => g.id === pickedGroupId)) {
      setPickedGroupId(null);
    }
  }, [afterProject, pickedGroupId]);

  /* dropdown 으로 group 선택 시 자동 펼침. */
  useEffect(() => {
    if (pickedGroupId) setOpenGroupId(pickedGroupId);
  }, [pickedGroupId]);

  /* ── render ─────────────────────────────────────── */
  if (!activeSiteId) {
    return (
      <div style={styles.empty}>
        <div style={styles.emptyTitle}>{t('siteQuarantine.empty.noSite')}</div>
      </div>
    );
  }

  return (
    <div style={styles.root}>
      <style>{QUAR_CARD_CSS}</style>

      {/* 페이지 내 탭 — Quarantine | Run History */}
      <div style={styles.viewTabs} role="tablist">
        <button
          type="button" role="tab" aria-selected={view === 'quarantine'}
          onClick={() => setView('quarantine')}
          style={{ ...styles.viewTab, ...(view === 'quarantine' ? styles.viewTabActive : {}) }}
        >
          {t('runResults.tab.quarantine')}
        </button>
        <button
          type="button" role="tab" aria-selected={view === 'history'}
          onClick={() => setView('history')}
          style={{ ...styles.viewTab, ...(view === 'history' ? styles.viewTabActive : {}) }}
        >
          {t('runResults.tab.history')}
        </button>
      </div>

      {view === 'history' ? (
        <div style={styles.scroll}>
          <RunHistoryPanel />
        </div>
      ) : (
      <>
      <div style={styles.header}>
        {/* 위 줄 — stats */}
        <div style={styles.stats}>
          <div style={styles.statsEyebrow}>
            {t('siteQuarantine.eyebrow')}
            {projectFilter && (
              <span style={styles.statsProjectChip}>
                {siteProjects.find((p) => p.id === projectFilter)?.name}
              </span>
            )}
          </div>
          <div style={styles.statsLine}>
            {t('logs.quarantine.statsGroups', { n: String(groupStats.total) })}
            <span style={styles.statsSep}>·</span>
            {t('logs.quarantine.statsRows', {
              n: String(groupStats.totalRows),
              err: String(groupStats.errRows),
              warn: String(groupStats.warnRows),
              skip: String(groupStats.skipRows),
            })}
          </div>
        </div>

        {/* 아래 줄 — 모든 필터 (좌: sev tab + project, 우: group select) */}
        <div style={styles.filterRow}>
          <div style={styles.sevToggle} role="tablist">
            <SevTab label={t('logs.quarantine.filter.all')}      count={groupStats.total}
              active={severityFilter === 'all'}     onClick={() => setSeverityFilter('all')} />
            <SevTab label={t('logs.quarantine.filter.errors')}   count={groupStats.errGroups}
              active={severityFilter === 'error'}   onClick={() => setSeverityFilter('error')}   tone="error" />
            <SevTab label={t('logs.quarantine.filter.warnings')} count={groupStats.warnGroups}
              active={severityFilter === 'warning'} onClick={() => setSeverityFilter('warning')} tone="warning" />
            <SevTab label={t('logs.quarantine.filter.skip')}     count={groupStats.skipGroups}
              active={severityFilter === 'skip'}    onClick={() => setSeverityFilter('skip')} />
          </div>
          <select
            style={styles.projectSelect}
            value={projectFilter ?? ''}
            onChange={(e) => setProjectFilter(e.target.value || null)}
            disabled={siteProjects.length === 0}
          >
            <option value="">{t('siteQuarantine.pickProject.all')}</option>
            {siteProjects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>

          <select
            style={styles.groupSelect}
            value={pickedGroupId ?? ''}
            onChange={(e) => setPickedGroupId(e.target.value || null)}
            disabled={afterProject.length === 0}
          >
            <option value="">{t('logs.quarantine.pick.all')}</option>
            {afterProject.map((g) => (
              <option key={g.id} value={g.id}>{g.projectName} · {g.reason} ({g.rowCount})</option>
            ))}
          </select>

          <div style={{ flex: 1 }} />
        </div>
      </div>

      <div style={styles.scroll}>
        {filteredGroups.length === 0 ? (
          <div style={styles.empty}>{t('logs.quarantine.empty')}</div>
        ) : (
          filteredGroups.map((g) => (
            <SiteQuarantineCard
              key={g.id}
              g={g}
              t={t}
              open={openGroupId === g.id}
              onToggle={() => setOpenGroupId((cur) => (cur === g.id ? null : g.id))}
              onOpenMapping={() => goToExecution(g.projectId)}
            />
          ))
        )}

        {/* Page-level 「과거 발생 이력」 collapse section — 필터링된 group 의 옛 run entry 통합 list.
            상단 = 최신 (Axis 1), 하단 = 과거 archive. severity / project / group dropdown 필터 모두 적용. */}
        <HistoryArchiveSection groups={archiveGroups} severityFilter={severityFilter} t={t} />
      </div>
      </>
      )}
    </div>
  );
}

/* ──────────────────────────────────────────────── components ───────── */

function SevTab({ label, count, active, onClick, tone }: {
  label: string; count: number; active: boolean; onClick: () => void;
  tone?: 'error' | 'warning';
}) {
  const activeStyle = !active ? {}
    : tone === 'error'   ? styles.sevTabBtnActiveErr
    : tone === 'warning' ? styles.sevTabBtnActiveWarn
                         : styles.sevTabBtnActive;
  return (
    <button
      type="button" role="tab" aria-selected={active} onClick={onClick}
      style={{ ...styles.sevTabBtn, ...activeStyle }}
    >
      <span>{label}</span>
      <span style={styles.sevTabCount}>{count}</span>
    </button>
  );
}

function SiteQuarantineCard({ g, t, open, onToggle, onOpenMapping }: {
  g: SiteQuarantineGroup;
  t: (k: string, v?: Record<string, string>) => string;
  open: boolean;
  onToggle: () => void;
  onOpenMapping: () => void;
}) {
  const isErr = g.severity === 'error';
  const sevColor  = isErr ? '#c92a3f' : '#a86b00';
  const sevBg     = isErr ? 'rgba(232,93,117,0.08)' : 'rgba(232,181,99,0.10)';
  const sevBorder = isErr ? '#e85d75' : '#e8b563';
  const tt = t as unknown as (k: string, v?: Record<string, string>) => string;
  const human = humanizeQuarantineDetail(g, tt);
  const handleToggle = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation();
    onToggle();
  };
  const onChevronKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleToggle(e); }
  };
  return (
    <div
      aria-expanded={open}
      className="site-quar-card"
      style={{ ...styles.cardRoot, ...(open ? styles.cardRootOpen : {}) }}
    >
      <div style={{ ...styles.cardLeftBar, background: sevBorder }} />
      <div style={styles.cardBody}>
        <div style={styles.cardTopRow}>
          <button
            type="button"
            onClick={handleToggle}
            onKeyDown={onChevronKey}
            aria-label={open ? 'Collapse' : 'Expand'}
            aria-expanded={open}
            style={styles.cardChevron}
          >
            {open ? '▾' : '▸'}
          </button>
          <div style={styles.cardTitles}>
            <div style={{ ...styles.cardReason, color: sevColor }}>
              {g.reason}
              {g.fromLatestRun === false && (
                <span style={styles.pastRunBadge}>{t('siteQuarantine.pastRun')}</span>
              )}
            </div>
            {human && <div style={styles.cardHumanDetail}>{human}</div>}
          </div>
          <div style={styles.cardMetaRight}>
            <span style={styles.cardProjectName}>{g.projectName}</span>
            <span style={{ ...styles.rowsBadge, color: sevColor, borderColor: sevBorder, background: sevBg }}>
              {t('logs.quarantine.rowsBadge', { n: String(g.rowCount) })}
            </span>
            <span style={styles.cardStage}>{g.stage}</span>
          </div>
        </div>

        {open && (
          <div style={styles.cardExpand}>
            <div style={styles.cardTableWrap}>
              <table style={styles.cardTable}>
                <thead>
                  {/* PROJECT 컬럼은 cross-project 뷰의 식별 도움 (card 헤더와 중복이지만 긴 스크롤 시 유용).
                      TABLE 컬럼은 PK 로 교체 — 같은 group 안에서 row 식별. */}
                  <tr>
                    <th style={{ ...styles.cardTh, ...styles.cardThTable }}>{t('logs.quarantine.colProject')}</th>
                    <th style={{ ...styles.cardTh, ...styles.cardThTable }}>
                      {quarantinePkColumnName(g) ?? t('logs.quarantine.colTable')}
                    </th>
                    <th style={{ ...styles.cardTh, color: sevColor }}>
                      {t('logs.quarantine.colAsIs')}
                      {quarantineViolatedColumnName(g) && (
                        <span style={{ fontWeight: 400, opacity: 0.75 }}> · {quarantineViolatedColumnName(g)}</span>
                      )}
                    </th>
                    <th style={styles.cardTh}>{t('logs.quarantine.colToBe')}</th>
                  </tr>
                </thead>
                <tbody>
                  {g.sampleRows.map((_, ri) => {
                    const pk = quarantineRowPk(g, ri);
                    const asIs = quarantineRowAsIs(g, ri);
                    const toBe = quarantineRowToBe(g, ri);
                    const asIsNullStyle = { ...styles.nullCell, color: sevColor, background: 'transparent', border: `1px solid ${sevBorder}` };
                    return (
                      <tr key={ri}>
                        <td style={{ ...styles.cardTd, ...styles.cardTdTable }}>{g.projectName}</td>
                        <td style={{ ...styles.cardTd, ...styles.cardTdTable }}>
                          {pk === null ? <span style={styles.nullCell}>—</span> : String(pk)}
                        </td>
                        <td style={{ ...styles.cardTd, color: sevColor, fontWeight: 700, background: sevBg }}>
                          {asIs === null ? <span style={asIsNullStyle}>NULL</span> : String(asIs)}
                        </td>
                        <td style={{ ...styles.cardTd, ...styles.cardTdToBe }}>
                          {toBe === null ? <span style={styles.nullCell}>NULL</span> : String(toBe)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div style={styles.cardActions} onClick={(e) => e.stopPropagation()}>
              <button type="button" style={styles.actPrimary} onClick={onOpenMapping}>
                {t('logs.quarantine.act.goToExecution')}
              </button>
              <div style={{ flex: 1 }} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Page-level 「과거 발생 이력」 collapse section. 모든 group 의 history entry flat list. */
function HistoryArchiveSection({ groups, severityFilter, t }: {
  groups: SiteQuarantineGroup[];
  severityFilter: 'all' | QuarantineSeverity | 'skip';
  t: (k: string, v?: Record<string, string>) => string;
}) {
  const [open, setOpen] = useState(false);
  /* row 별 expand state — 펼치면 그 group 의 sample 표 표시 (Open mapping 없음). */
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  /* archive 자체 접으면 내부 row expand 도 reset — 다음 펼침 시 detail 닫힌 상태로 시작. */
  useEffect(() => { if (!open) setExpandedKey(null); }, [open]);
  /* 모든 group 의 history entry 를 group key 와 함께 flatten + 최신순 정렬. severity + group 전체 carry. */
  const flatHistory = useMemo(() => {
    const rows: Array<{
      key: string;
      group: SiteQuarantineGroup;
      runId: string;
      createdAt: string;
      rowCount: number;
      acked: boolean;
      ackedBy?: string;
      ackedPhase?: string;
      columns?: typeof groups[number]['columns'];
      columnRoles?: typeof groups[number]['columnRoles'];
      sampleRows?: typeof groups[number]['sampleRows'];
      toBeValues?: typeof groups[number]['toBeValues'];
    }> = [];
    for (const g of groups) {
      /* 과거 run(fromLatestRun=false) 의 self occurrence — 새 run 이 시작되며 카드에서 빠진 옛
         quarantine 을 archive 에 그대로 보여준다 (엄격 B). active group(최신 run)은 카드에 있으니 제외. */
      if (g.fromLatestRun === false) {
        const selfAcked = !!g.ack;
        let includeSelf = true;
        if (g.severity === 'warning') {
          if (severityFilter === 'warning' && selfAcked) includeSelf = false;
          if (severityFilter === 'skip'    && !selfAcked) includeSelf = false;
        }
        if (includeSelf) {
          rows.push({
            key: g.id + '-self',
            group: g,
            runId: g.runId ?? '—',
            createdAt: g.firstSeenAt,
            rowCount: g.rowCount,
            acked: selfAcked,
            ackedBy: g.ack?.acknowledgedBy,
            ackedPhase: g.ack?.phase,
            columns: g.columns,
            columnRoles: g.columnRoles,
            sampleRows: g.sampleRows,
            toBeValues: g.toBeValues,
          });
        }
      }
      for (const h of g.history ?? []) {
        /* severity filter 가 history 의 ack 상태에도 적용:
           - 'warning' tab → unack warning history 만
           - 'skip'    tab → ack warning history 만
           - 'error'/all → 그대로 (error 는 ack 시스템 X) */
        if (g.severity === 'warning') {
          if (severityFilter === 'warning' && h.acked) continue;
          if (severityFilter === 'skip'    && !h.acked) continue;
        }
        rows.push({
          key: g.id + '-' + h.runId,
          group: g,
          runId: h.runId,
          createdAt: h.createdAt,
          rowCount: h.rowCount,
          acked: h.acked,
          ackedBy: h.ackedBy,
          ackedPhase: h.ackedPhase,
          columns: h.columns,
          columnRoles: h.columnRoles,
          sampleRows: h.sampleRows,
          toBeValues: h.toBeValues,
        });
      }
    }
    return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [groups, severityFilter]);

  if (flatHistory.length === 0) return null;

  return (
    <>
      {/* 카드 list 와 archive 사이 구분선. */}
      <div style={styles.archiveSeparator} />
      <div style={styles.archiveRoot}>
        <div style={styles.archiveLeftBar} />
        <div style={styles.archiveBody}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={styles.archiveToggle}
        aria-expanded={open}
      >
        <span style={styles.archiveChevron}>{open ? '▾' : '▸'}</span>
        {t('logs.quarantine.history.toggle', { n: String(flatHistory.length) })}
      </button>
      {open && (
        <div style={styles.archivePanel}>
          <table style={styles.archiveTable}>
            <thead>
              <tr>
                <th style={{ ...styles.archiveTh, width: 24 }}></th>
                <th style={styles.archiveTh}>{t('logs.quarantine.colProject')}</th>
                <th style={styles.archiveTh}>Reason</th>
                <th style={styles.archiveTh}>Table</th>
                <th style={styles.archiveTh}>Stage</th>
                <th style={styles.archiveTh}>Run ID</th>
                <th style={styles.archiveTh}>Time</th>
                <th style={{ ...styles.archiveTh, textAlign: 'right' }}>Rows</th>
                <th style={styles.archiveTh}>Status</th>
              </tr>
            </thead>
            <tbody>
              {flatHistory.map((h) => {
                const g = h.group;
                const isOpen = expandedKey === h.key;
                const isErr = g.severity === 'error';
                const sevColor  = isErr ? '#c92a3f' : '#a86b00';
                const sevBg     = isErr ? 'rgba(232,93,117,0.08)' : 'rgba(232,181,99,0.10)';
                const sevBorder = isErr ? '#e85d75' : '#e8b563';
                const human = humanizeQuarantineDetail(g, t);
                return (
                  <Fragment key={h.key}>
                    <tr
                      style={{ cursor: 'pointer' }}
                      onClick={() => setExpandedKey((cur) => (cur === h.key ? null : h.key))}
                    >
                      <td style={{ ...styles.archiveTd, color: 'var(--text-3)' }}>{isOpen ? '▾' : '▸'}</td>
                      <td style={styles.archiveTd}>{h.group.projectName}</td>
                      <td style={styles.archiveTd}>{h.group.reason}</td>
                      <td style={{ ...styles.archiveTd, fontFamily: 'var(--mono)' }}>{h.group.table}</td>
                      <td style={styles.archiveTd}>{h.group.stage}</td>
                      <td style={{ ...styles.archiveTd, fontFamily: 'var(--mono)' }}>{h.runId}</td>
                      <td style={{ ...styles.archiveTd, color: 'var(--text-3)' }}>{new Date(h.createdAt).toLocaleString()}</td>
                      <td style={{ ...styles.archiveTd, textAlign: 'right' }}>{h.rowCount}</td>
                      <td style={styles.archiveTd}>
                        {(() => {
                          /* Status badge — severity + ack 조합. severity tab 의 4 값과 일관:
                             error (active) / warning (active) / skip (warning + ack). */
                          if (g.severity === 'error') {
                            return <span style={styles.statusErrorBadge}>error</span>;
                          }
                          if (h.acked) {
                            return (
                              <span
                                style={styles.statusSkipBadge}
                                title={h.ackedBy ? `${h.ackedBy} · ${h.ackedPhase ?? ''}` : undefined}
                              >
                                skip
                              </span>
                            );
                          }
                          return <span style={styles.statusWarningBadge}>warning</span>;
                        })()}
                      </td>
                    </tr>
                    {isOpen && (() => {
                      /* archive expand 시 그 옛 entry (h) 의 sample 사용. backend 가 history 에 sample
                         payload 채워줌. h.sampleRows 없으면 group g 의 sample fallback (옛 mock 호환). */
                      const hView: SiteQuarantineGroup = {
                        ...g,
                        columns: h.group.columns,           // 같은 group 의 columns 구조 (보통 동일)
                        columnRoles: h.group.columnRoles,
                        sampleRows: h.sampleRows ?? g.sampleRows,
                        toBeValues: h.toBeValues ?? g.toBeValues,
                      };
                      if (h.columns && h.columns.length > 0) hView.columns = h.columns;
                      if (h.columnRoles && h.columnRoles.length > 0) hView.columnRoles = h.columnRoles;
                      return (
                      <tr>
                        <td colSpan={9} style={styles.archiveDetailTd}>
                          {/* 상세 — 기존 SiteQuarantineCard 의 cardExpand 와 동일 layout.
                              Project / PK / AS-IS / TO-BE 4 column + cardTableWrap. Open mapping 없음. */}
                          <div style={styles.cardExpand}>
                            {human && <div style={styles.cardHumanDetail}>{human}</div>}
                            <div style={styles.cardTableWrap}>
                              <table style={styles.cardTable}>
                                <thead>
                                  <tr>
                                    <th style={{ ...styles.cardTh, ...styles.cardThTable }}>{t('logs.quarantine.colProject')}</th>
                                    <th style={{ ...styles.cardTh, ...styles.cardThTable }}>
                                      {quarantinePkColumnName(hView) ?? t('logs.quarantine.colTable')}
                                    </th>
                                    <th style={{ ...styles.cardTh, color: sevColor }}>
                                      {t('logs.quarantine.colAsIs')}
                                      {quarantineViolatedColumnName(hView) && (
                                        <span style={{ fontWeight: 400, opacity: 0.75 }}> · {quarantineViolatedColumnName(hView)}</span>
                                      )}
                                    </th>
                                    <th style={styles.cardTh}>{t('logs.quarantine.colToBe')}</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {hView.sampleRows.map((_, ri) => {
                                    const pk = quarantineRowPk(hView, ri);
                                    const asIs = quarantineRowAsIs(hView, ri);
                                    const toBe = quarantineRowToBe(hView, ri);
                                    const asIsNullStyle = { ...styles.nullCell, color: sevColor, background: 'transparent', border: `1px solid ${sevBorder}` };
                                    return (
                                      <tr key={ri}>
                                        <td style={{ ...styles.cardTd, ...styles.cardTdTable }}>{g.projectName}</td>
                                        <td style={{ ...styles.cardTd, ...styles.cardTdTable }}>
                                          {pk === null ? <span style={styles.nullCell}>—</span> : String(pk)}
                                        </td>
                                        <td style={{ ...styles.cardTd, color: sevColor, fontWeight: 700, background: sevBg }}>
                                          {asIs === null ? <span style={asIsNullStyle}>NULL</span> : String(asIs)}
                                        </td>
                                        <td style={{ ...styles.cardTd, ...styles.cardTdToBe }}>
                                          {toBe === null ? <span style={styles.nullCell}>NULL</span> : String(toBe)}
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        </td>
                      </tr>
                      );
                    })()}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
        </div>
      </div>
    </>
  );
}

/* ──────────────────────────────────────────────── styles ───────────── */

const QUAR_CARD_CSS = `
.site-quar-card,
.site-quar-card:focus,
.site-quar-card:focus-visible,
.site-quar-card:focus-within { outline: none !important; }
`;

const styles: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', height: 'calc(100vh - 80px)', minHeight: 540 },

  viewTabs: {
    display: 'flex', gap: 4, marginBottom: 10,
    borderBottom: '1px solid var(--border)',
  },
  viewTab: {
    padding: '7px 16px', fontSize: 13, fontWeight: 500,
    border: 'none', borderBottom: '2px solid transparent',
    background: 'transparent', color: 'var(--text-3)', cursor: 'pointer',
    marginBottom: -1,
  },
  viewTabActive: {
    color: 'var(--text)', borderBottomColor: 'var(--accent, var(--green))',
  },

  header: {
    /* 2 줄 stack — 위: stats, 아래: 필터 한 줄. */
    display: 'flex', flexDirection: 'column', gap: 10,
    padding: '10px 14px', background: 'var(--panel)',
    border: '1px solid var(--border)', borderRadius: 6, marginBottom: 8,
  },
  filterRow: {
    display: 'flex', alignItems: 'center', gap: 10,
    flexWrap: 'nowrap',
  },
  stats: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
  statsEyebrow: {
    display: 'flex', alignItems: 'center', gap: 8,
    fontSize: 10, fontWeight: 800, color: 'var(--text-3)',
    fontFamily: 'var(--mono)', letterSpacing: 1.4, textTransform: 'uppercase',
  },
  /* SITE QUARANTINE 옆 — 선택된 project 이름 chip */
  statsProjectChip: {
    display: 'inline-flex', alignItems: 'center',
    padding: '2px 8px', borderRadius: 999,
    background: 'var(--panel-2)', border: '1px solid var(--border)',
    color: 'var(--text)',
    /* eyebrow 가 mono+uppercase 인데 chip 은 normal text 가 자연스럽다. */
    fontFamily: 'inherit', fontSize: 11, fontWeight: 600,
    letterSpacing: 0, textTransform: 'none',
    maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  statsLine: {
    fontSize: 12, color: 'var(--text-2)', fontFamily: 'var(--mono)',
    display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap',
  },
  statsSep: { color: 'var(--text-4)' },

  sevToggle: {
    display: 'inline-flex', border: '1px solid var(--border-strong)', borderRadius: 5,
    overflow: 'hidden', background: 'var(--panel-2)',
  },
  sevTabBtn: {
    /* chip width 고정 — 활성 background 색이 바뀌어도 width 변동 X → layout shift 없음. */
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    minWidth: 92,
    padding: '5px 12px', border: 'none', background: 'transparent',
    color: 'var(--text-3)', fontSize: 11, fontWeight: 600, cursor: 'pointer',
    borderRight: '1px solid var(--border)',
  },
  sevTabBtnActive:     { background: 'var(--panel)',          color: 'var(--text)' },
  sevTabBtnActiveErr:  { background: 'rgba(232,93,117,0.12)', color: '#c92a3f' },
  sevTabBtnActiveWarn: { background: 'rgba(232,181,99,0.18)', color: '#a86b00' },
  sevTabCount: {
    display: 'inline-block', minWidth: 14, padding: '0 5px',
    background: 'rgba(0,0,0,0.06)', fontSize: 10, fontWeight: 700,
    fontFamily: 'var(--mono)', borderRadius: 999, textAlign: 'center',
    color: 'inherit',
  },

  /* 사이드바 "프로젝트 검색" input 과 동일 폰트 (default sans, 11.5). */
  projectSelect: {
    padding: '5px 10px', border: '1px solid var(--border-strong)', borderRadius: 4,
    background: 'var(--panel)', color: 'var(--text)',
    fontSize: 11.5, cursor: 'pointer',
    minWidth: 140, maxWidth: 200,
  },
  /* 우측 group select — 작게 ('항목 선택' 의도) */
  groupSelect: {
    padding: '5px 10px', border: '1px solid var(--border-strong)', borderRadius: 4,
    background: 'var(--panel)', color: 'var(--text)',
    fontSize: 11.5, cursor: 'pointer',
    width: 220, maxWidth: 260,
    textOverflow: 'ellipsis',
  },

  scroll: {
    flex: 1, overflow: 'auto', padding: 12,
    display: 'flex', flexDirection: 'column', gap: 12,
    background: 'var(--panel-2)',
    border: '1px solid var(--border)', borderRadius: 6,
  },
  empty: {
    padding: '60px 20px', textAlign: 'center',
    color: 'var(--text-4)', fontSize: 12, fontFamily: 'var(--mono)',
  },
  emptyTitle: { fontSize: 13, fontWeight: 600, color: 'var(--text-3)' },

  /* card — LogViewerPage 의 quarantine card 와 같은 디자인 + project name 추가 */
  cardRoot: {
    display: 'flex', flexShrink: 0,
    background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 6,
    overflow: 'hidden',
    outline: 'none',
    transition: 'box-shadow 120ms ease',
  },
  cardRootOpen: { boxShadow: '0 1px 0 rgba(0,0,0,0.04), 0 8px 24px -12px rgba(0,0,0,0.18)' },
  cardLeftBar:  { width: 4, flexShrink: 0 },
  cardBody:     { flex: 1, minWidth: 0, padding: '10px 16px' },

  cardTopRow:  { display: 'flex', alignItems: 'center', gap: 12 },
  /* chevron 만 클릭 가능 — 카드 전체 클릭으로 펴졌다 접혔다 하지 않도록. */
  cardChevron: {
    flexShrink: 0, width: 22, height: 22, padding: 0,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    border: '1px solid transparent', borderRadius: 4,
    background: 'transparent',
    color: 'var(--text-4)', fontSize: 11, lineHeight: 1, userSelect: 'none',
    cursor: 'pointer',
  },
  cardTitles:   { display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 },
  cardReason:   { fontSize: 14, fontWeight: 700, lineHeight: 1.3 },
  cardDetail:   { fontSize: 11.5, color: 'var(--text-4)', fontFamily: 'var(--mono)', wordBreak: 'break-word' },
  /* DB 표기를 사람말로 풀이한 한 줄 — mono 가 아닌 본문 폰트, 본문 톤. */
  cardHumanDetail: {
    fontSize: 11.5, color: 'var(--text-2)', lineHeight: 1.45,
    marginTop: 4, wordBreak: 'keep-all',
  },
  cardMetaRight: {
    display: 'grid',
    gridTemplateColumns: '160px 72px 132px',
    alignItems: 'center', gap: 10, flexShrink: 0,
    fontFamily: 'var(--mono)',
  },
  cardProjectName: {
    fontSize: 11, color: 'var(--text-2)', fontWeight: 600,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  rowsBadge: {
    display: 'inline-flex', alignItems: 'center',
    padding: '3px 10px', border: '1px solid', borderRadius: 999,
    fontSize: 10.5, fontWeight: 800, letterSpacing: 0.6,
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  cardStage: { fontSize: 11, color: 'var(--text-3)', fontWeight: 600 },
  /* 새 run 이 시작돼 이 quarantine 이 더 이상 최신 run 게 아닐 때 — "지난 Run" 표시. */
  pastRunBadge: {
    marginLeft: 8,
    padding: '1px 7px',
    fontSize: 9.5,
    fontWeight: 800,
    fontFamily: 'var(--mono)',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: 'var(--text-3)',
    background: 'var(--panel-2)',
    border: '1px solid var(--border-strong)',
    borderRadius: 999,
    verticalAlign: 'middle',
  },

  cardExpand: { marginTop: 12 },
  cardTableWrap: {
    border: '1px solid var(--border)', borderRadius: 4,
    maxHeight: 280, overflow: 'auto',
  },
  cardTable: {
    width: '100%', borderCollapse: 'collapse',
    fontFamily: 'var(--mono)', fontSize: 11.5,
  },
  /* 모든 컬럼 헤더는 PROJECT_NAME 기준으로 배경/색을 통일 (panel + text-2). */
  cardTh: {
    textAlign: 'left', padding: '6px 12px',
    background: 'var(--panel)', color: 'var(--text-2)',
    fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase',
    borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
  },
  /* 위반 컬럼은 severity color 로 강조 — 운영자가 한눈에 원인 파악. */
  cardThViolated: { fontWeight: 800 },
  cardThPk:       {},
  /* PROJECT_NAME 컬럼 — 시각 통일성을 위해 default cardTh 그대로 사용. */
  cardThTable:    {},
  /* 컬럼 헤더 옆 role 라벨 — 컬럼 이름의 색을 그대로 상속해서 가독성 확보. */
  cardThRole: {
    color: 'inherit', fontWeight: 500,
    fontSize: 10, letterSpacing: 0, textTransform: 'none',
    marginLeft: 2,
  },
  cardTd: {
    padding: '6px 12px', borderBottom: '1px solid var(--border)',
    color: 'var(--text-2)', whiteSpace: 'nowrap',
  },
  /* PROJECT_NAME / TABLE_NAME 컬럼 셀 — default cardTd 와 동일 톤, 굵기만 약간 강조. */
  cardTdTable: { fontWeight: 600 },
  /* TO-BE 컬럼 셀 — 룰 엔진 transform 결과 값. AS-IS 보다 한 톤 약하게. */
  cardTdToBe: { color: 'var(--text-3)' },
  nullCell: {
    display: 'inline-block', padding: '0 6px',
    background: 'rgba(160,168,180,0.18)', color: 'var(--text-4)',
    fontSize: 10, fontWeight: 700, borderRadius: 3, letterSpacing: 0.4,
  },

  cardActions: {
    display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
    marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)',
  },
  /* 과거 발생 이력 — Site quarantine card 의 footer 접/펴 panel. */
  historyRoot: {
    marginTop: 8, paddingTop: 8,
    borderTop: '1px dashed var(--border)',
  },
  historyEmpty: {
    marginTop: 8, paddingTop: 8,
    borderTop: '1px dashed var(--border)',
    fontSize: 10.5, color: 'var(--text-4)', fontStyle: 'italic',
  },
  historyToggle: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '4px 8px', border: 'none', borderRadius: 3,
    background: 'transparent', color: 'var(--text-2)',
    fontSize: 11, fontWeight: 600, cursor: 'pointer',
  },
  historyChevron: {
    fontSize: 10, color: 'var(--text-3)',
  },
  historyPanel: {
    marginTop: 6, padding: '6px 10px',
    background: 'var(--panel-2)',
    border: '1px solid var(--border)', borderRadius: 4,
    display: 'flex', flexDirection: 'column', gap: 4,
  },
  historyRow: {
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '4px 0',
    fontSize: 11,
    borderBottom: '1px dotted var(--border)',
  },
  historyRunId: {
    fontFamily: 'var(--mono)', color: 'var(--text)', minWidth: 110,
  },
  historyTs: {
    color: 'var(--text-3)', minWidth: 160,
  },
  historyRows: {
    color: 'var(--text-2)', minWidth: 70, textAlign: 'right',
  },
  historyAckBadge: {
    marginLeft: 'auto',
    fontSize: 10, fontWeight: 700,
    color: 'var(--text-3)',
    padding: '2px 6px',
    background: 'var(--panel)',
    border: '1px solid var(--border)', borderRadius: 3,
  },
  historyUnackBadge: {
    marginLeft: 'auto',
    fontSize: 10, fontWeight: 700,
    color: 'var(--amber)',
    padding: '2px 6px',
    background: 'rgba(232,181,99,0.10)',
    border: '1px solid var(--amber)', borderRadius: 3,
  },
  /* Page-level archive section — 카드 list 아래의 「과거 발생 이력」 collapse */
  /* 카드 list 와 archive 사이 시각적 구분선. archive 의 marginTop 대체. */
  archiveSeparator: {
    height: 1,
    marginTop: 20,
    marginBottom: 16,
    background: 'var(--border-strong)',
  },
  archiveRoot: {
    display: 'flex',
    flexShrink: 0,                                  /* scroll parent (column flex) 의 압축 방지 */
    background: 'var(--panel)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    overflow: 'hidden',
  },
  /* 카드 의 cardLeftBar 와 같은 위치. severity 없는 archive 라 진한 회색. */
  archiveLeftBar: {
    width: 4, flexShrink: 0,
    background: 'var(--text-3)',
  },
  archiveBody: {
    flex: 1, minWidth: 0,
    padding: '32px 18px',
  },
  archiveToggle: {
    display: 'inline-flex', alignItems: 'center', gap: 10,
    padding: '10px 16px', border: 'none', borderRadius: 4,
    background: 'transparent', color: 'var(--text-2)',
    fontSize: 13.5, fontWeight: 700, cursor: 'pointer',
  },
  archiveChevron: {
    fontSize: 13, color: 'var(--text-3)',
  },
  archivePanel: {
    marginTop: 10,
    overflowX: 'auto',
  },
  archiveTable: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: 11.5,
  },
  archiveTh: {
    padding: '6px 8px',
    textAlign: 'left',
    fontWeight: 700,
    color: 'var(--text-2)',
    background: 'var(--panel-2)',
    borderBottom: '1px solid var(--border)',
  },
  archiveTd: {
    padding: '6px 8px',
    borderBottom: '1px solid var(--border)',
    color: 'var(--text)',
  },
  archiveDetailTd: {
    padding: '10px 14px 14px',
    background: 'var(--panel)',
    borderBottom: '1px solid var(--border)',
  },
  archiveDetailHuman: {
    marginBottom: 8,
    fontSize: 11.5,
    color: 'var(--text-2)',
    fontStyle: 'italic',
  },
  /* Status badge — severity tab 의 4 값과 일관 (error / warning / skip). */
  statusErrorBadge: {
    display: 'inline-block',
    fontSize: 10, fontWeight: 700,
    padding: '2px 8px',
    color: '#c92a3f',
    background: 'rgba(232,93,117,0.10)',
    border: '1px solid #e85d75',
    borderRadius: 3,
  },
  statusWarningBadge: {
    display: 'inline-block',
    fontSize: 10, fontWeight: 700,
    padding: '2px 8px',
    color: '#a86b00',
    background: 'rgba(232,181,99,0.10)',
    border: '1px solid #e8b563',
    borderRadius: 3,
  },
  statusSkipBadge: {
    display: 'inline-block',
    fontSize: 10, fontWeight: 700,
    padding: '2px 8px',
    color: 'var(--text-3)',
    background: 'var(--panel-2)',
    border: '1px solid var(--border-strong)',
    borderRadius: 3,
  },
  actPrimary: {
    padding: '6px 14px', border: '1px solid #1f8a5c', borderRadius: 4,
    background: '#21946a', color: '#fff',
    fontSize: 11.5, fontWeight: 700, cursor: 'pointer',
  },
  actSecondary: {
    padding: '6px 14px', border: '1px solid var(--border-strong)', borderRadius: 4,
    background: 'var(--panel)', color: 'var(--text)',
    fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
  },
};
