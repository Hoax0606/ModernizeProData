import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useWorkspaceStore } from '../store/workspace';
import type { Project, ProjectPhase, ProjectEnvironment, Site } from '../store/workspace';
import { useTobeDdlStore } from '../store/tobeDdl';
import { useAsisDdlStore } from '../store/asisDdl';
import { useAuthStore } from '../store/auth';
import { useSnapshotsStore, usePinnedSnapshotsStore, type MappingSnapshot } from '../store/snapshots';
import {
  useExecutionPreflightStore,
  type PreflightCheck,
  type PreflightPhase,
  type ActiveRunState,
} from '../store/executionPreflight';
import { runPreflight, isAllPass, type TableCheckResult } from '../lib/preflightValidation';
import { tobeDbApi } from '../api/tobeDb';
import { PreflightResultPanel } from '../components/PreflightResultPanel';
import { useDemoMode, type DemoMode } from '../lib/useDemoMode';
import {
  STAGE_MS,
  TOTAL_STAGES,
  TOTAL_RUN_MS,
  BASE_STAGES,
  buildStages,
  buildStagesFromActiveRun,
  computeElapsedMs,
  type Stage,
  type StageTone,
} from '../lib/pipelineStages';
import { useT, type TranslationKey } from '../i18n';

type T = (key: TranslationKey, vars?: Record<string, string | number>) => string;

type RunMode = 'test' | 'rehearsal' | 'cutover';
type RunResult = 'ok' | 'warn' | 'failed' | 'aborted' | 'running';
type RunScope = 'all' | 'failed-only';
type BadgeTone = 'ok' | 'running' | 'queued' | 'err' | 'warn' | 'info';

interface Run {
  id: string;
  mode: 'rehearsal' | 'cutover';
  scope: RunScope;
  scopeLabel?: string;
  startedAt: string;
  elapsed: string;
  eta?: string;
  result: RunResult;
  quarantineCount?: number;
  triggeredBy: { actor: string; source?: string };
}

/**
 * Execution tab — run controls, pre-flight, progress, pipeline stages, run history.
 * Quarantine and Worker-pool panels are intentionally omitted (gated to later iterations).
 */
export function ExecutionPage() {
  const t = useT();
  const projects = useWorkspaceStore((s) => s.projects);
  const sites = useWorkspaceStore((s) => s.sites);
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const project = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId],
  );
  const site = useMemo(
    () => project ? sites.find((s) => s.id === project.siteId) ?? null : null,
    [sites, project],
  );

  const { isDemo, demoMode, exitDemo } = useDemoMode();
  const user = useAuthStore((s) => s.user);

  /* activeRun (frontend mock simulation) */
  const storeActiveRun: ActiveRunState | null = useExecutionPreflightStore(
    (s) => (project ? s.byProject[project.id]?.activeRun : null) ?? null,
  );
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!storeActiveRun) return;
    if (storeActiveRun.runStatus !== 'running') return;
    if (storeActiveRun.pausedAt !== null) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 250);
    return () => window.clearInterval(id);
  }, [storeActiveRun?.runId, storeActiveRun?.pausedAt, storeActiveRun?.runStatus]);

  const projectId = project?.id ?? null;
  useEffect(() => {
    if (!projectId || !storeActiveRun) return;
    if (storeActiveRun.runStatus !== 'running') return;
    if (computeElapsedMs(storeActiveRun) >= TOTAL_RUN_MS) {
      useExecutionPreflightStore.getState().finishActiveRun(projectId);
      useWorkspaceStore.getState().setProjectRunStatus(projectId, 'completed').catch(() => { /* mock; ignore */ });
    }
  }, [tick, storeActiveRun, projectId]);

  /* TO-BE / AS-IS DDL schemas — used for table selector + preflight validation. */
  const tobeSchema = useTobeDdlStore((s) => project ? s.schemasByProject[project.id] : undefined);
  const asisSchema = useAsisDdlStore((s) => project ? s.schemasByProject[project.id] : undefined);
  const fetchTobeDdl = useTobeDdlStore((s) => s.fetch);
  const fetchAsisDdl = useAsisDdlStore((s) => s.fetch);
  useEffect(() => {
    if (!project) return;
    if (!tobeSchema) fetchTobeDdl(project.id).catch(() => { /* DDL 미등록 */ });
    if (!asisSchema) fetchAsisDdl(project.id).catch(() => { /* DDL 미등록 */ });
  }, [project?.id, tobeSchema, asisSchema, fetchTobeDdl, fetchAsisDdl]);
  const tobeTables = tobeSchema?.tables.map((tc) => tc.table.physicalName) ?? [];

  /* Snapshots + pin. Pin is per-project — at most one snapshot per project. */
  const snapshots = useSnapshotsStore((s) => s.snapshots);
  const pinnedIds = usePinnedSnapshotsStore((s) => s.pinnedIds);
  const fetchSnapshots = useSnapshotsStore((s) => s.fetchByProject);
  useEffect(() => {
    if (!project) return;
    void fetchSnapshots(project.id);
  }, [project?.id, fetchSnapshots]);
  const projectSnapshots = useMemo(
    () => project ? snapshots.filter((s) => s.projectId === project.id) : [],
    [snapshots, project],
  );
  const pinnedSnapshot = useMemo(
    () => projectSnapshots.find((s) => pinnedIds.includes(s.id)) ?? null,
    [projectSnapshots, pinnedIds],
  );

  /* Demo 모드 stale flag 시연 */
  const [demoStale, setDemoStale] = useState(false);
  useEffect(() => {
    setDemoStale(false);
  }, [isDemo, demoMode, project?.id]);

  /* Demo 진입 시 fixture 의 모든 TO-BE 테이블 자동 선택 */
  useEffect(() => {
    if (!isDemo || !project) return;
    const store = useExecutionPreflightStore.getState();
    const entry = store.byProject[project.id];
    if ((entry?.selectedTables.length ?? 0) === 0 && tobeTables.length > 0) {
      store.setSelected(project.id, tobeTables);
    }
  }, [isDemo, project?.id, tobeTables.length]);

  const entrySelected = useExecutionPreflightStore((s) => project ? s.byProject[project.id]?.selectedTables : undefined);
  const entryPhase    = useExecutionPreflightStore((s) => project ? s.byProject[project.id]?.preflightPhase : undefined);
  const entryStale    = useExecutionPreflightStore((s) => project ? s.byProject[project.id]?.isStale : undefined);
  /* pin 단위 결과 캐시. pin 이 바뀌면 표시도 자동으로 그 pin 의 結果로 切替. */
  const entryBySnapshot = useExecutionPreflightStore((s) => project ? s.byProject[project.id]?.bySnapshot : undefined);
  const selectedTables = useMemo(() => new Set(entrySelected ?? []), [entrySelected]);
  const preflightPhase: PreflightPhase = entryPhase ?? 'idle';
  const isStale: boolean = entryStale ?? false;

  const setSelectedTables = (next: Set<string>) => {
    if (!project) return;
    useExecutionPreflightStore.getState().setSelected(project.id, [...next]);
    if (isDemo) setDemoStale(true);
  };

  /* mount 시 stuck 'checking' 검출 → idle 복구. 이전 실행이 throw 했거나 navigate 로
     interrupt 된 상태로부터의 escape hatch.  반드시 early return 보다 위에 두어
     hooks 호출 순서를 安定시킨다 (이전 버그: f5 새로고침 시 hooks count mismatch). */
  const projectIdForReset = project?.id;
  useEffect(() => {
    if (!projectIdForReset) return;
    const cur = useExecutionPreflightStore.getState();
    if (cur.byProject[projectIdForReset]?.preflightPhase === 'checking') {
      cur.setPhase(projectIdForReset, 'idle');
    }
  }, [projectIdForReset]);

  if (!project || !site) {
    return (
      <div style={styles.empty}>
        <div style={styles.emptyTitle}>{t('execution.empty.noProject')}</div>
      </div>
    );
  }

  const hasPinnedSnapshot = !!pinnedSnapshot;
  const runMode = deriveRunMode(project.phase, site.environment);

  /* selection / pin 변경 → snapshot 결과 캐시 / store 결과 모두 stale 화 (UX 명료성). */

  const startPreflight = async () => {
    if (isDemo) {
      setDemoStale(false);
      return;
    }
    if (!project || !site || !pinnedSnapshot) return;
    if (selectedTables.size === 0 || preflightPhase === 'checking') return;

    const store = useExecutionPreflightStore.getState();
    store.setPhase(project.id, 'checking');
    /* 이 pin 에 대한 cache 를 初期化 (선택 테이블 / 빈 results) — 演出 중 incremental
       append 가 이 base 에 上書きされる. */
    const tablesList = [...selectedTables];
    store.setSnapshotResult(project.id, pinnedSnapshot.id, {
      runAt: Date.now(),
      selectedTables: tablesList,
      results: [],
    });

    try {
      const snapshotData = await useSnapshotsStore.getState().ensureSnapshotData(pinnedSnapshot.id);

      /* TO-BE DB 接続テストを live で実行. host/username 等が空なら test 自体スキップ —
         runPreflight 側 (checkConnTobe) が「設定不足」として fail を出す. */
      const env = site.environment;
      const conn = site.tobeDbByEnv?.[env];
      let tobeDbReachable: { success: boolean; message: string } | null = null;
      if (conn && conn.host?.trim() && conn.database?.trim() && conn.username?.trim()) {
        try {
          const r = await tobeDbApi.testConnection(site.id, {
            dbType: conn.type, host: conn.host, port: conn.port,
            database: conn.database, username: conn.username, password: conn.password,
          });
          tobeDbReachable = { success: r.success, message: r.message };
        } catch (e) {
          tobeDbReachable = {
            success: false,
            message: e instanceof Error ? e.message : 'request failed',
          };
        }
      }

      const results = runPreflight({
        project, site, tobeSchema, asisSchema, snapshotData,
        selectedTables: tablesList,
        t,
        tobeDbReachable,
      });
      /* 결과를 400ms 간격으로 bySnapshot[pinnedId].results 에 incremental append.
         setTimeout は이미 종료된 mount 후에도 발화하지만 store 가 살아있어 무해. */
      results.forEach((check, i) => {
        window.setTimeout(() => {
          const cur = useExecutionPreflightStore.getState();
          cur.appendSnapshotResultCheck(project.id, pinnedSnapshot.id, check);
          if (i === results.length - 1) {
            cur.setPhase(project.id, 'done');
          }
        }, (i + 1) * 400);
      });
    } catch (e) {
      /* ensureSnapshotData / runPreflight 가 throw 했을 때 phase 가 'checking' 에 영구
         lock 되지 않도록 idle 로 강제 reset. cache 도 비워둠. console 에 reason 남김. */
      console.error('[execution] preflight failed:', e);
      store.setPhase(project.id, 'idle');
      store.clearSnapshotResult(project.id, pinnedSnapshot.id);
    }
  };

  /* 현재 pin 된 snapshot 의 cached 결과를 표시 source 로 사용.
     - pin 切替 → 表示も自動的に切替 (그 snapshot 用 cache がなければ empty)
     - 동일 snapshot 으로 다시 돌리면 results が逐次 append 되어 演出 진행 */
  const pinnedResult = (pinnedSnapshot && entryBySnapshot) ? entryBySnapshot[pinnedSnapshot.id] : undefined;
  const cachedResults: PreflightCheck[] = pinnedResult?.results ?? [];

  /* Demo 모드: trigger 없이 즉시 결과 표시. 8 fail / 8 pass 분기. */
  const displayedResults = demoMode === 'run-fail'
    ? buildDemoPreflightPassChecks(t)
    : demoMode === 'preflight'
      ? buildDemoPreflightChecks(t)
      : cachedResults;
  /* phase 派生: checking 中なら checking、cache に結果 있으면 done、그 외 idle */
  const displayedPhase: PreflightPhase = isDemo
    ? 'done'
    : preflightPhase === 'checking'
      ? 'checking'
      : cachedResults.length > 0
        ? 'done'
        : 'idle';
  const displayedStale = isDemo ? demoStale : isStale;
  const preflightPassed = displayedPhase === 'done'
    && !displayedStale
    && isAllPass(displayedResults);

  const stages = storeActiveRun
    ? buildStagesFromActiveRun(storeActiveRun, TOTAL_RUN_MS)
    : buildStages(project.phase);
  const runs = buildRuns(project);

  const controlsLocked = storeActiveRun !== null || !hasPinnedSnapshot;

  const handleStartRun = () => {
    if (!preflightPassed || selectedTables.size === 0) return;
    if (!hasPinnedSnapshot || !pinnedSnapshot) return;
    if (!runMode) return;
    const current = useExecutionPreflightStore.getState().byProject[project.id]?.activeRun;
    if (current && current.runStatus !== 'running') {
      useExecutionPreflightStore.getState().clearActiveRun(project.id);
    } else if (current && current.runStatus === 'running') {
      return;
    }
    const tables = Array.from(selectedTables);
    useExecutionPreflightStore.getState().startActiveRun(project.id, tables);
    /* phase / runStatus 갱신.
       run 起動による phase 自動進行は forward-only — 既に test 以降の phase に
       いる時に planning 측 'test' run を起동해도 phase を巻き戻さない. */
    if (runMode === 'cutover') {
      useWorkspaceStore.getState().startCutover(project.id, pinnedSnapshot.id, user?.username ?? 'Admin')
        .catch(() => { /* mock; ignore */ });
    } else {
      const targetPhase: ProjectPhase = runMode === 'rehearsal' ? 'rehearsal' : 'test';
      if (phaseOrder(project.phase) < phaseOrder(targetPhase)) {
        useWorkspaceStore.getState().setProjectPhase(project.id, targetPhase).catch(() => { /* mock */ });
      }
      useWorkspaceStore.getState().setProjectRunStatus(project.id, 'running').catch(() => { /* mock */ });
    }
  };

  const handlePauseToggle = () => {
    if (!storeActiveRun) return;
    if (storeActiveRun.pausedAt === null) {
      useExecutionPreflightStore.getState().pauseActiveRun(project.id);
      useWorkspaceStore.getState().setProjectRunStatus(project.id, 'paused').catch(() => { /* mock */ });
    } else {
      useExecutionPreflightStore.getState().resumeActiveRun(project.id);
      useWorkspaceStore.getState().setProjectRunStatus(project.id, 'running').catch(() => { /* mock */ });
    }
  };

  const handleTriggerFail = () => {
    if (!storeActiveRun || storeActiveRun.runStatus !== 'running') return;
    const elapsed = computeElapsedMs(storeActiveRun);
    const stageIndex = Math.min(Math.floor(elapsed / STAGE_MS), TOTAL_STAGES - 1);
    const stageName = BASE_STAGES[stageIndex]?.name ?? '?';
    const reason = `Demo: ${stageName} 단계에서 PK 위반 3건 — accounts.account_id`;
    useExecutionPreflightStore.getState().failActiveRun(project.id, stageIndex, reason);
    useWorkspaceStore.getState().setProjectRunStatus(project.id, 'failed').catch(() => { /* mock */ });
  };

  const handleRetry = () => {
    useExecutionPreflightStore.getState().retryActiveRun(project.id, STAGE_MS);
    useWorkspaceStore.getState().setProjectRunStatus(project.id, 'running').catch(() => { /* mock */ });
  };

  const handleDiscard = () => {
    useExecutionPreflightStore.getState().clearActiveRun(project.id);
    useWorkspaceStore.getState().setProjectRunStatus(project.id, 'idle').catch(() => { /* mock */ });
  };

  const handleStopRun = () => {
    if (!storeActiveRun || storeActiveRun.runStatus !== 'running') return;
    const elapsed = computeElapsedMs(storeActiveRun);
    const stageIndex = Math.min(Math.floor(elapsed / STAGE_MS), TOTAL_STAGES - 1);
    const reason = t('execution.run.abortReason');
    useExecutionPreflightStore.getState().abortActiveRun(project.id, stageIndex, reason);
    useWorkspaceStore.getState().setProjectRunStatus(project.id, 'aborted').catch(() => { /* mock */ });
  };

  const handleExitDemo = () => {
    if (project) useExecutionPreflightStore.getState().clearActiveRun(project.id);
    exitDemo();
  };

  return (
    <div style={styles.page}>
      <RunHeader
        t={t}
        project={project}
        site={site}
        runMode={runMode}
        activeRun={storeActiveRun}
        runs={runs}
        preflightPassed={preflightPassed}
        hasPinnedSnapshot={hasPinnedSnapshot}
        selectedTablesCount={selectedTables.size}
        isDemo={isDemo}
        onStart={handleStartRun}
        onPauseToggle={handlePauseToggle}
        onStop={handleStopRun}
        onTriggerFail={handleTriggerFail}
        onRetry={handleRetry}
        onDiscard={handleDiscard}
      />
      <DisabledOverlay disabled={controlsLocked}>
        <TableSelector
          t={t}
          tables={tobeTables}
          selected={selectedTables}
          onChange={setSelectedTables}
        />
        <SnapshotDisplay t={t} pinned={pinnedSnapshot} />
        <PreflightPanel
          t={t}
          checks={displayedResults}
          phase={displayedPhase}
          isStale={displayedStale}
          canStart={selectedTables.size > 0 && hasPinnedSnapshot}
          startDisabledReason={!hasPinnedSnapshot ? t('execution.preflight.trigger.disabledNoPin') : t('execution.preflight.trigger.disabled')}
          onStart={startPreflight}
          onReset={() => useExecutionPreflightStore.getState().resetForProject(project.id)}
          isDemo={isDemo}
          demoMode={demoMode}
          onExitDemo={handleExitDemo}
        />
      </DisabledOverlay>
      <OverallProgress t={t} stages={stages} />
      <PipelineStages t={t} stages={stages} />
    </div>
  );
}

/* ───────────────────────── Disabled overlay ─────────────────────── */

function DisabledOverlay({ disabled, children }: { disabled: boolean; children: React.ReactNode }) {
  return (
    <div style={disabled ? { pointerEvents: 'none', opacity: 0.55, filter: 'saturate(0.7)' } : undefined}>
      {children}
    </div>
  );
}

/* ───────────────────────── Run header ──────────────────────────── */

function RunHeader({
  t, project, site, runMode, activeRun, runs, preflightPassed, hasPinnedSnapshot,
  selectedTablesCount, isDemo, onStart, onPauseToggle, onStop, onTriggerFail, onRetry, onDiscard,
}: {
  t: T;
  project: Project;
  site: Site;
  runMode: RunMode | null;
  activeRun: ActiveRunState | null;
  runs: Run[];
  preflightPassed: boolean;
  hasPinnedSnapshot: boolean;
  selectedTablesCount: number;
  isDemo: boolean;
  onStart: () => void;
  onPauseToggle: () => void;
  onStop: () => void;
  onTriggerFail: () => void;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  const canStart = preflightPassed && selectedTablesCount > 0 && hasPinnedSnapshot && runMode !== null;
  const isDone = project.phase === 'done';

  const startTooltip = !hasPinnedSnapshot
    ? t('execution.run.startBlocked.noPin')
    : !runMode
      ? t('execution.run.startBlocked.phaseEnv', { phase: project.phase, env: site.environment })
      : !preflightPassed
        ? t('execution.run.startBlockedHint')
        : t('execution.run.startReadyHint');

  if (!activeRun) {
    const lastRun = runs[0] ?? null;
    return (
      <section style={styles.runHeader}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={styles.runHeaderLabel}>{t('execution.run.noActive')}</div>
          <div style={styles.runHeaderMono}>
            {lastRun
              ? t('execution.run.lastRun', { id: lastRun.id, when: lastRun.startedAt, result: lastRun.result })
              : t('execution.run.noHistory')}
          </div>
        </div>
        {!isDone && (
          <button
            type="button"
            onClick={() => { if (canStart) onStart(); }}
            disabled={!canStart}
            title={startTooltip}
            style={canStart ? styles.btnPrimary : styles.btnDisabled}
          >
            ▶ {runMode === 'cutover' ? t('execution.run.startBtn.cutover') : runMode === 'rehearsal' ? t('execution.run.startBtn.rehearsal') : t('execution.run.startBtn')}
          </button>
        )}
      </section>
    );
  }

  const isPaused = activeRun.pausedAt !== null;
  const isCompleted = activeRun.runStatus === 'completed';
  const isFailed = activeRun.runStatus === 'failed';
  const isAborted = activeRun.runStatus === 'aborted';
  const isHalted = isCompleted || isFailed || isAborted;
  const running = activeRun.runStatus === 'running' && !isPaused;
  const elapsedMs = computeElapsedMs(activeRun);
  const totalMs = STAGE_MS * BASE_STAGES.length;
  const remainingMs = Math.max(0, totalMs - elapsedMs);
  const elapsedLabel = isHalted
    ? t('execution.run.elapsed', {
        time: formatTimeOfDay(activeRun.startedAt),
        elapsed: formatDuration(elapsedMs),
      })
    : t('execution.run.elapsedEta', {
        time: formatTimeOfDay(activeRun.startedAt),
        elapsed: formatDuration(elapsedMs),
        eta: formatDuration(remainingMs),
      });

  const statusChipTone: BadgeTone =
    isFailed ? 'err'
    : isAborted ? 'warn'
    : isCompleted ? 'queued'
    : running ? 'ok'
    : 'warn';
  const statusChipText =
    isFailed ? t('execution.run.status.failed')
    : isAborted ? t('execution.run.status.aborted')
    : isCompleted ? t('execution.run.status.completed')
    : running ? t('execution.run.status.running')
    : t('execution.run.status.paused');

  const failedStageName = activeRun.failedStageIndex != null
    ? BASE_STAGES[activeRun.failedStageIndex]?.name ?? '?'
    : '?';
  const showBanner = (isFailed || isAborted) && !!activeRun.failureReason;

  return (
    <>
      <section style={styles.runHeader}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={styles.runHeaderLabel}>{t('execution.run.active')}</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 16, fontWeight: 600 }}>{activeRun.runId}</span>
            <StatusBadge tone={statusChipTone}>{statusChipText}</StatusBadge>
            <span style={{ fontSize: 12, color: 'var(--text-3)', fontFamily: 'var(--mono)' }}>{elapsedLabel}</span>
          </div>
          <div style={{ fontSize: 10.5, color: 'var(--text-3)', fontFamily: 'var(--mono)', marginTop: 3 }}>
            {t('execution.run.triggeredBy')}{' '}
            <b style={{ color: 'var(--text-2)' }}>{project.executionAssignee ?? project.owner ?? 'Admin'}</b>
            <span> · {t('execution.run.tablesSummary', { n: activeRun.selectedTables.length })}</span>
          </div>
        </div>
        {isDemo && running && (
          <button type="button" onClick={onTriggerFail} style={styles.btnGhost} title={t('execution.run.demo.triggerFail')}>
            {t('execution.run.demo.triggerFail')}
          </button>
        )}
        {isHalted && (
          <button
            type="button"
            onClick={onDiscard}
            style={{ ...styles.btnDanger, padding: '6px 14px', minWidth: 80 }}
            title={t('execution.run.discardHint')}
          >
            {t('execution.run.discard')}
          </button>
        )}
        {(isFailed || isAborted) && (
          <button
            type="button"
            onClick={onRetry}
            style={{ ...styles.btnPrimary, minWidth: 80 }}
            title={t('execution.run.retryHint')}
          >
            ↻ {t('execution.run.retry')}
          </button>
        )}
        {isHalted && (
          <button
            type="button"
            onClick={() => { if (canStart) onStart(); }}
            disabled={!canStart}
            style={canStart ? { ...styles.btnPrimary, minWidth: 80 } : { ...styles.btnDisabled, minWidth: 80 }}
            title={startTooltip}
          >
            ▶ {t('execution.run.startOver')}
          </button>
        )}
        {!isHalted && (
          <>
            <button type="button" onClick={onPauseToggle} style={styles.btnSecondary}>
              {running ? `⏸ ${t('execution.run.pause')}` : `▶ ${t('execution.run.resume')}`}
            </button>
            <button type="button" onClick={onStop} style={styles.btnDanger}>
              ⏹ {t('execution.run.stop')}
            </button>
          </>
        )}
      </section>
      {showBanner && (
        <div style={isAborted ? styles.warnBanner : styles.errorBanner}>
          <span style={{ fontSize: 14 }}>{isAborted ? '⏹' : '❌'}</span>
          <span>
            {t('execution.run.errorBanner', {
              stage: (activeRun.failedStageIndex ?? 0) + 1,
              name: failedStageName,
              reason: activeRun.failureReason ?? '',
            })}
          </span>
        </div>
      )}
    </>
  );
}

/* ───────────────────────── Table selector ─────────────────────── */

function TableSelector({
  t, tables, selected, onChange,
}: {
  t: T;
  tables: string[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const [open, setOpen] = useState(true);

  if (tables.length === 0) {
    return (
      <div style={{ ...styles.section, background: 'var(--panel)' }}>
        <div style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={styles.sectionLabel}>{t('execution.preflight.tableSelector.title')}</span>
          <span style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--mono)' }}>
            {t('execution.preflight.tableSelector.noDdl')}
          </span>
        </div>
      </div>
    );
  }

  const allChecked = selected.size === tables.length;
  const noneChecked = selected.size === 0;
  const toggleAll = () => {
    if (allChecked) onChange(new Set());
    else onChange(new Set(tables));
  };
  const toggleOne = (name: string) => {
    const next = new Set(selected);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    onChange(next);
  };

  return (
    <div style={{ ...styles.section, background: 'var(--panel)' }}>
      <div onClick={() => setOpen((v) => !v)} style={styles.sectionToggle}>
        <span style={styles.chev}>{open ? '▾' : '▸'}</span>
        <span style={styles.sectionLabel}>{t('execution.preflight.tableSelector.title')}</span>
        <span style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--mono)' }}>
          {t('execution.preflight.tableSelector.selectedCount', { n: selected.size, total: tables.length })}
        </span>
        <div style={{ flex: 1 }} />
      </div>
      {open && (
        <div style={{ padding: '4px 18px 14px' }}>
          <div style={{ border: '1px solid var(--border)', borderRadius: 4, background: 'var(--panel)', overflow: 'hidden' }}>
            <label
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '8px 14px',
                borderBottom: '1px solid var(--border)',
                background: 'var(--panel-2)',
                cursor: 'pointer', fontSize: 12, fontWeight: 600,
              }}
            >
              <input
                type="checkbox"
                checked={allChecked}
                ref={(el) => { if (el) el.indeterminate = !noneChecked && !allChecked; }}
                onChange={toggleAll}
              />
              {t('execution.preflight.tableSelector.selectAll')}
            </label>
            <div style={{ maxHeight: 220, overflowY: 'auto' }}>
              {tables.map((name) => (
                <label
                  key={name}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '6px 14px',
                    borderBottom: '1px solid var(--border)',
                    cursor: 'pointer', fontSize: 12, fontFamily: 'var(--mono)',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(name)}
                    onChange={() => toggleOne(name)}
                  />
                  {name}
                </label>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── Snapshot display (read-only) ────────── */

function SnapshotDisplay({ t, pinned }: { t: T; pinned: MappingSnapshot | null }) {
  const label = pinned
    ? t('execution.snapshot.value', { name: pinned.name, version: pinned.version, status: pinned.status })
    : t('execution.snapshot.empty');
  return (
    <div style={{ ...styles.section, background: pinned ? 'var(--panel)' : 'var(--amber-50)' }}>
      <div style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={styles.sectionLabel}>{t('execution.snapshot.title')}</span>
        <span style={{ fontSize: 11, color: pinned ? 'var(--text-2)' : 'var(--amber)', fontFamily: 'var(--mono)', fontWeight: pinned ? 400 : 600 }}>
          {label}
        </span>
      </div>
    </div>
  );
}

/* ───────────────────────── Pre-flight panel ────────────────────── */

function PreflightPanel({
  t, checks, phase, isStale, canStart, startDisabledReason, onStart, onReset, isDemo, demoMode, onExitDemo,
}: {
  t: T;
  checks: PreflightCheck[];
  phase: PreflightPhase;
  isStale: boolean;
  canStart: boolean;
  startDisabledReason: string;
  onStart: () => void;
  onReset: () => void;
  isDemo?: boolean;
  demoMode?: DemoMode | null;
  onExitDemo?: () => void;
}) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const counts = countResults(checks);
  const hasBlocking = counts.fail > 0;
  const isChecking = phase === 'checking';
  const isDone = phase === 'done';
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (isChecking || hasBlocking) setOpen(true);
  }, [isChecking, hasBlocking]);

  const search = demoMode ? `?demo=${demoMode}` : '';
  const handleFix = (c: PreflightCheck, table?: string) => {
    switch (c.id) {
      case 'csv-arrived':
      case 'conn-tobe': {
        const next = new URLSearchParams(searchParams);
        next.set('siteSettings', c.id === 'csv-arrived' ? 'csv' : 'tobe-db');
        setSearchParams(next);
        return;
      }
      case 'ddl-asis':
        navigate({ pathname: '/settings', search }, { state: { highlightSide: 'asis' } });
        return;
      case 'ddl-tobe':
        navigate({ pathname: '/settings', search }, { state: { highlightSide: 'tobe' } });
        return;
      case 'tobe-bindings':
        navigate({ pathname: '/mapping', search }, { state: { fixTarget: { kind: 'unbound-tobe', table } } });
        return;
      case 'unmapped-cols':
        navigate({ pathname: '/mapping', search }, { state: { fixTarget: { kind: 'unmapped-tobe', table } } });
        return;
      case 'asis-unmapped':
        navigate({ pathname: '/mapping', search }, { state: { fixTarget: { kind: 'unmapped-asis', table } } });
        return;
    }
  };

  const showStale = isStale && isDone;
  const bg = hasBlocking ? 'var(--red-50)' : showStale ? 'var(--amber-50)' : 'var(--panel)';
  const headColor = hasBlocking ? 'var(--red)' : showStale ? 'var(--amber)' : 'var(--text-2)';
  const hint = isChecking
    ? t('execution.preflight.checking')
    : showStale ? t('execution.preflight.hint.stale')
    : hasBlocking ? t('execution.preflight.hint.blocked')
    : isDone ? t('execution.preflight.hint.allPass')
    : t('execution.preflight.hint.idle');

  return (
    <div style={{ ...styles.section, background: bg }}>
      <div onClick={() => setOpen((v) => !v)} style={styles.sectionToggle}>
        <span style={styles.chev}>{open ? '▾' : '▸'}</span>
        <span style={{ ...styles.sectionLabel, color: headColor }}>{t('execution.preflight.title')}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          {counts.pass > 0 && <StatusBadge tone="ok">{t('execution.preflight.count.pass', { n: counts.pass })}</StatusBadge>}
          {counts.fail > 0 && <StatusBadge tone="err">{t('execution.preflight.count.fail', { n: counts.fail })}</StatusBadge>}
          {counts.skip > 0 && <StatusBadge tone="queued">{t('execution.preflight.count.skip', { n: counts.skip })}</StatusBadge>}
        </div>
        {isDemo && (
          <span
            onClick={(e) => { e.stopPropagation(); onExitDemo?.(); }}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '2px 8px', marginLeft: 6,
              fontSize: 10, fontWeight: 700, fontFamily: 'var(--mono)',
              background: 'var(--navy-50)', color: 'var(--navy)',
              border: '1px solid var(--navy)', borderRadius: 2,
              letterSpacing: 0.4, textTransform: 'uppercase', cursor: 'pointer',
            }}
            title={t('execution.preflight.demo.exit')}
          >
            {t('execution.preflight.demo.indicator')}
            <span style={{ fontSize: 10 }}>✕</span>
          </span>
        )}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--mono)' }}>{hint}</span>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onStart(); }}
          disabled={!canStart || isChecking}
          title={canStart ? t('execution.preflight.trigger.start') : startDisabledReason}
          style={canStart && !isChecking ? styles.btnPrimary : styles.btnDisabled}
        >
          ▶ {t('execution.preflight.trigger.start')}
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onReset(); }}
          title={t('execution.preflight.trigger.reset')}
          style={styles.btnGhost}
        >
          ↺ {t('execution.preflight.trigger.reset')}
        </button>
      </div>

      {open && (
        <div style={{ padding: '4px 18px 14px' }}>
          {showStale && (
            <div style={styles.staleBanner}>
              <span style={{ fontSize: 14 }}>⚠</span>
              <div>
                <div style={{ fontWeight: 600 }}>{t('execution.preflight.stale.title')}</div>
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2, fontFamily: 'var(--mono)' }}>
                  {t('execution.preflight.stale.detail')}
                </div>
              </div>
            </div>
          )}
          <PreflightResultPanel
            checks={checks}
            onFix={handleFix}
            emptyText={isChecking ? t('execution.preflight.checking') : t('execution.preflight.empty')}
          />
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── Overall progress ────────────────────── */

function OverallProgress({ t, stages }: { t: T; stages: Stage[] }) {
  const overall = stages.length > 0 ? stages.reduce((a, x) => a + x.pct, 0) / stages.length : 0;
  const done = stages.filter((s) => s.tone === 'ok').length;
  return (
    <div style={{ ...styles.section, background: 'var(--panel)' }}>
      <div style={{ padding: '14px 18px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
          <div style={styles.sectionLabel}>{t('execution.progress.title')}</div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-2)' }}>
            {t('execution.progress.summary', { pct: overall.toFixed(1), done, total: stages.length })}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 2, height: 8, borderRadius: 2, overflow: 'hidden' }}>
          {stages.map((st) => (
            <div key={st.id} title={`${st.name} · ${st.pct.toFixed(0)}%`}
              style={{ flex: 1, background: 'var(--border)', position: 'relative', overflow: 'hidden' }}>
              <div style={{
                width: `${st.pct}%`, height: '100%',
                background:
                  st.tone === 'ok' ? 'var(--text-3)'
                  : st.tone === 'running' ? 'var(--green)'
                  : st.tone === 'err' ? 'var(--red)'
                  : 'var(--amber)',
                transition: 'width .4s ease',
              }} />
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 2, marginTop: 4 }}>
          {stages.map((st) => (
            <div key={st.id} style={{ flex: 1, textAlign: 'center', fontSize: 10, color: 'var(--text-3)', fontFamily: 'var(--mono)' }}>
              {st.shortName ?? st.name.toLowerCase().split(' ')[0]}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── Pipeline stages ─────────────────────── */

function PipelineStages({ t, stages }: { t: T; stages: Stage[] }) {
  return (
    <div style={{ ...styles.section, background: 'var(--panel)' }}>
      <div style={{ padding: '14px 18px' }}>
        <div style={{ ...styles.sectionLabel, marginBottom: 8 }}>{t('execution.stages.title')}</div>
        <div style={{ border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden', background: 'var(--panel)' }}>
          {stages.map((st, i) => (
            <div
              key={st.id}
              style={{
                display: 'grid',
                gridTemplateColumns: '24px 170px 1fr 80px 90px 80px',
                gap: 14, alignItems: 'center',
                padding: '10px 14px',
                borderBottom: i < stages.length - 1 ? '1px solid var(--border)' : 'none',
                background:
                  st.tone === 'running' ? 'var(--green-50)'
                  : st.tone === 'idle' ? 'var(--amber-50)'
                  : st.tone === 'err' ? 'var(--red-50)'
                  : 'var(--panel)',
              }}
            >
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-4)' }}>{String(i + 1).padStart(2, '0')}</div>
              <div>
                <div style={{ fontWeight: 500, fontSize: 13 }}>{st.name}</div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-3)' }}>{st.sub}</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <ProgressBar pct={st.pct} tone={st.tone} />
                <div style={{ width: 44, textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-2)' }}>{st.pct.toFixed(0)}%</div>
              </div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--text-2)' }}>{st.rate}</div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--text-3)' }}>{t('execution.stages.etaPrefix')} {st.eta}</div>
              <div>
                {st.tone === 'ok' && <StatusBadge tone="queued">{t('execution.stages.status.done')}</StatusBadge>}
                {st.tone === 'running' && <StatusBadge tone="ok">{t('execution.stages.status.live')}</StatusBadge>}
                {st.tone === 'err' && <StatusBadge tone="err">{t('execution.stages.status.failed')}</StatusBadge>}
                {st.tone === 'idle' && <StatusBadge tone="running">{t('execution.stages.status.queued')}</StatusBadge>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── Shared atoms ────────────────────────── */

function StatusBadge({ tone, children }: { tone: BadgeTone; children: React.ReactNode }) {
  const palette: Record<BadgeTone, { bg: string; fg: string; bd: string }> = {
    ok:      { bg: 'var(--green-50)',  fg: 'var(--green)',  bd: 'var(--green)' },
    running: { bg: 'var(--amber-50)',  fg: 'var(--amber)',  bd: 'var(--amber)' },
    queued:  { bg: 'var(--panel-2)',   fg: 'var(--text-3)', bd: 'var(--border-strong)' },
    err:     { bg: 'var(--red-50)',    fg: 'var(--red)',    bd: 'var(--red)' },
    warn:    { bg: 'var(--amber-50)',  fg: 'var(--amber)',  bd: 'var(--amber)' },
    info:    { bg: 'var(--navy-50)',   fg: 'var(--navy)',   bd: 'var(--navy)' },
  };
  const c = palette[tone];
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '1px 6px',
        fontSize: 9.5, fontWeight: 700, fontFamily: 'var(--mono)',
        background: c.bg, color: c.fg, border: `1px solid ${c.bd}`,
        borderRadius: 2, letterSpacing: 0.4, textTransform: 'uppercase',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

function ProgressBar({ pct, tone }: { pct: number; tone: StageTone }) {
  const fill =
    tone === 'ok'       ? 'var(--text-3)'
    : tone === 'running'? 'var(--green)'
    : tone === 'err'    ? 'var(--red)'
    : 'var(--amber)';
  return (
    <div style={{ flex: 1, height: 6, background: 'var(--border)', borderRadius: 2, overflow: 'hidden' }}>
      <div style={{ width: `${Math.min(pct, 100)}%`, height: '100%', background: fill, transition: 'width .4s ease' }} />
    </div>
  );
}

/* ───────────────────────── Mock data + helpers ─────────────────── */

function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatTimeOfDay(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** phase の lifecycle 순서. forward-only な phase 自動進行 비교에 사용. */
const PHASE_ORDER: ProjectPhase[] = [
  'planning', 'analysis', 'test', 'sign-off', 'rehearsal', 'ready', 'cutover', 'hypercare', 'done',
];
function phaseOrder(phase: ProjectPhase): number {
  const i = PHASE_ORDER.indexOf(phase);
  return i < 0 ? 0 : i;
}

/**
 * phase × site.environment から起動可能な run mode を導出.
 * BE 側 `RunService.resolveRunTypeFromPhase` と一致させる:
 *   - production + ready             → cutover (本番移行)
 *   - production + その他            → null   (本番では ready のみ実行可)
 *   - non-prod   + rehearsal         → rehearsal (リハーサル run)
 *   - non-prod   + cutover/hypercare/done → null (既に走っている / 終了済)
 *   - non-prod   + その他            → test (planning / analysis / test / sign-off / ready
 *                                            すべて test run 扱い — preflight 通れば起動可)
 */
function deriveRunMode(phase: ProjectPhase, env: ProjectEnvironment): RunMode | null {
  if (env === 'production') {
    return phase === 'ready' ? 'cutover' : null;
  }
  if (phase === 'rehearsal') return 'rehearsal';
  if (phase === 'cutover' || phase === 'hypercare' || phase === 'done') return null;
  return 'test';
}

function countResults(checks: PreflightCheck[]): { pass: number; fail: number; skip: number } {
  return checks.reduce(
    (acc, c) => {
      if (c.aggregate === 'pass') acc.pass++;
      else if (c.aggregate === 'fail') acc.fail++;
      else acc.skip++;
      return acc;
    },
    { pass: 0, fail: 0, skip: 0 },
  );
}

const DEMO_TABLES = ['accounts', 'transactions', 'customers', 'audit_log'];

/** Demo: 7 checks all fail. Per-table rows synthesised over a fixed demo table list. */
function buildDemoPreflightChecks(t: T): PreflightCheck[] {
  const projectFail = (id: PreflightCheck['id'], title: TranslationKey, detail: TranslationKey): PreflightCheck => ({
    id, title: t(title), scope: 'project', aggregate: 'fail',
    perTable: [{ table: '*', status: 'fail', detail: t(detail) }],
  });
  const perTableFail = (id: PreflightCheck['id'], title: TranslationKey, detail: TranslationKey): PreflightCheck => ({
    id, title: t(title), scope: 'per-table', aggregate: 'fail',
    perTable: DEMO_TABLES.map<TableCheckResult>((table) => ({ table, status: 'fail', detail: t(detail) })),
  });
  return [
    projectFail('csv-arrived',  'execution.preflight.check.csvArrived.title',  'execution.preflight.demo.csvArrived.fail'),
    projectFail('ddl-asis',     'execution.preflight.check.ddlAsis.title',     'execution.preflight.check.ddlAsis.fail'),
    projectFail('ddl-tobe',     'execution.preflight.check.ddlTobe.title',     'execution.preflight.check.ddlTobe.fail'),
    projectFail('conn-tobe',    'execution.preflight.check.connTobe.title',    'execution.preflight.demo.connTobe.fail'),
    perTableFail('tobe-bindings','execution.preflight.check.tobeBindings.title','execution.preflight.demo.tobeBindings.fail'),
    perTableFail('asis-unmapped','execution.preflight.check.asisUnmapped.title','execution.preflight.demo.asisUnmapped.fail'),
    perTableFail('unmapped-cols','execution.preflight.check.unmappedCols.title','execution.preflight.demo.unmappedCols.fail'),
  ];
}

function buildDemoPreflightPassChecks(t: T): PreflightCheck[] {
  const projectPass = (id: PreflightCheck['id'], title: TranslationKey): PreflightCheck => ({
    id, title: t(title), scope: 'project', aggregate: 'pass',
    perTable: [{ table: '*', status: 'pass', detail: t('execution.preflight.demo.passDetail') }],
  });
  const perTablePass = (id: PreflightCheck['id'], title: TranslationKey): PreflightCheck => ({
    id, title: t(title), scope: 'per-table', aggregate: 'pass',
    perTable: DEMO_TABLES.map<TableCheckResult>((table) => ({
      table, status: 'pass', detail: t('execution.preflight.demo.passDetail'),
    })),
  });
  return [
    projectPass('csv-arrived',  'execution.preflight.check.csvArrived.title'),
    projectPass('ddl-asis',     'execution.preflight.check.ddlAsis.title'),
    projectPass('ddl-tobe',     'execution.preflight.check.ddlTobe.title'),
    projectPass('conn-tobe',    'execution.preflight.check.connTobe.title'),
    perTablePass('tobe-bindings','execution.preflight.check.tobeBindings.title'),
    perTablePass('asis-unmapped','execution.preflight.check.asisUnmapped.title'),
    perTablePass('unmapped-cols','execution.preflight.check.unmappedCols.title'),
  ];
}

function buildRuns(project: Project): Run[] {
  const phase = project.phase;
  if (phase === 'planning' || phase === 'analysis') return [];

  const baseDate = '2026-05-22';
  const runs: Run[] = [];

  if (phase === 'rehearsal' || phase === 'cutover') {
    runs.push({
      id: phase === 'cutover' ? 'cut-001' : 'reh-003',
      mode: phase === 'cutover' ? 'cutover' : 'rehearsal',
      scope: 'all',
      startedAt: `${baseDate} 10:12`,
      elapsed: '04:38',
      eta: '06:20',
      result: 'running',
      triggeredBy: { actor: project.executionAssignee ?? 'Admin', source: 'manual' },
    });
  }
  if (phase !== 'test') {
    runs.push(
      { id: 'reh-002', mode: 'rehearsal', scope: 'all', startedAt: `${baseDate} 09:01`, elapsed: '06:12', result: 'ok',   quarantineCount: 0, triggeredBy: { actor: 'Admin', source: 'manual' } },
      { id: 'reh-001', mode: 'rehearsal', scope: 'all', startedAt: '2026-05-21 17:40', elapsed: '06:30', result: 'warn', quarantineCount: 24, triggeredBy: { actor: 'Admin', source: 'manual' } },
    );
  }
  if (phase === 'hypercare' || phase === 'done') {
    runs.unshift({ id: 'cut-001', mode: 'cutover', scope: 'all', startedAt: `${baseDate} 02:00`, elapsed: '05:48', result: 'ok', quarantineCount: 0, triggeredBy: { actor: project.cutover?.startedBy ?? 'Admin', source: 'manual · cutover' } });
  }
  return runs;
}

/* ───────────────────────── Styles ──────────────────────────────── */

const styles: Record<string, React.CSSProperties> = {
  page: { display: 'flex', flexDirection: 'column' },

  empty:      { background: 'var(--panel)', border: '1px dashed var(--border-strong)', borderRadius: 6, padding: '50px 24px', textAlign: 'center' },
  emptyTitle: { fontSize: 13, fontWeight: 600, color: 'var(--text-3)' },

  runHeader: {
    padding: '14px 18px',
    borderBottom: '1px solid var(--border)',
    background: 'var(--panel)',
    display: 'flex', alignItems: 'center', gap: 16,
  },
  runHeaderLabel: { fontSize: 10.5, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 3 },
  runHeaderMono:  { fontSize: 12, color: 'var(--text-2)', fontFamily: 'var(--mono)' },

  errorBanner: {
    padding: '10px 18px',
    borderBottom: '1px solid var(--red)',
    background: 'var(--red-50)',
    color: 'var(--red)',
    fontSize: 12, fontWeight: 500, fontFamily: 'var(--mono)',
    display: 'flex', alignItems: 'center', gap: 10,
  },

  warnBanner: {
    padding: '10px 18px',
    borderBottom: '1px solid var(--amber)',
    background: 'var(--amber-50)',
    color: 'var(--amber)',
    fontSize: 12, fontWeight: 500, fontFamily: 'var(--mono)',
    display: 'flex', alignItems: 'center', gap: 10,
  },

  staleBanner: {
    padding: '10px 14px',
    marginBottom: 8,
    border: '1px solid var(--amber)',
    borderRadius: 4,
    background: 'var(--amber-50)',
    color: 'var(--amber)',
    fontSize: 12,
    display: 'flex', alignItems: 'flex-start', gap: 10,
  },

  section:        { borderBottom: '1px solid var(--border)' },
  sectionToggle:  { padding: '9px 18px', display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' },
  sectionLabel:   { fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.6, color: 'var(--text-3)' },
  chev:           { color: 'var(--text-4)', fontSize: 10, width: 10 },

  btnPrimary: {
    padding: '6px 14px', border: '1px solid var(--navy)', background: 'var(--navy)', color: '#fff',
    borderRadius: 3, fontSize: 12, fontWeight: 600, cursor: 'pointer',
  },
  btnSecondary: {
    padding: '6px 12px', border: '1px solid var(--border-strong)', background: 'var(--panel)', color: 'var(--text)',
    borderRadius: 3, fontSize: 12, fontWeight: 500, cursor: 'pointer',
  },
  btnDanger: {
    padding: '6px 12px', border: '1px solid var(--red)', background: 'var(--red)', color: '#fff',
    borderRadius: 3, fontSize: 12, fontWeight: 600, cursor: 'pointer',
  },
  btnGhost: {
    padding: '3px 8px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-2)',
    borderRadius: 3, fontSize: 11, fontWeight: 500, cursor: 'pointer',
  },
  btnDisabled: {
    padding: '6px 14px', border: '1px solid var(--border)', background: 'var(--panel-2)', color: 'var(--text-4)',
    borderRadius: 3, fontSize: 12, fontWeight: 600, cursor: 'not-allowed',
  },
};
