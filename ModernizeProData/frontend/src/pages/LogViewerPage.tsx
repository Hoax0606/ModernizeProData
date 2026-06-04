import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useQuery } from '@tanstack/react-query';
import { useWorkspaceStore } from '../store/workspace';
import { useT } from '../i18n';
import {
  levelName,
  runLogApi,
  type RunLogLevel,
  type RunLogLine,
} from '../api/runLogs';
import { runsApi, type RunHistoryDto, type RunTableResult } from '../api/runs';
import { quarantineApi } from '../api/quarantine';
import { quarantineAckApi, type RunPhase, type QuarantineGroupAck, type AckHistoryEntry } from '../api/quarantineAck';
import { useSnapshotsStore, usePinnedSnapshotsStore } from '../store/snapshots';
import { formatTimestamp, formatTimeMs, formatDuration } from '../lib/formatters';
import { stageColor } from './logViewerMock';
import {
  humanizeQuarantineDetail,
  quarantineRowAsIs,
  quarantineRowToBe,
  quarantineRowPk,
  quarantinePkColumnName,
  quarantineViolatedColumnName,
  type QuarantineGroup,
  type QuarantineSeverity,
} from './quarantineMock';
import { Modal } from '../components/Modal';
import { useActiveProjectReadOnly } from '../store/readOnly';

/**
 * Log viewer — 프로젝트 실행 로그 조회.
 *
 *  activeProjectId 의 최근 run 의 runId 를 listByProject 로 자동 결정.
 *  runLogApi.list 로 line stream, quarantineApi.byRun 로 group 데이터 fetch.
 */

const ROW_ESTIMATE = 22;
const LOG_FETCH_LIMIT = 1000;

export function LogViewerPage() {
  const t = useT();
  const navigate = useNavigate();
  // read-only project = quarantine acknowledge / re-review 차단. 보기/필터는 허용.
  const readOnly = useActiveProjectReadOnly();
  const projects = useWorkspaceStore((s) => s.projects);
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const project = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId],
  );
  /** project 의 최근 run — useQuery 로 5s 폴링 + window focus refetch + WS invalidate 와 키 공유.
     mount 후 새 run 起動되면 자동으로 최신 run 의 로그·quarantine 으로 전환된다. */
  const { data: runHistory } = useQuery<RunHistoryDto[]>({
    queryKey: ['run-history', activeProjectId],
    enabled: !!activeProjectId,
    queryFn: () => runsApi.listByProject(activeProjectId!),
    refetchInterval: 5_000,
    refetchOnWindowFocus: true,
    staleTime: 2_000,
  });
  /* runHistory 가 비었거나 아직 로딩 중일 때 활성 snapshot 의 박제된 executionContext.runId
     로 fallback. 활성 snapshot 우선순위: (1) pinned, (2) 가장 최근 mapping. 사용자가 pin 을
     옛 snapshot 으로 옮기면 그 snapshot 의 logs 가 자동으로 보인다.
     박제 안 된 snapshot 이면 runId 가 '' → empty state 표시 (사용자 결정). */
  const snapshots = useSnapshotsStore((s) => s.snapshots);
  const fetchSnapshots = useSnapshotsStore((s) => s.fetchByProject);
  const pinnedIds = usePinnedSnapshotsStore((s) => s.pinnedIds);
  useEffect(() => {
    if (activeProjectId) void fetchSnapshots(activeProjectId);
  }, [activeProjectId, fetchSnapshots]);
  const snapshotFallbackRunId = useMemo(() => {
    const projectMapping = snapshots.filter(
      (s) => s.projectId === activeProjectId && s.type === 'mapping',
    );
    const pinned = projectMapping.find((s) => pinnedIds.includes(s.id));
    const active = pinned
      ?? [...projectMapping].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return active?.executionContext?.runId ?? '';
  }, [snapshots, activeProjectId, pinnedIds]);
  /* 활성 snapshot 의 박제된 runId 가 있으면 그것 우선. 박제 없으면 — 그 snapshot 으로 한 번도
     run 안 됐다는 뜻이라 empty 가 맞다 (사용자 결정 — 다른 snapshot 의 run logs 가 잘못 보이면 안 됨).
     runHistory[0] (가장 최근 run) 은 fallback 으로도 안 씀: pin 을 옛 snapshot 으로 옮기면
     runHistory[0] 는 새 snapshot 의 run 이라 stale. */
  const runId = snapshotFallbackRunId;
  void runHistory; // useQuery 는 다른 부수효과 (WS invalidate 캐시 키) 를 위해 유지.

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [levelFilter, setLevelFilter] = useState<Record<RunLogLevel, boolean>>({
    INFO: true, WARN: true, ERROR: true,
  });
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  /** STEP(=stage) 필터. null = 전체, 문자열 = 그 stage 만. */
  const [stepFilter, setStepFilter] = useState<string | null>(null);
  /** Run History の drill-down 展開行 (複数同時展開可). */
  const [expandedRunIds, setExpandedRunIds] = useState<Set<string>>(new Set());
  const toggleExpandedRun = useCallback((runId: string) => {
    setExpandedRunIds((cur) => {
      const next = new Set(cur);
      if (next.has(runId)) next.delete(runId); else next.add(runId);
      return next;
    });
  }, []);
  /** 화면 모드. stream = 전체 로그 tail, quarantine = 규칙 위반 group 카드 뷰, history = run 履歴. */
  const [view, setView] = useState<'stream' | 'quarantine' | 'history'>('stream');
  /** Quarantine 화면의 severity 필터. */
  /* 'skip' = ack 된 WARN group. severity 와 별개 분류 — warning 카운트에서 제외. */
  const [severityFilter, setSeverityFilter] = useState<'all' | QuarantineSeverity | 'skip'>('all');
  /** 펼쳐진 (= 액션바 표시) group 의 id. 한 번에 하나만. 같은 카드 다시 클릭 → 접힘. */
  const [openGroupId, setOpenGroupId] = useState<string | null>(null);
  /** 우상단 group dropdown 선택 — null 이면 severity 결과 다 표시, id 면 그 group 만 표시 + 자동 펼침. */
  const [pickedGroupId, setPickedGroupId] = useState<string | null>(null);
  /** 테이블 dropdown 선택 — null 이면 전체 테이블, 문자열이면 그 테이블의 group 만. severity 와 AND 결합. */
  const [tableFilter, setTableFilter] = useState<string | null>(null);

  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedSearch(search), 200);
    return () => window.clearTimeout(id);
  }, [search]);

  /* ── 데이터 ─────────────────────────────────────── */
  /** runId 의 모든 RunLog line (최대 LOG_FETCH_LIMIT). runId 변경 시 자동 refetch. */
  const [allLines, setAllLines] = useState<RunLogLine[]>([]);
  useEffect(() => {
    if (!runId) { setAllLines([]); return; }
    runLogApi.list(runId, { limit: LOG_FETCH_LIMIT })
      .then((p) => setAllLines(p.lines))
      .catch((e) => { console.error('runLog fetch failed', e); setAllLines([]); });
  }, [runId]);

  /** Stream 모드 라인 — 검색/level/step 필터 적용. Quarantine 모드는 별도 데이터 소스(아래 groups)로 동작.
   *  stepFilter 매치는 정확 일치 또는 family prefix (예: 'validate' → 'validate.notnull') 둘 다 허용 —
   *  quarantine 점프 시 그룹의 dotted stage 가 stream 의 family 라인과 매칭되지 않는 문제 회피. */
  const lines = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    return allLines.filter((l) => {
      const name: RunLogLevel = l.level === 2 ? 'ERROR' : l.level === 1 ? 'WARN' : 'INFO';
      if (!levelFilter[name]) return false;
      if (stepFilter && l.stage !== stepFilter && !l.stage.startsWith(stepFilter + '.')) return false;
      if (!q) return true;
      return l.message.toLowerCase().includes(q) || l.stage.toLowerCase().includes(q);
    });
  }, [allLines, debouncedSearch, levelFilter, stepFilter]);

  /** Quarantine groups — runId 의 위반 row 묶음. useQuery 로 캐시 + 자동 refetch.
     runId 변경 시 자동 refetch. usePipelineProgress 의 WS invalidate('run-history') 와는
     별개 queryKey 라 직접 invalidate 안 받지만, 5s 폴링이 곧 따라잡음. */
  const { data: allGroupsData, refetch: refetchQuarantine } = useQuery<QuarantineGroup[]>({
    queryKey: ['quarantine', runId],
    enabled: !!runId,
    queryFn: () => quarantineApi.byRun(runId),
    refetchInterval: 5_000,
    staleTime: 2_000,
  });

  /* group 별 ack 상태 (carry-over 반영). ack 된 group 은 Quarantine 목록에서 숨김. */
  const { data: ackGroupsData, refetch: refetchAckGroups } = useQuery<QuarantineGroupAck[]>({
    queryKey: ['quarantine-ack', runId],
    enabled: !!runId,
    queryFn: () => quarantineAckApi.listGroups(runId),
    refetchInterval: 5_000,
    staleTime: 2_000,
  });
  /* ackGroupsData 는 carry-over visibility polling 용 — render 는 byRun 의 g.ack 직접 사용. */
  void ackGroupsData;

  /* WARN ack 시스템 (2026-06-01).
     runHistory 의 latest run 의 runType 을 ack phase 로 사용.
     runHistory 데이터 미도착 시 ack 버튼 미노출. */
  const latestRun = (runHistory ?? [])[0];
  const runPhase: RunPhase | null = latestRun
    ? (latestRun.runType as RunPhase)
    : null;

  /** Ack Modal state — 운영자가 [그룹 검토 완료] 클릭 → 이 modal 에서 메모 입력 후 저장.
      isRereview=true 면 carry-over 된 group 의 재검토 — 같은 modal 재사용, 제목/placeholder 만 동적. */
  const [ackTarget, setAckTarget] = useState<QuarantineGroup | null>(null);
  const [ackIsRereview, setAckIsRereview] = useState(false);
  const [ackPreviousNote, setAckPreviousNote] = useState<string | null>(null);
  const [ackNote, setAckNote] = useState('');
  const [ackBusy, setAckBusy] = useState(false);
  const [ackError, setAckError] = useState<string | null>(null);

  /** Ack history popover state — dim 카드의 (↗ history) 클릭 시 group 의 전체 ack 이력 표시.
      run history 의 historyRows 와 충돌 피하기 위해 ackHistory* prefix 사용. */
  const [ackHistoryTarget, setAckHistoryTarget] = useState<QuarantineGroup | null>(null);
  const [ackHistoryRows, setAckHistoryRows] = useState<AckHistoryEntry[]>([]);
  const [ackHistoryBusy, setAckHistoryBusy] = useState(false);
  const [ackHistoryError, setAckHistoryError] = useState<string | null>(null);
  const openAckHistory = useCallback(async (g: QuarantineGroup) => {
    if (!project || !g.bindingId) return;
    setAckHistoryTarget(g);
    setAckHistoryRows([]);
    setAckHistoryError(null);
    setAckHistoryBusy(true);
    try {
      const rows = await quarantineAckApi.history({
        projectId: project.id,
        bindingId: g.bindingId,
        ruleName: g.stage,
        reason: g.reason,
      });
      setAckHistoryRows(rows);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setAckHistoryError(t('logs.quarantine.ack.history.failed', { error: msg }));
    } finally {
      setAckHistoryBusy(false);
    }
  }, [project, t]);
  const closeAckHistory = useCallback(() => {
    setAckHistoryTarget(null);
    setAckHistoryRows([]);
    setAckHistoryError(null);
  }, []);

  const openAckModal = useCallback((g: QuarantineGroup) => {
    setAckTarget(g);
    setAckIsRereview(false);
    setAckPreviousNote(null);
    setAckNote('');
    setAckError(null);
  }, []);

  /** Re-review — 이미 ack 된 group 을 다시 검토. 새 ack row 추가 (기존 ack 는 audit 보존). */
  const openRereviewModal = useCallback(async (g: QuarantineGroup) => {
    if (!project || !g.bindingId) return;
    setAckTarget(g);
    setAckIsRereview(true);
    setAckPreviousNote(null);
    setAckNote('');
    setAckError(null);
    // 이전 ack 의 note 를 모달 안내에 표시 — history endpoint 의 첫 row 가 latest.
    try {
      const rows = await quarantineAckApi.history({
        projectId: project.id,
        bindingId: g.bindingId,
        ruleName: g.stage,
        reason: g.reason,
      });
      if (rows.length > 0 && rows[0].note) setAckPreviousNote(rows[0].note);
    } catch {
      /* 이전 note 표시 실패 무시 — re-review 자체는 진행 가능. */
    }
  }, [project]);

  const closeAckModal = useCallback(() => {
    if (ackBusy) return;
    setAckTarget(null);
    setAckIsRereview(false);
    setAckPreviousNote(null);
    setAckNote('');
    setAckError(null);
  }, [ackBusy]);

  const handleAckSave = useCallback(async () => {
    const g = ackTarget;
    if (readOnly) return;
    if (!g || !project || !runPhase || !g.bindingId) return;
    setAckBusy(true);
    setAckError(null);
    try {
      await quarantineAckApi.acknowledge({
        projectId: project.id,
        bindingId: g.bindingId,
        ruleName: g.stage,
        reason: g.reason,
        phase: runPhase,
        // CSV fingerprint 전송 — 같은 CSV 로 재실행 시 carry-over (정책 3·6).
        csvMtimeMs: g.csvMtimeMs ?? null,
        csvSize: g.csvSize ?? null,
        note: ackNote || null,
      });
      await refetchQuarantine();
      await refetchAckGroups();
      setAckTarget(null);
      setAckNote('');
    } catch (e: unknown) {
      console.error('quarantine acknowledge failed', e);
      const msg = e instanceof Error ? e.message : String(e);
      // BE 가 409 (ACK_DUPLICATE) 반환 시 친화적 메시지로 교체.
      if (msg.includes('ACK_DUPLICATE') || msg.includes('409')) {
        setAckError(t('logs.quarantine.ack.duplicate'));
      } else {
        setAckError(t('logs.quarantine.ack.failed', { error: msg }));
      }
    } finally {
      setAckBusy(false);
    }
  }, [ackTarget, project, runPhase, ackNote, refetchQuarantine, refetchAckGroups, t, readOnly]);
  /* ack 된 group 도 dim+meta 로 표시 (사용자 결정 — hide 가 아닌 dim). QuarantineCard 가 g.ack 로 처리. */
  const allGroups: QuarantineGroup[] = allGroupsData ?? [];
  const groupStats = useMemo(() => {
    /* ack 된 WARN 은 'skip' 으로 분리 카운트. warning 카운트에서 제외 (사용자 결정).
       error 는 ack 무관 — error 는 ack 시스템 X. */
    let errRows = 0, warnRows = 0, skipRows = 0;
    for (const g of allGroups) {
      if (g.severity === 'error') errRows += g.rowCount;
      else if (g.ack) skipRows += g.rowCount;
      else warnRows += g.rowCount;
    }
    const errGroups  = allGroups.filter((g) => g.severity === 'error').length;
    const warnGroups = allGroups.filter((g) => g.severity === 'warning' && !g.ack).length;
    const skipGroups = allGroups.filter((g) => g.severity === 'warning' && !!g.ack).length;
    return {
      total: allGroups.length,
      errGroups, warnGroups, skipGroups,
      errRows, warnRows, skipRows,
      totalRows: errRows + warnRows + skipRows,
    };
  }, [allGroups]);
  /* 필터는 severity → table → group(개별) 순으로 AND 결합한다.
     - bySeverity : severity 탭 결과 (table dropdown 옵션의 모집단)
     - byTable    : 거기서 테이블 dropdown 적용 (group dropdown 옵션의 모집단)
     - filtered   : 거기서 개별 group dropdown 적용 → 최종 표시 카드 */
  const bySeverity = useMemo(() => {
    if (severityFilter === 'all')     return allGroups;
    if (severityFilter === 'skip')    return allGroups.filter((g) => g.severity === 'warning' && !!g.ack);
    if (severityFilter === 'warning') return allGroups.filter((g) => g.severity === 'warning' && !g.ack);
    return allGroups.filter((g) => g.severity === severityFilter);
  }, [allGroups, severityFilter]);
  const byTable = useMemo(() => (
    tableFilter ? bySeverity.filter((g) => g.table === tableFilter) : bySeverity
  ), [bySeverity, tableFilter]);
  const filteredGroups = useMemo(() => (
    pickedGroupId ? byTable.filter((g) => g.id === pickedGroupId) : byTable
  ), [byTable, pickedGroupId]);

  /** 테이블 dropdown 옵션 — 현재 severity 안에 등장하는 unique 테이블 + group 수, 알파벳순.
     빈 table('') 인 entry 는 제외 (선택 의미 없음). */
  const tableOptions = useMemo(() => {
    const m = new Map<string, number>();
    for (const g of bySeverity) {
      if (!g.table) continue;
      m.set(g.table, (m.get(g.table) ?? 0) + 1);
    }
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [bySeverity]);

  /** group dropdown 옵션 — severity + table 필터까지 반영한 group 목록. */
  const pickableGroups = byTable;

  /* severity 가 바뀌어 그 안에 선택 테이블이 더는 없으면 table 필터 초기화. */
  useEffect(() => {
    if (tableFilter && !tableOptions.some(([v]) => v === tableFilter)) {
      setTableFilter(null);
    }
  }, [tableOptions, tableFilter]);

  /* severity/table 가 바뀌면 그 안에 picked 가 더 이상 없으니 picked 초기화. */
  useEffect(() => {
    if (pickedGroupId && !pickableGroups.some((g) => g.id === pickedGroupId)) {
      setPickedGroupId(null);
    }
  }, [pickableGroups, pickedGroupId]);

  /* ── Run history (history 탭 専用 — listByProject) ────────────────
     project 当たりの最近 run 一覧. SettingsPage の Schedule 탭에서 이쪽으로 이동.
     view==='history' 진입 시 fetch, project 변경 시 자동 refetch. */
  const [historyRows, setHistoryRows] = useState<RunHistoryDto[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  /** Status / Type / Trigger フィルタ. 空文字 = All. */
  const [historyStatusFilter, setHistoryStatusFilter] = useState<string>('');
  const [historyTypeFilter, setHistoryTypeFilter] = useState<string>('');
  const [historyTriggerFilter, setHistoryTriggerFilter] = useState<string>('');
  const refreshHistory = useCallback(async (projectId: string) => {
    setHistoryLoading(true);
    try {
      const h = await runsApi.listByProject(projectId);
      setHistoryRows(h);
    } catch (e) {
      console.error('Failed to load run history', e);
    } finally {
      setHistoryLoading(false);
    }
  }, []);
  useEffect(() => {
    if (view !== 'history') return;
    if (!activeProjectId) return;
    refreshHistory(activeProjectId);
  }, [view, activeProjectId, refreshHistory]);

  /** フィルタ dropdown の選択肢 — 現データに存在する値だけ derive (Step フィルタと同じパターン). */
  const historyStatusOptions = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of historyRows) m.set(r.status, (m.get(r.status) ?? 0) + 1);
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [historyRows]);
  const historyTypeOptions = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of historyRows) m.set(r.runType, (m.get(r.runType) ?? 0) + 1);
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [historyRows]);
  const historyTriggerOptions = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of historyRows) m.set(r.triggerSource, (m.get(r.triggerSource) ?? 0) + 1);
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [historyRows]);
  const filteredHistoryRows = useMemo(() => historyRows.filter((r) => {
    if (historyStatusFilter && r.status !== historyStatusFilter) return false;
    if (historyTypeFilter && r.runType !== historyTypeFilter) return false;
    if (historyTriggerFilter && r.triggerSource !== historyTriggerFilter) return false;
    return true;
  }), [historyRows, historyStatusFilter, historyTypeFilter, historyTriggerFilter]);

  /* データから消えた値を選んでた場合は filter をリセット (refresh で項目が変わった時など). */
  useEffect(() => {
    if (historyStatusFilter && !historyStatusOptions.some(([v]) => v === historyStatusFilter)) {
      setHistoryStatusFilter('');
    }
  }, [historyStatusOptions, historyStatusFilter]);
  useEffect(() => {
    if (historyTypeFilter && !historyTypeOptions.some(([v]) => v === historyTypeFilter)) {
      setHistoryTypeFilter('');
    }
  }, [historyTypeOptions, historyTypeFilter]);
  useEffect(() => {
    if (historyTriggerFilter && !historyTriggerOptions.some(([v]) => v === historyTriggerFilter)) {
      setHistoryTriggerFilter('');
    }
  }, [historyTriggerOptions, historyTriggerFilter]);

  /* dropdown 으로 group 선택하면 그 카드는 자동으로 펼친 상태. */
  useEffect(() => {
    if (pickedGroupId) setOpenGroupId(pickedGroupId);
  }, [pickedGroupId]);

  /** STEP 필터 리스트용 — 모든 unique stage + 발생 횟수, 알파벳순. */
  const stages = useMemo(() => {
    const counts = new Map<string, number>();
    for (const l of allLines) counts.set(l.stage, (counts.get(l.stage) ?? 0) + 1);
    return Array.from(counts.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [allLines]);

  const totalCounts = useMemo(() => {
    let info = 0, warn = 0, err = 0;
    for (const l of allLines) {
      if (l.level === 2) err++;
      else if (l.level === 1) warn++;
      else info++;
    }
    return { info, warn, error: err, total: allLines.length };
  }, [allLines]);

  const selected: RunLogLine | null = useMemo(
    () => lines.find((l) => l.seq === selectedSeq) ?? null,
    [lines, selectedSeq],
  );

  /** 현재 필터링된 lines 안에서 선택된 라인의 0-based 위치. 선택 없음/필터됨 → -1 */
  const selectedIndex = useMemo(
    () => (selectedSeq == null ? -1 : lines.findIndex((l) => l.seq === selectedSeq)),
    [lines, selectedSeq],
  );

  /* 첫 ERROR 자동 선택 (필터 변경 시 사라지면 재선택) */
  useEffect(() => {
    if (selectedSeq != null && lines.some((l) => l.seq === selectedSeq)) return;
    const firstErr = lines.find((l) => l.level === 2);
    setSelectedSeq((firstErr ?? lines[0])?.seq ?? null);
  }, [lines, selectedSeq]);

  /* Step 필터 변경 시 — 그 step 범위의 첫 ERROR 로 강제 재선택.
     ALL ↔ specific 전환 시 이전 INFO 선택이 그대로 남아 Suggested action 이
     안 보이던 문제를 잡는다. */
  const prevStepFilter = useRef(stepFilter);
  useEffect(() => {
    if (prevStepFilter.current === stepFilter) return;
    prevStepFilter.current = stepFilter;
    const firstErr = lines.find((l) => l.level === 2);
    setSelectedSeq((firstErr ?? lines[0])?.seq ?? null);
  }, [stepFilter, lines]);

  /* ── virtualizer ─────────────────────────────────── */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE,
    overscan: 24,
  });

  /**
   * 방향키로 행을 한 칸씩 이동. 검색창 / 텍스트 입력 중에는 가로채지 않는다
   * (input 안의 텍스트 커서 동작을 깨면 안 됨).
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (t && t.isContentEditable)) return;
      if (lines.length === 0) return;
      e.preventDefault();
      const cur = selectedSeq == null ? -1 : lines.findIndex((l) => l.seq === selectedSeq);
      const nextIdx = e.key === 'ArrowDown'
        ? (cur < 0 ? 0 : Math.min(lines.length - 1, cur + 1))
        : (cur <= 0 ? 0 : cur - 1);
      const next = lines[nextIdx];
      if (!next) return;
      setSelectedSeq(next.seq);
      virtualizer.scrollToIndex(nextIdx, { align: 'auto' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lines, selectedSeq, virtualizer]);

  /* ── render ──────────────────────────────────────── */

  if (!project) {
    return (
      <div style={styles.empty}>
        <div style={styles.emptyTitle}>{t('logs.empty.noProject')}</div>
      </div>
    );
  }

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div style={styles.root}>
      <style>{LOG_SCROLL_CSS}</style>

      <div style={styles.toolbar}>
        <div style={styles.viewToggle} role="tablist" aria-label={t('logs.view.label')}>
          <button
            role="tab"
            aria-selected={view === 'stream'}
            onClick={() => setView('stream')}
            style={{ ...styles.viewToggleBtn, ...(view === 'stream' ? styles.viewToggleBtnActive : {}) }}
          >
            {t('logs.view.stream')}
          </button>
          <button
            role="tab"
            aria-selected={view === 'quarantine'}
            onClick={() => setView('quarantine')}
            style={{ ...styles.viewToggleBtn, ...(view === 'quarantine' ? styles.viewToggleBtnActive : {}) }}
          >
            {t('logs.view.quarantine')}
            {groupStats.totalRows > 0 && (
              <span style={styles.viewToggleCount}>{groupStats.totalRows}</span>
            )}
          </button>
          <button
            role="tab"
            aria-selected={view === 'history'}
            onClick={() => setView('history')}
            style={{ ...styles.viewToggleBtn, ...(view === 'history' ? styles.viewToggleBtnActive : {}) }}
          >
            {t('logs.view.history')}
          </button>
        </div>

        {view === 'stream' && (
          <>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('logs.search.placeholder')}
              style={styles.search}
            />

            <div style={styles.levelGroup}>
              <LevelChip label="INFO"  active={levelFilter.INFO}  count={totalCounts.info}
                color="#a0a8b4" onClick={() => setLevelFilter((f) => ({ ...f, INFO: !f.INFO }))} />
              <LevelChip label="WARN"  active={levelFilter.WARN}  count={totalCounts.warn}
                color="#e8b563" onClick={() => setLevelFilter((f) => ({ ...f, WARN: !f.WARN }))} />
              <LevelChip label="ERROR" active={levelFilter.ERROR} count={totalCounts.error}
                color="#e85d75" onClick={() => setLevelFilter((f) => ({ ...f, ERROR: !f.ERROR }))} />
            </div>

            <label style={styles.stepInline}>
              <span style={styles.stepInlineLabel}>Step</span>
              <select
                value={stepFilter ?? ''}
                onChange={(e) => setStepFilter(e.target.value || null)}
                style={styles.stepSelectInline}
              >
                <option value="">All ({allLines.length})</option>
                {stages.map(([s, n]) => (
                  <option key={s} value={s}>{s} ({n})</option>
                ))}
              </select>
            </label>
          </>
        )}

        <div style={{ flex: 1 }} />
      </div>

      <div style={styles.main}>
        {view === 'history' ? (
          /* Run history 모드 — project 별 최근 run 一覧. SettingsPage / Schedule 탭에서 이쪽으로 이동. */
          <div style={styles.quarPanel}>
            <div style={styles.quarHeader}>
              <div style={styles.quarStats}>
                <div style={styles.quarStatsEyebrow}>
                  {t('logs.view.history').toUpperCase()}
                  {project && (
                    <span style={styles.quarStatsProjectChip}>{project.name}</span>
                  )}
                </div>
                <div style={styles.quarStatsLine}>
                  {historyLoading
                    ? ''
                    : filteredHistoryRows.length === historyRows.length
                      ? `${historyRows.length} runs`
                      : `${filteredHistoryRows.length} / ${historyRows.length} runs`}
                </div>
              </div>
              <div style={styles.quarFilterRow}>
                <label style={styles.historyFilterLabel}>
                  <span style={styles.historyFilterLabelText}>Status</span>
                  <select
                    value={historyStatusFilter}
                    onChange={(e) => setHistoryStatusFilter(e.target.value)}
                    style={styles.historyFilterSelect}
                    disabled={historyStatusOptions.length === 0}
                  >
                    <option value="">All ({historyRows.length})</option>
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
                    <option value="">All ({historyRows.length})</option>
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
                    <option value="">All ({historyRows.length})</option>
                    {historyTriggerOptions.map(([v, n]) => (
                      <option key={v} value={v}>{v} ({n})</option>
                    ))}
                  </select>
                </label>
                <button
                  onClick={() => activeProjectId && refreshHistory(activeProjectId)}
                  disabled={historyLoading || !activeProjectId}
                  style={styles.historyRefreshBtn}
                >
                  {historyLoading ? '' : t('projectSettings.action.refresh')}
                </button>
                <div style={{ flex: 1 }} />
              </div>
            </div>

            <div style={styles.historyScroll}>
              {filteredHistoryRows.length === 0 ? (
                <div style={styles.quarEmpty}>{t('projectSettings.schedule.history.empty')}</div>
              ) : (
                <table style={styles.historyTable}>
                  <thead>
                    <tr>
                      <th style={{ ...styles.historyTh, width: 22, padding: '6px 4px' }} aria-label="expand"></th>
                      <th style={styles.historyTh}>{t('projectSettings.schedule.history.col.runId')}</th>
                      <th style={styles.historyTh}>{t('projectSettings.schedule.history.col.started')}</th>
                      <th style={styles.historyTh}>{t('projectSettings.schedule.history.col.finished')}</th>
                      <th style={styles.historyTh}>{t('projectSettings.schedule.history.col.type')}</th>
                      <th style={styles.historyTh}>{t('projectSettings.schedule.history.col.trigger')}</th>
                      <th style={styles.historyTh}>{t('projectSettings.schedule.history.col.worker')}</th>
                      <th style={styles.historyTh}>{t('projectSettings.schedule.history.col.tables')}</th>
                      <th style={styles.historyTh}>{t('projectSettings.schedule.history.col.status')}</th>
                      <th
                        style={{ ...styles.historyTh, textAlign: 'right' }}
                        title={t('projectSettings.schedule.history.col.duration.tooltip')}
                      >
                        {t('projectSettings.schedule.history.col.duration')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredHistoryRows.map((h) => {
                      const expanded = expandedRunIds.has(h.id);
                      const canExpand = h.tableSummary.total > 0;
                      return (
                        <Fragment key={h.id}>
                          <tr
                            onClick={canExpand ? () => toggleExpandedRun(h.id) : undefined}
                            style={{ cursor: canExpand ? 'pointer' : 'default' }}
                          >
                            <td style={{ ...styles.historyTd, padding: '4px 4px', textAlign: 'center' }}>
                              {canExpand && (
                                <span style={{ color: 'var(--text-3)', fontSize: 11, userSelect: 'none' }}>
                                  {expanded ? '▾' : '▸'}
                                </span>
                              )}
                            </td>
                            <td style={styles.historyTd}><code style={{ fontSize: 10, color: 'var(--text-3)' }}>{h.id}</code></td>
                            <td style={styles.historyTd}>{formatTimestamp(h.startedAt)}</td>
                            <td style={styles.historyTd}>{h.finishedAt ? formatTimestamp(h.finishedAt) : '-'}</td>
                            <td style={styles.historyTd}>{h.runType}</td>
                            <td style={styles.historyTd}>{h.triggerSource}</td>
                            <td style={styles.historyTd}>{h.workerId ?? '-'}</td>
                            <td style={styles.historyTd}>
                              <HistoryTablesCell h={h} t={t} />
                            </td>
                            <td style={styles.historyTd}>
                              <span style={historyStatusStyle(h.status)}>{h.status}</span>
                            </td>
                            <td
                              style={{ ...styles.historyTd, textAlign: 'right', fontFamily: 'var(--mono)' }}
                              title={t('projectSettings.schedule.history.col.duration.tooltip')}
                            >
                              {formatDuration(h.durationMs)}
                            </td>
                          </tr>
                          {expanded && (
                            <tr>
                              <td colSpan={10} style={{ padding: 0, background: 'var(--panel-2)' }}>
                                <HistoryRunDrilldown runId={h.id} t={t} />
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
          </div>
        ) : view === 'quarantine' ? (
          /* Quarantine 모드 — 라이트 톤 panel + group card 리스트. */
          <div style={styles.quarPanel}>
            <div style={styles.quarHeader}>
              {/* 위 줄 — stats */}
              <div style={styles.quarStats}>
                <div style={styles.quarStatsEyebrow}>
                  QUARANTINE
                  {project && (
                    <span style={styles.quarStatsProjectChip}>{project.name}</span>
                  )}
                </div>
                <div style={styles.quarStatsLine}>
                  {t('logs.quarantine.statsGroups', { n: String(groupStats.total) })}
                  <span style={styles.quarStatsSep}>·</span>
                  {t('logs.quarantine.statsRows', {
                    n: String(groupStats.totalRows),
                    err: String(groupStats.errRows),
                    warn: String(groupStats.warnRows),
                    skip: String(groupStats.skipRows),
                  })}
                </div>
              </div>

              {/* 아래 줄 — 필터 한 줄 (sevToggle + group select) */}
              <div style={styles.quarFilterRow}>
                <div style={styles.sevToggle} role="tablist">
                  <SevTab label={t('logs.quarantine.filter.all')}      count={groupStats.total}
                    active={severityFilter === 'all'}     onClick={() => setSeverityFilter('all')} />
                  <SevTab label={t('logs.quarantine.filter.errors')}   count={groupStats.errGroups}
                    active={severityFilter === 'error'}   onClick={() => setSeverityFilter('error')}   tone="error" />
                  <SevTab label={t('logs.quarantine.filter.warnings')} count={groupStats.warnGroups}
                    active={severityFilter === 'warning'} onClick={() => setSeverityFilter('warning')} tone="warning" />
                  <SevTab label={t('logs.quarantine.filter.skip')} count={groupStats.skipGroups}
                    active={severityFilter === 'skip'} onClick={() => setSeverityFilter('skip')} />
                </div>
                {/* 테이블 dropdown — severity 탭 바로 옆. 한 테이블의 위반만 모아 보기. */}
                <select
                  style={styles.tablePickSelect}
                  value={tableFilter ?? ''}
                  onChange={(e) => setTableFilter(e.target.value || null)}
                  disabled={tableOptions.length === 0}
                >
                  <option value="">{t('logs.quarantine.pickTable.all')}</option>
                  {tableOptions.map(([tbl, n]) => (
                    <option key={tbl} value={tbl}>{tbl} ({n})</option>
                  ))}
                </select>
                <select
                  style={styles.groupPickSelect}
                  value={pickedGroupId ?? ''}
                  onChange={(e) => setPickedGroupId(e.target.value || null)}
                  disabled={pickableGroups.length === 0}
                >
                  <option value="">{t('logs.quarantine.pick.all')}</option>
                  {pickableGroups.map((g) => (
                    /* 같은 reason 이 여러 테이블에서 나면 라벨이 동일해 구분 불가 →
                       테이블명을 앞에 붙여 식별. table 비면 reason 만. */
                    <option key={g.id} value={g.id}>
                      {g.table ? `${g.table} — ${g.reason}` : g.reason} ({g.rowCount})
                    </option>
                  ))}
                </select>
                <div style={{ flex: 1 }} />
              </div>
            </div>

            <div style={styles.quarScroll}>
              {filteredGroups.length === 0 ? (
                <div style={styles.quarEmpty}>{t('logs.quarantine.empty')}</div>
              ) : (
                filteredGroups.map((g) => (
                  <QuarantineCard
                    key={g.id}
                    g={g}
                    t={t}
                    open={openGroupId === g.id}
                    runId={runId}
                    onAcknowledge={!readOnly && g.severity === 'warning' && g.bindingId && runPhase && !g.ack
                      ? () => openAckModal(g)
                      : null}
                    onRereview={!readOnly && g.severity === 'warning' && g.bindingId && runPhase && g.ack
                      ? () => void openRereviewModal(g)
                      : null}
                    ackInfo={g.ack ?? null}
                    onOpenHistory={g.severity === 'warning' && g.bindingId
                      ? () => void openAckHistory(g)
                      : null}
                    onToggle={() => setOpenGroupId((cur) => (cur === g.id ? null : g.id))}
                    onOpenMapping={() => {
                      // 매핑 row highlight 대상 컬럼명 추출 — 3 단계로 robust 하게 시도.
                      // 1) 'violated' role 컬럼 우선 (정상 BE 응답)
                      // 2) 그게 placeholder ('error'/'unknown'/빈값) 면 g.columns 전체에서 다시 필터
                      // 3) 그래도 없으면 g.detail / g.reason 텍스트에서 'source column XXX' / 't.XXX' / 'OF XXX' 같은
                      //    SQL 에러 패턴으로 컬럼명 보충 (예: 'casting from source column TXN_DTTM').
                      const PLACEHOLDER = new Set(['error', 'unknown', '']);
                      const isReal = (c: string) => c && !PLACEHOLDER.has(c.toLowerCase());

                      let cols = g.columns
                        .filter((_, i) => g.columnRoles[i] === 'violated')
                        .filter(isReal);
                      if (cols.length === 0) {
                        cols = g.columns.filter(isReal);
                      }
                      if (cols.length === 0) {
                        const text = `${g.detail || ''} ${g.reason || ''}`;
                        const found = new Set<string>();
                        // 'source column XXX' / 'column XXX' (대소문자 무관).
                        for (const m of text.matchAll(/\b(?:source\s+)?column\s+([A-Za-z_][A-Za-z0-9_]*)/gi)) {
                          found.add(m[1]);
                        }
                        // 't.XXX' / 'a.XXX' / 'src.XXX' alias 패턴 (SQL CAST/SELECT 안에 자주 등장).
                        for (const m of text.matchAll(/\b[a-z]\w*\.([A-Z_][A-Z0-9_]+)\b/g)) {
                          found.add(m[1]);
                        }
                        cols = [...found];
                      }
                      navigate('/mapping', {
                        state: { focusRule: { tobeTable: g.table, tobeColumns: cols } },
                      });
                    }}
                    onOpenInspector={() => {
                      // Quarantine group → Stream 모드로 점프.
                      //
                      // 자동 stage/severity 좁힘은 폐기 — quarantine group 의 stage (validate.type 등)
                      // 와 실제 RunLog 라인의 stage 가 매치된다는 보장이 없음 (백엔드/데이터에 따라 다름).
                      // 좁힌 결과가 0 라인이면 "필터 조건에 맞는 로그가 없습니다" 만 떠서 빈 화면.
                      // 그래서 stepFilter / search 는 풀고 level 만 모두 켠 채 stream 으로 전환 —
                      // 그 run 의 전체 라인을 그대로 보여주고, 사용자가 STEP dropdown 으로 직접 좁힘.
                      setView('stream');
                      setStepFilter(null);
                      setSearch('');
                      setDebouncedSearch('');
                      setLevelFilter({ INFO: true, WARN: true, ERROR: true });
                      setOpenGroupId(null);
                    }}
                  />
                ))
              )}
            </div>
          </div>
        ) : (
          /* Stream 모드 — 다크 터미널 로그 테이블 (가상화). */
          <div style={styles.tablePanel}>
            <div ref={scrollRef} className="log-scroll" style={styles.tableScroll}>
              {lines.length === 0 ? (
                <div style={styles.emptyRow}>{t('logs.empty.noResult')}</div>
              ) : (
                <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%', minWidth: 1196 }}>
                  {virtualItems.map((vi) => {
                    const l = lines[vi.index];
                    if (!l) return null;
                    const isSelected = l.seq === selectedSeq;
                    const tone = l.level === 2 ? styles.rowError
                      : l.level === 1 ? styles.rowWarn : undefined;
                    const msgColor = l.level === 2 ? '#ff8194'
                      : l.level === 1 ? '#f5d76e' : '#a0a8b4';
                    return (
                      <div
                        key={`${l.runId}-${l.seq}`}
                        data-index={vi.index}
                        ref={virtualizer.measureElement}
                        onClick={() => setSelectedSeq(l.seq)}
                        style={{
                          position: 'absolute', top: 0, left: 0, right: 0,
                          transform: `translateY(${vi.start}px)`,
                          ...styles.row, ...tone,
                          ...(isSelected ? styles.rowSelected : {}),
                        }}
                      >
                        <span style={styles.cellTime}>
                          {formatTime(l.ts)}<span style={styles.cellMs}>{formatMs(l.ts)}</span>
                        </span>
                        <span style={styles.cellLevel}>
                          <span style={{
                            ...styles.lvBadge,
                            ...(l.level === 2 ? styles.lvError
                              : l.level === 1 ? styles.lvWarn : styles.lvInfo),
                          }}>{levelName(l.level)}</span>
                        </span>
                        <span style={{ ...styles.cellStage, color: stageColor(l.stage) }}>
                          <Hl text={l.stage} q={debouncedSearch} />
                        </span>
                        <span style={{ ...styles.cellMsg, color: msgColor }}>
                          <Hl text={l.message} q={debouncedSearch} />
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <div style={styles.tableFooter}>
              <span>
                {selectedIndex >= 0
                  ? t('logs.footer.shown', { shown: String(selectedIndex + 1), total: String(lines.length) })
                  : t('logs.footer.shown', { shown: String(lines.length), total: String(totalCounts.total) })}
              </span>
            </div>
          </div>
        )}

        {/* 우측 — Stream 모드에서만 상세 패널 표시. Quarantine 모드는 group card 가 자체로 detail 포함. */}
        {view === 'stream' && (
        <aside style={styles.detail}>
          {selected ? (
            <>
              <div style={styles.detailHeader}>
                <div style={styles.detailEyebrow}>{t('logs.detail.title')} #{selected.seq}</div>
                <span style={{
                  ...styles.levelBadge,
                  ...(selected.level === 2 ? styles.levelError
                    : selected.level === 1 ? styles.levelWarn : styles.levelInfo),
                }}>{levelName(selected.level)}</span>
              </div>

              <div style={styles.detailMsg}>{selected.message}</div>

              <div style={styles.detailMeta}>
                <MetaRow label={t('logs.detail.time')}  value={formatTime(selected.ts) + formatMs(selected.ts)} />
                <MetaRow label={t('logs.detail.stage')} value={selected.stage} />
              </div>
            </>
          ) : (
            <div style={styles.detailEmpty}>
              <div style={styles.detailEmptyTitle}>{t('logs.detail.emptyTitle')}</div>
              <div style={styles.detailEmptyHint}>{t('logs.detail.emptyHint')}</div>
            </div>
          )}

        </aside>
        )}
      </div>

      {/* WARN 그룹 ack Modal — 운영자가 검토 후 메모 입력. window.prompt 대체 (2026-06-01).
          isRereview=true 면 같은 modal 을 재검토 용으로 재사용 — 제목/placeholder 동적,
          이전 note 표시. Save 시 새 ack row 추가 (기존 ack 는 audit 보존). */}
      <Modal
        open={ackTarget !== null}
        onClose={closeAckModal}
        title={t(ackIsRereview ? 'logs.quarantine.ack.reReview.title' : 'logs.quarantine.ack.modal.title')}
        width={520}
      >
        {ackTarget && (
          <div>
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 4 }}>
                {t('logs.quarantine.ack.modal.reasonLabel')}
              </div>
              <div style={{ fontSize: 13, color: 'var(--text)' }}>{ackTarget.reason}</div>
            </div>
            {ackIsRereview && ackPreviousNote && (
              <div style={{ marginBottom: 12, padding: 8, background: 'var(--panel-2)', borderRadius: 3, fontSize: 11, color: 'var(--text-2)' }}>
                {t('logs.quarantine.ack.reReview.previousNote', { note: ackPreviousNote })}
              </div>
            )}
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: 11, color: 'var(--text-3)', marginBottom: 4 }}>
                {t('logs.quarantine.ack.modal.noteLabel')}
              </label>
              <textarea
                value={ackNote}
                onChange={(e) => setAckNote(e.target.value)}
                placeholder={t(ackIsRereview ? 'logs.quarantine.ack.reReview.notePlaceholder' : 'logs.quarantine.ack.modal.notePlaceholder')}
                rows={4}
                disabled={ackBusy}
                style={{
                  width: '100%',
                  fontFamily: 'inherit',
                  fontSize: 12,
                  border: '1px solid var(--border)',
                  background: 'var(--panel)',
                  color: 'var(--text)',
                  padding: 8,
                  borderRadius: 3,
                  resize: 'vertical',
                  boxSizing: 'border-box',
                }}
              />
            </div>
            {ackError && (
              <div style={{ color: '#c92a3f', fontSize: 12, marginBottom: 8 }}>{ackError}</div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                type="button"
                onClick={closeAckModal}
                disabled={ackBusy}
                style={{
                  padding: '6px 14px',
                  fontSize: 12,
                  border: '1px solid var(--border)',
                  background: 'var(--panel)',
                  color: 'var(--text)',
                  borderRadius: 3,
                  cursor: ackBusy ? 'not-allowed' : 'pointer',
                }}
              >
                {t('logs.quarantine.ack.modal.cancel')}
              </button>
              <button
                type="button"
                onClick={() => void handleAckSave()}
                disabled={ackBusy}
                style={{
                  padding: '6px 14px',
                  fontSize: 12,
                  border: '1px solid var(--navy)',
                  background: 'var(--navy)',
                  color: '#fff',
                  borderRadius: 3,
                  cursor: ackBusy ? 'not-allowed' : 'pointer',
                  opacity: ackBusy ? 0.6 : 1,
                }}
              >
                {t('logs.quarantine.ack.modal.save')}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Ack history popover — group 의 모든 ack 이력 (phase 무관 시간 역순). */}
      <Modal
        open={ackHistoryTarget !== null}
        onClose={closeAckHistory}
        title={t('logs.quarantine.ack.history.title')}
        width={680}
      >
        {ackHistoryTarget && (
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 12 }}>
              {t('logs.quarantine.ack.history.subtitle', {
                table: ackHistoryTarget.table,
                rule: ackHistoryTarget.stage,
                reason: ackHistoryTarget.reason,
              })}
            </div>
            {ackHistoryError && (
              <div style={{ color: '#c92a3f', fontSize: 12, marginBottom: 8 }}>{ackHistoryError}</div>
            )}
            {ackHistoryBusy ? (
              <div style={{ fontSize: 12, color: 'var(--text-3)', padding: '16px 0' }}>...</div>
            ) : ackHistoryRows.length === 0 && !ackHistoryError ? (
              <div style={{ fontSize: 12, color: 'var(--text-3)', padding: '16px 0' }}>
                {t('logs.quarantine.ack.history.empty')}
              </div>
            ) : (
              <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-3)' }}>
                    <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 500 }}>{t('logs.quarantine.ack.history.col.phase')}</th>
                    <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 500 }}>{t('logs.quarantine.ack.history.col.by')}</th>
                    <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 500 }}>{t('logs.quarantine.ack.history.col.at')}</th>
                    <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 500 }}>{t('logs.quarantine.ack.history.col.fp')}</th>
                    <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 500 }}>{t('logs.quarantine.ack.history.col.note')}</th>
                  </tr>
                </thead>
                <tbody>
                  {ackHistoryRows.map((r) => (
                    <tr key={r.acknowledgmentId} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '6px 8px', fontFamily: 'var(--mono)', color: 'var(--text-2)' }}>[{r.phase}]</td>
                      <td style={{ padding: '6px 8px' }}>{r.acknowledgedBy}</td>
                      <td style={{ padding: '6px 8px', fontFamily: 'var(--mono)', color: 'var(--text-2)' }}>{new Date(r.acknowledgedAt).toLocaleString()}</td>
                      <td style={{ padding: '6px 8px', fontFamily: 'var(--mono)', color: 'var(--text-3)', fontSize: 11 }}>
                        {r.csvMtimeMs != null && r.csvSize != null
                          ? `${r.csvMtimeMs} · ${r.csvSize}b`
                          : '—'}
                      </td>
                      <td style={{ padding: '6px 8px', color: 'var(--text-2)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.note ?? ''}>
                        {r.note || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <button
                type="button"
                onClick={closeAckHistory}
                style={{
                  padding: '6px 14px',
                  fontSize: 12,
                  border: '1px solid var(--border)',
                  background: 'var(--panel)',
                  color: 'var(--text)',
                  borderRadius: 3,
                  cursor: 'pointer',
                }}
              >
                {t('logs.quarantine.ack.history.close')}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

/* ─────────────────── small components ──────────────── */

function LevelChip({ label, active, count, color, onClick }: {
  label: RunLogLevel; active: boolean; count: number; color: string; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        ...styles.levelChip,
        color: active ? color : 'var(--text-4)',
        borderColor: active ? color : 'var(--border-strong)',
        opacity: active ? 1 : 0.55,
      }}
    >
      <span style={{ ...styles.levelChipDot, background: 'currentColor' }} />
      <span>{label}</span>
      <span style={styles.levelChipCount}>{count}</span>
    </button>
  );
}

/** Severity 필터 탭 — Quarantine 모드 panel header 의 [All N] [Errors E] [Warnings W]. */
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
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      style={{ ...styles.sevTabBtn, ...activeStyle }}
    >
      <span>{label}</span>
      <span style={styles.sevTabCount}>{count}</span>
    </button>
  );
}

/** Quarantine group card — 카드 클릭으로 열고 닫음. 열렸을 때만 액션바(이 테이블만 다시 이행/매핑/Requeue/...) 표시. */
function QuarantineCard({ g, t, open, onToggle, onOpenMapping, onOpenInspector, onAcknowledge, onRereview, onOpenHistory, ackInfo, runId }: {
  g: QuarantineGroup;
  t: (k: string, v?: Record<string, string>) => string;
  open: boolean;
  onToggle: () => void;
  onOpenMapping: () => void;
  onOpenInspector: () => void;
  /** WARN 그룹 ack 핸들러. null 이면 버튼 미노출 (severity!=warning / bindingId 없음 / phase 미상 / 이미 ack 됨). */
  onAcknowledge: (() => void) | null;
  /** Re-review 핸들러 — 이미 ack 된 group 의 재검토. ack 된 상태에서만 활성. */
  onRereview: (() => void) | null;
  /** Ack history popover 핸들러. null 이면 link 미노출. */
  onOpenHistory: (() => void) | null;
  /** 이 group 의 명시 ack 메타 — 있으면 dim 처리 + "검토 완료" 라벨 표시. */
  ackInfo: import('./quarantineMock').QuarantineGroupAck | null;
  runId: string | null;
}) {
  const isErr = g.severity === 'error';
  /* ack 된 group(=skip 처리 완료) 은 carry-over 표시. severity tone 대신 회색으로 — 운영자가
     한 눈에 "이 group 은 처리됨" 알 수 있도록. */
  const isAcked = !!ackInfo;
  const sevColor  = isAcked ? 'var(--text-3)' : isErr ? '#c92a3f' : '#a86b00';
  const sevBg     = isAcked ? 'var(--panel-2)' : isErr ? 'rgba(232,93,117,0.08)' : 'rgba(232,181,99,0.10)';
  const sevBorder = isAcked ? 'var(--border)' : isErr ? '#e85d75' : '#e8b563';
  const sample = g.sampleRows;
  const tt = t as unknown as (k: string, v?: Record<string, string>) => string;
  const human  = humanizeQuarantineDetail(g, tt);
  /**
   * All 탭에서 아래쪽 카드를 펼치면 sample 표 + 액션바가 panel scroll 영역 밖으로
   * 밀려나서 잘려 보이는 문제 — 펼침 시 카드 자체를 scroll container 상단으로
   * 끌어올린다. block: 'start' 라 펼친 sample 까지 가시 영역에 들어온다.
   */
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open || !rootRef.current) return;
    rootRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [open]);

  const handleToggle = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation();
    onToggle();
  };
  const onChevronKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleToggle(e); }
  };
  return (
    <div
      ref={rootRef}
      aria-expanded={open}
      className="quar-card"
      style={{
        ...styles.cardRoot,
        ...(open ? styles.cardRootOpen : {}),
        ...(isAcked ? { background: 'var(--panel-2)', opacity: 0.85 } : {}),
      }}
    >
      <div style={{ ...styles.cardLeftBar, background: sevBorder }} />
      <div style={styles.cardBody}>
        {/* 헤더 한 줄 — chevron 만 토글, 나머지 영역 클릭은 무시. */}
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
            <div style={styles.cardReasonRow}>
              <span style={{ ...styles.cardReason, color: sevColor }}>{g.reason}</span>
              {/* 테이블명 — 같은 reason 이 여러 테이블에서 나도 카드별로 식별되도록 항상 노출. */}
              {g.table && <span style={styles.cardTableChip}>{g.table}</span>}
            </div>
            {human && <div style={styles.cardHumanDetail}>{human}</div>}
          </div>
          <div style={styles.cardMetaRight}>
            <span style={{ ...styles.rowsBadge, color: sevColor, borderColor: sevBorder, background: sevBg }}>
              {t('logs.quarantine.rowsBadge', { n: String(g.rowCount) })}
            </span>
            <span style={styles.cardStage}>{g.stage}</span>
            <span style={styles.cardTs}>{formatTime(g.firstSeenAt)}{formatMs(g.firstSeenAt)}</span>
          </div>
        </div>

        {/* 펼쳤을 때만 — sample rows 표 + 액션바 */}
        {open && (
          <div style={styles.cardExpand}>
            <div style={styles.cardTableWrap}>
              {/* 첫 컬럼: PK (어느 row 가 위반인지 식별). 헤더는 PK 컬럼명, 없으면 fallback "ROW".
                 (이전엔 group 의 table 이름을 매 row 반복 표시 — 행 식별 불가했음.) */}
              <table style={styles.cardTable}>
                <thead>
                  {/* AS-IS 헤더에 violated 컬럼명 부기 — 예: "AS-IS · gender" */}
                  <tr>
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
                  {sample.map((_, ri) => {
                    const pk = quarantineRowPk(g, ri);
                    const asIs = quarantineRowAsIs(g, ri);
                    const toBe = quarantineRowToBe(g, ri);
                    /* AS-IS NULL 은 위반 값이므로 severity 색, TO-BE NULL 은 거부됐다는 표시라 중립색. */
                    const asIsNullStyle = { ...styles.nullCell, color: sevColor, background: 'transparent', border: `1px solid ${sevBorder}` };
                    return (
                      <tr key={ri}>
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

            {/* 액션바 — 버튼 클릭이 카드 toggle 로 전파되지 않게 stopPropagation. */}
            <div style={styles.cardActions} onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                style={styles.actPrimary}
                onClick={onOpenMapping}
              >
                {t('logs.quarantine.act.openMapping')}
              </button>
              {/* 위반 row 전수 parquet 다운로드 — BE 가 bindingId 채운 경우 + ERROR 만 노출.
                  WARN entry 는 ValidationReportService 의 aggregate diff (SUM/MIN/MAX/SHA256) 라
                  row-level parquet 파일이 없음 → 다운로드 버튼 노출 X. AuditStage 의 ERROR 만
                  exportViolationParquet 로 파일 생성. fetch 로 blob 받아 직접 다운로드 —
                  4xx 응답이 새 탭의 빈 페이지로 표시되던 문제 회피. */}
              {runId && g.bindingId && g.severity === 'error' && (
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const { blob, filename } = await quarantineApi.downloadBinding(runId, g.bindingId!);
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = filename;
                      document.body.appendChild(a);
                      a.click();
                      a.remove();
                      URL.revokeObjectURL(url);
                    } catch (e: unknown) {
                      console.error('quarantine parquet download failed', e);
                      alert(t('logs.quarantine.act.downloadFailed'));
                    }
                  }}
                  style={{ ...styles.actLink, background: 'transparent', border: 'none', cursor: 'pointer' }}
                >
                  {t('logs.quarantine.act.downloadParquet')}
                </button>
              )}
              <div style={{ flex: 1 }} />
              {/* WARN 그룹 명시 ack — 2026-06-01. 운영자가 검토 후 OK 표시 → 다음 run 에서
                  같은 fingerprint (project + binding + rule + reason + csv_mtime + csv_size) 의
                  WARN 은 자동 carry-over. 정책 7 — Rehearsal ack → Cutover 도 자동 적용.
                  이미 ack 됐으면 라벨을 "by {운영자} · {시각}" 으로 바꾸고 비활성화. */}
              {ackInfo ? (
                <>
                  <button
                    type="button"
                    style={{ ...styles.actPrimary, opacity: 0.6, cursor: 'default' }}
                    disabled
                    title={ackInfo.acknowledgedBy + ' · ' + ackInfo.phase}
                  >
                    {t('logs.quarantine.ack.acknowledgedBy', {
                      phase: ackInfo.phase,
                      by: ackInfo.acknowledgedBy,
                      at: new Date(ackInfo.acknowledgedAt).toLocaleString(),
                    })}
                  </button>
                  {onRereview && (
                    <button
                      type="button"
                      style={styles.actLink}
                      onClick={onRereview}
                      title={t('logs.quarantine.ack.reReview.title')}
                    >
                      {t('logs.quarantine.ack.reReview.link')}
                    </button>
                  )}
                </>
              ) : onAcknowledge && (
                <>
                  {/* 이전 ack 가 있지만 fingerprint 다름 (다른 CSV/phase) — 운영자가 즉시
                      과거 검토 이력 확인 가능하도록 hint + history 링크. carry-over 정책 3·6
                      유지 (자동 통과 X), 단 audit 친화. */}
                  {(g.priorAckCount ?? 0) > 0 && onOpenHistory && (
                    <button
                      type="button"
                      style={{ ...styles.actLink, color: 'var(--amber)' }}
                      onClick={onOpenHistory}
                      title={t('logs.quarantine.ack.history.title')}
                    >
                      {t('logs.quarantine.ack.priorHint', { n: String(g.priorAckCount ?? 0) })}
                    </button>
                  )}
                  <button
                    type="button"
                    style={styles.actWarn}
                    onClick={onAcknowledge}
                  >
                    {t('logs.quarantine.act.acknowledgeGroup')}
                  </button>
                </>
              )}
              {onOpenHistory && (
                <button
                  type="button"
                  style={styles.actLink}
                  onClick={onOpenHistory}
                  title={t('logs.quarantine.ack.history.title')}
                >
                  {t('logs.quarantine.ack.history.link')}
                </button>
              )}
              <button
                type="button"
                style={styles.actLink}
                onClick={onOpenInspector}
              >
                {t('logs.quarantine.act.openInspector')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.metaRow}>
      <span style={styles.metaLabel}>{label}</span>
      <span style={styles.metaValue}>{value}</span>
    </div>
  );
}

/** 검색어 노란 highlight */
function Hl({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const lc = text.toLowerCase();
  const needle = q.toLowerCase();
  const out: React.ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < text.length) {
    const found = lc.indexOf(needle, i);
    if (found < 0) { out.push(<span key={k++}>{text.slice(i)}</span>); break; }
    if (found > i) out.push(<span key={k++}>{text.slice(i, found)}</span>);
    out.push(<mark key={k++} style={styles.mark}>{text.slice(found, found + needle.length)}</mark>);
    i = found + needle.length;
  }
  return <>{out}</>;
}

/**
 * Run history の Tables セル. tableSummary (per-table 結果集計) を badge 表示.
 * "4 tables: 3✓ 1✗" の形.  partial run (h.tables 設定あり) は tooltip に対象 table 一覧を出す.
 * stage_table_result がまだ無い (新規/aborted) run は "—" 表示.
 */
function HistoryTablesCell({ h, t }: { h: RunHistoryDto; t: (k: string, v?: Record<string, string>) => string }) {
  const s = h.tableSummary;
  const tooltipLines: string[] = [];
  if (h.tables == null) tooltipLines.push(t('projectSettings.schedule.history.tables.all'));
  else if (h.tables.length > 0) {
    tooltipLines.push(`partial: ${h.tables.length}`);
    tooltipLines.push(...h.tables);
  }
  const tooltip = tooltipLines.join('\n');
  if (s.total === 0) {
    return <span title={tooltip} style={{ color: 'var(--text-4)', fontFamily: 'var(--mono)' }}>—</span>;
  }
  return (
    <span title={tooltip} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'var(--mono)', fontSize: 11 }}>
      <span style={{ color: 'var(--text-3)' }}>{s.total}</span>
      {s.success > 0 && (
        <span style={{ ...summaryBadgeStyle, color: '#166534', background: '#dcfce7', borderColor: '#86efac' }}>
          {s.success}✓
        </span>
      )}
      {s.failed > 0 && (
        <span style={{ ...summaryBadgeStyle, color: '#991b1b', background: '#fee2e2', borderColor: '#fca5a5' }}>
          {s.failed}✗
        </span>
      )}
      {s.running > 0 && (
        <span style={{ ...summaryBadgeStyle, color: '#92400e', background: '#fef3c7', borderColor: '#fcd34d' }}>
          {s.running}
        </span>
      )}
      {s.pending > 0 && (
        /* Pipeline 의 idle stage 와 동일 톤 (회색) — 후속 stage 미실행 (abort 등). */
        <span style={{ ...summaryBadgeStyle, color: 'var(--text-3)', background: 'var(--panel-2)', borderColor: 'var(--border-strong)' }}>
          {s.pending}·
        </span>
      )}
    </span>
  );
}

const summaryBadgeStyle: React.CSSProperties = {
  display: 'inline-block', padding: '0 5px', borderRadius: 3,
  fontSize: 10, fontWeight: 700, border: '1px solid', lineHeight: '14px',
};

/**
 * Run history drill-down sub-row 中身. 展開時に BE から per-table 結果を取得して
 * status / rows / duration / error を 1 table = 1 行で表示.
 */
function HistoryRunDrilldown({ runId, t }: { runId: string; t: (k: string, v?: Record<string, string>) => string }) {
  const { data, isLoading, isError } = useQuery<RunTableResult[]>({
    queryKey: ['run-table-results', runId],
    queryFn: () => runsApi.tableResults(runId),
    staleTime: 5_000,
  });
  if (isLoading) {
    return <div style={drillStyles.loading}>{t('projectSettings.schedule.history.drilldown.loading')}</div>;
  }
  if (isError) {
    return <div style={drillStyles.error}>{t('projectSettings.schedule.history.drilldown.error')}</div>;
  }
  if (!data || data.length === 0) {
    return <div style={drillStyles.loading}>{t('projectSettings.schedule.history.drilldown.empty')}</div>;
  }
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
            /* pending = 일부 stage 만 처리됨 (abort 등). Pipeline 의 idle tone 과 동일 (회색).
               표시 라벨도 pipeline 의 queued 와 일치 — layer-specific terminology 규칙 따름. */
            const statusColor = r.status === 'success' ? '#166534'
              : r.status === 'failed' ? '#991b1b'
              : r.status === 'pending' ? 'var(--text-3)'
              : '#92400e';
            const statusIcon = r.status === 'success' ? '✓'
              : r.status === 'failed' ? '✗'
              : r.status === 'pending' ? '·'
              : '';
            const statusLabel = r.status === 'pending' ? 'queued' : r.status;
            return (
              <tr key={fullName}>
                <td style={{ ...drillStyles.td, color: statusColor, fontWeight: 700 }}>
                  {statusIcon} {statusLabel}
                </td>
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

const drillStyles: Record<string, React.CSSProperties> = {
  wrap: { padding: '8px 12px 12px 36px', background: 'var(--panel-2)' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: 'var(--mono)' },
  th: {
    textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid var(--border)',
    color: 'var(--text-3)', fontWeight: 600, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5,
  },
  td: { padding: '3px 8px', borderBottom: '1px dashed var(--border)', color: 'var(--text-2)' },
  loading: { padding: '8px 12px 8px 36px', color: 'var(--text-3)', fontSize: 11, fontStyle: 'italic' },
  error: { padding: '8px 12px 8px 36px', color: 'var(--red)', fontSize: 11 },
};

/* ─────────────────── helpers ────────────────────────── */
/** Run history 行 status 배지 색 — SettingsPage / PSSchedule 의 historyStatusStyle 그대로 移植. */
function historyStatusStyle(status: string): React.CSSProperties {
  const base: React.CSSProperties = { padding: '2px 6px', borderRadius: 2, fontSize: 10 };
  switch (status) {
    case 'running': return { ...base, background: '#fef3c7', color: '#92400e' };
    case 'success': return { ...base, background: '#dcfce7', color: '#166534' };
    case 'failed':
    case 'aborted':
    case 'timed_out': return { ...base, background: '#fee2e2', color: '#991b1b' };
    default:        return { ...base, background: 'var(--panel-2)', color: 'var(--text-2)' };
  }
}

function formatTime(iso: string): string {
  try { const d = new Date(iso); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; }
  catch { return ''; }
}
function formatMs(iso: string): string {
  try { const d = new Date(iso); return `.${String(d.getMilliseconds()).padStart(3, '0')}`; }
  catch { return ''; }
}
function pad2(n: number) { return String(n).padStart(2, '0'); }


/* ─────────────────── styles ──────────────────────────
 *  로그 테이블 row 영역만 다크 (검정), 나머지(툴바·검색·상세·context·footer)는 라이트.
 *  라이트 톤은 사이트 공통 CSS 변수 (--panel / --border / --text-* 등) 를 그대로 사용.
 */

// 로그 row 영역 전용 — 다크 네이비. 검정에 푸른 끼만 살짝, 채도는 낮춰 눈 피로 방지.
const LOG_BG       = '#161c2c';
const LOG_BORDER   = '#262d40';

/**
 * 로그 테이블 스크롤바 — 다크 배경 위에서 도드라지지 않도록 같은 톤으로.
 * inline style 로는 ::-webkit-scrollbar pseudo 를 못 줘서 <style> 태그로 주입.
 * Firefox 는 inline `scrollbarColor` / `scrollbarWidth` 로 처리.
 */
const LOG_SCROLL_CSS = `
.log-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
.log-scroll::-webkit-scrollbar-track { background: transparent; }
.log-scroll::-webkit-scrollbar-thumb { background: #2a3550; border-radius: 4px; }
.log-scroll::-webkit-scrollbar-thumb:hover { background: #3a4566; }
.log-scroll::-webkit-scrollbar-corner { background: transparent; }

/* role="button" + tabIndex 의 quarantine 카드가 클릭/탭 후 받는 브라우저 기본
   focus outline (검정 테두리) 을 모든 pseudo-class 에서 제거. */
.quar-card,
.quar-card:focus,
.quar-card:focus-visible,
.quar-card:focus-within { outline: none !important; }
`;

const styles: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', height: 'calc(100vh - 80px)', minHeight: 540 },

  empty: { background: 'var(--panel)', border: '1px dashed var(--border-strong)', borderRadius: 6, padding: '60px 24px', textAlign: 'center' },
  emptyTitle: { fontSize: 13, fontWeight: 600, color: 'var(--text-3)' },

  toolbar: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '5px 8px', background: 'var(--panel)',
    border: '1px solid var(--border)', borderRadius: 5, marginBottom: 6, flexWrap: 'wrap',
  },
  search: {
    flex: '0 0 220px', width: 220, minWidth: 140,
    padding: '4px 9px', border: '1px solid var(--border-strong)', borderRadius: 4,
    background: 'var(--panel)', color: 'var(--text)', fontSize: 11.5,
    outline: 'none',
  },
  levelGroup: { display: 'flex', alignItems: 'center', gap: 4 },
  levelChip: {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    padding: '2px 8px', border: '1px solid', borderRadius: 999,
    fontSize: 10, fontWeight: 700, fontFamily: 'var(--mono)', letterSpacing: 0.4,
    cursor: 'pointer', background: 'var(--panel)',
  },
  levelChipDot: { width: 5, height: 5, borderRadius: 999, display: 'inline-block' },
  levelChipCount: { background: 'rgba(0,0,0,0.06)', padding: '0 5px', borderRadius: 999, fontSize: 9.5, fontWeight: 700 },

  main: { display: 'flex', gap: 10, flex: 1, minHeight: 0 },

  /* ── 로그 테이블 (다크) ── */
  tablePanel: {
    flex: 1, minWidth: 0, background: LOG_BG,
    border: `1px solid ${LOG_BORDER}`, borderRadius: 6,
    display: 'flex', flexDirection: 'column', overflow: 'hidden',
  },
  tableScroll: {
    flex: 1, overflow: 'auto', fontFamily: 'var(--mono)', background: LOG_BG,
    scrollbarColor: '#2a3550 transparent',
    scrollbarWidth: 'thin',
  },

  row: {
    display: 'grid',
    /* 메시지 col 최소 900px 보장 — 가시 폭이 좁으면 부모 (가상화 컨테이너) minWidth
       에 의해 row 가 가시폭 초과 → tableScroll 가로 스크롤 활성화. */
    gridTemplateColumns: '108px 56px 132px minmax(900px, 1fr)',
    alignItems: 'center',
    gap: 0,
    minHeight: ROW_ESTIMATE,
    borderBottom: `1px solid ${LOG_BORDER}`,
    cursor: 'pointer',
    fontSize: 11.5,
    fontFamily: 'var(--mono)',
  },
  rowSelected: { background: 'rgba(95,163,232,0.18)', outline: '1px solid #5fa3e8', outlineOffset: -1 },
  rowError: { background: 'rgba(232,93,117,0.12)' },
  rowWarn:  { background: 'rgba(232,181,99,0.08)' },
  rowQuarantined: { opacity: 0.45 },

  cellTime:  { padding: '3px 10px', color: '#7a8398', whiteSpace: 'nowrap' },
  cellMs:    { color: '#5a6280' },
  cellLevel: { padding: '3px 4px', whiteSpace: 'nowrap', textAlign: 'center' },
  cellStage: { padding: '3px 10px', whiteSpace: 'nowrap', fontWeight: 600 },

  /* row 안의 level 배지 — 다크 배경 위에서 잘 보이는 톤 */
  lvBadge: {
    display: 'inline-block', padding: '1px 6px', border: '1px solid', borderRadius: 3,
    fontSize: 9.5, fontWeight: 700, fontFamily: 'var(--mono)', letterSpacing: 0.5,
    minWidth: 44, textAlign: 'center',
  },
  lvInfo:  { color: '#a0a8b4', borderColor: '#3a4150', background: 'rgba(160,168,180,0.10)' },
  lvWarn:  { color: '#f5d76e', borderColor: '#7a6627', background: 'rgba(245,215,110,0.14)' },
  lvError: { color: '#ff8194', borderColor: '#7a2734', background: 'rgba(255,107,129,0.18)' },
  cellMsg: {
    padding: '3px 12px',
    whiteSpace: 'nowrap',
  },
  mark: { background: '#4a3f00', color: '#f5d76e', padding: '0 1px', borderRadius: 1 },
  quarantineTag: {
    display: 'inline-block', marginRight: 6,
    padding: '0 4px', borderRadius: 2,
    background: 'rgba(160,168,180,0.18)', color: '#a8b0c0',
    fontSize: 9.5, fontWeight: 700, letterSpacing: 0.4,
  },

  emptyRow: {
    padding: '40px 16px', textAlign: 'center',
    color: '#4a5060', fontFamily: 'var(--mono)', fontSize: 11, background: LOG_BG,
  },

  /* ── footer (라이트) ── */
  tableFooter: {
    padding: '5px 12px', borderTop: '1px solid var(--border)', background: 'var(--panel-2)',
    fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-4)',
    display: 'flex', justifyContent: 'flex-end',
  },

  /* ── 우측 상세 (라이트) — 콘텐츠 크기로만 차지, 메인은 옆으로 확장 ── */
  detail: {
    width: 240, flexShrink: 0,
    alignSelf: 'flex-start',
    background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 6,
    padding: '10px 12px', overflow: 'auto',
    display: 'flex', flexDirection: 'column', gap: 8,
    color: 'var(--text)',
  },
  detailHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  detailEyebrow: {
    fontSize: 10, fontWeight: 700, color: 'var(--text-3)', fontFamily: 'var(--mono)',
    letterSpacing: 0.8, textTransform: 'uppercase',
  },
  detailMsg: {
    fontFamily: 'var(--mono)', fontSize: 12, lineHeight: 1.5, color: 'var(--text)',
    background: 'var(--panel-2)', padding: '8px 10px',
    borderRadius: 4, border: '1px solid var(--border)', wordBreak: 'break-all',
  },
  detailMeta: { display: 'flex', flexDirection: 'column', gap: 4, padding: '0 2px' },
  metaRow: { display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 11 },
  metaLabel: {
    color: 'var(--text-4)', fontFamily: 'var(--mono)', fontSize: 10,
    textTransform: 'uppercase', letterSpacing: 0.5,
  },
  metaValue: { color: 'var(--text-2)', fontFamily: 'var(--mono)', fontSize: 11, textAlign: 'right', wordBreak: 'break-all' },

  /* level badge — 흰 배경에 잘 보이도록 라이트 톤 */
  levelBadge: {
    display: 'inline-block', padding: '1px 7px', border: '1px solid', borderRadius: 3,
    fontSize: 9.5, fontWeight: 700, fontFamily: 'var(--mono)', letterSpacing: 0.5,
    minWidth: 46, textAlign: 'center',
  },
  levelInfo:  { color: '#5a6172', borderColor: '#c8ccd3', background: 'rgba(120,128,140,0.08)' },
  levelWarn:  { color: '#a86b00', borderColor: '#e8b563', background: 'rgba(232,181,99,0.15)' },
  levelError: { color: '#c92a3f', borderColor: '#e85d75', background: 'rgba(232,93,117,0.12)' },


  /* STEP 필터 — 툴바 안 inline (INFO/WARN/ERROR chip 오른쪽) */
  stepInline: { display: 'inline-flex', alignItems: 'center', gap: 5 },
  stepInlineLabel: {
    fontSize: 10, fontWeight: 700, color: 'var(--text-3)', fontFamily: 'var(--mono)',
    letterSpacing: 0.8, textTransform: 'uppercase',
  },
  stepSelectInline: {
    padding: '3px 8px',
    border: '1px solid var(--border-strong)', borderRadius: 4,
    background: 'var(--panel)', color: 'var(--text)',
    fontSize: 11, fontFamily: 'var(--mono)', cursor: 'pointer',
    maxWidth: 180,
  },

  detailEmpty: {
    flex: 1, display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 24,
  },
  detailEmptyTitle: { fontSize: 12, fontWeight: 600, color: 'var(--text-3)' },
  detailEmptyHint:  { fontSize: 10.5, fontFamily: 'var(--mono)', color: 'var(--text-4)', marginTop: 4 },

  /* ── View 토글 (Stream / Quarantine) ── */
  viewToggle: {
    display: 'inline-flex', border: '1px solid var(--border-strong)', borderRadius: 4,
    overflow: 'hidden', background: 'var(--panel)',
  },
  viewToggleBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '4px 12px', border: 'none', background: 'transparent',
    color: 'var(--text-3)', fontSize: 11, fontWeight: 600, cursor: 'pointer',
    borderRight: '1px solid var(--border)',
  },
  viewToggleBtnActive: {
    /* 사이드바 Log viewer 탭 활성 색 (var(--navy)) 과 동일 — 시각적으로 한 가족. */
    background: 'var(--navy)', color: '#fff',
  },
  viewToggleCount: {
    display: 'inline-block', minWidth: 18, padding: '0 5px',
    background: 'rgba(0,0,0,0.18)', color: 'inherit',
    fontSize: 10, fontWeight: 700, fontFamily: 'var(--mono)',
    borderRadius: 999, textAlign: 'center',
  },

  /* Clear all (quarantine 모드 toolbar 우측) */
  clearAllBtn: {
    padding: '4px 10px', border: '1px solid var(--border-strong)', borderRadius: 4,
    background: 'var(--panel)', color: 'var(--text-2)',
    fontSize: 11, fontWeight: 600, cursor: 'pointer',
  },

  /* Quarantine group header (다크 배경 위 sticky) */
  groupHeader: {
    position: 'sticky', top: 0, zIndex: 1,
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '4px 12px',
    background: '#1d2438', borderBottom: `1px solid ${LOG_BORDER}`,
    fontFamily: 'var(--mono)',
  },
  groupHeaderStage: { fontSize: 11.5, fontWeight: 700, letterSpacing: 0.4 },
  groupHeaderCount: {
    display: 'inline-block', minWidth: 22, padding: '0 6px',
    background: '#2a3550', color: '#cdd5e0',
    fontSize: 10, fontWeight: 700, borderRadius: 999, textAlign: 'center',
  },
  groupHeaderBtn: {
    padding: '2px 9px', border: '1px solid #3a4566', borderRadius: 3,
    background: 'transparent', color: '#cdd5e0',
    fontSize: 10, fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--mono)',
  },

  /* Detail action button (우측 패널 내 격리/해제) */
  detailActionBtn: {
    marginTop: 4, padding: '6px 10px',
    border: '1px solid #2d92c7', borderRadius: 4,
    background: '#2d92c7', color: '#fff',
    fontSize: 11, fontWeight: 700, cursor: 'pointer',
  },
  detailActionBtnDisabled: {
    border: '1px solid var(--border-strong)', background: 'var(--panel-2)',
    color: 'var(--text-4)', cursor: 'not-allowed',
  },
  detailActionBtnDanger: {
    border: '1px solid #c92a3f', background: '#c92a3f',
  },

  /* ── Quarantine 모드 panel (라이트 톤) ── */
  quarPanel: {
    flex: 1, minWidth: 0,
    background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 6,
    display: 'flex', flexDirection: 'column', overflow: 'hidden',
  },
  quarHeader: {
    /* 2 줄 stack — 위: stats, 아래: 필터 한 줄. 한 줄 시도하면 severity 별 dropdown
       width 차이로 wrap 이 발생해 라인이 깨졌다. 분리해서 항상 안정. */
    display: 'flex', flexDirection: 'column', gap: 10,
    padding: '10px 14px',
    borderBottom: '1px solid var(--border)',
    background: 'var(--panel)',
  },
  quarFilterRow: {
    display: 'flex', alignItems: 'center', gap: 10,
    flexWrap: 'nowrap',
  },
  quarStats: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
  quarStatsEyebrow: {
    display: 'flex', alignItems: 'center', gap: 8,
    fontSize: 10, fontWeight: 800, color: 'var(--text-3)',
    fontFamily: 'var(--mono)', letterSpacing: 1.4, textTransform: 'uppercase',
  },
  /* QUARANTINE 옆 — 현재 project 이름 chip (SiteQuarantine 의 같은 패턴) */
  quarStatsProjectChip: {
    display: 'inline-flex', alignItems: 'center',
    padding: '2px 8px', borderRadius: 999,
    background: 'var(--panel-2)', border: '1px solid var(--border)',
    color: 'var(--text)',
    fontFamily: 'inherit', fontSize: 11, fontWeight: 600,
    letterSpacing: 0, textTransform: 'none',
    maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  quarStatsLine: {
    fontSize: 12, color: 'var(--text-2)', fontFamily: 'var(--mono)',
    display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap',
  },
  quarStatsSep: { color: 'var(--text-4)' },

  /* Severity 탭 그룹 */
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
  sevTabBtnActive:     { background: 'var(--panel)',                color: 'var(--text)' },
  sevTabBtnActiveErr:  { background: 'rgba(232,93,117,0.12)',       color: '#c92a3f' },
  sevTabBtnActiveWarn: { background: 'rgba(232,181,99,0.18)',       color: '#a86b00' },
  sevTabCount: {
    display: 'inline-block', minWidth: 14, padding: '0 5px',
    background: 'rgba(0,0,0,0.06)', fontSize: 10, fontWeight: 700,
    fontFamily: 'var(--mono)', borderRadius: 999, textAlign: 'center',
    color: 'inherit',
  },

  /* 테이블 dropdown — severity 탭 바로 옆. group dropdown 보다 좁게 (테이블명 위주). */
  tablePickSelect: {
    padding: '5px 10px', border: '1px solid var(--border-strong)', borderRadius: 4,
    background: 'var(--panel)', color: 'var(--text)',
    fontSize: 11.5, cursor: 'pointer',
    width: 180, flexShrink: 0,
  },
  groupPickSelect: {
    padding: '5px 10px', border: '1px solid var(--border-strong)', borderRadius: 4,
    background: 'var(--panel)', color: 'var(--text)',
    /* 사이드바 "프로젝트 검색" input 과 동일 폰트 (default sans, 11.5). */
    fontSize: 11.5, cursor: 'pointer',
    /* severity 별 옵션 text 길이가 달라도 dropdown 박스 width 가 변하지 않도록 고정. */
    width: 240, flexShrink: 0,
  },

  quarScroll: {
    flex: 1, overflow: 'auto', padding: 12,
    display: 'flex', flexDirection: 'column', gap: 12,
    background: 'var(--panel-2)',
  },
  quarEmpty: {
    padding: '60px 20px', textAlign: 'center',
    color: 'var(--text-4)', fontSize: 12, fontFamily: 'var(--mono)',
  },

  /* ── Group card ── */
  cardRoot: {
    display: 'flex',
    /* 부모(quarScroll) 가 flex column 이라 default flex-shrink:1 이면 카드 content 가
       잘림. flex-shrink:0 으로 자기 content 만큼 height 차지 + 부모는 overflow:auto 로 스크롤. */
    flexShrink: 0,
    background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 6,
    overflow: 'hidden',
    outline: 'none',
    transition: 'box-shadow 120ms ease, border-color 120ms ease',
  },
  cardLeftBar: { width: 4, flexShrink: 0 },
  cardBody: { flex: 1, minWidth: 0, padding: '10px 16px' },

  cardTopRow: {
    display: 'flex', alignItems: 'center', gap: 12,
  },
  /* chevron 만 클릭 가능 — 카드 전체 클릭 토글은 비활성. */
  cardChevron: {
    flexShrink: 0, width: 22, height: 22, padding: 0,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    border: '1px solid transparent', borderRadius: 4,
    background: 'transparent',
    color: 'var(--text-4)', fontSize: 11, lineHeight: 1, userSelect: 'none',
    cursor: 'pointer',
  },
  cardExpand: { marginTop: 12 },
  cardTitles: { display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 },
  cardReasonRow: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
  cardReason: { fontSize: 14, fontWeight: 700, lineHeight: 1.3 },
  /* reason 옆 테이블명 chip — 사이트/프로젝트 chip 과 같은 톤, mono. */
  cardTableChip: {
    display: 'inline-flex', alignItems: 'center',
    padding: '1px 8px', borderRadius: 999,
    background: 'var(--panel-2)', border: '1px solid var(--border)',
    color: 'var(--text-2)', fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
    maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  cardDetail: {
    fontSize: 11.5, color: 'var(--text-4)', fontFamily: 'var(--mono)',
    wordBreak: 'break-word',
  },
  /* DB 표기를 사람말로 풀이한 한 줄 — mono 가 아닌 본문 폰트, 본문 톤. */
  cardHumanDetail: {
    fontSize: 11.5, color: 'var(--text-2)', lineHeight: 1.45,
    marginTop: 4, wordBreak: 'keep-all',
  },
  cardMetaRight: {
    /* grid 로 3 컬럼 고정 width — 카드끼리 ROWS / stage / ts 의 좌측 시작점이 동일.
       stage 가장 긴 값 "validate.notnull" (16자) 기준 132px, ROWS 배지 72px, ts 96px. */
    display: 'grid',
    gridTemplateColumns: '72px 132px 96px',
    alignItems: 'center', gap: 10, flexShrink: 0,
    fontFamily: 'var(--mono)',
  },
  rowsBadge: {
    display: 'inline-flex', alignItems: 'center',
    padding: '3px 10px', border: '1px solid', borderRadius: 999,
    fontSize: 10.5, fontWeight: 800, letterSpacing: 0.6,
  },
  cardStage: { fontSize: 11, color: 'var(--text-3)', fontWeight: 600 },
  cardTs:    { fontSize: 11, color: 'var(--text-4)' },

  cardTableWrap: {
    border: '1px solid var(--border)', borderRadius: 4,
    /* sample row 수가 많아도 카드 자체가 너무 길어지지 않게 — 표 안에서 위아래 스크롤. */
    maxHeight: 280,
    overflow: 'auto',
  },
  cardTable: {
    width: '100%', borderCollapse: 'collapse',
    fontFamily: 'var(--mono)', fontSize: 11.5,
  },
  /* 모든 컬럼 헤더는 동일 톤 (panel + text-2) 으로 통일 — SiteQuarantine 과 동일. */
  cardTh: {
    textAlign: 'left', padding: '6px 12px',
    background: 'var(--panel)', color: 'var(--text-2)',
    fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase',
    borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
  },
  /* violated 컬럼 헤더 — color 는 호출부에서 sevColor 로 inline override, 굵기만 강조. */
  cardThViolated: { fontWeight: 800 },
  cardThPk: {},
  /* PROJECT_NAME 컬럼 — 시각 통일성을 위해 default cardTh 그대로 사용. */
  cardThTable: {},
  /* 컬럼 헤더 옆 role 라벨 — 컬럼 이름의 색을 그대로 상속 (violated 는 sevColor,
     pk 는 var(--text-2), context 는 var(--text-3)) → 가독성 확보. */
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

  /* 펼친 상태의 카드 — 좌측 bar 색과 같은 톤으로 살짝 강조 */
  cardRootOpen: {
    boxShadow: '0 1px 0 rgba(0,0,0,0.04), 0 8px 24px -12px rgba(0,0,0,0.18)',
  },

  /* 액션바 (펼친 카드 하단) */
  cardActions: {
    display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
    marginTop: 12, paddingTop: 12,
    borderTop: '1px solid var(--border)',
  },
  actPrimary: {
    padding: '6px 14px', border: '1px solid #1f8a5c', borderRadius: 4,
    background: '#21946a', color: '#fff',
    fontSize: 11.5, fontWeight: 700, cursor: 'pointer',
  },
  actWarn: {
    padding: '6px 14px', border: '1px solid var(--amber)', borderRadius: 4,
    background: 'var(--amber)', color: '#fff',
    fontSize: 11.5, fontWeight: 700, cursor: 'pointer',
  },
  actSecondary: {
    padding: '6px 14px', border: '1px solid var(--border-strong)', borderRadius: 4,
    background: 'var(--panel)', color: 'var(--text)',
    fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
  },
  actGhost: {
    padding: '6px 10px', border: 'none', borderRadius: 4,
    background: 'transparent', color: 'var(--text-2)',
    fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
  },
  actGhostIcon: {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    padding: '6px 10px', border: 'none', borderRadius: 4,
    background: 'transparent', color: 'var(--text-2)',
    fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
  },
  actGhostIconCh: { fontSize: 13, lineHeight: 1, color: 'var(--text-3)' },
  actLink: {
    padding: '6px 0', border: 'none', borderRadius: 0,
    background: 'transparent', color: 'var(--text-3)',
    fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
    textDecoration: 'none',
  },

  /* ── Run history 탭 (라이트 톤) — Quarantine panel 과 동일한 외곽 + 그 안에 평범한 table. ── */
  /* 注: padding を入れると sticky thead と scroll container の間に隙間ができ、
     その隙間にデータ行が見えてしまうので 0. 水平 margin は td/th の padding で取る. */
  historyScroll: {
    flex: 1, overflow: 'auto', padding: 0,
    background: 'var(--panel-2)',
  },
  historyTable: {
    width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontSize: 11,
    background: 'var(--panel)',
  },
  /* borderCollapse: separate + box-shadow で下線を描く. borderCollapse: collapse +
     border-bottom は sticky 中に下線がセルから離れる既知の挙動. */
  historyTh: {
    textAlign: 'left', padding: '8px 12px',
    color: 'var(--text-3)', fontSize: 10, fontWeight: 600,
    background: 'var(--panel)',
    position: 'sticky', top: 0, zIndex: 2,
    boxShadow: 'inset 0 -1px 0 var(--border)',
  },
  historyTd: {
    padding: '6px 12px', borderBottom: '1px solid var(--border)',
    fontSize: 11, color: 'var(--text-2)', whiteSpace: 'nowrap',
  },
  historyRefreshBtn: {
    padding: '5px 12px', border: '1px solid var(--border-strong)', borderRadius: 4,
    background: 'var(--panel)', color: 'var(--text-2)',
    fontSize: 11, fontWeight: 600, cursor: 'pointer',
  },
  historyFilterLabel: { display: 'inline-flex', alignItems: 'center', gap: 5 },
  historyFilterLabelText: {
    fontSize: 10, fontWeight: 700, color: 'var(--text-3)', fontFamily: 'var(--mono)',
    letterSpacing: 0.8, textTransform: 'uppercase',
  },
  historyFilterSelect: {
    padding: '4px 8px', border: '1px solid var(--border-strong)', borderRadius: 4,
    background: 'var(--panel)', color: 'var(--text)',
    fontSize: 11, fontFamily: 'var(--mono)', cursor: 'pointer',
    minWidth: 130,
  },
};
