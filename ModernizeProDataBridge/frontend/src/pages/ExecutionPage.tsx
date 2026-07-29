import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
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
import { useTobeDbHealth } from '../hooks/useTobeDbHealth';
import { csvPreviewApi } from '../api/csvPreview';
import { mappingImportApi } from '../api/mappingImport';
import { runsApi, errorDetailText, type RunHistoryDto, type StageView } from '../api/runs';
import { quarantineApi } from '../api/quarantine';
import type { QuarantineGroup } from './quarantineMock';
import { quarantineAckApi, type CutoverReviewRequest } from '../api/quarantineAck';
import { CutoverReviewModal, buildReviewItems, type CutoverReviewItem } from '../components/CutoverReviewModal';
import { usePipelineProgress, isTerminal } from '../hooks/usePipelineProgress';
import { PreflightResultPanel } from '../components/PreflightResultPanel';
import {
  BASE_STAGES,
  buildStages,
  buildStagesFromStageViews,
  stageFillColor,
  successFillColor,
  isPipelineComplete,
  type Stage,
  type StageTone,
} from '../lib/pipelineStages';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useT, type TranslationKey } from '../i18n';

type T = (key: TranslationKey, vars?: Record<string, string | number>) => string;

/** BE run + stageViews 를 한 묶음의 표시용 shape 로 합성. RunHeader · banner 등 UI 가 사용.
 *  2026-05-29: paused / pauseAccumMs 제거 — Pause 영구 제거 결정.
 */
type ActiveRunStatus = 'running' | 'completed' | 'failed' | 'aborted';
interface ActiveRunState {
  runId: string;
  selectedTables: string[];
  startedAt: number;
  runStatus: ActiveRunStatus;
  failedStageIndex: number | null;
  failureReason: string | null;
  haltedAt: number | null;
  /** 이 run 을 起動한 주체 (BE requestedBy). 'Admin' 하드코딩 대체 (#6-5). */
  requestedBy: string;
  /** 이 run 의 대상 테이블 수 (부분 실행 tables[] 길이, null=전체면 tableSummary.total) (#6-5). */
  tableScopeCount: number;
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
  const isMaster = user?.role === 'master';
  const queryClient = useQueryClient();

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
  // 실행 target env 의 TO-BE DB 실시간 도달성 — run 진행 중엔 5s, 평소 12s 로 poll.
  // (hook 은 early-return 위에 둬야 하므로 site 미확정 시 site?.id = undefined → 자동 disabled.)
  const tobeHealth = useTobeDbHealth(site?.id, true, activeRunId ? 5_000 : 12_000);
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
  /* Pipeline fallback — pin 中心統一 (2026-05-31): pin の executionContext のみを fallback
     として使う. pin が無いプロジェクトでは fallback 無し. 旧仕様の「pin が無くても最新 mapping
     snapshot を fallback」は ad-hoc run / 別 snapshot run を Execution 画面に映してしまうため廃止. */
  const fallbackSnapshot: MappingSnapshot | null =
    pinnedSnapshot && pinnedSnapshot.type === 'mapping' ? pinnedSnapshot : null;
  /* Discard 済み snapshot id — ユーザーが「この pin の박제 run 表示をいったん消したい」と明示した状態.
     pin が別 snapshot に変わったら自動 reset (= 新 pin に Discard 効果は持ち越さない). */
  const [discardedSnapshotId, setDiscardedSnapshotId] = useState<string | null>(null);
  useEffect(() => {
    setDiscardedSnapshotId((cur) => (cur && cur !== pinnedSnapshot?.id ? null : cur));
  }, [pinnedSnapshot?.id]);
  const effectiveFallback = pinnedSnapshot?.id === discardedSnapshotId ? null : fallbackSnapshot;
  /* pin 切替 effect は runHistoryData を参照するため宣言後 (下方) に移動. ここでは ref のみ宣言. */
  const prevPinIdRef = useRef<string | undefined | null>(undefined);
  const { run, stages: stageViews } = usePipelineProgress(
    activeRunId,
    effectiveFallback?.executionContext ?? null,
  );

  /* failed table drill-down — 그 이행(run)의 quarantine 상세 (검증 위반 + stage 실행
     실패 둘 다 quarantine 카드로 적재됨). live run 은 activeRunId, snapshot view 는
     pin 의 executionContext.runId 로 조회. table 별 group 으로 묶어 PipelineStages 의
     failed table 클릭 시 inline 표시. */
  const effectiveRunId = activeRunId ?? effectiveFallback?.executionContext?.runId ?? null;
  const { data: execQuarantine } = useQuery({
    queryKey: ['exec-quarantine', effectiveRunId],
    enabled: !!effectiveRunId,
    queryFn: () => quarantineApi.byRun(effectiveRunId!),
    refetchInterval: activeRunId ? 5_000 : false,
  });

  const quarantineByTable = useMemo(() => {
    const m = new Map<string, QuarantineGroup[]>();
    for (const g of execQuarantine ?? []) {
      const k = (g.table ?? '').toLowerCase();
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(g);
    }
    return m;
  }, [execQuarantine]);

  const entrySelected = useExecutionPreflightStore((s) => project ? s.byProject[project.id]?.selectedTables : undefined);
  const entryPhase    = useExecutionPreflightStore((s) => project ? s.byProject[project.id]?.preflightPhase : undefined);
  const entryStale    = useExecutionPreflightStore((s) => project ? s.byProject[project.id]?.isStale : undefined);
  /* pin 단위 결과 캐시. pin 이 바뀌면 표시도 자동으로 그 pin 의 結果로 切替. */
  const entryBySnapshot = useExecutionPreflightStore((s) => project ? s.byProject[project.id]?.bySnapshot : undefined);
  const selectedTables = useMemo(() => new Set(entrySelected ?? []), [entrySelected]);
  const preflightPhase: PreflightPhase = entryPhase ?? 'idle';
  const isStale: boolean = entryStale ?? false;

  /* selectedTables 自動同期 effect は displayedActiveRun を参照するため宣言後 (下方) に移動. */

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

  /* elapsed 1초 tick — AppShell lightSync 가 5초 (BE 부담 회피) 라 elapsed 가 5초씩
     점프하던 문제 해결. running 중에만 활성, terminal 시 정지. 로컬 setState 만 trigger
     하므로 BE 호출 X. RunHeader 의 elapsedMs / PipelineStages 의 stage 별 elapsedMs
     모두 매 render Date.now() 로 재계산되므로 이 re-render 로 같이 갱신됨. */
  const [, setElapsedTick] = useState(0);
  useEffect(() => {
    if (!run || isTerminal(run.status)) return;
    const id = setInterval(() => setElapsedTick((v) => v + 1), 1_000);
    return () => clearInterval(id);
  }, [run?.id, run?.status]);

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
      runStatus: mapBeRunStatus(run.status),
      failedStageIndex: failedIdx,
      failureReason: run.errorMessage ?? null,
      haltedAt: haltedAtMs,
      requestedBy: run.requestedBy,
      // 부분 실행이면 run.tables 길이, 전체 run(null)이면 stage 결과 집계 total.
      tableScopeCount: run.tables?.length ?? run.tableSummary?.total ?? 0,
    };
  }, [run, stageViews]);

  const displayedActiveRun: ActiveRunState | null = realActiveRun;

  /* selectedTables 자동 동기는 **pin id が実際に切り替わった時のみ** 発火.
     - pin 切替 (= pinnedSnapshot.id 変更) → 新 pin の executionContext.stages から success table 反映.
       박제 없음이면 빈 set, 있으면 status='success' 인 tobeTable 만 자동 체크.
       (실패 table 까지 union 하면 다음 run 도 또 실패 — mapping 미정의 테이블이 반복적으로 끼는
       사용자 함정 발생.)
     - 同じ pin で executionContext.runId 更新 (= run finish) → skip. RUN 起動時の選択を維持.
       Discard 経由 or 手動で TableSelector を編集するまで selectedTables は不変.
     - 初回マウント → persist 復元値をそのまま採用 (前回離脱時の選択維持).
     ※ syncSelectedFromExecution を使う — ユーザー操作ではないので isStale 化しない.
     (2026-05-31 fix: 旧版は executionContext.runId 変更でも自動同期していたため,
     run finish 後 success table のみで上書きされて起動時の選択が失われた.) */
  const prevSelectionPinIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!project) return;
    if (!pinnedSnapshot) {
      prevSelectionPinIdRef.current = undefined;
      return;
    }
    const currentPinId = pinnedSnapshot.id;
    const isInitialSet = prevSelectionPinIdRef.current === undefined;
    const pinChanged = !isInitialSet && prevSelectionPinIdRef.current !== currentPinId;
    prevSelectionPinIdRef.current = currentPinId;

    // 初回 mount は persist 復元値そのまま. pin id が変わっていなければ何もしない.
    if (!pinChanged) return;

    // pin 切替: 新 pin の박제 success table で同期.
    const ctx = pinnedSnapshot.executionContext;
    if (!ctx) {
      useExecutionPreflightStore.getState().syncSelectedFromExecution(project.id, []);
      return;
    }
    const tables = new Set<string>();
    for (const st of ctx.stages) {
      for (const t of st.tables) {
        if (t.tobeTable && t.status === 'success') tables.add(t.tobeTable);
      }
    }
    useExecutionPreflightStore.getState().syncSelectedFromExecution(project.id, [...tables]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinnedSnapshot?.id, project?.id]);

  /* 実行履歴: real は BE fetch、demo は既存 mock. project が未確定なら disabled.
     polling 은 activeRunId 와 무관하게 항상 — 다른 사용자가 시작한 run 을 감지해야
     하므로 (아래 adopt-running effect). 이전엔 activeRunId 없으면 polling 정지 →
     타인 run 이 영영 안 보였음 (2026-06-03). */
  const runHistoryQuery = useQuery<RunHistoryDto[]>({
    queryKey: ['run-history', projectIdForReset],
    enabled: !!projectIdForReset,
    queryFn: () => runsApi.listByProject(projectIdForReset!),
    staleTime: 5_000,
    refetchInterval: 5_000,
  });
  const runHistoryData = runHistoryQuery.data;

  /* 델타 버튼 게이트 — "초기 전량적재가 한 번이라도 성공했나"(불변 사실)로 판정한다.
     ※ '전 테이블 최신 run success(run-readiness)' 로 걸면, 델타 run 이 한 번 실패한 순간
     최신 run 이 failed 가 되어 버튼이 잠기고, 다시 열려면 초기적재를 재실행해야 하는 문제가 있었음.
     초기적재(=non-delta full run) 성공 이력은 사라지지 않으므로, 델타가 실패해도 재시도 가능. */
  const initialLoadDone = (runHistoryData ?? []).some(
    (r) => r.runType !== 'delta' && r.status === 'success',
  );

  /* pin 切替 effect: pin の id が actually 変わったら新 pin の executionContext.runId に同期.
     ・新 pin に박제あり → その run を ACTIVE RUN として描画 (= pin 中心メンタルモデル)
     ・新 pin に박제なし → null = NO ACTIVE RUN
     ・Discard 済み pin の場合は活性化しない.
     ・初回マウント時の persisted activeRunId 扱い: その run が **現在の pin と紐づく** (= run.snapshotId
       が現 pin.id と一致) なら尊重 ─ 「running 中 → ページ遷移 → 戻る」のとき新 run id が pin の
       executionContext (まだ未更新) に巻き戻るのを防ぐ. 紐づかなければ pin の executionContext.runId
       で初期化 ─ 別 pin で起動した古い run id が残り続けるのを防ぐ.
     ※ runHistoryData 参照のため宣言後にここに置く. ref は上で宣言済み.
     (2026-05-31 fix: 旧版は紐づかない場合も尊重していたため pin 切替後に前 pin の run が残った.) */
  useEffect(() => {
    if (!project) return;
    const currentPinId = pinnedSnapshot?.id ?? null;
    const isInitialSet = prevPinIdRef.current === undefined;

    // 初回判定は run history fetch を待つ (snapshotId 照合に必要).
    if (isInitialSet && runHistoryData === undefined) return;

    const pinChanged = !isInitialSet && prevPinIdRef.current !== currentPinId;
    prevPinIdRef.current = currentPinId;

    if (pinnedSnapshot && pinnedSnapshot.id === discardedSnapshotId) return;
    const expectedRunId = pinnedSnapshot?.executionContext?.runId ?? null;

    if (isInitialSet) {
      // persisted activeRunId が現在 pin に紐づくなら尊重 (running 中の救済). それ以外は initialize.
      if (activeRunId != null && runHistoryData) {
        const r = runHistoryData.find((rh) => rh.id === activeRunId);
        if (r && r.snapshotId === currentPinId) return;
      }
      if (activeRunId !== expectedRunId) {
        setActiveRunId(expectedRunId);
      }
      return;
    }

    if (!pinChanged) return;
    if (activeRunId !== expectedRunId) {
      setActiveRunId(expectedRunId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinnedSnapshot?.id, project?.id, discardedSnapshotId, runHistoryData]);

  /* 他ユーザー/他 PC が開始した run の可視化 (2026-06-03) — activeRunId 는 localStorage
     (zustand persist) 기반이라 run 을 시작한 브라우저에만 존재. 타인은 pin 의 frozen
     context 만 보게 돼 run id / 시작 시간 / 경과 시간이 안 보였다. run history polling
     에서 non-terminal run 을 발견하면 채택 — 모두가 같은 ACTIVE RUN 을 본다.
     pin-sync effect 보다 뒤에 선언 (같은 commit 내에서 이쪽이 이긴다). */
  useEffect(() => {
    if (!project || !runHistoryData) return;
    const running = runHistoryData.find((r) => !isTerminal(r.status));
    if (running && activeRunId !== running.id) {
      setActiveRunId(running.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runHistoryData, project?.id]);

  /* Cutover review state (정책 4·8 — 2026-06-01).
     Cutover Start 버튼 클릭 직후 rehearsal phase 의 ack 된 group 목록을 review modal 에 표시.
     운영자가 group 별 confirm/reject 후 [Confirm & Start cutover] → startrun + confirmCutoverReview.
     ※ 반드시 아래 early return 보다 위에 — 옛 위치 (early return 아래) 에서는 All projects
       클릭 (project → null) 시 hook 개수가 줄어 React #300 → #520 → window error 화면
       (2026-06-03 fix). */
  const [cutoverReviewOpen, setCutoverReviewOpen] = useState(false);
  const [cutoverReviewItems, setCutoverReviewItems] = useState<CutoverReviewItem[]>([]);
  const [cutoverReviewTables, setCutoverReviewTables] = useState<string[]>([]);

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

      // 자식 link binding 의 master project 의 binding + rules lookup 미리 fetch.
      // key = `${masterProjectId}|${schema}|${table}` (lowercase).
      const masterBindingHasSources: Record<string, boolean> = {};
      const masterRulesByKey: Record<string, import('../store/snapshots').FrozenRule[]> = {};
      const masterIds = new Set<string>();
      for (const b of snapshotData.bindings ?? []) {
        if (b.sharedFromProjectId) masterIds.add(b.sharedFromProjectId);
      }
      if (masterIds.size > 0) {
        for (const masterId of masterIds) {
          try {
            const [masterBindings, masterRules] = await Promise.all([
              mappingImportApi.listBindings(masterId),
              mappingImportApi.listRules(masterId),
            ]);
            for (const mb of masterBindings) {
              const key = `${masterId}|${(mb.tobeSchema ?? '').toLowerCase()}|${mb.tobeTable.toLowerCase()}`;
              masterBindingHasSources[key] = (mb.sources?.length ?? 0) > 0;
            }
            for (const r of masterRules) {
              const key = `${masterId}|${(r.tobeSchema ?? '').toLowerCase()}|${r.tobeTable.toLowerCase()}`;
              const arr = masterRulesByKey[key] ?? [];
              // MappingRuleDto → FrozenRule shape. preflight 가 사용하는 필드만 채움.
              arr.push({
                id: r.id,
                importId: r.importId,
                tobeSchema: r.tobeSchema,
                tobeTable: r.tobeTable,
                tobeColumn: r.tobeColumn,
                asisSchema: r.asisSchema,
                asisTable: r.asisTable,
                asisColumn: r.asisColumn,
                asisType: r.asisType,
                codeDomain: null,
                strategy: r.strategy,
                transformRule: r.transformRule,
                transformSql: r.transformSql,
                defaultValue: r.defaultValue,
                notNullOverride: r.notNullOverride,
                ruleOrigin: r.ruleOrigin,
                notes: r.notes,
                createdBy: null, createdAt: null, updatedBy: null, updatedAt: null,
              });
              masterRulesByKey[key] = arr;
            }
          } catch (e) {
            console.warn('[preflight] master mapping fetch failed', masterId, e);
          }
        }
      }

      const results = runPreflight({
        project, site, tobeSchema, asisSchema, snapshotData,
        selectedTables: tablesList,
        t,
        tobeDbReachable,
        csvFilesByAsisTable,
        masterBindingHasSources,
        masterRulesByKey,
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

  /* Execution 페이지 전체 컨트롤 (table 선택 / preflight / Start) 권한.
     master 또는 project assignee 본인만 — Execution 도 mapping 과 동일한 assignee
     (Site Overview 에서 지정한 그 project 의 담당자) 기준. 비권한자는 DisabledOverlay
     로 UI 잠그고 RunHeader 의 canStart 도 false 로.
     (executionAssignee 는 Execution Overview 의 일괄 실행 시 "누구 자리에서 run 할지"
      만 정하는 별개 필드 — 평소 Execution 권한과 무관.) */
  const isMyProject = !!user?.username && project?.assignee === user.username;
  const canControl = isMaster || isMyProject;

  /* Discard が「テーブル選択アンロック + 履歴片付け」を兼ねる役割なので, activeRun 表示中は
     TableSelector / Preflight をロックする (旧仕様維持). アンロックは Discard 経由.
     さらに executionAssignee 본인 또는 master 만 컨트롤 가능 — canControl 게이트. */
  const controlsLocked = displayedActiveRun !== null || !hasPinnedSnapshot || !canControl;

  /* Real モードの run 起動本体 — start API 呼び出し + runId 保存.
     handleStartRun(二重起動 guard 経由) と handleRetry(guard なしで再起動 + resumeFromRunId) が共有.
     opts.resumeFromRunId 있으면 BE 가 옛 run 의 마지막 success stage 이후부터 재개 (parquet 복원). */
  const startRealRun = async (tables: string[], mode: RunMode,
                              opts?: { resumeFromRunId?: string }) => {
    try {
      const result = await runsApi.start(project.id, mode, tables, opts);
      if (result.status === 'STARTED' && result.runId) {
        setActiveRunId(result.runId);
        /* run history を即時 refetch — staleTime/refetchInterval (5s) の遅延で
           runs.findIndex(activeRunId) が -1 になり #N 表示が最大 5 秒遅れるのを回避. */
        void queryClient.invalidateQueries({ queryKey: ['run-history', project.id] });
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

  const closeCutoverReview = () => {
    setCutoverReviewOpen(false);
    setCutoverReviewItems([]);
    setCutoverReviewTables([]);
  };

  /** Confirm & Start — startrun 직후 즉시 cutover-review 전송. */
  const handleCutoverReviewConfirm = async (confirmed: Set<string>, note: string | null) => {
    if (!runMode) return;
    const tables = cutoverReviewTables;
    try {
      const result = await runsApi.start(project.id, runMode, tables);
      if (result.status !== 'STARTED' || !result.runId) {
        console.warn('[execution] cutover startRun rejected:', result.status, result.reason);
        alert(`Start rejected: ${result.status}\n${result.reason ?? ''}`);
        return;
      }
      setActiveRunId(result.runId);
      void queryClient.invalidateQueries({ queryKey: ['run-history', project.id] });
      // review 전송 — runId 받자마자 즉시. validation stage 실행 전 cutover ack 가 DB 에 적재되어야 함.
      const body: CutoverReviewRequest = {
        groups: cutoverReviewItems.map((it) => ({
          bindingId: it.bindingId,
          ruleName: it.ruleName,
          reason: it.reason,
          csvMtimeMs: null,
          csvSize: null,
          confirmed: confirmed.has(it.bindingId + '|' + it.ruleName + '|' + it.reason),
        })),
        note,
      };
      await quarantineAckApi.confirmCutoverReview(result.runId, body);
      closeCutoverReview();
    } catch (e) {
      console.error('[execution] cutover review failed:', e);
      throw e; // modal 이 표시
    }
  };

  const handleStartRun = async () => {
    if (!preflightPassed || selectedTables.size === 0) return;
    if (!hasPinnedSnapshot || !pinnedSnapshot) return;
    if (!runMode) return;

    const tables = Array.from(selectedTables);

    /* BE에 start 던지고 반환 runId 보존. polling은 usePipelineProgress가 자동 시작.
       project.runStatus / phase는 BE의 RunService가 갱신 → AppShell의 10s polling으로 sidebar 반영. */
    /* 이중 기동 방지 — 진행 중(running/paused) 인 run 일 때만 차단.
       halted (success/failed/aborted/timed_out) 면 같은 버튼이 'Start over' 로 노출되며
       새 run 시작 허용. 이전엔 activeRunId 만 체크해서 Start over 가 항상 noop 이었음 (2026-05-29 수정). */
    if (activeRunId && run && !isTerminal(run.status)) return;

    /* Cutover 전 review (정책 4·8) — rehearsal phase 의 ack 된 group 들을 가져와
       운영자가 group 별 confirm/reject. ack 없으면 review skip 하고 바로 start. */
    if (runMode === 'cutover') {
      const latestRehearsal = runs.find(
        (r) => r.runType === 'rehearsal' && (r.result === 'ok' || r.status === 'completed'),
      );
      if (latestRehearsal) {
        try {
          const groups = await quarantineApi.byRun(latestRehearsal.id);
          const items = buildReviewItems(groups);
          if (items.length > 0) {
            setCutoverReviewItems(items);
            setCutoverReviewTables(tables);
            setCutoverReviewOpen(true);
            return; // modal 의 Confirm 핸들러가 실제 start.
          }
        } catch (e) {
          console.warn('[execution] cutover review fetch failed — proceeding without review:', e);
        }
      }
    }

    if (activeRunId) setActiveRunId(null);  // halted run UI 정리 후 새 run.
    setDiscardedSnapshotId(null);  // 新 run 起動で Discard 状態クリア (次の run 結果は通常通り表示).
    await startRealRun(tables, runMode);
  };

  // handlePauseToggle 제거 (2026-05-29) — Pause 영구 제거. Stop + Retry 가 기능 동치.

  const handleRetry = async () => {
    /* Retry = 실패한 run 의 **마지막 success stage 이후부터** 재개. BE 가 정합성 검증
       (snapshot / selectedTables 동일 + 옛 parquet 존재) → 자동 fallback 처음부터 if 부적합.
       opts.resumeFromRunId 로 옛 run id 전달. handleStartRun 의 guard 우회 위해 직접 호출. */
    if (!canRetry) return;
    if (!runMode || selectedTables.size === 0) return;
    const oldRunId = activeRunId;   // null 가능 — 그 경우 처음부터.
    setActiveRunId(null);
    setDiscardedSnapshotId(null);  // 同上.
    await startRealRun(Array.from(selectedTables), runMode,
        oldRunId ? { resumeFromRunId: oldRunId } : undefined);
  };

  const handleDiscard = () => {
    if (!canDiscard) return;
    /* halted run の表示をヘッダーから片付ける + pin 박제 fallback も殺す.
       BE の run 자체는 history 에 남으므로 영향 없음. discardedSnapshotId 로 pin 切替 effect 의
       재 注入을 막고, pin 을 別 snapshot 으로 옮기면 자동 reset. */
    setActiveRunId(null);
    if (pinnedSnapshot) setDiscardedSnapshotId(pinnedSnapshot.id);
  };

  // Stop 권한: 자기 project 인 assignee 본인은 자기 run 을 stop 가능. 단 그 run 이
  // master 가 /runs/all 로 일괄 시작한 bulk run (metadata.bulk === true) 이면 master 만.
  // master 는 모든 경우 stop 가능. (isMyProject / canControl 는 위 controlsLocked
  // 정의 직전 블록 참조.)
  const runIsBulk = run?.metadata != null && (run.metadata as Record<string, unknown>).bulk === true;
  const canStop = isMaster || (isMyProject && !runIsBulk);
  /* Retry / Discard — terminal(failed/timed_out/aborted) run 의 복구라 bulk 여부와 무관하게
     assignee 본인(isMyProject)도 가능해야 한다. 이전엔 canStop(=bulk run 이면 master 한정)을
     그대로 써서, master 가 /runs/all 로 일괄 시작한 run 이 실패하면 배정된 worker 가 자기 run 을
     Resume/Discard 못 하고 "Run failed …" 만 보였다 (2026-06-11 수정). bystander(타 worker)는
     isMyProject=false 라 여전히 못 함 — assignee 본인만 자기 실패 run 복구. */
  const canRetry = isMaster || isMyProject;
  const canDiscard = isMaster || isMyProject;

  const handleStopRun = async () => {
    if (!canStop) return;
    if (!activeRunId) return;
    if (run && isTerminal(run.status)) return; // 既に terminal 이면 무시
    try {
      await runsApi.abort(activeRunId, t('execution.run.abortReason'));
    } catch (e) {
      console.warn('[execution] abort failed:', e);
      alert(`Abort failed: ${e instanceof Error ? e.message : 'unknown error'}`);
    }
  };

  /* CDC 델타(증분) 수동 트리거 — 운영은 외부 스케줄러가 API 로 자동 실행하지만, 테스트·시연용
     수동 버튼. phase/preflight/runMode 게이트를 타지 않는다(델타는 컷오버 이후 lifecycle).
     선택 테이블이 있으면 그 테이블만, 없으면 전체. BE 가 runType=delta 로 병합 적재. */
  const handleStartDelta = async () => {
    if (!canControl) return;
    if (!initialLoadDone) return;   // 초기 전량적재(전 테이블 최신 run success) 후에만
    if (activeRunId && run && !isTerminal(run.status)) return;   // 진행 중이면 차단
    const tables = selectedTables.size > 0 ? Array.from(selectedTables) : undefined;
    if (!window.confirm(t('execution.run.deltaConfirm'))) return;
    try {
      const result = await runsApi.start(project.id, 'delta', tables);
      if (result.status === 'STARTED' && result.runId) {
        if (activeRunId) setActiveRunId(null);
        setActiveRunId(result.runId);
        void queryClient.invalidateQueries({ queryKey: ['run-history', project.id] });
      } else {
        alert(`Delta start rejected: ${result.status}\n${result.reason ?? ''}`);
      }
    } catch (e) {
      alert(`Delta start failed: ${e instanceof Error ? e.message : 'unknown error'}`);
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
        pinLastRunId={pinnedSnapshot?.executionContext?.runId ?? null}
        preflightPassed={preflightPassed}
        hasPinnedSnapshot={hasPinnedSnapshot}
        selectedTablesCount={selectedTables.size}
        onStart={handleStartRun}
        onStop={handleStopRun}
        canStop={canStop}
        canRetry={canRetry}
        canDiscard={canDiscard}
        canControl={canControl}
        onRetry={handleRetry}
        onDiscard={handleDiscard}
      />
      {/* CDC 델타(증분) 수동 트리거 — 테스트·시연용. 운영은 외부 스케줄러가 API 로 자동 실행.
          phase/preflight 게이트 밖의 별도 버튼(델타는 컷오버 이후 lifecycle). */}
      {canControl && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
          margin: '8px 0', padding: '8px 12px', borderRadius: 4,
          border: '1px dashed var(--border-strong)', background: 'var(--panel-2)',
        }}>
          <span style={{ fontSize: 11.5, color: 'var(--text-3)', fontFamily: 'var(--mono)' }}>
            {initialLoadDone ? t('execution.run.deltaHint') : t('execution.run.deltaBlocked')}
          </span>
          <button
            type="button"
            onClick={() => { if (initialLoadDone) handleStartDelta(); }}
            disabled={!initialLoadDone}
            title={initialLoadDone ? t('execution.run.deltaHint') : t('execution.run.deltaBlocked')}
            style={initialLoadDone ? {
              padding: '6px 14px', background: 'var(--navy)', color: '#fff',
              border: '1px solid var(--navy)', borderRadius: 4, fontSize: 12.5, fontWeight: 600,
              cursor: 'pointer', whiteSpace: 'nowrap',
            } : {
              padding: '6px 14px', background: 'var(--panel)', color: 'var(--text-3)',
              border: '1px solid var(--border-strong)', borderRadius: 4, fontSize: 12.5, fontWeight: 600,
              cursor: 'not-allowed', whiteSpace: 'nowrap', opacity: 0.6,
            }}
          >
            ▶ {t('execution.run.startBtn.delta')}
          </button>
        </div>
      )}
      {/* TO-BE DB 실시간 단절 경고 — run 진행 중인데 target env 가 unreachable 이면 즉시 red 배너.
          (CheckStage 의 1회 ping 만으로는 중간 단절을 못 잡던 갭을 메움.) */}
      {(() => {
        const eh = tobeHealth?.[site.environment];
        const runActive = !!run && !isTerminal(run.status);
        if (!runActive || !eh || eh.reachable) return null;
        return (
          <div style={{
            padding: '8px 14px', margin: '8px 0', borderRadius: 4,
            background: 'var(--red-50)', border: '1px solid var(--red)',
            fontSize: 12, color: 'var(--red)', display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600,
          }}>
            <span>⛔</span>
            <span>{t('execution.run.tobeDbDown', { env: site.environment })}</span>
            {eh.message && (
              <span style={{ fontWeight: 400, color: 'var(--text-3)', fontFamily: 'var(--mono)', fontSize: 11 }}>
                {eh.message}
              </span>
            )}
          </div>
        );
      })()}
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
        />
      </DisabledOverlay>
      <OverallProgress t={t} stages={stages} />
      {/* run 은 running 인데 stage 데이터가 전혀 없으면 — Worker 미응답/큐 대기 상태를
          사용자가 구분 못 하던 문제 (2026-06-03). 대기 hint 를 명시 표시. */}
      {run && !isTerminal(run.status) && (!stageViews || stageViews.length === 0) && (
        <div style={{
          padding: '8px 14px', margin: '8px 0', borderRadius: 4,
          background: 'var(--amber-50)', border: '1px solid var(--amber)',
          fontSize: 12, color: 'var(--text-2)', display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span>⏳</span>
          <span>{t('execution.run.waitingForWorker')}</span>
        </div>
      )}
      {/* key = project:run — expanded(펼침) state 를 프로젝트/run 별로 분리 (#6-2).
          전엔 PipelineStages 인스턴스가 프로젝트 전환에도 유지돼 A 에서 펼친 Validation 이
          B 로 가도 펼쳐진 채로 남았다. key 변경 시 remount → 펼침 초기화. */}
      <PipelineStages key={`${project.id}:${run?.id ?? 'norun'}`} t={t} stages={stages} stageViews={stageViews ?? undefined} quarantineByTable={quarantineByTable} />
      {/* Cutover review modal (정책 4·8 — 2026-06-01). cutover Start 시 rehearsal ack
          목록을 운영자가 confirm/reject 후 [Confirm & Start] → startrun + review 전송. */}
      <CutoverReviewModal
        open={cutoverReviewOpen}
        items={cutoverReviewItems}
        onConfirm={handleCutoverReviewConfirm}
        onClose={closeCutoverReview}
      />
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
  t, project, site, runMode, activeRun, runs, pinLastRunId, preflightPassed, hasPinnedSnapshot,
  selectedTablesCount, onStart, onStop, canStop, canRetry, canDiscard, canControl, onRetry, onDiscard,
}: {
  t: T;
  project: Project;
  site: Site;
  runMode: RunMode | null;
  activeRun: ActiveRunState | null;
  runs: Run[];
  /** pin の executionContext.runId — Discard 直後の LAST RUN 表示に使う. null なら pin に박제なし. */
  pinLastRunId: string | null;
  preflightPassed: boolean;
  hasPinnedSnapshot: boolean;
  selectedTablesCount: number;
  onStart: () => void;
  onStop: () => void;
  /** Stop 권한 — assignee 본인은 자기 run stop 가능, 단 bulk run (master 가 일괄 시작) 은 master 만. */
  canStop: boolean;
  /** Retry / Discard 도 Stop 과 동일 권한 (master 또는 assignee 본인 + non-bulk). */
  canRetry: boolean;
  canDiscard: boolean;
  /** Start 권한 — master 또는 executionAssignee 본인만. */
  canControl: boolean;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  const canStart = canControl && preflightPassed && selectedTablesCount > 0 && hasPinnedSnapshot && runMode !== null;
  const isDone = project.phase === 'done';

  /* run 에 미승인 WARN group 이 있으면 상태를 completed 대신 warning 으로 표시.
     Log Viewer 에서 Acknowledge 하면 ack=non-null → warningPending=false → completed 로 자동 전환. */
  const { data: ackGroups } = useQuery({
    queryKey: ['exec-ack-groups', activeRun?.runId],
    enabled: !!activeRun?.runId && activeRun.runStatus === 'completed',
    queryFn: () => quarantineAckApi.listGroups(activeRun!.runId),
    refetchInterval: 5_000,
    staleTime: 2_000,
  });
  const warningPending = (ackGroups ?? []).some((g) => g.severity === 'warning' && !g.ack);

  const startTooltip = !canControl
    ? 'Only the assignee or master can start a run'
    : !hasPinnedSnapshot
      ? t('execution.run.startBlocked.noPin')
      : !runMode
        ? t('execution.run.startBlocked.phaseEnv', { phase: project.phase, env: site.environment })
        : !preflightPassed
          ? t('execution.run.startBlockedHint')
          : t('execution.run.startReadyHint');

  /* Start ボタンは no-active / halted 両方で出すので共有. */
  const startButton = !isDone && (
    <button
      type="button"
      onClick={() => { if (canStart) onStart(); }}
      disabled={!canStart}
      title={startTooltip}
      style={canStart ? styles.btnPrimary : styles.btnDisabled}
    >
      ▶ {runMode === 'cutover' ? t('execution.run.startBtn.cutover') : runMode === 'rehearsal' ? t('execution.run.startBtn.rehearsal') : t('execution.run.startBtn')}
    </button>
  );

  /* no-active ブランチに入るのは「pin なし」 or 「pin あり + 박제 run なし」or 「Discard 直後」.
     Discard 直後は pinLastRunId (= pin.executionContext.runId) を引いて LAST RUN として描画
     — 「ACTIVE RUN → アーカイブ化」のニュアンス. pin に박제なしなら NO ACTIVE RUN のみ.
     pin と無関係に走った run は Run History 画面で見る前提なのでヘッダーには出さない. */
  if (!activeRun) {
    const pinLastRun = pinLastRunId ? runs.find((r) => r.id === pinLastRunId) ?? null : null;

    if (!pinLastRun) {
      const hasHistory = runs.length > 0;
      return (
        <section style={styles.runHeader}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={styles.runHeaderLabel}>{t('execution.run.noActive')}</div>
            {!hasHistory && (
              <div style={styles.runHeaderMono}>{t('execution.run.noHistory')}</div>
            )}
          </div>
          {startButton}
        </section>
      );
    }

    /* LAST RUN ヘッダー — active 側と同じ 2 段構造で project.id · #N · status badge を出す. */
    const lastTone: BadgeTone =
      pinLastRun.result === 'failed'   ? 'err'
      : pinLastRun.result === 'aborted' ? 'warn'
      : pinLastRun.result === 'ok'     ? 'queued'
      : 'ok';
    const lastText =
      pinLastRun.result === 'failed'   ? t('execution.run.status.failed')
      : pinLastRun.result === 'aborted' ? t('execution.run.status.aborted')
      : pinLastRun.result === 'ok'     ? t('execution.run.status.completed')
      : t('execution.run.status.running');
    const lastRunIdx = runs.findIndex((r) => r.id === pinLastRun.id);
    const lastRunNumber = lastRunIdx >= 0 ? runs.length - lastRunIdx : null;
    return (
      <section style={styles.runHeader}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={styles.runHeaderLabel}>{t('execution.run.lastLabel')}</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 16, fontWeight: 600 }}>
              {project.id}{lastRunNumber != null ? ` · #${lastRunNumber}` : ''}
            </span>
            <StatusBadge tone={lastTone}>{lastText}</StatusBadge>
          </div>
          <div style={{ fontSize: 10.5, color: 'var(--text-3)', fontFamily: 'var(--mono)', marginTop: 3 }}>
            <span>run </span><b style={{ color: 'var(--text-2)' }}>{pinLastRun.id}</b>
            <span> · </span>{pinLastRun.startedAt}
          </div>
        </div>
        {startButton}
      </section>
    );
  }

  const isCompleted = activeRun.runStatus === 'completed';
  const isFailed = activeRun.runStatus === 'failed';
  const isAborted = activeRun.runStatus === 'aborted';
  const isHalted = isCompleted || isFailed || isAborted;
  const running = activeRun.runStatus === 'running';
  /* elapsed: BE 真値 기반 wall-clock(시작~정지/현재). 신뢰할 ETA 없으므로 미표시. */
  const elapsedMs = Math.max(0, (activeRun.haltedAt ?? Date.now()) - activeRun.startedAt);
  const elapsedLabel = t('execution.run.elapsed', {
    time: formatTimeOfDay(activeRun.startedAt),
    elapsed: formatDuration(elapsedMs),
  });

  const isWarning = isCompleted && warningPending;
  const statusChipTone: BadgeTone =
    isFailed ? 'err'
    : isWarning ? 'warn'
    : isAborted ? 'warn'
    : isCompleted ? 'queued'
    : 'ok';
  const statusChipText =
    isFailed ? t('execution.run.status.failed')
    : isWarning ? t('execution.run.status.warning')
    : isAborted ? t('execution.run.status.aborted')
    : isCompleted ? t('execution.run.status.completed')
    : t('execution.run.status.running');

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
            <b style={{ color: 'var(--text-2)' }}>{activeRun.requestedBy || project.executionAssignee || 'Admin'}</b>
            <span> · {t('execution.run.tablesSummary', { n: activeRun.tableScopeCount })}</span>
          </div>
        </div>
        {/* halted 時のボタン: failed/aborted = Discard + Retry / completed = Discard のみ.
            新規 Start run は Discard 後の no-active ブランチで出る.
            canDiscard / canRetry 권한 가드 — bystander 가 他人の run 을 rewind / abort 못 하도록. */}
        {isHalted && canDiscard && (
          <button
            type="button"
            onClick={onDiscard}
            style={{ ...styles.btnDanger, padding: '6px 14px', minWidth: 80 }}
            title={t('execution.run.discardHint')}
          >
            {t('execution.run.discard')}
          </button>
        )}
        {(isFailed || isAborted) && canRetry && (
          <button
            type="button"
            onClick={onRetry}
            style={{ ...styles.btnPrimary, minWidth: 80 }}
            title={t('execution.run.retryHint')}
          >
            ↻ {t('execution.run.retry')}
          </button>
        )}
        {running && canStop && (
          <button type="button" onClick={onStop} style={styles.btnDanger}>
            ⏹ {t('execution.run.stop')}
          </button>
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
  t, checks, phase, isStale, canStart, startDisabledReason, onStart,
}: {
  t: T;
  checks: PreflightCheck[];
  phase: PreflightPhase;
  isStale: boolean;
  canStart: boolean;
  startDisabledReason: string;
  onStart: () => void;
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
        {/* Reset 버튼 제거 (2026-05-29). Pre-flight 검사 자체가 idempotent — 재실행 가능. */}
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
  // 파이프라인 전체가 끝나야 완료 segment 가 어두워진다 (#59).
  const complete = isPipelineComplete(stages);
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
                background: stageFillColor(st.tone, complete),
                // transition 제거 — JavaFX WebView (WebKit ~v608) 에서 빠른 polling +
// width 변경이 compositing layer 재구성 폭주를 일으켜 native crash 유발.
// 즉시 갱신으로 안전성 우선.
transition: 'none',
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

function PipelineStages({ t, stages, stageViews, quarantineByTable }: {
  t: T; stages: Stage[];
  stageViews?: StageView[];
  quarantineByTable?: Map<string, QuarantineGroup[]>;
}) {
  /* 펼친 stage id. failed table 이 있는 stage 만 펼침 가능 — 클릭 시 그 stage 의
     table 목록 + failed table 의 에러 상세 (quarantine) 를 inline 표시. */
  const [expanded, setExpanded] = useState<string | null>(null);
  const viewByKey = useMemo(() => {
    const m = new Map<string, StageView>();
    for (const sv of stageViews ?? []) m.set(sv.stageKey, sv);
    return m;
  }, [stageViews]);

  // 파이프라인 전체 종료 여부 — 완료 segment 의 밝음/어두움 결정 (#59).
  const complete = isPipelineComplete(stages);

  return (
    <div style={{ ...styles.section, background: 'var(--panel)' }}>
      <div style={{ padding: '14px 18px' }}>
        <div style={{ ...styles.sectionLabel, marginBottom: 8 }}>{t('execution.stages.title')}</div>
        <div style={{ border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden', background: 'var(--panel)' }}>
          {stages.map((st, i) => {
            const sv = viewByKey.get(st.id);
            const failedCount = sv?.tablesFailed ?? 0;
            const hasFailed = failedCount > 0 && !!sv?.tables?.length;
            // warn tone = failed_with_pending_warnings. 경고 종료 stage 도 클릭해 원인(quarantine warning) 표시 (#6-1).
            const warnTables = (st.tone === 'warn' && sv?.tables?.length)
              ? sv.tables.filter((tr) =>
                  (quarantineByTable?.get((tr.tobeTable ?? '').toLowerCase()) ?? []).some((g) => g.severity === 'warning'))
              : [];
            const isWarn = st.tone === 'warn' && !!sv?.tables?.length;
            const warnCount = warnTables.length;
            // warn stage 는 보여줄 warning quarantine 이 있을 때만 펼침 가능. validation 의
            // checksum WARN 등은 quarantine 을 만들지 않으므로 클릭해도 열리지 않는다
            // (상세는 Artifacts 의 Validation report). 빈 "상세 없음" 박스를 없앤다.
            const expandable = hasFailed || (isWarn && warnCount > 0);
            const isOpen = expanded === st.id;
            return (
            <Fragment key={st.id}>
            <div
              onClick={expandable ? () => setExpanded(isOpen ? null : st.id) : undefined}
              style={{
                display: 'grid',
                gridTemplateColumns: '24px 170px 1fr 80px 90px 80px',
                gap: 14, alignItems: 'center',
                padding: '10px 14px',
                cursor: expandable ? 'pointer' : 'default',
                borderBottom: i < stages.length - 1 ? '1px solid var(--border)' : 'none',
                /* Pipeline 박스 배경 — B3 배지 톤과 일관 (2026-06-04):
                   ok=green-50 / running=navy-50 / err=red-50 / warn=amber-50 / idle=panel (배경 없음). */
                background:
                  st.tone === 'ok' ? 'var(--green-50)'
                  : st.tone === 'running' ? 'var(--navy-50)'
                  : st.tone === 'err' ? 'var(--red-50)'
                  : st.tone === 'warn' ? 'var(--amber-50)'
                  : 'var(--panel)',
              }}
            >
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-4)' }}>{String(i + 1).padStart(2, '0')}</div>
              <div>
                <div style={{ fontWeight: 500, fontSize: 13 }}>
                  {st.name}
                  {hasFailed && (
                    <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--red)', fontFamily: 'var(--mono)' }}>
                      {isOpen ? '▾' : '▸'} {failedCount} failed
                    </span>
                  )}
                  {!hasFailed && isWarn && (
                    <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--amber)', fontFamily: 'var(--mono)' }}>
                      {isOpen ? '▾' : '▸'} {warnCount} warning{warnCount === 1 ? '' : 's'}
                    </span>
                  )}
                </div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-3)' }}>{st.sub}</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <ProgressBar
                  pct={st.pct}
                  tone={st.tone}
                  success={st.tablesSuccess}
                  failed={st.tablesFailed}
                  total={st.tablesTotal}
                  pipelineComplete={complete}
                />
                <div style={{ width: 44, textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-2)' }}>{st.pct.toFixed(0)}%</div>
              </div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--text-2)' }}>{st.rate}</div>
              {/* C4 (2026-06-04) — 기존 ETA 라벨 자리에 stage wall-clock 시간 표시.
                 elapsedMs = 완료 시 durationMs, 진행 중 시 now - startedAt. 대기 중은 "—". */}
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--text-3)' }}>
                {st.elapsedMs != null ? formatDuration(st.elapsedMs) : '—'}
              </div>
              <div>
                {/* B3 (2026-06-04) — tone 명명 swap 제거. badge tone 이름과 의미 일치:
                   ok(green) / running(navy) / err(red) / warn(amber) / queued(grey). */}
                {st.tone === 'ok' && <StatusBadge tone="ok">{t('execution.stages.status.done')}</StatusBadge>}
                {st.tone === 'running' && <StatusBadge tone="running">{t('execution.stages.status.live')}</StatusBadge>}
                {st.tone === 'err' && <StatusBadge tone="err">{t('execution.stages.status.failed')}</StatusBadge>}
                {st.tone === 'warn' && <StatusBadge tone="warn">{t('execution.stages.status.awaitingReview')}</StatusBadge>}
                {st.tone === 'idle' && <StatusBadge tone="queued">{t('execution.stages.status.queued')}</StatusBadge>}
              </div>
            </div>
            {isOpen && sv && hasFailed && (
              <div style={{
                padding: '4px 14px 12px 62px',
                background: 'var(--red-50)',
                borderBottom: i < stages.length - 1 ? '1px solid var(--border)' : 'none',
              }}>
                {sv.tables.filter((tr) => tr.status === 'failed').map((tr) => {
                  const groups = quarantineByTable?.get((tr.tobeTable ?? '').toLowerCase()) ?? [];
                  return (
                    <div key={tr.tobeTable} style={{ marginTop: 8 }}>
                      <div style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600, color: 'var(--red)' }}>
                        ✗ {tr.tobeSchema ? `${tr.tobeSchema}.` : ''}{tr.tobeTable}
                      </div>
                      {groups.length === 0 ? (
                        <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2, fontStyle: 'italic' }}>
                          {errorDetailText(tr.errorDetail) ?? t('execution.stages.noErrorDetail')}
                        </div>
                      ) : groups.map((g) => (
                        <div key={g.id} style={{ marginTop: 4, paddingLeft: 8, borderLeft: '2px solid var(--red)' }}>
                          <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text)' }}>{g.reason}</div>
                          <div style={{ fontSize: 11, color: 'var(--text-2)', fontFamily: 'var(--mono)' }}>{g.detail}</div>
                          <div style={{ fontSize: 10.5, color: 'var(--text-3)', marginTop: 1 }}>
                            {g.stage} · {g.severity} · {g.sampleRows?.length ?? 0} sample{(g.sampleRows?.length ?? 0) === 1 ? '' : 's'}
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            )}
            {isOpen && sv && !hasFailed && isWarn && (
              <div style={{
                padding: '4px 14px 12px 62px',
                background: 'var(--amber-50)',
                borderBottom: i < stages.length - 1 ? '1px solid var(--border)' : 'none',
              }}>
                {warnTables.length === 0 ? (
                  <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 8, fontStyle: 'italic' }}>
                    {sv.errorSummary ?? t('execution.stages.noErrorDetail')}
                  </div>
                ) : warnTables.map((tr) => {
                  const groups = (quarantineByTable?.get((tr.tobeTable ?? '').toLowerCase()) ?? [])
                    .filter((g) => g.severity === 'warning');
                  return (
                    <div key={tr.tobeTable} style={{ marginTop: 8 }}>
                      <div style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600, color: 'var(--amber)' }}>
                        ⚠ {tr.tobeSchema ? `${tr.tobeSchema}.` : ''}{tr.tobeTable}
                      </div>
                      {groups.map((g) => (
                        <div key={g.id} style={{ marginTop: 4, paddingLeft: 8, borderLeft: '2px solid var(--amber)' }}>
                          <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text)' }}>{g.reason}</div>
                          <div style={{ fontSize: 11, color: 'var(--text-2)', fontFamily: 'var(--mono)' }}>{g.detail}</div>
                          <div style={{ fontSize: 10.5, color: 'var(--text-3)', marginTop: 1 }}>
                            {g.stage} · {g.severity} · {g.sampleRows?.length ?? 0} sample{(g.sampleRows?.length ?? 0) === 1 ? '' : 's'}
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            )}
            </Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── Shared atoms ────────────────────────── */

function StatusBadge({ tone, children }: { tone: BadgeTone; children: React.ReactNode }) {
  /* B3 정리 (2026-06-04, 사용자 확인: 디자이너 의도 없음):
   * 이전: running=amber 라 warn 과 같은 색이라 진행 중인지 검토 대기인지 시각 구분 모호.
   * 이후: running=navy(파랑) — "live = 진행 중" 의미 직관적, warn(amber) 와 명확 구분.
   * queued(grey) / warn(amber) / err(red) / ok(green) / info(navy) 5색 의미 일관. */
  const palette: Record<BadgeTone, { bg: string; fg: string; bd: string }> = {
    ok:      { bg: 'var(--green-50)',  fg: 'var(--green)',  bd: 'var(--green)' },
    running: { bg: 'var(--navy-50)',   fg: 'var(--navy)',   bd: 'var(--navy)' },
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

/**
 * Stage 의 success/failed 비율을 시각적으로 분할 표시.
 * - success → green segment
 * - failed  → red segment
 * - pending → bar background grey (빈 공간)
 *
 * total 또는 success/failed 정보 없으면 fallback = 단색 fill (stageFillColor #6-4:
 * running 밝은 green / done 어두운 green / failed·warning red / idle amber).
 */
function ProgressBar({
  pct, tone, success, failed, total, pipelineComplete = true,
}: {
  pct: number;
  tone: StageTone;
  success?: number;
  failed?: number;
  total?: number;
  /** 파이프라인 전체 종료 여부 — success segment 의 밝음(진행 중)/어두움(완료) 결정 (#59). */
  pipelineComplete?: boolean;
}) {
  const hasSegments = typeof total === 'number' && total > 0
    && typeof success === 'number' && typeof failed === 'number';
  if (hasSegments) {
    const successPct = (success! / total!) * 100;
    const failedPct = (failed! / total!) * 100;
    return (
      <div style={{ flex: 1, height: 6, background: 'var(--border)', borderRadius: 2, overflow: 'hidden', display: 'flex' }}>
        <div style={{ width: `${successPct}%`, height: '100%', background: successFillColor(pipelineComplete), transition: 'width .4s ease' }} />
        <div style={{ width: `${failedPct}%`, height: '100%', background: 'var(--red)', transition: 'width .4s ease' }} />
      </div>
    );
  }
  // Fallback (total 미상 / running 중 데이터 없음) — 단색 fill.
  return (
    <div style={{ flex: 1, height: 6, background: 'var(--border)', borderRadius: 2, overflow: 'hidden' }}>
      <div style={{ width: `${Math.min(pct, 100)}%`, height: '100%', background: stageFillColor(tone, pipelineComplete), transition: 'width .4s ease' }} />
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
 * BE 側 `RunService.resolveRunTypeFromPhase` と一致させる (2026-05-29 update):
 *   - production + ready             → cutover (本番移行)
 *   - production + その他            → null   (本番では ready のみ実行可)
 *   - non-prod   + sign-off          → rehearsal (sign-off で Run = rehearsal 進行)
 *   - non-prod   + rehearsal         → rehearsal
 *   - non-prod   + cutover/hypercare/done → null (既に走っている / 終了済)
 *   - non-prod   + その他            → test (planning / analysis / test / ready
 *                                            preflight 通れば起動可)
 */
function deriveRunMode(phase: ProjectPhase, env: ProjectEnvironment): RunMode | null {
  if (env === 'production') {
    return phase === 'ready' ? 'cutover' : null;
  }
  /* non-prod: cutover 以降は全部 block (実行中 / 終了後). */
  if (phase === 'sign-off') return 'rehearsal';
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
