import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useWorkspaceStore } from '../store/workspace';
import type { Project, ProjectPhase, ProjectEnvironment, Site } from '../store/workspace';
import { useTobeDdlStore } from '../store/tobeDdl';
import { useAsisDdlStore } from '../store/asisDdl';
import { useAuthStore } from '../store/auth';
import { useSnapshotsStore, usePinnedSnapshotsStore, type MappingSnapshot } from '../store/snapshots';
import { Checkbox } from '../components/Checkbox';
import {
  useExecutionPreflightStore,
  type PreflightCheck,
  type PreflightPhase,
} from '../store/executionPreflight';
import { runPreflight, isAllPass, type TableCheckResult } from '../lib/preflightValidation';
import { tobeDbApi } from '../api/tobeDb';
import { csvPreviewApi } from '../api/csvPreview';
import { runsApi, type RunHistoryDto, type StageView } from '../api/runs';
import { usePipelineProgress, isTerminal } from '../hooks/usePipelineProgress';
import { PreflightResultPanel } from '../components/PreflightResultPanel';
import {
  BASE_STAGES,
  buildStages,
  buildStagesFromStageViews,
  type Stage,
  type StageTone,
} from '../lib/pipelineStages';
import { useQuery } from '@tanstack/react-query';
import { useT, type TranslationKey } from '../i18n';

type T = (key: TranslationKey, vars?: Record<string, string | number>) => string;

/** BE run + stageViews 를 한 묶음의 표시용 shape 로 합성. RunHeader · banner 등 UI 가 사용. */
type ActiveRunStatus = 'running' | 'completed' | 'failed' | 'aborted';
interface ActiveRunState {
  runId: string;
  selectedTables: string[];
  startedAt: number;
  pausedAt: number | null;
  pauseAccumMs: number;
  runStatus: ActiveRunStatus;
  failedStageIndex: number | null;
  failureReason: string | null;
  haltedAt: number | null;
}

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

  const user = useAuthStore((s) => s.user);

  /* 활성 run id. start 성공 시 BE 반환값 보존 → usePipelineProgress 자동 polling.
     setActiveRunId(null) 로 polling 정지 + 표시 클리어.
     localStorage(zustand persist) 에 저장돼 새로고침 후 pipeline 복원 — mount 시 store 가
     undefined (legacy / 첫 방문) 이면 아래 useEffect 가 runHistoryData 의 최신 run 으로 자동 복원.
     null 은 사용자가 Discard 한 의도로 간주 → 복원 안 함. */
  const storedActiveRunId = useExecutionPreflightStore((s) =>
    project ? s.byProject[project.id]?.activeRunId : undefined,
  );
  const activeRunId: string | null = storedActiveRunId ?? null;
  const setActiveRunId = (runId: string | null) => {
    if (!project) return;
    useExecutionPreflightStore.getState().setActiveRunId(project.id, runId);
  };
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
  /* Pipeline fallback — pinned snapshot 우선, 없으면 가장 최근 mapping snapshot.
     사용자가 pin 을 옛 snapshot 으로 옮기면 그 시점 execution_context 로 자동 전환. */
  const fallbackSnapshot = useMemo<MappingSnapshot | null>(() => {
    if (pinnedSnapshot && pinnedSnapshot.type === 'mapping') return pinnedSnapshot;
    const projectMapping = projectSnapshots.filter((s) => s.type === 'mapping');
    return [...projectMapping].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  }, [pinnedSnapshot, projectSnapshots]);
  /* "Discard" 한 snapshot id — 사용자가 활성 snapshot 의 fallback 표시를 명시적으로 끈 상태.
     pinned 가 다른 snapshot 으로 옮겨가면 자동 reset (그 새 snapshot 은 Discard 적용 안 됨). */
  const [discardedSnapshotId, setDiscardedSnapshotId] = useState<string | null>(null);
  useEffect(() => {
    setDiscardedSnapshotId((cur) => (cur && cur !== fallbackSnapshot?.id ? null : cur));
  }, [fallbackSnapshot?.id]);
  const effectiveFallback = fallbackSnapshot?.id === discardedSnapshotId ? null : fallbackSnapshot;
  /* pinned snapshot 의 id 가 변경되면 stale activeRunId 는 clear.
     예: Test 1 run → activeRunId=run1, pin 을 Test 2(아직 run X)로 옮기면 run1 은 더 이상
     이 snapshot 의 것이 아님 → clear 하면 fallback(빈 또는 그 snapshot 박제) 으로 자동 전환.
     deps 는 pinnedSnapshot.id 만 — pinned 의 executionContext 가 갱신될 뿐인 경우(같은 snapshot
     으로 run 끝남) 에는 clear 하지 않는다. */
  useEffect(() => {
    if (!project) return;
    if (!pinnedSnapshot) return; // pin 없으면 activeRunId 그대로 (test ad-hoc 등).
    const expectedRunId = pinnedSnapshot.executionContext?.runId ?? null;
    if (activeRunId && activeRunId !== expectedRunId) {
      setActiveRunId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinnedSnapshot?.id, project?.id]);
  const { run, stages: stageViews } = usePipelineProgress(
    activeRunId,
    effectiveFallback?.executionContext ?? null,
  );

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

  /* === Hooks: 必ず early return より前 ===
     project/site が未確定でも hook 数を一定に保つため、ここに集約する.
     使用は早期 return 後に分岐. */

  /* BE polling 結果 (RunHistoryDto + StageView[]) を ActiveRunState 形に合成. real モードのみ. */
  const realActiveRun: ActiveRunState | null = useMemo(() => {
    if (!run) return null;
    const startedAtMs = run.startedAt ? new Date(run.startedAt).getTime() : Date.now();
    const haltedAtMs = run.finishedAt && isTerminal(run.status) ? new Date(run.finishedAt).getTime() : null;
    const failedIdx = stageViews ? findFailedStageIndex(stageViews) : null;
    return {
      runId: run.id,
      selectedTables: [],            // BE は run 単位で記録しない (tables[] は per-stage 配下)
      startedAt: startedAtMs,
      /* paused 中は pausedAt≠null → isPaused=true (status chip=paused / 버튼=Resume).
         demo の様な正確な pause 時刻/pauseAccumMs は FE で追跡しないため Date.now() で近似
         (elapsed ラベルは wall-clock; 実 progress は stageViews=BE 真値が描く). */
      pausedAt: run.status === 'paused' ? Date.now() : null,
      pauseAccumMs: 0,
      runStatus: mapBeRunStatus(run.status),
      failedStageIndex: failedIdx,
      failureReason: run.errorMessage ?? null,
      haltedAt: haltedAtMs,
    };
  }, [run, stageViews]);

  const displayedActiveRun: ActiveRunState | null = realActiveRun;

  /* 実行履歴: real は BE fetch、demo は既存 mock. project が未確定なら disabled. */
  const runHistoryQuery = useQuery<RunHistoryDto[]>({
    queryKey: ['run-history', projectIdForReset],
    enabled: !!projectIdForReset,
    queryFn: () => runsApi.listByProject(projectIdForReset!),
    staleTime: 5_000,
    refetchInterval: activeRunId ? 5_000 : false,
  });
  const runHistoryData = runHistoryQuery.data;

  /* 새로고침 후 pipeline 복원: store 의 activeRunId 가 undefined (한 번도 set 안 된 상태)
     이고 BE 히스토리에 run 이 있으면 최신 run 으로 자동 복원. null (Discard) 은 사용자 의도
     이므로 손대지 않는다. */
  useEffect(() => {
    if (!projectIdForReset) return;
    if (storedActiveRunId !== undefined) return;
    if (!runHistoryData || runHistoryData.length === 0) return;
    useExecutionPreflightStore.getState().setActiveRunId(projectIdForReset, runHistoryData[0].id);
  }, [projectIdForReset, runHistoryData, storedActiveRunId]);

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

      /* CSV ファイル存在チェックを per-AS-IS-table 並列で実行.
         選択 TO-BE → bindings → 必要 AS-IS テーブル集合 を計算し、
         csv-preview/{table}?limit=1 で 404 / 200 を判定. */
      let csvFilesByAsisTable: Record<string, { exists: boolean; error?: string }> = {};
      if (site.csvPath?.trim()) {
        // key = asisTable(schema 제거된 이름, csvFilesByAsisTable 조회 키), value = preview API 에 넘길 이름
        // (schema 있으면 'schema.table' — BE resolver 가 schema 한정 파일을 먼저 찾도록).
        const asisTablesNeeded = new Map<string, string>();
        for (const tobeTable of tablesList) {
          const bindings = (snapshotData.bindings ?? []).filter((b) => b.tobeTable === tobeTable);
          for (const b of bindings) {
            for (const src of b.sources ?? []) {
              if (src.asisTable) {
                const queryName = src.asisSchema ? `${src.asisSchema}.${src.asisTable}` : src.asisTable;
                asisTablesNeeded.set(src.asisTable, queryName);
              }
            }
          }
        }
        if (asisTablesNeeded.size > 0) {
          /* BE の DuckDbService が現状スレッドセーフでなく、Promise.all で並列に
             csv-preview を叩くと "Invalid Input Error: Attempting to execute an
             unsuccessful or closed pending query result" でランダムに 1 件失敗する.
             直列化(for-of await)で回避. 数テーブル分の +N × ~100ms 待ち増は preflight
             の演出時間内に収まるので体感差は無視できる. BE 側の並列対応 / bulk endpoint
             が入ったら parallel に戻すか bulk 呼び出しに切替可能. */
          for (const [table, queryName] of asisTablesNeeded) {
            try {
              await csvPreviewApi.forTable(site.id, queryName, 1);
              csvFilesByAsisTable[table] = { exists: true };
            } catch (e) {
              csvFilesByAsisTable[table] = {
                exists: false,
                error: e instanceof Error ? e.message : 'not found',
              };
            }
          }
        }
      }

      const results = runPreflight({
        project, site, tobeSchema, asisSchema, snapshotData,
        selectedTables: tablesList,
        t,
        tobeDbReachable,
        csvFilesByAsisTable,
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

  const displayedResults = cachedResults;
  /* phase 派生: checking 中なら checking、cache 에 결과 있으면 done、그 외 idle */
  const displayedPhase: PreflightPhase = preflightPhase === 'checking'
    ? 'checking'
    : cachedResults.length > 0
      ? 'done'
      : 'idle';
  const displayedStale = isStale;
  const preflightPassed = displayedPhase === 'done'
    && !displayedStale
    && isAllPass(displayedResults);

  /* stages 표시: BE polling 派生. null 이면 project.phase ベースの 정적 fallback. */
  const stages = stageViews ? buildStagesFromStageViews(stageViews) : buildStages(project.phase);

  const runs = (runHistoryData ?? []).map(beRunToRunCard);

  const controlsLocked = displayedActiveRun !== null || !hasPinnedSnapshot;

  /* Real モードの run 起動本体 — start API 呼び出し + runId 保存.
     handleStartRun(二重起動 guard 経由) と handleRetry(guard なしで再起動) が共有. */
  const startRealRun = async (tables: string[], mode: RunMode) => {
    try {
      const result = await runsApi.start(project.id, mode, tables);
      if (result.status === 'STARTED' && result.runId) {
        setActiveRunId(result.runId);
      } else {
        /* REJECTED / LOCKED — alert 暫定. toast 化は別件. */
        console.warn('[execution] startRun rejected:', result.status, result.reason);
        alert(`Start rejected: ${result.status}\n${result.reason ?? ''}`);
      }
    } catch (e) {
      console.error('[execution] startRun failed:', e);
      alert(`Start failed: ${e instanceof Error ? e.message : 'unknown error'}`);
    }
  };

  const handleStartRun = async () => {
    if (!preflightPassed || selectedTables.size === 0) return;
    if (!hasPinnedSnapshot || !pinnedSnapshot) return;
    if (!runMode) return;

    const tables = Array.from(selectedTables);

    /* BE에 start 던지고 반환 runId 보존. polling은 usePipelineProgress가 자동 시작.
       project.runStatus / phase는 BE의 RunService가 갱신 → AppShell의 10s polling으로 sidebar 반영. */
    if (activeRunId) return;  // 이미 도는 중 — 이중 기동 방지
    await startRealRun(tables, runMode);
  };

  const handlePauseToggle = async () => {
    /* BE pause/resume endpoint 호출. 상태 전이는 usePipelineProgress polling이
       다음 tick에서 캐치 — 수동 갱신 불필요 (paused는 non-terminal → polling 계속). */
    if (!activeRunId || !run) return;
    try {
      if (run.status === 'running')     await runsApi.pause(activeRunId);
      else if (run.status === 'paused') await runsApi.resume(activeRunId);
    } catch (e) {
      console.error('[execution] pause/resume failed:', e);
      alert(`Pause/Resume failed: ${e instanceof Error ? e.message : 'unknown error'}`);
    }
  };

  const handleRetry = async () => {
    /* Retry = 失敗した run を捨てて新しい run を起こす.
       handleStartRun の `if (activeRunId) return` を経由すると、setActiveRunId(null) が
       同期反映されず stale closure の旧 activeRunId を見て no-op になる → startRealRun 직접 호출. */
    if (!runMode || selectedTables.size === 0) return;
    setActiveRunId(null);
    await startRealRun(Array.from(selectedTables), runMode);
  };

  const handleDiscard = () => {
    /* polling 停止 + UI 의 「현재 run」 제거. BE 의 run 자체는 history 에 남음.
       추가로 fallback snapshot 의 executionContext 도 화면에서 끄기 — 안 그러면 activeRunId
       가 null 되자마자 fallback 으로 다시 그려진다 (Discard 가 무효화돼 보임). */
    setActiveRunId(null);
    if (fallbackSnapshot) setDiscardedSnapshotId(fallbackSnapshot.id);
  };

  const handleStopRun = async () => {
    if (!activeRunId) return;
    if (run && isTerminal(run.status)) return; // 既に terminal 이면 무시
    try {
      await runsApi.abort(activeRunId, t('execution.run.abortReason'));
    } catch (e) {
      console.warn('[execution] abort failed:', e);
      alert(`Abort failed: ${e instanceof Error ? e.message : 'unknown error'}`);
    }
  };

  return (
    <div style={styles.page}>
      <RunHeader
        t={t}
        project={project}
        site={site}
        runMode={runMode}
        activeRun={displayedActiveRun}
        runs={runs}
        preflightPassed={preflightPassed}
        hasPinnedSnapshot={hasPinnedSnapshot}
        selectedTablesCount={selectedTables.size}
        onStart={handleStartRun}
        onPauseToggle={handlePauseToggle}
        onStop={handleStopRun}
        onRetry={handleRetry}
        onDiscard={handleDiscard}
        onReset={() => useExecutionPreflightStore.getState().resetForProject(project.id)}
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
  selectedTablesCount, onStart, onPauseToggle, onStop, onRetry, onDiscard, onReset,
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
  onStart: () => void;
  onPauseToggle: () => void;
  onStop: () => void;
  onRetry: () => void;
  onDiscard: () => void;
  /** 테스트용 — preflight 캐시 / selectedTables / activeRunId 한꺼번에 비움. */
  onReset: () => void;
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
  /* elapsed: BE 真値 기반 wall-clock(시작~정지/현재). 신뢰할 ETA 없으므로 미표시. */
  const elapsedMs = Math.max(0, (activeRun.haltedAt ?? activeRun.pausedAt ?? Date.now()) - activeRun.startedAt);
  const elapsedLabel = t('execution.run.elapsed', {
    time: formatTimeOfDay(activeRun.startedAt),
    elapsed: formatDuration(elapsedMs),
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

  /* Run 순번 (#N) — runHistoryData desc 정렬에서 활성 run 위치로 계산.
     가장 오래된=#1, 최신=#N. mock 시절 PreflightEntry.runCounter 와 등가 (BE 폴링 기반). */
  const activeRunIndex = (() => {
    const idx = runs.findIndex((r) => r.id === activeRun.runId);
    return idx >= 0 ? runs.length - idx : null;
  })();

  return (
    <>
      <section style={styles.runHeader}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={styles.runHeaderLabel}>{t('execution.run.active')}</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 16, fontWeight: 600 }}>
              {project.id}{activeRunIndex != null ? ` · #${activeRunIndex}` : ''}
            </span>
            <StatusBadge tone={statusChipTone}>{statusChipText}</StatusBadge>
            <span style={{ fontSize: 12, color: 'var(--text-3)', fontFamily: 'var(--mono)' }}>{elapsedLabel}</span>
          </div>
          <div style={{ fontSize: 10.5, color: 'var(--text-3)', fontFamily: 'var(--mono)', marginTop: 3 }}>
            <span>run </span><b style={{ color: 'var(--text-2)' }}>{activeRun.runId}</b>
            <span> · </span>{t('execution.run.triggeredBy')}{' '}
            <b style={{ color: 'var(--text-2)' }}>{project.executionAssignee ?? project.owner ?? 'Admin'}</b>
            <span> · {t('execution.run.tablesSummary', { n: selectedTablesCount })}</span>
          </div>
        </div>
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
        {isHalted && (
          /* 테스트용 한방 리셋 — preflight + 테이블 선택 + 활성 run 표시 모두 비움.
             PreflightPanel 의 Reset 은 DisabledOverlay 안이라 halted 중엔 접근 불가 →
             여기에서 노출. 활성 run(=running) 중엔 보이지 않음 (orphan 방지). */
          <button
            type="button"
            onClick={onReset}
            style={{ ...styles.btnGhost, minWidth: 80 }}
            title={t('execution.preflight.trigger.reset')}
          >
            ↺ {t('execution.preflight.trigger.reset')}
          </button>
        )}
        {!isHalted && (
          <>
            {/* Pause/Resume — real/demo 両対応. real は BE pause/resume endpoint へ
               (同期実行のため停止は次 stage 境界で反応). */}
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
            {activeRun.failedStageIndex != null
              ? t('execution.run.errorBanner', {
                  stage: activeRun.failedStageIndex + 1,
                  name: failedStageName,
                  reason: activeRun.failureReason ?? '',
                })
              : t('execution.run.errorBannerNoStage', {
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
              onClick={toggleAll}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '8px 14px',
                borderBottom: '1px solid var(--border)',
                background: 'var(--panel-2)',
                cursor: 'pointer', fontSize: 12, fontWeight: 600,
              }}
            >
              <Checkbox checked={allChecked} indeterminate={!noneChecked && !allChecked} onChange={toggleAll} />
              {t('execution.preflight.tableSelector.selectAll')}
            </label>
            <div style={{ maxHeight: 220, overflowY: 'auto' }}>
              {tables.map((name) => (
                <label
                  key={name}
                  onClick={() => toggleOne(name)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '6px 14px',
                    borderBottom: '1px solid var(--border)',
                    cursor: 'pointer', fontSize: 12, fontFamily: 'var(--mono)',
                  }}
                >
                  <Checkbox checked={selected.has(name)} onChange={() => toggleOne(name)} />
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
    <div style={{ ...styles.section, background: pinned ? 'var(--panel)' : 'var(--red-50)' }}>
      <div style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={styles.sectionLabel}>{t('execution.snapshot.title')}</span>
        <span style={{ fontSize: 11, color: pinned ? 'var(--text-2)' : 'var(--red)', fontFamily: 'var(--mono)', fontWeight: pinned ? 400 : 600 }}>
          {label}
        </span>
      </div>
    </div>
  );
}

/* ───────────────────────── Pre-flight panel ────────────────────── */

function PreflightPanel({
  t, checks, phase, isStale, canStart, startDisabledReason, onStart, onReset,
}: {
  t: T;
  checks: PreflightCheck[];
  phase: PreflightPhase;
  isStale: boolean;
  canStart: boolean;
  startDisabledReason: string;
  onStart: () => void;
  onReset: () => void;
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
        navigate('/settings', { state: { highlightSide: 'asis' } });
        return;
      case 'ddl-tobe':
        navigate('/settings', { state: { highlightSide: 'tobe' } });
        return;
      case 'tobe-bindings':
        navigate('/mapping', { state: { fixTarget: { kind: 'unbound-tobe', table } } });
        return;
      case 'unmapped-cols':
        navigate('/mapping', { state: { fixTarget: { kind: 'unmapped-tobe', table } } });
        return;
      case 'asis-unmapped':
        navigate('/mapping', { state: { fixTarget: { kind: 'unmapped-asis', table } } });
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

/** BE 의 RunStatus enum 을 FE ActiveRunState.runStatus 에 매핑. */
function mapBeRunStatus(s: RunHistoryDto['status']): ActiveRunState['runStatus'] {
  switch (s) {
    case 'success':   return 'completed';
    case 'failed':    return 'failed';
    case 'aborted':   return 'aborted';
    case 'timed_out': return 'failed';   // UX 上は failed 扱い
    case 'paused':                        // paused は runStatus='running' + pausedAt≠null で表現
    case 'pending':                       // queued state → 視覚的には running 扱い
    case 'running':
    default:          return 'running';
  }
}

/** stages から最初に failed になった stage の index を求める. 全 success / 全 pending なら null. */
function findFailedStageIndex(stageViews: StageView[]): number | null {
  /* stageKey と BASE_STAGES.id の対応で index を確定. BE が seq 順で返す保証は無いので明示マッチ. */
  for (let i = 0; i < BASE_STAGES.length; i++) {
    const sv = stageViews.find((s) => s.stageKey === BASE_STAGES[i].id);
    if (sv?.status === 'failed') return i;
  }
  return null;
}

/** BE RunHistoryDto → 既存 Run カード形 (履歴表示用). */
function beRunToRunCard(r: RunHistoryDto): Run {
  const startedAt = r.startedAt ? new Date(r.startedAt) : null;
  const durationMs = r.durationMs ?? 0;
  const result: RunResult =
    r.status === 'success'   ? 'ok'
    : r.status === 'failed'   ? 'failed'
    : r.status === 'aborted'  ? 'aborted'
    : r.status === 'timed_out'? 'failed'
    : 'running';
  return {
    id: r.id,
    mode: r.runType === 'cutover' ? 'cutover' : 'rehearsal',
    scope: 'all',
    startedAt: startedAt ? formatRunStartedAt(startedAt) : '—',
    elapsed: formatDuration(durationMs),
    result,
    triggeredBy: { actor: r.requestedBy ?? 'system', source: r.triggerSource ?? undefined },
  };
}

function formatRunStartedAt(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const HH = String(d.getHours()).padStart(2, '0');
  const MM = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${HH}:${MM}`;
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
  /* non-prod: ready 以降は全部 block. ready の cutover は production 専用仕様, それより
     先 (cutover/hypercare/done) は実行できる phase ではない. */
  if (phase === 'rehearsal') return 'rehearsal';
  if (phase === 'ready' || phase === 'cutover' || phase === 'hypercare' || phase === 'done') return null;
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
