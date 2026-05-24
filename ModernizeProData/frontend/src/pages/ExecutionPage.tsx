import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useWorkspaceStore } from '../store/workspace';
import type { Project, ProjectPhase } from '../store/workspace';
import { useTobeDdlStore } from '../store/tobeDdl';
import { useSnapshotsStore, type MappingSnapshot } from '../store/snapshots';
import {
  useExecutionPreflightStore,
  type PreflightCheck,
  type PreflightPhase,
  type CheckStatus,
  type ActiveRunState,
} from '../store/executionPreflight';
import { useDemoMode, type DemoMode } from '../lib/useDemoMode';
import { useT, type TranslationKey } from '../i18n';

type T = (key: TranslationKey, vars?: Record<string, string | number>) => string;

type StageTone = 'idle' | 'running' | 'ok' | 'err';
type RunMode = 'rehearsal' | 'cutover';
type RunResult = 'ok' | 'warn' | 'failed' | 'aborted' | 'running';
type RunScope = 'all' | 'failed-only';
type BadgeTone = 'ok' | 'running' | 'queued' | 'err' | 'warn' | 'info';

/* Frontend mock simulation 의 시간 모델. 각 stage 5초, 7 stage = 35초.
   백엔드 run engine 연결 시점에 이 부분이 실제 진행률 / WS 이벤트로 교체된다. */
const STAGE_MS = 5000;
const TOTAL_STAGES = 7; /* BASE_STAGES.length — keep in sync */
const TOTAL_RUN_MS = STAGE_MS * TOTAL_STAGES;

interface Stage {
  id: string;
  name: string;
  sub: string;
  pct: number;
  tone: StageTone;
  color: string;
  rate: string;
  eta: string;
}

interface Run {
  id: string;
  mode: RunMode;
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
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const project = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId],
  );

  const { isDemo, demoMode, exitDemo } = useDemoMode();

  /* activeRun (frontend mock simulation) — Pre-flight pass 후 Start 누르면 store 에 생성된다.
     Stage 진행은 startedAt(절대 시각) 기반으로 derive — tick state 는 단순 re-render trigger. */
  const storeActiveRun: ActiveRunState | null = useExecutionPreflightStore(
    (s) => (project ? s.byProject[project.id]?.activeRun : null) ?? null,
  );
  const [tick, setTick] = useState(0);

  /* Re-render timer — run 이 진짜로 running 일 때만 (paused / completed / failed 면 멈춤). */
  useEffect(() => {
    if (!storeActiveRun) return;
    if (storeActiveRun.runStatus !== 'running') return;
    if (storeActiveRun.pausedAt !== null) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 250);
    return () => window.clearInterval(id);
  }, [storeActiveRun?.runId, storeActiveRun?.pausedAt, storeActiveRun?.runStatus]);

  /* Finish 감지 — elapsed >= TOTAL_RUN_MS 면 completed. Fail 은 명시적 trigger (Demo 버튼 / 백엔드) 로만. */
  const projectId = project?.id ?? null;
  useEffect(() => {
    if (!projectId || !storeActiveRun) return;
    if (storeActiveRun.runStatus !== 'running') return;
    if (computeElapsedMs(storeActiveRun) >= TOTAL_RUN_MS) {
      useExecutionPreflightStore.getState().finishActiveRun(projectId);
      useWorkspaceStore.getState().setProjectRunStatus(projectId, 'completed').catch(() => { /* mock; ignore */ });
    }
  }, [tick, storeActiveRun, projectId]);

  /* TO-BE DDL → 테이블 선택 목록. 캐시 미존재 시 자동 fetch. */
  const tobeSchema = useTobeDdlStore((s) => project ? s.schemasByProject[project.id] : undefined);
  const fetchTobeDdl = useTobeDdlStore((s) => s.fetch);
  useEffect(() => {
    if (!project) return;
    if (!tobeSchema) {
      fetchTobeDdl(project.id).catch(() => { /* DDL 미등록 — UI 가 안내 표시 */ });
    }
  }, [project?.id, tobeSchema, fetchTobeDdl]);
  const tobeTables = tobeSchema?.tables.map((tc) => tc.table.physicalName) ?? [];

  /* approved-snapshot 체크는 phase 가 아니라 snapshots store 의 실제 데이터로 판정 — phase 는
     단방향 전환이라 snapshot 삭제 후 sign-off 에 머무르는 케이스에서 거짓 pass 가 됐었음. */
  const snapshots = useSnapshotsStore((s) => s.snapshots);

  /* Pre-flight 워크플로 state — store 에서 영속. project 별로 격리되어 자동 reset 효과. */
  const entrySelected = useExecutionPreflightStore((s) => project ? s.byProject[project.id]?.selectedTables : undefined);
  const entrySnapshot = useExecutionPreflightStore((s) => project ? s.byProject[project.id]?.selectedSnapshotId : undefined);
  const entryPhase    = useExecutionPreflightStore((s) => project ? s.byProject[project.id]?.preflightPhase : undefined);
  const entryResults  = useExecutionPreflightStore((s) => project ? s.byProject[project.id]?.preflightResults : undefined);
  const selectedTables = useMemo(() => new Set(entrySelected ?? []), [entrySelected]);
  const selectedSnapshotId: string | null = entrySnapshot ?? null;
  const preflightPhase: PreflightPhase = entryPhase ?? 'idle';
  const preflightResults: PreflightCheck[] = entryResults ?? [];

  const setSelectedTables = (next: Set<string>) => {
    if (!project) return;
    useExecutionPreflightStore.getState().setSelected(project.id, [...next]);
  };

  /* 현재 project 의 snapshot 만 — SnapshotDisplay 가 selectedSnapshotId 로 찾을 때 사용. */
  const projectSnapshots = useMemo(
    () => project ? snapshots.filter((s) => s.projectId === project.id) : [],
    [snapshots, project],
  );
  const pinnedSnapshot = useMemo(
    () => selectedSnapshotId ? projectSnapshots.find((s) => s.id === selectedSnapshotId) ?? null : null,
    [projectSnapshots, selectedSnapshotId],
  );

  if (!project) {
    return (
      <div style={styles.empty}>
        <div style={styles.emptyTitle}>{t('execution.empty.noProject')}</div>
      </div>
    );
  }

  const startPreflight = () => {
    if (selectedTables.size === 0 || preflightPhase === 'checking') return;
    const checks = buildPreflightChecks(project, Array.from(selectedTables), t);
    const store = useExecutionPreflightStore.getState();
    store.setPhase(project.id, 'checking');
    store.setResults(project.id, []);
    /* 각 체크가 600ms 간격으로 순차 확정. fail 나도 끝까지 진행. */
    checks.forEach((check, i) => {
      window.setTimeout(() => {
        useExecutionPreflightStore.getState().setResults(project.id, (prev) => [...prev, check]);
        if (i === checks.length - 1) {
          useExecutionPreflightStore.getState().setPhase(project.id, 'done');
        }
      }, (i + 1) * 600);
    });
  };

  /* Demo 모드: trigger 없이 즉시 결과 표시. mode 별로 8 fail / 8 pass 분기. */
  const displayedResults = demoMode === 'run-fail'
    ? buildDemoPreflightPassChecks(t)
    : demoMode === 'preflight'
      ? buildDemoPreflightChecks(t)
      : preflightResults;
  const displayedPhase: PreflightPhase = isDemo ? 'done' : preflightPhase;
  const preflightPassed = displayedPhase === 'done'
    && displayedResults.length > 0
    && displayedResults.every((c) => c.status !== 'fail');

  /* Stage 진행은 activeRun 기반 (mock simulation), 없으면 phase 기반 fallback (기존 동작). */
  const stages = storeActiveRun
    ? buildStagesFromActiveRun(storeActiveRun, TOTAL_RUN_MS)
    : buildStages(project.phase);
  const runs = buildRuns(project);

  /* ActiveRun 이 존재하면 (running / paused / completed / failed / aborted) 모든 컨트롤 잠금.
     한 번 시작한 run 의 selection 은 고정 — 새 selection 으로 가려면 Discard 링크. */
  const controlsLocked = storeActiveRun !== null;

  const handleStartRun = () => {
    if (!preflightPassed || selectedTables.size === 0) return;
    /* 이전 run 이 completed / failed 상태라면 먼저 정리하고 새 run 생성. */
    const current = useExecutionPreflightStore.getState().byProject[project.id]?.activeRun;
    if (current && current.runStatus !== 'running') {
      useExecutionPreflightStore.getState().clearActiveRun(project.id);
    } else if (current && current.runStatus === 'running') {
      /* 방어적 — 이론상 도달 안 함 (controlsLocked 라 Start 자체가 disabled). */
      return;
    }
    const tables = Array.from(selectedTables);
    useExecutionPreflightStore.getState().startActiveRun(project.id, tables);
    /* Project phase 를 'test' 로, runStatus 'running' 으로. demo 모드면 fixture 가 일시적 — 영향 없음. */
    useWorkspaceStore.getState().setProjectPhase(project.id, 'test').catch(() => { /* mock */ });
    useWorkspaceStore.getState().setProjectRunStatus(project.id, 'running').catch(() => { /* mock */ });
  };

  const handlePauseToggle = () => {
    if (!storeActiveRun) return;
    if (storeActiveRun.pausedAt === null) {
      useExecutionPreflightStore.getState().pauseActiveRun(project.id);
    } else {
      useExecutionPreflightStore.getState().resumeActiveRun(project.id);
    }
  };

  /* Demo 모드 한정 — 현재 진행 중인 stage 에서 즉시 fail 처리.
     실제 운영 환경에선 backend WS 이벤트 → failActiveRun store action 으로 진입한다. */
  const handleTriggerFail = () => {
    if (!storeActiveRun || storeActiveRun.runStatus !== 'running') return;
    const elapsed = computeElapsedMs(storeActiveRun);
    const stageIndex = Math.min(Math.floor(elapsed / STAGE_MS), TOTAL_STAGES - 1);
    const stageName = BASE_STAGES[stageIndex]?.name ?? '?';
    /* mock reason — 실 백엔드 연결 시 fail 페이로드의 reason 으로 교체된다. */
    const reason = `Demo: ${stageName} 단계에서 PK 위반 3건 — accounts.account_id`;
    useExecutionPreflightStore.getState().failActiveRun(project.id, stageIndex, reason);
    useWorkspaceStore.getState().setProjectRunStatus(project.id, 'failed').catch(() => { /* mock */ });
  };

  const handleRetry = () => {
    useExecutionPreflightStore.getState().retryActiveRun(project.id, STAGE_MS);
    useWorkspaceStore.getState().setProjectRunStatus(project.id, 'running').catch(() => { /* mock */ });
  };

  /* halted (completed/failed/aborted) 상태에서만 노출 — activeRun 제거 + 컨트롤 잠금 해제. */
  const handleDiscard = () => {
    useExecutionPreflightStore.getState().clearActiveRun(project.id);
    useWorkspaceStore.getState().setProjectRunStatus(project.id, 'idle').catch(() => { /* mock */ });
  };

  /* 사용자 명시 중단 — running / paused 중에만 가능. 현재 stage 에서 멈춤. */
  const handleStopRun = () => {
    if (!storeActiveRun || storeActiveRun.runStatus !== 'running') return;
    const elapsed = computeElapsedMs(storeActiveRun);
    const stageIndex = Math.min(Math.floor(elapsed / STAGE_MS), TOTAL_STAGES - 1);
    const reason = t('execution.run.abortReason');
    useExecutionPreflightStore.getState().abortActiveRun(project.id, stageIndex, reason);
    useWorkspaceStore.getState().setProjectRunStatus(project.id, 'aborted').catch(() => { /* mock */ });
  };

  /* exitDemo 시 demo project 의 activeRun 도 정리 — 잔재 방지. */
  const handleExitDemo = () => {
    if (project) useExecutionPreflightStore.getState().clearActiveRun(project.id);
    exitDemo();
  };

  return (
    <div style={styles.page}>
      <RunHeader
        t={t}
        project={project}
        activeRun={storeActiveRun}
        runs={runs}
        preflightPassed={preflightPassed}
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
          canStart={!isDemo && selectedTables.size > 0}
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

/** Active run 중인 동안 선택 컨트롤을 비활성화 — pointer-events 차단 + opacity 표시. */
function DisabledOverlay({ disabled, children }: { disabled: boolean; children: React.ReactNode }) {
  return (
    <div style={disabled ? { pointerEvents: 'none', opacity: 0.55, filter: 'saturate(0.7)' } : undefined}>
      {children}
    </div>
  );
}

/* ───────────────────────── Run header ──────────────────────────── */

function RunHeader({
  t,
  project,
  activeRun,
  runs,
  preflightPassed,
  selectedTablesCount,
  isDemo,
  onStart,
  onPauseToggle,
  onStop,
  onTriggerFail,
  onRetry,
  onDiscard,
}: {
  t: T;
  project: Project;
  activeRun: ActiveRunState | null;
  runs: Run[];
  preflightPassed: boolean;
  selectedTablesCount: number;
  isDemo: boolean;
  onStart: () => void;
  onPauseToggle: () => void;
  onStop: () => void;
  onTriggerFail: () => void;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  /* Start 활성 = Pre-flight 모든 체크 pass + 최소 1개 테이블 선택. */
  const canStart = preflightPassed && selectedTablesCount > 0;
  const isDone = project.phase === 'done';

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
            title={canStart ? t('execution.run.startReadyHint') : t('execution.run.startBlockedHint')}
            style={canStart ? styles.btnPrimary : styles.btnDisabled}
          >
            ▶ {t('execution.run.startBtn')}
          </button>
        )}
      </section>
    );
  }

  /* Active run 상태 = running / paused / completed / failed / aborted. */
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

  const phaseChipTone: BadgeTone =
    isFailed ? 'err'
    : isAborted ? 'warn'
    : isCompleted ? 'queued'
    : 'ok';
  const statusChipTone: BadgeTone =
    isFailed ? 'err'
    : isAborted ? 'warn'
    : isCompleted ? 'ok'
    : running ? 'running'
    : 'warn';
  const statusChipText =
    isFailed ? t('execution.run.status.failed')
    : isAborted ? t('execution.run.status.aborted')
    : isCompleted ? t('execution.run.status.completed')
    : running ? t('execution.run.status.running')
    : t('execution.run.status.paused');

  /* Error/abort banner — failed / aborted 일 때 RunHeader 아래에 메시지 박스로 노출. */
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
            <StatusBadge tone={phaseChipTone}>{project.phase}</StatusBadge>
            <StatusBadge tone={statusChipTone}>{statusChipText}</StatusBadge>
            <span style={{ fontSize: 12, color: 'var(--text-3)', fontFamily: 'var(--mono)' }}>{elapsedLabel}</span>
          </div>
          <div style={{ fontSize: 10.5, color: 'var(--text-3)', fontFamily: 'var(--mono)', marginTop: 3 }}>
            {t('execution.run.triggeredBy')}{' '}
            <b style={{ color: 'var(--text-2)' }}>{project.executionAssignee ?? project.owner ?? 'Admin'}</b>
            <span> · {t('execution.run.tablesSummary', { n: activeRun.selectedTables.length })}</span>
          </div>
        </div>
        {/* Demo 모드 + running 일 때만 노출 — 실 운영에선 fail 은 backend 이벤트가 trigger */}
        {isDemo && running && (
          <button type="button" onClick={onTriggerFail} style={styles.btnGhost} title={t('execution.run.demo.triggerFail')}>
            {t('execution.run.demo.triggerFail')}
          </button>
        )}
        {isHalted && (
          <button
            type="button"
            onClick={onDiscard}
            style={styles.btnGhost}
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
            onClick={onStart}
            style={{ ...styles.btnPrimary, minWidth: 80 }}
            title={t('execution.run.startOverHint')}
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
  t,
  tables,
  selected,
  onChange,
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

/**
 * 선택된 snapshot 의 이름·version·status 를 read-only 로 표시.
 * 실제 snapshot 선택(pin)은 /versions 페이지에서 — 여기선 그 결과만 보여준다.
 */
function SnapshotDisplay({ t, pinned }: { t: T; pinned: MappingSnapshot | null }) {
  const label = pinned
    ? t('execution.snapshot.value', { name: pinned.name, version: pinned.version, status: pinned.status })
    : t('execution.snapshot.empty');
  return (
    <div style={{ ...styles.section, background: 'var(--panel)' }}>
      <div style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={styles.sectionLabel}>{t('execution.snapshot.title')}</span>
        <span style={{ fontSize: 11, color: pinned ? 'var(--text-2)' : 'var(--text-3)', fontFamily: 'var(--mono)' }}>
          {label}
        </span>
      </div>
    </div>
  );
}

/* ───────────────────────── Pre-flight panel ────────────────────── */

function PreflightPanel({ t, checks, phase, canStart, onStart, onReset, isDemo, demoMode, onExitDemo }: {
  t: T;
  checks: PreflightCheck[];
  phase: PreflightPhase;
  canStart: boolean;
  onStart: () => void;
  onReset: () => void;
  isDemo?: boolean;
  demoMode?: DemoMode | null;
  onExitDemo?: () => void;
}) {
  // PreflightPanel 내부에서 navigate 시 search 보존을 위해 isDemo 를 그대로 사용.
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const counts: Record<CheckStatus, number> = { pass: 0, fail: 0, skip: 0 };
  checks.forEach((c) => { counts[c.status]++; });
  const hasBlocking = counts.fail > 0;
  const isChecking = phase === 'checking';
  const isDone = phase === 'done';
  // 기본 펼친 상태 — 사용자가 Pre-flight 항목을 바로 볼 수 있게.
  // checking / fail 발생 시에도 자동으로 펼치는 보조 effect 는 유지.
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (isChecking || hasBlocking) setOpen(true);
  }, [isChecking, hasBlocking]);

  // demo URL 로 진입한 상태였다면 도착 페이지도 demo 로 유지되도록 search 보존.
  const search = demoMode ? `?demo=${demoMode}` : '';
  const handleFix = (c: PreflightCheck) => {
    switch (c.id) {
      case 'csv-arrived':
      case 'conn-tobe': {
        // 외부 인프라 영역이지만 1차 자연스러운 액션은 SiteSettings 의 해당 입력값 확인.
        // 현재 페이지 유지 + URL 쿼리로 AppShell 이 SiteSettingsModal 자동 open + 섹션 강조.
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
        // table-level routing 누락 — Table binding 패널을 강조.
        navigate({ pathname: '/mapping', search }, { state: { fixTarget: { kind: 'unbound-tobe' } } });
        return;
      case 'unmapped-cols':
        // column-level mapping 누락 — 첫 unmapped TO-BE 컬럼 row 를 강조.
        navigate({ pathname: '/mapping', search }, { state: { fixTarget: { kind: 'unmapped-tobe' } } });
        return;
      case 'asis-unmapped':
        navigate({ pathname: '/mapping', search }, { state: { fixTarget: { kind: 'unmapped-asis' } } });
        return;
    }
  };

  const bg = hasBlocking ? 'var(--red-50)' : 'var(--panel)';
  const headColor = hasBlocking ? 'var(--red)' : 'var(--text-2)';
  const hint = isChecking
    ? t('execution.preflight.checking')
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
          title={canStart ? t('execution.preflight.trigger.start') : t('execution.preflight.trigger.disabled')}
          style={canStart && !isChecking ? styles.btnPrimary : styles.btnDisabled}
        >
          ▶ {t('execution.preflight.trigger.start')}
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onReset(); }}
          disabled={isChecking}
          title={t('execution.preflight.trigger.reset')}
          style={isChecking ? styles.btnDisabled : styles.btnGhost}
        >
          ↺ {t('execution.preflight.trigger.reset')}
        </button>
      </div>

      {open && (
        <div style={{ padding: '4px 18px 14px' }}>
          <div style={{ border: '1px solid var(--border)', borderRadius: 4, background: 'var(--panel)' }}>
            {checks.length === 0 && !isChecking && (
              <div style={{ padding: 14, textAlign: 'center', fontSize: 12, color: 'var(--text-3)' }}>
                {t('execution.preflight.empty')}
              </div>
            )}
            {checks.length === 0 && isChecking && (
              <div style={{ padding: 14, textAlign: 'center', fontSize: 12, color: 'var(--text-3)' }}>
                {t('execution.preflight.checking')}
              </div>
            )}
            {checks.map((c, i) => (
              <div
                key={c.id}
                style={{
                  display: 'grid', gridTemplateColumns: '24px 260px 1fr auto',
                  alignItems: 'center', gap: 12,
                  padding: '8px 14px',
                  borderBottom: i < checks.length - 1 ? '1px solid var(--border)' : 'none',
                  background: c.status === 'fail' ? 'var(--red-50)' : 'var(--panel)',
                }}
              >
                <StatusDot tone={toneForCheck(c.status)} />
                <span style={{ fontSize: 12, fontWeight: 500 }}>{c.title}</span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: detailColorFor(c.status) }}>{c.detail}</span>
                {c.status === 'fail' ? (
                  <button type="button" style={styles.btnGhost} onClick={() => handleFix(c)}>
                    {t('execution.preflight.fix')}
                  </button>
                ) : <span />}
              </div>
            ))}
          </div>
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
                  st.tone === 'ok' ? 'var(--green)'
                  : st.tone === 'err' ? 'var(--red)'
                  : st.tone === 'idle' ? 'var(--text-4)'
                  : st.color,
                transition: 'width .4s ease',
              }} />
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 2, marginTop: 4 }}>
          {stages.map((st) => (
            <div key={st.id} style={{ flex: 1, textAlign: 'center', fontSize: 10, color: 'var(--text-3)', fontFamily: 'var(--mono)' }}>
              {st.name.toLowerCase().split(' ')[0]}
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
                  st.tone === 'running' ? 'var(--amber-50)'
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
                <ProgressBar pct={st.pct} tone={st.tone} color={st.color} />
                <div style={{ width: 44, textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-2)' }}>{st.pct.toFixed(0)}%</div>
              </div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--text-2)' }}>{st.rate}</div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--text-3)' }}>{t('execution.stages.etaPrefix')} {st.eta}</div>
              <div>
                {st.tone === 'ok' && <StatusBadge tone="ok">{t('execution.stages.status.done')}</StatusBadge>}
                {st.tone === 'running' && <StatusBadge tone="running">{t('execution.stages.status.live')}</StatusBadge>}
                {st.tone === 'err' && <StatusBadge tone="err">{t('execution.stages.status.failed')}</StatusBadge>}
                {st.tone === 'idle' && <StatusBadge tone="queued">{t('execution.stages.status.queued')}</StatusBadge>}
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

function StatusDot({ tone }: { tone: BadgeTone }) {
  const color =
    tone === 'ok' ? 'var(--green)'
    : tone === 'warn' || tone === 'running' ? 'var(--amber)'
    : tone === 'err' ? 'var(--red)'
    : tone === 'info' ? 'var(--navy)'
    : 'var(--text-4)';
  return <span style={{ width: 9, height: 9, borderRadius: '50%', background: color, display: 'inline-block' }} />;
}

function ProgressBar({ pct, tone, color }: { pct: number; tone: StageTone; color: string }) {
  const fill =
    tone === 'ok'  ? 'var(--green)'
    : tone === 'err' ? 'var(--red)'
    : tone === 'idle' ? 'var(--text-4)'
    : color;
  return (
    <div style={{ flex: 1, height: 6, background: 'var(--border)', borderRadius: 2, overflow: 'hidden' }}>
      <div style={{ width: `${Math.min(pct, 100)}%`, height: '100%', background: fill, transition: 'width .4s ease' }} />
    </div>
  );
}

/* ───────────────────────── Mock data + helpers ─────────────────── */

const BASE_STAGES: Array<Omit<Stage, 'pct' | 'tone'> & { defaultPct: number; defaultTone: StageTone }> = [
  { id: 'extract',  name: 'Extract',  sub: 'AS-IS CSV → Parquet', defaultPct: 0, defaultTone: 'idle', color: 'var(--phase-analysis)',  rate: '—', eta: '—' },
  { id: 'profile',  name: 'Profile',  sub: 'row counts · null %',  defaultPct: 0, defaultTone: 'idle', color: 'var(--phase-analysis)',  rate: '—', eta: '—' },
  { id: 'transform',name: 'Transform',sub: 'apply rule engine',    defaultPct: 0, defaultTone: 'idle', color: 'var(--phase-test)',      rate: '—', eta: '—' },
  { id: 'validate', name: 'Validate', sub: 'PK · FK · NOT NULL',   defaultPct: 0, defaultTone: 'idle', color: 'var(--phase-test)',      rate: '—', eta: '—' },
  { id: 'stage',    name: 'Stage',    sub: 'load to staging',      defaultPct: 0, defaultTone: 'idle', color: 'var(--phase-rehearsal)', rate: '—', eta: '—' },
  { id: 'load',     name: 'Load',     sub: 'apply to TO-BE',       defaultPct: 0, defaultTone: 'idle', color: 'var(--phase-rehearsal)', rate: '—', eta: '—' },
  { id: 'verify',   name: 'Verify',   sub: 'row count parity',     defaultPct: 0, defaultTone: 'idle', color: 'var(--phase-cutover)',   rate: '—', eta: '—' },
];

function buildStages(phase: ProjectPhase): Stage[] {
  /* activeRun 이 없을 때의 fallback. Pre-rehearsal phases 는 idle, hypercare/done 은 완료 표시. */
  const completePhases: ProjectPhase[] = ['hypercare', 'done'];
  if (completePhases.includes(phase)) {
    return BASE_STAGES.map((s) => ({ ...s, pct: 100, tone: 'ok', rate: '—', eta: 'done' }));
  }
  return BASE_STAGES.map((s) => ({ ...s, pct: s.defaultPct, tone: s.defaultTone }));
}

/** activeRun 의 startedAt + pauseAccumMs 로부터 elapsed ms 를 derive. completed 면 즉시 max. */
function computeElapsedMs(activeRun: ActiveRunState): number {
  if (activeRun.runStatus === 'completed') return STAGE_MS * BASE_STAGES.length;
  const ref = activeRun.pausedAt ?? Date.now();
  const raw = ref - activeRun.startedAt - activeRun.pauseAccumMs;
  return Math.max(0, Math.min(raw, STAGE_MS * BASE_STAGES.length));
}

/** Mock simulation 의 진행 상태를 stage 단위 progress 로 변환.
 *  Failed: 멈춘 stage 가 'err' (빨강) / Aborted: 멈춘 stage 가 'idle' (회색). 그 외 stage 는 동일 규칙. */
function buildStagesFromActiveRun(activeRun: ActiveRunState, totalMs: number): Stage[] {
  const halted = (activeRun.runStatus === 'failed' || activeRun.runStatus === 'aborted')
    && activeRun.failedStageIndex != null;
  const haltIdx = activeRun.failedStageIndex ?? -1;
  const haltedTone: StageTone = activeRun.runStatus === 'failed' ? 'err' : 'idle';
  const haltedEta = activeRun.runStatus === 'failed' ? 'failed' : 'stopped';
  const elapsed = computeElapsedMs(activeRun);

  return BASE_STAGES.map((s, i) => {
    if (halted) {
      if (i < haltIdx) return { ...s, pct: 100, tone: 'ok' as StageTone, rate: 'mock', eta: 'done' };
      if (i === haltIdx) {
        /* 멈춘 stage 의 pct 는 정지 시점까지의 진행률 그대로. */
        const stageStart = i * STAGE_MS;
        const partial = Math.max(0, Math.min(elapsed - stageStart, STAGE_MS));
        const pct = (partial / STAGE_MS) * 100;
        return { ...s, pct, tone: haltedTone, rate: 'mock', eta: haltedEta };
      }
      return { ...s, pct: 0, tone: 'idle' as StageTone, rate: '—', eta: '—' };
    }
    const stageStart = i * STAGE_MS;
    const stageEnd = stageStart + STAGE_MS;
    if (elapsed >= stageEnd || elapsed >= totalMs) {
      return { ...s, pct: 100, tone: 'ok' as StageTone, rate: 'mock', eta: 'done' };
    }
    if (elapsed > stageStart) {
      const pct = ((elapsed - stageStart) / STAGE_MS) * 100;
      const remainSec = Math.ceil((stageEnd - elapsed) / 1000);
      return { ...s, pct, tone: 'running' as StageTone, rate: 'mock', eta: `00:${String(remainSec).padStart(2, '0')}` };
    }
    return { ...s, pct: 0, tone: 'idle' as StageTone, rate: '—', eta: '—' };
  });
}

/** ms → MM:SS 문자열. RunHeader 의 elapsed/eta 표시용. */
function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** epoch ms → HH:MM 문자열. startedAt 표시용 (현지 시각 기준). */
function formatTimeOfDay(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function buildPreflightChecks(
  project: Project,
  selectedTables: string[],
  t: T,
): PreflightCheck[] {
  const asisDdl = project.tableCount > 0;
  const tobeDdl = project.tobeTableCount > 0;
  const bothDdl = asisDdl && tobeDdl;
  const selectedCount = selectedTables.length;

  return [
    {
      id: 'csv-arrived',
      title: t('execution.preflight.check.csvArrived.title'),
      detail: asisDdl
        ? t('execution.preflight.check.csvArrived.pass')
        : t('execution.preflight.check.needsAsisDdl'),
      status: asisDdl ? 'pass' : 'fail',
    },
    {
      id: 'ddl-asis',
      title: t('execution.preflight.check.ddlAsis.title'),
      detail: asisDdl
        ? t('execution.preflight.check.ddlAsis.pass', { n: project.tableCount })
        : t('execution.preflight.check.ddlAsis.fail'),
      status: asisDdl ? 'pass' : 'fail',
    },
    {
      id: 'ddl-tobe',
      title: t('execution.preflight.check.ddlTobe.title'),
      detail: tobeDdl
        ? t('execution.preflight.check.ddlTobe.pass', { n: project.tobeTableCount })
        : t('execution.preflight.check.ddlTobe.fail'),
      status: tobeDdl ? 'pass' : 'fail',
    },
    {
      id: 'conn-tobe',
      title: t('execution.preflight.check.connTobe.title'),
      detail: t('execution.preflight.check.connTobe.pass'),
      status: 'pass',
    },
    {
      id: 'tobe-bindings',
      title: t('execution.preflight.check.tobeBindings.title'),
      detail: !bothDdl
        ? t('execution.preflight.check.needsBothDdl')
        : t('execution.preflight.check.tobeBindings.pass', { n: selectedCount }),
      status: bothDdl ? 'pass' : 'fail',
    },
    {
      id: 'asis-unmapped',
      title: t('execution.preflight.check.asisUnmapped.title'),
      detail: !bothDdl
        ? t('execution.preflight.check.needsBothDdl')
        : t('execution.preflight.check.asisUnmapped.pass'),
      status: bothDdl ? 'pass' : 'fail',
    },
    {
      id: 'unmapped-cols',
      title: t('execution.preflight.check.unmappedCols.title'),
      detail: !bothDdl
        ? t('execution.preflight.check.needsBothDdl')
        : t('execution.preflight.check.unmappedCols.pass'),
      status: bothDdl ? 'pass' : 'fail',
    },
  ];
}

/**
 * Demo 결과 — 7개 체크 모두 fail. 사용자가 demo 한 번 진입으로 모든 Fix 흐름
 * (도착지·강조) 을 검증할 수 있게 의도적으로 worst-case 시나리오로 통일.
 */
function buildDemoPreflightChecks(t: T): PreflightCheck[] {
  return [
    { id: 'csv-arrived',       title: t('execution.preflight.check.csvArrived.title'),       detail: t('execution.preflight.demo.csvArrived.fail'),       status: 'fail' },
    { id: 'ddl-asis',          title: t('execution.preflight.check.ddlAsis.title'),          detail: t('execution.preflight.check.ddlAsis.fail'),         status: 'fail' },
    { id: 'ddl-tobe',          title: t('execution.preflight.check.ddlTobe.title'),          detail: t('execution.preflight.check.ddlTobe.fail'),         status: 'fail' },
    { id: 'conn-tobe',         title: t('execution.preflight.check.connTobe.title'),         detail: t('execution.preflight.demo.connTobe.fail'),         status: 'fail' },
    { id: 'tobe-bindings',     title: t('execution.preflight.check.tobeBindings.title'),     detail: t('execution.preflight.demo.tobeBindings.fail'),     status: 'fail' },
    { id: 'asis-unmapped',     title: t('execution.preflight.check.asisUnmapped.title'),     detail: t('execution.preflight.demo.asisUnmapped.fail'),     status: 'fail' },
    { id: 'unmapped-cols',     title: t('execution.preflight.check.unmappedCols.title'),     detail: t('execution.preflight.demo.unmappedCols.fail'),     status: 'fail' },
  ];
}

/**
 * `?demo=run-fail` 용 — 7개 체크 모두 pass. preflightPassed=true 가 되어 Start 활성화.
 * 그 후 사용자가 ⚡ Simulate failure 로 실패 시연.
 */
function buildDemoPreflightPassChecks(t: T): PreflightCheck[] {
  return [
    { id: 'csv-arrived',       title: t('execution.preflight.check.csvArrived.title'),       detail: t('execution.preflight.demo.passDetail'),            status: 'pass' },
    { id: 'ddl-asis',          title: t('execution.preflight.check.ddlAsis.title'),          detail: t('execution.preflight.demo.passDetail'),            status: 'pass' },
    { id: 'ddl-tobe',          title: t('execution.preflight.check.ddlTobe.title'),          detail: t('execution.preflight.demo.passDetail'),            status: 'pass' },
    { id: 'conn-tobe',         title: t('execution.preflight.check.connTobe.title'),         detail: t('execution.preflight.demo.passDetail'),            status: 'pass' },
    { id: 'tobe-bindings',     title: t('execution.preflight.check.tobeBindings.title'),     detail: t('execution.preflight.demo.passDetail'),            status: 'pass' },
    { id: 'asis-unmapped',     title: t('execution.preflight.check.asisUnmapped.title'),     detail: t('execution.preflight.demo.passDetail'),            status: 'pass' },
    { id: 'unmapped-cols',     title: t('execution.preflight.check.unmappedCols.title'),     detail: t('execution.preflight.demo.passDetail'),            status: 'pass' },
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

function toneForCheck(s: CheckStatus): BadgeTone {
  return s === 'pass' ? 'ok' : s === 'fail' ? 'err' : 'queued';
}

function detailColorFor(s: CheckStatus): string {
  return s === 'fail' ? 'var(--red)' : s === 'skip' ? 'var(--text-4)' : 'var(--text-2)';
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
