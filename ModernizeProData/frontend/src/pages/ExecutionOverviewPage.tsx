import { useCallback, useEffect, useMemo, useState } from 'react';
import { useWorkspaceStore, type Project } from '../store/workspace';
import { useUsersStore } from '../store/users';
import { useAuthStore } from '../store/auth';
import { useSnapshotsStore, usePinnedSnapshotsStore, type MappingSnapshot } from '../store/snapshots';
import { Checkbox } from '../components/Checkbox';
import {
  buildStages,
  buildStagesFromStageViews,
  type Stage,
  type StageTone,
} from '../lib/pipelineStages';
import { useT } from '../i18n';
import { overviewApi, type ProjectExecMetrics } from '../api/executionOverview';
import { useExecutionPreflightStore } from '../store/executionPreflight';
import { runsApi } from '../api/runs';
import { workerApi, type WorkerSummaryDto } from '../api/worker';

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
  const setProjectExecutionAssignee = useWorkspaceStore((s) => s.setProjectExecutionAssignee);
  const fetchProjects = useWorkspaceStore((s) => s.fetchProjects);

  const site = useMemo(() => sites.find((s) => s.id === activeSiteId) ?? null, [sites, activeSiteId]);
  // assignee 변경에도 행 순서가 바뀌지 않도록 createdAt asc 로 명시 정렬.
  const siteProjects = useMemo(
    () => projects
      .filter((p) => p.siteId === activeSiteId)
      .slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [projects, activeSiteId],
  );

  const users = useUsersStore((s) => s.users);
  const snapshots = useSnapshotsStore((s) => s.snapshots);
  const pinnedIds = usePinnedSnapshotsStore((s) => s.pinnedIds);
  // projectId -> pinned snapshot (if any). 同サイト内全 project の snapshot は
  // AppShell が site 切替時に fetchBySite で読み込み済みである前提。
  const pinnedByProject = useMemo(() => {
    const pinSet = new Set(pinnedIds);
    const map: Record<string, MappingSnapshot> = {};
    for (const s of snapshots) {
      if (pinSet.has(s.id)) map[s.projectId] = s;
    }
    return map;
  }, [snapshots, pinnedIds]);

  // per-row pipeline 진행은 ProjectExecMetrics 의 progressPct + runStatus 로 그린다
  // (이전 demo 모드: mock activeRun + 500ms tick — 이번 PoC1 real wiring 으로 교체).
  // 자동 갱신은 안 함 (필요시 새로고침 / Execution 페이지로 가서 상세 보기).

  const [selected, setSelected] = useState<Set<string>>(new Set());
  // 담당자 변경 draft — Save 누르기 전까지는 backend / store 에 반영 안 됨.
  // key = projectId, value = 새 executionAssignee ('' = unassigned).
  const [assigneeDraft, setAssigneeDraft] = useState<Record<string, string>>({});
  const [savingAssignees, setSavingAssignees] = useState(false);

  const dirtyAssigneeIds = useMemo(() => Object.keys(assigneeDraft).filter((id) => {
    const p = projects.find((p) => p.id === id);
    if (!p) return false;
    return (assigneeDraft[id] ?? '') !== (p.executionAssignee ?? '');
  }), [assigneeDraft, projects]);

  const handleSaveAssignees = async () => {
    if (dirtyAssigneeIds.length === 0 || savingAssignees) return;
    setSavingAssignees(true);
    try {
      await Promise.all(
        dirtyAssigneeIds.map((id) =>
          setProjectExecutionAssignee(id, assigneeDraft[id] || undefined),
        ),
      );
      setAssigneeDraft({});
    } finally {
      setSavingAssignees(false);
    }
  };

  const handleDiscardAssignees = () => {
    if (savingAssignees) return;
    setAssigneeDraft({});
  };

  // 필터 — phase · username · errors · warnings. 'has' / 'none' / '' (=all)
  const [phaseFilter, setPhaseFilter] = useState<string>('');
  const [userFilter, setUserFilter] = useState<string>('');
  const [errorFilter, setErrorFilter] = useState<'' | 'has' | 'none'>('');
  const [warningFilter, setWarningFilter] = useState<'' | 'has' | 'none'>('');

  // execution overview 실데이터 — per-project 최신 run 집계 (BE: /sites/{id}/execution-overview).
  // 5 秒 polling — Execution 画面の 2 秒 polling よりは緩いが、overview なので桁ずれが起きないように
  // 定期更新する. running 中の project があると bar の進行が反映される.
  const [apiMetrics, setApiMetrics] = useState<Record<string, ProjectExecMetrics>>({});
  const loadMetrics = useCallback(() => {
    if (!activeSiteId) { setApiMetrics({}); return; }
    overviewApi.bySite(activeSiteId)
      .then((list) => {
        const m: Record<string, ProjectExecMetrics> = {};
        for (const it of list) m[it.projectId] = it;
        setApiMetrics(m);
      })
      .catch(() => setApiMetrics({}));
  }, [activeSiteId]);
  useEffect(() => { loadMetrics(); }, [loadMetrics]);
  // (A) 자동 갱신 — Execution 단일 페이지와 동일한 5초 polling. 다른 페이지로 떠나면 cleanup.
  // run 시작 / 종료 / abort 후 사용자가 Refresh 안 눌러도 화면이 따라온다.
  // metrics 만이 아니라 projects 도 같이 refetch — finishRun 이 cutover→hypercare 로
  // phase 를 advance 하므로 chip 색상도 같이 따라와야 한다.
  useEffect(() => {
    if (!activeSiteId) return;
    const id = window.setInterval(() => {
      loadMetrics();
      fetchProjects(activeSiteId);
    }, 5_000);
    return () => window.clearInterval(id);
  }, [activeSiteId, loadMetrics, fetchProjects]);

  // Run 종료 시 그 행만 selected 에서 자동 해제 — 사용자가 매번 직접 체크 해제할 필요 없게.
  // running / paused / pending / null (run 시작 전) 은 유지 — Abort 활성화를 위해.
  // success / failed / aborted / timed_out 으로 떨어지면 자동 해제.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set(prev);
      let changed = false;
      for (const id of prev) {
        const m = apiMetrics[id];
        if (!m) continue;
        const s = m.runStatus;
        if (s === 'success' || s === 'failed' || s === 'aborted' || s === 'timed_out') {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [apiMetrics]);

  // worker_nodes — master 만 fetch (endpoint 가 master only). assignee 별 online dot 용.
  // 90s heartbeat timeout. 동일 5초 polling.
  const [workers, setWorkers] = useState<WorkerSummaryDto[]>([]);
  const loadWorkers = useCallback(() => {
    if (!isMaster) { setWorkers([]); return; }
    workerApi.list().then(setWorkers).catch(() => setWorkers([]));
  }, [isMaster]);
  useEffect(() => { loadWorkers(); }, [loadWorkers]);
  useEffect(() => {
    if (!isMaster) return;
    const id = window.setInterval(() => loadWorkers(), 5000);
    return () => window.clearInterval(id);
  }, [isMaster, loadWorkers]);

  // username -> 가장 최근 heartbeat 받은 worker. online 판정은 lastSeenAt 90s 기준.
  const workerByUsername = useMemo(() => {
    const map = new Map<string, WorkerSummaryDto>();
    const sorted = [...workers].sort((a, b) =>
      (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? ''));
    for (const w of sorted) {
      if (w.username && !map.has(w.username)) map.set(w.username, w);
    }
    return map;
  }, [workers]);
  const ONLINE_TIMEOUT_MS = 90_000;
  const isWorkerOnline = (username: string | null | undefined): boolean => {
    if (!username) return false;
    const w = workerByUsername.get(username);
    if (!w || w.status !== 'REGISTERED' || !w.lastSeenAt) return false;
    return Date.now() - new Date(w.lastSeenAt).getTime() <= ONLINE_TIMEOUT_MS;
  };

  // (D) Overview の data 源は BE の apiMetrics 一本 (2026-05-31 simplify).
  // BE 側で「baseline (pinned) snapshot で起動された最新 run」を返すように変更済み
  // (ExecutionOverviewService.metricsFor) なので, pin 切替時はそれ自体が新 pin の最新 run に
  // 切り替わり, time travel ユースケースも自然にカバーされる.
  // 旧仕様は pin.executionContext (= finishRun 時の박제) で上書きしていたが,
  //   - 박제 시点に stage runner が走行中だと未完了 status のまま固定
  //   - その後 stage_instances が完走で update されても박제は据え置き
  // で Execution 画面 (stage_instances live polling) と Overview の表示が乖離していた.
  const metrics = apiMetrics;

  const errorCount = (p: Project) => metrics[p.id]?.errorCount ?? 0;
  const warningCount = (p: Project) => metrics[p.id]?.warningCount ?? 0;
  const warningAckedCount = (p: Project) => metrics[p.id]?.warningAckedCount ?? 0;

  // redirect 는 sidebar 프로젝트 클릭 핸들러가 직접 처리 (race 회피).
  if (activeProjectId || !site) return null;

  // username 비교 정규화 — null / empty string / 대소문자 다른 표기 대응 (DashboardPage 와 동일).
  const normExec = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();
  const filteredProjects = siteProjects.filter((p) => {
    if (phaseFilter && p.phase !== phaseFilter) return false;
    const pe = normExec(p.executionAssignee);
    if (userFilter === '__unassigned') {
      if (pe !== '') return false;
    } else if (userFilter && pe !== normExec(userFilter)) return false;
    const ec = errorCount(p);
    if (errorFilter === 'has'  && ec === 0) return false;
    if (errorFilter === 'none' && ec >  0) return false;
    const wc = warningCount(p);
    if (warningFilter === 'has'  && wc === 0) return false;
    if (warningFilter === 'none' && wc >  0) return false;
    return true;
  });

  // 체크박스 활성 기준: ready / sign-off 만 (test · rehearsal · cutover 는 실행 중 상태).
  // 담당자 dropdown 은 Coordinator(master) 만 변경 가능. 그 외는 text 로만 표시 (본인 row 포함).
  // 단 체크박스(run/abort 대상 선택) 는 본인 row 도 가능.
  const isMine = (p: Project) => !!user?.username && p.executionAssignee === user.username;
  const canEditRow = (_p: Project) => isMaster;
  const isSelectable = (p: Project) => {
    if (!isMaster && !isMine(p)) return false;
    return p.phase === 'ready' || p.phase === 'sign-off';
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
  // 선택된 row 중 executionAssignee 미할당 (또는 draft 의 변경 도 unassigned) 이
  // 하나라도 있으면 Run 금지 — Worker delegate 대상이 없는 row 는 RunService 가
  // REJECTED 반환하므로 UI 에서 미리 차단해 혼란 방지.
  const hasUnassignedSelected = [...selected].some((id) => {
    const draft = assigneeDraft[id];
    const effective = draft !== undefined ? draft : (siteProjects.find((p) => p.id === id)?.executionAssignee ?? '');
    return !effective;
  });
  const canRun = runCount > 0 && !hasUnassignedSelected;
  const canAbort = selectedRunningCount > 0;

  const handleRefresh = () => { loadMetrics(); loadWorkers(); };
  const handleRun = async () => {
    if (!isMaster || !activeSiteId) return;
    const ids = [...selected];
    if (ids.length === 0) return;
    // 선택 project 일괄 실행 — /runs/all (startAll) 로 호출해 각 run 에 bulk marker 가
    // 박힌다. 이것이 (1) 개별 ExecutionPage 의 site-level lock 감지 (2) abort 권한
    // master 한정 분기의 근거. 개별 start 반복은 bulk marker 가 안 붙어 둘 다 안 됨.
    const setActive = useExecutionPreflightStore.getState().setActiveRunId;
    const rejected: string[] = [];
    try {
      const res = await runsApi.startAll(activeSiteId, ids);
      res.results.forEach((r) => {
        const projectName = r.projectName ?? r.projectId ?? '?';
        if (r.status === 'REJECTED' || r.status === 'LOCKED') {
          rejected.push(`${projectName}: ${r.reason ?? r.status.toLowerCase()}`);
        } else if (r.status === 'STARTED' && r.runId && r.projectId) {
          setActive(r.projectId, r.runId);
        }
      });
    } catch (e) {
      rejected.push((e as Error)?.message ?? 'bulk run failed');
    }
    if (rejected.length > 0) {
      console.warn('[ExecutionOverview] run rejected', rejected);
      window.alert(rejected.join('\n'));
    }
    // 선택 유지 — Run 직후 Abort 활성화를 위해 selectedRunningCount 가 살아 있어야 함.
    loadMetrics();
    // Run 起動と同時に backend が phase advance (sign-off→rehearsal, ready→cutover) +
    // run_status='running' に変えるので、projects も refetch して chip / 行状態을 即反映.
    if (activeSiteId) fetchProjects(activeSiteId);
  };
  const handleAbort = async () => {
    if (!isMaster) return;
    // Abort 대상은 항상 "지금 실행 중인 run". pinned snapshot 의 박제는 종료 상태라
    // 그것을 abort 하려 들면 실패 — 그래서 apiMetrics (latest run) 만 본다.
    const runIds = [...selected]
      .map((id) => apiMetrics[id])
      .filter((m): m is ProjectExecMetrics => !!m && m.runStatus === 'running' && !!m.latestRunId)
      .map((m) => m.latestRunId!);
    await Promise.allSettled(runIds.map((rid) => runsApi.abort(rid, 'aborted from overview')));
    loadMetrics();
    if (activeSiteId) fetchProjects(activeSiteId);
  };

  // KPI 집계 — phase 기준 (running/done counter 용).
  const status = siteProjects.reduce(
    (a, p) => {
      if (p.phase === 'done') return { ...a, done: a.done + 1 };
      if (runningPhases.includes(p.phase)) return { ...a, running: a.running + 1 };
      return a;
    },
    { running: 0, done: 0 },
  );

  // (B) Overall progress / toolbar 상단 안내 — metrics 상태에 따라 동적.
  const metricValues = Object.values(metrics);
  const runningRuns = metricValues.filter((m) => m.runStatus === 'running').length;
  const failedRuns = metricValues.filter(
    (m) => m.runStatus === 'failed' || m.runStatus === 'timed_out' || m.runStatus === 'aborted',
  ).length;
  const successRuns = metricValues.filter((m) => m.runStatus === 'success').length;
  const anyRun = runningRuns + failedRuns + successRuns > 0;
  const statusHint = !anyRun
    ? t('executionOverview.noRunYet')
    : runningRuns > 0
      ? t('executionOverview.statusRunning', { n: runningRuns })
      : failedRuns > 0
        ? t('executionOverview.statusFailed', { n: failedRuns })
        : t('executionOverview.statusAllDone');
  /* "전체 tables" 는 그 project 가 run 에서 처리한 테이블 수 기준 (metric.tablesTotal).
     run 박제가 없으면 project.tableCount (= DDL TO-BE 수) 로 fallback. DDL 에는 5 테이블이
     있어도 mapping 이 3 만 정의돼있고 그 3 만 run 했다면 "3/3" 으로 보여야 자연스럽다. */
  const totalTables = siteProjects.reduce(
    (a, p) => a + (metrics[p.id]?.tablesTotal ?? p.tableCount ?? 0), 0,
  );
  const totalRows = siteProjects.reduce((a, p) => a + (metrics[p.id]?.rows ?? 0), 0);
  const totalTablesDone = siteProjects.reduce((a, p) => a + (metrics[p.id]?.tablesDone ?? 0), 0);
  const totalErrors = siteProjects.reduce((a, p) => a + (metrics[p.id]?.errorCount ?? 0), 0);
  const totalWarnings = siteProjects.reduce((a, p) => a + (metrics[p.id]?.warningCount ?? 0), 0);
  const totalWarningsAcked = siteProjects.reduce((a, p) => a + (metrics[p.id]?.warningAckedCount ?? 0), 0);
  const overallProgressPct = siteProjects.length
    ? siteProjects.reduce((a, p) => a + (metrics[p.id]?.progressPct ?? 0), 0) / siteProjects.length
    : 0;

  return (
    <div>
      {/* KPI row — Phase Mix 없음 */}
      <div style={styles.kpiRow}>
        <Kpi label={t('executionOverview.kpi.projects')} value={`${status.done} / ${siteProjects.length}`} tone="info" />
        <Kpi label={t('executionOverview.kpi.running')}  value={runningRuns} tone={runningRuns > 0 ? 'warn' : undefined} />
        <Kpi label={t('executionOverview.kpi.tables')}   value={`${totalTablesDone} / ${totalTables}`} />
        <Kpi label={t('executionOverview.kpi.rows')}     value={totalRows.toLocaleString()} />
        <Kpi label={t('executionOverview.kpi.errors')}   value={totalErrors}   tone="err" />
        <Kpi label={t('executionOverview.kpi.warnings')} value={totalWarnings > 0 ? `${totalWarningsAcked} / ${totalWarnings}` : 0} tone="warn" />
      </div>

      {/* Overall progress bar */}
      <div style={styles.overallProgressBox}>
        <div style={styles.overallProgressHeader}>
          <span style={styles.overallProgressLabel}>{t('executionOverview.overall')}</span>
          <span style={styles.overallProgressPct}>{overallProgressPct.toFixed(1)}%</span>
          <div style={{ flex: 1 }} />
          <span style={styles.overallProgressDim}>{statusHint}</span>
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
        <span style={styles.toolbarHint}>{statusHint}</span>
        <div style={{ flex: 1 }} />
        {dirtyAssigneeIds.length > 0 && (
          <>
            <button
              onClick={handleDiscardAssignees}
              disabled={savingAssignees}
              style={{ ...styles.btnGhost, ...(savingAssignees ? styles.btnDisabled : {}) }}
            >
              {t('executionOverview.btn.discardAssignees')}
            </button>
            <button
              onClick={handleSaveAssignees}
              disabled={savingAssignees}
              style={{ ...styles.btnPrimary, ...(savingAssignees ? styles.btnDisabled : {}) }}
            >
              {savingAssignees
                ? t('executionOverview.btn.savingAssignees')
                : t('executionOverview.btn.saveAssignees', { n: dirtyAssigneeIds.length })}
            </button>
          </>
        )}
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
                <Checkbox checked={allSelected} onChange={toggleAll} ariaLabel="Select all" />
              </th>
              <Th>{t('executionOverview.col.project')}</Th>
              <Th align="center">{t('executionOverview.col.phase')}</Th>
              <Th width={150}>{t('executionOverview.col.pinned')}</Th>
              <Th align="center">{t('executionOverview.col.username')}</Th>
              <Th align="center" width={70}>{t('executionOverview.col.tables')}</Th>
              <Th align="center" width={80}>{t('executionOverview.col.rows')}</Th>
              <Th align="center" width={260}>{t('executionOverview.col.progress')}</Th>
              <Th align="center" width={64}>{t('executionOverview.col.errors')}</Th>
              <Th align="center" width={76}>{t('executionOverview.col.warnings')}</Th>
            </tr>
          </thead>
          <tbody>
            {filteredProjects.length === 0 ? (
              <tr><td colSpan={10} style={styles.emptyRow}>{t('executionOverview.empty')}</td></tr>
            ) : (
              filteredProjects.map((p, i) => {
                const checked = selected.has(p.id);
                const selectable = isSelectable(p);
                const dimmed = !selectable;
                const rowBg = checked ? 'var(--navy-50)' : i % 2 ? 'var(--zebra)' : 'transparent';
                const dimColor = dimmed ? 'var(--text-4)' : undefined;
                const pipelineStages: Stage[] = buildStagesFromMetric(metrics[p.id], p.phase);
                return (
                  <tr key={p.id} style={{ background: rowBg, borderBottom: '1px solid var(--border)' }}>
                    <td style={{ ...styles.td, paddingLeft: 12 }}>
                      <Checkbox
                        checked={checked}
                        disabled={!selectable}
                        onChange={() => toggleOne(p.id)}
                        title={selectable ? '' : t('executionOverview.notSelectable', { phase: p.phase })}
                        ariaLabel={p.name}
                      />
                    </td>
                    <td style={styles.td}>
                      <span style={{ ...styles.projName, ...(dimColor ? { color: dimColor } : {}) }}>{p.name}</span>
                    </td>
                    <td style={{ ...styles.td, textAlign: 'center' }}>
                      <span style={{ ...styles.phaseChip, ...phaseChipColor(p.phase, metrics[p.id]?.runStatus ?? p.runStatus) }}>{p.phase}</span>
                    </td>
                    <td style={styles.td}>
                      {(() => {
                        const pinned = pinnedByProject[p.id];
                        if (!pinned) {
                          return <span style={styles.pinnedEmpty}>—</span>;
                        }
                        return (
                          <span style={styles.pinnedCell}>
                            <span style={styles.pinnedVersion}>{pinned.version}</span>
                            <span style={styles.pinnedName} title={pinned.name}>{pinned.name}</span>
                          </span>
                        );
                      })()}
                    </td>
                    <td style={{ ...styles.td, textAlign: 'center' }}>
                      {(() => {
                        // dropdown 또는 text 옆에 worker online 상태 dot 한 개 — assignee
                        // 가 잡혀있고 그 사람의 Worker daemon 이 heartbeat 살아있으면 green,
                        // 아니면 red. 미할당은 dot 없음.
                        const effective = assigneeDraft[p.id] !== undefined
                          ? assigneeDraft[p.id]
                          : (p.executionAssignee ?? '');
                        const online = isWorkerOnline(effective || null);
                        const dotTitle = !effective
                          ? ''
                          : online
                            ? t('executionOverview.worker.online', { name: effective })
                            : t('executionOverview.worker.offline', { name: effective });
                        return (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            {effective && (
                              <span
                                title={dotTitle}
                                style={{
                                  width: 7, height: 7, borderRadius: '50%',
                                  background: online ? 'var(--green)' : 'var(--red)',
                                  flexShrink: 0,
                                }}
                              />
                            )}
                            {canEditRow(p) ? (
                              (() => {
                                const isDirty = assigneeDraft[p.id] !== undefined
                                  && (assigneeDraft[p.id] ?? '') !== (p.executionAssignee ?? '');
                                return (
                                  <select
                                    value={effective}
                                    onChange={(e) => setAssigneeDraft((cur) => ({ ...cur, [p.id]: e.target.value }))}
                                    disabled={savingAssignees}
                                    style={{ ...styles.assigneeSelect, ...(isDirty ? styles.assigneeSelectDirty : {}) }}
                                  >
                                    <option value="">— {t('executionOverview.unassigned')} —</option>
                                    {users.map((u) => (
                                      <option key={u.id} value={u.username}>{u.username}</option>
                                    ))}
                                  </select>
                                );
                              })()
                            ) : (
                              <span style={{ ...styles.assigneeText, color: effective ? 'var(--text)' : 'var(--text-4)' }}>
                                {effective || t('executionOverview.unassigned')}
                              </span>
                            )}
                          </span>
                        );
                      })()}
                    </td>
                    <td style={{ ...styles.td, textAlign: 'center', fontFamily: 'var(--mono)' }}>{p.tableCount}</td>
                    <td style={{ ...styles.td, textAlign: 'center', fontFamily: 'var(--mono)', color: (metrics[p.id]?.rows ?? 0) > 0 ? 'var(--text-2)' : 'var(--text-4)' }}>{(metrics[p.id]?.rows ?? 0).toLocaleString()}</td>
                    <td style={{ ...styles.td, textAlign: 'center' }}>
                      <div style={styles.pipelineSlots}>
                        {pipelineStages.map((st) => (
                          <div
                            key={st.id}
                            title={`${st.name} · ${st.pct.toFixed(0)}%`}
                            style={styles.pipelineSlotOuter}
                          >
                            <div
                              style={{
                                ...styles.pipelineSlotInner,
                                width: `${st.pct}%`,
                                background:
                                  st.tone === 'ok'      ? 'var(--text-3)'
                                  : st.tone === 'running' ? 'var(--green)'
                                  : st.tone === 'err'   ? 'var(--red)'
                                  : st.tone === 'warn'  ? 'var(--amber)'
                                  : 'var(--amber)',
                              }}
                            />
                          </div>
                        ))}
                      </div>
                    </td>
                    <td style={{ ...styles.td, textAlign: 'center', fontFamily: 'var(--mono)', color: errorCount(p) > 0 ? 'var(--red)' : 'var(--text-4)' }}>{errorCount(p)}</td>
                    <td style={{ ...styles.td, textAlign: 'center', fontFamily: 'var(--mono)', color: warningCount(p) > 0 ? 'var(--amber)' : 'var(--text-4)' }}>
                      {warningCount(p) > 0 ? `${warningAckedCount(p)} / ${warningCount(p)}` : 0}
                    </td>
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

function Th({ children, align, width }: { children?: React.ReactNode; align?: 'left' | 'right' | 'center'; width?: number }) {
  return (
    <th style={{ ...styles.th, textAlign: align ?? 'left', width }}>{children}</th>
  );
}
function phaseChipColor(phase: string, runStatus?: string): React.CSSProperties {
  const activePhase = phase === 'test' || phase === 'rehearsal' || phase === 'cutover';
  if (activePhase && runStatus !== 'running') {
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
  assigneeSelectDirty: {
    background: 'var(--amber-50)',
    borderColor: 'var(--amber)',
    color: 'var(--amber)',
    fontWeight: 600,
  },
  assigneeText: { fontFamily: 'var(--mono)', fontSize: 11.5 },

  pinnedCell: {
    display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start',
    gap: 3, maxWidth: 140,
  },
  pinnedVersion: {
    fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700,
    color: 'var(--navy)', background: 'var(--navy-50)',
    border: '1px solid var(--navy)', borderRadius: 3, padding: '1px 6px', flexShrink: 0,
  },
  pinnedName: {
    display: 'block', maxWidth: 140,
    fontSize: 11.5, color: 'var(--text-2)',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  pinnedEmpty: { color: 'var(--text-4)', fontFamily: 'var(--mono)', fontSize: 12 },

  progressOuter: {
    width: 140, height: 6, background: 'var(--panel-2)',
    border: '1px solid var(--border)', borderRadius: 3, overflow: 'hidden', display: 'inline-block', verticalAlign: 'middle',
  },
  progressInner: { height: '100%', background: 'var(--navy)' },
  progressLabel: { fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--mono)', marginLeft: 8 },

  pipelineSlots: { display: 'flex', gap: 2, height: 8 },
  pipelineSlotOuter: {
    flex: 1, background: 'var(--border)', borderRadius: 2,
    overflow: 'hidden', position: 'relative',
  },
  pipelineSlotInner: { height: '100%', transition: 'width .4s ease' },
};

/**
 * ProjectExecMetrics(BE per-project 최신 run 집계)을 per-row pipeline Stage[] 로 변환.
 *
 * 優先: BE が返す per-stage の {@code stages} array をそのまま buildStagesFromStageViews
 * に流す — Execution 画面と同じレンダラなので「3 success なのに 2 bar しか塗られない」
 * 桁ずれが原理的に起きない.
 *
 * Fallback: stages が空 (古い BE / run 없음) ならば progressPct ベースの近似に切替.
 * これは旧コードと同じふるまい (success/failed/aborted/running の 4 分岐 + floor()).
 */
function buildStagesFromMetric(metric: ProjectExecMetrics | undefined, fallbackPhase: Project['phase']): Stage[] {
  const base = buildStages(fallbackPhase);
  if (!metric || !metric.runStatus) return base;

  // 優先パス — per-stage 情報あり.
  if (metric.stages && metric.stages.length > 0) {
    return buildStagesFromStageViews(metric.stages);
  }

  // Fallback — progressPct 近似 (run 직전 / BE 旧版 etc.)
  const total = base.length;
  const pct = Math.max(0, Math.min(100, metric.progressPct ?? 0));
  const completed = Math.floor((pct / 100) * total);
  const currentPct = ((pct / 100) * total - completed) * 100;
  const status = metric.runStatus;

  if (status === 'success') {
    return base.map((s) => ({ ...s, pct: 100, tone: 'ok' as StageTone }));
  }
  if (status === 'failed' || status === 'timed_out') {
    return base.map((s, i) => {
      if (i < completed) return { ...s, pct: 100, tone: 'ok' as StageTone };
      if (i === completed) return { ...s, pct: 100, tone: 'err' as StageTone };
      return { ...s, pct: 0, tone: 'idle' as StageTone };
    });
  }
  if (status === 'aborted') {
    return base.map((s, i) => ({
      ...s, pct: i < completed ? 100 : 0,
      tone: (i < completed ? 'ok' : 'idle') as StageTone,
    }));
  }
  // running / paused / pending
  return base.map((s, i) => {
    if (i < completed) return { ...s, pct: 100, tone: 'ok' as StageTone };
    if (i === completed) return { ...s, pct: currentPct, tone: 'running' as StageTone };
    return { ...s, pct: 0, tone: 'idle' as StageTone };
  });
}
