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
} from '../store/executionPreflight';
import { useDemoMode } from '../lib/useDemoMode';
import { useT, type TranslationKey } from '../i18n';
import { Modal } from '../components/Modal';

type T = (key: TranslationKey, vars?: Record<string, string | number>) => string;

type StageTone = 'idle' | 'running' | 'ok';
type RunMode = 'rehearsal' | 'cutover';
type RunResult = 'ok' | 'warn' | 'failed' | 'aborted' | 'running';
type RunScope = 'all' | 'failed-only';
type BadgeTone = 'ok' | 'running' | 'queued' | 'err' | 'warn' | 'info';

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

  const { isDemo, exitDemo } = useDemoMode();

  /* Simulated live tick — drives the running stage's pct upward for visual feedback. */
  const [tick, setTick] = useState(0);
  const [running, setRunning] = useState(true);

  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 1200);
    return () => window.clearInterval(id);
  }, [running]);

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

  const setSelectedSnapshotId = (id: string | null) => {
    if (!project) return;
    useExecutionPreflightStore.getState().setSelectedSnapshot(project.id, id);
  };

  /* 현재 project 의 snapshot 만 (SnapshotSelector dropdown 옵션). */
  const projectSnapshots = useMemo(
    () => project ? snapshots.filter((s) => s.projectId === project.id) : [],
    [snapshots, project],
  );

  if (!project) {
    return (
      <div style={styles.empty}>
        <div style={styles.emptyTitle}>{t('execution.empty.noProject')}</div>
      </div>
    );
  }

  const isAll = tobeTables.length > 0 && selectedTables.size === tobeTables.length;
  const startPreflight = () => {
    if (selectedTables.size === 0 || preflightPhase === 'checking') return;
    const checks = buildPreflightChecks(project, Array.from(selectedTables), isAll, t, snapshots, selectedSnapshotId);
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

  /* Demo 모드: trigger 없이 즉시 결과 표시. */
  const displayedResults = isDemo ? buildDemoPreflightChecks(t) : preflightResults;
  const displayedPhase: PreflightPhase = isDemo ? 'done' : preflightPhase;
  const preflightPassed = displayedPhase === 'done'
    && displayedResults.length > 0
    && displayedResults.every((c) => c.status !== 'fail');

  const stages = animateStages(buildStages(project.phase), tick, running);
  const runs = buildRuns(project);
  const activeRun = runs.find((r) => r.result === 'running') ?? null;

  return (
    <div style={styles.page}>
      <RunHeader
        t={t}
        project={project}
        activeRun={activeRun}
        runs={runs}
        running={running}
        onToggleRun={() => setRunning((v) => !v)}
        preflightPassed={preflightPassed}
      />
      <TableSelector
        t={t}
        tables={tobeTables}
        selected={selectedTables}
        onChange={setSelectedTables}
      />
      <SnapshotSelector
        t={t}
        snapshots={projectSnapshots}
        selectedId={selectedSnapshotId}
        onChange={setSelectedSnapshotId}
      />
      <PreflightPanel
        t={t}
        checks={displayedResults}
        phase={displayedPhase}
        canStart={!isDemo && selectedTables.size > 0}
        onStart={startPreflight}
        onReset={() => useExecutionPreflightStore.getState().resetForProject(project.id)}
        isDemo={isDemo}
        onExitDemo={exitDemo}
      />
      <OverallProgress t={t} stages={stages} />
      <PipelineStages t={t} stages={stages} />
    </div>
  );
}

/* ───────────────────────── Run header ──────────────────────────── */

function RunHeader({
  t,
  project,
  activeRun,
  runs,
  running,
  onToggleRun,
  preflightPassed,
}: {
  t: T;
  project: Project;
  activeRun: Run | null;
  runs: Run[];
  running: boolean;
  onToggleRun: () => void;
  preflightPassed: boolean;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  // Start run 활성 = Pre-flight 모든 체크 pass. phase 체크는 별도 정책 결정 시 추가.
  const canStart = preflightPassed;
  const isDone = project.phase === 'done';

  if (!activeRun) {
    const lastRun = runs[0] ?? null;
    return (
      <>
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
              onClick={() => canStart && setDialogOpen(true)}
              disabled={!canStart}
              title={canStart ? t('execution.run.startReadyHint') : t('execution.run.startBlockedHint')}
              style={canStart ? styles.btnPrimary : styles.btnDisabled}
            >
              ▶ {t('execution.run.startBtn')}
            </button>
          )}
        </section>
        {dialogOpen && (
          <StartRunDialog
            t={t}
            project={project}
            onClose={() => setDialogOpen(false)}
          />
        )}
      </>
    );
  }

  const elapsedLabel = activeRun.eta
    ? t('execution.run.elapsedEta', {
        time: activeRun.startedAt.split(' ')[1] ?? activeRun.startedAt,
        elapsed: activeRun.elapsed,
        eta: activeRun.eta,
      })
    : t('execution.run.elapsed', {
        time: activeRun.startedAt.split(' ')[1] ?? activeRun.startedAt,
        elapsed: activeRun.elapsed,
      });

  return (
    <section style={styles.runHeader}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={styles.runHeaderLabel}>{t('execution.run.active')}</div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 16, fontWeight: 600 }}>{activeRun.id}</span>
          <StatusBadge tone={running ? 'running' : 'warn'}>
            {running ? t('execution.run.status.running') : t('execution.run.status.paused')}
          </StatusBadge>
          {activeRun.scope !== 'all' && (
            <StatusBadge tone="info">{activeRun.scopeLabel ?? activeRun.scope}</StatusBadge>
          )}
          <span style={{ fontSize: 12, color: 'var(--text-3)', fontFamily: 'var(--mono)' }}>{elapsedLabel}</span>
        </div>
        <div style={{ fontSize: 10.5, color: 'var(--text-3)', fontFamily: 'var(--mono)', marginTop: 3 }}>
          {t('execution.run.triggeredBy')}{' '}
          <b style={{ color: 'var(--text-2)' }}>{activeRun.triggeredBy.actor}</b>
          {activeRun.triggeredBy.source && <span> · {activeRun.triggeredBy.source}</span>}
        </div>
      </div>
      <button type="button" onClick={onToggleRun} style={styles.btnSecondary}>
        {running ? `⏸ ${t('execution.run.pause')}` : `▶ ${t('execution.run.resume')}`}
      </button>
      <button type="button" style={styles.btnDanger}>⏹ {t('execution.run.abort')}</button>
    </section>
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

/* ───────────────────────── Snapshot selector ───────────────────── */

function SnapshotSelector({
  t,
  snapshots,
  selectedId,
  onChange,
}: {
  t: T;
  snapshots: MappingSnapshot[];
  selectedId: string | null;
  onChange: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(true);

  if (snapshots.length === 0) {
    return (
      <div style={{ ...styles.section, background: 'var(--panel)' }}>
        <div style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={styles.sectionLabel}>{t('execution.preflight.snapshotSelector.title')}</span>
          <span style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--mono)' }}>
            {t('execution.preflight.snapshotSelector.noSnapshots')}
          </span>
        </div>
      </div>
    );
  }

  const selected = selectedId ? snapshots.find((s) => s.id === selectedId) ?? null : null;
  const headerLabel = selected
    ? `${selected.name} (${selected.version} · ${selected.status})`
    : t('execution.preflight.snapshotSelector.placeholder');

  return (
    <div style={{ ...styles.section, background: 'var(--panel)' }}>
      <div onClick={() => setOpen((v) => !v)} style={styles.sectionToggle}>
        <span style={styles.chev}>{open ? '▾' : '▸'}</span>
        <span style={styles.sectionLabel}>{t('execution.preflight.snapshotSelector.title')}</span>
        <span style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--mono)' }}>{headerLabel}</span>
        <div style={{ flex: 1 }} />
      </div>
      {open && (
        <div style={{ padding: '4px 18px 14px' }}>
          <select
            value={selectedId ?? ''}
            onChange={(e) => onChange(e.target.value || null)}
            style={{
              width: '100%',
              padding: '8px 12px',
              fontSize: 12,
              fontFamily: 'var(--mono)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              background: 'var(--panel)',
            }}
          >
            <option value="">— {t('execution.preflight.snapshotSelector.placeholder')} —</option>
            {snapshots.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.version} · {s.status})
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── Pre-flight panel ────────────────────── */

function PreflightPanel({ t, checks, phase, canStart, onStart, onReset, isDemo, onExitDemo }: {
  t: T;
  checks: PreflightCheck[];
  phase: PreflightPhase;
  canStart: boolean;
  onStart: () => void;
  onReset: () => void;
  isDemo?: boolean;
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
  const search = isDemo ? '?demo=preflight' : '';
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
      case 'approved-snapshot':
        // 프로젝트 단위 스냅샷 목록 = VersionsPage. site-level approvals 가 아니라 versions.
        navigate({ pathname: '/versions', search });
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
                background: st.tone === 'ok' ? 'var(--green)' : st.tone === 'idle' ? 'var(--text-4)' : st.color,
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
                background: st.tone === 'running' ? 'var(--amber-50)' : 'var(--panel)',
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
                {st.tone === 'idle' && <StatusBadge tone="queued">{t('execution.stages.status.queued')}</StatusBadge>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── Start run dialog ────────────────────── */

function StartRunDialog({
  t,
  project,
  onClose,
}: {
  t: T;
  project: Project;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<RunMode>('rehearsal');
  const [scope, setScope] = useState<RunScope>('all');
  const [confirmCutover, setConfirmCutover] = useState(false);

  const isCut = mode === 'cutover';
  const failedCount = 0; /* no source of failed-table list yet; wire to API later */
  const failedDisabled = failedCount === 0;

  useEffect(() => {
    if (scope === 'failed-only' && failedDisabled) setScope('all');
  }, [scope, failedDisabled]);

  const canConfirm = !isCut || confirmCutover;

  return (
    <Modal
      open
      onClose={onClose}
      width={460}
      title={
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{t('execution.dialog.title')}</div>
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2, fontFamily: 'var(--mono)' }}>
            {project.name} · {project.phase}
          </div>
        </div>
      }
    >
      <div>
        <div style={styles.dialogGroupLabel}>{t('execution.dialog.modeLabel')}</div>
        <ModeOption
          selected={mode === 'rehearsal'}
          onSelect={() => setMode('rehearsal')}
          title={t('execution.dialog.mode.rehearsal.title')}
          desc={t('execution.dialog.mode.rehearsal.desc')}
          tone="navy"
        />
        <ModeOption
          selected={mode === 'cutover'}
          onSelect={() => setMode('cutover')}
          title={t('execution.dialog.mode.cutover.title')}
          desc={t('execution.dialog.mode.cutover.desc')}
          tone="red"
        />

        <div style={{ ...styles.dialogGroupLabel, marginTop: 14 }}>{t('execution.dialog.scopeLabel')}</div>
        <ScopeOption
          selected={scope === 'all'}
          onSelect={() => setScope('all')}
          title={t('execution.dialog.scope.all.title')}
          desc={isCut
            ? t('execution.dialog.scope.all.desc.cutover')
            : t('execution.dialog.scope.all.desc.rehearsal')}
        />
        <ScopeOption
          selected={scope === 'failed-only'}
          onSelect={() => !failedDisabled && setScope('failed-only')}
          title={t('execution.dialog.scope.failed.title', { n: failedCount })}
          desc={isCut
            ? (failedDisabled
                ? t('execution.dialog.scope.failed.desc.cutoverEmpty')
                : t('execution.dialog.scope.failed.desc.cutover'))
            : (failedDisabled
                ? t('execution.dialog.scope.failed.desc.rehearsalEmpty')
                : t('execution.dialog.scope.failed.desc.rehearsal'))}
          disabled={failedDisabled}
        />

        {isCut && (
          <div
            style={{
              marginTop: 12, padding: 10,
              border: '1px solid var(--red)', background: 'var(--red-50)',
              borderRadius: 3, fontSize: 11, color: 'var(--red)', lineHeight: 1.55,
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 6 }}>{t('execution.dialog.confirmCutover.title')}</div>
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer', color: 'var(--text-2)' }}>
              <input
                type="checkbox"
                checked={confirmCutover}
                onChange={(e) => setConfirmCutover(e.target.checked)}
                style={{ marginTop: 2 }}
              />
              <span>{t('execution.dialog.confirmCutover.body')}</span>
            </label>
          </div>
        )}
      </div>

      <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" onClick={onClose} style={styles.btnSecondary}>{t('execution.dialog.cancel')}</button>
        <button
          type="button"
          disabled={!canConfirm}
          onClick={onClose} /* backend wiring TBD; closing for now */
          style={canConfirm ? (isCut ? styles.btnDanger : styles.btnPrimary) : styles.btnDisabled}
        >
          ▶ {isCut ? t('execution.dialog.start.cutover') : t('execution.dialog.start.rehearsal')}
        </button>
      </div>
    </Modal>
  );
}

function ModeOption({
  selected, onSelect, title, desc, tone,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  desc: string;
  tone: 'navy' | 'red';
}) {
  const accent = tone === 'red' ? 'var(--red)' : 'var(--navy)';
  return (
    <label
      onClick={onSelect}
      style={{
        display: 'flex', gap: 10, alignItems: 'flex-start',
        padding: '10px 12px',
        border: `1px solid ${selected ? accent : 'var(--border)'}`,
        background: selected ? (tone === 'red' ? 'var(--red-50)' : 'var(--navy-50)') : 'var(--panel)',
        borderRadius: 4, marginBottom: 6, cursor: 'pointer',
      }}
    >
      <input type="radio" checked={selected} onChange={onSelect} style={{ marginTop: 3 }} />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: selected ? accent : 'var(--text)' }}>{title}</div>
        <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2, lineHeight: 1.5 }}>{desc}</div>
      </div>
    </label>
  );
}

function ScopeOption({
  selected, onSelect, title, desc, disabled,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  desc: string;
  disabled?: boolean;
}) {
  const accent = 'var(--navy)';
  return (
    <label
      onClick={() => !disabled && onSelect()}
      style={{
        display: 'flex', gap: 10, alignItems: 'flex-start',
        padding: '8px 12px',
        border: `1px solid ${selected ? accent : 'var(--border)'}`,
        background: selected ? 'var(--navy-50)' : 'var(--panel)',
        borderRadius: 4, marginBottom: 6,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <input type="radio" checked={selected} disabled={disabled} onChange={() => !disabled && onSelect()} style={{ marginTop: 3 }} />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: selected ? accent : 'var(--text)' }}>{title}</div>
        <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2, lineHeight: 1.5 }}>{desc}</div>
      </div>
    </label>
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
  const fill = tone === 'ok' ? 'var(--green)' : tone === 'idle' ? 'var(--text-4)' : color;
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
  /* Snapshot of stages shaped by the project's current phase. Pre-rehearsal phases keep
     all idle; rehearsal/cutover phases simulate an in-flight pipeline; hypercare/done
     show all complete. */
  const runningPhases: ProjectPhase[] = ['rehearsal', 'cutover'];
  const completePhases: ProjectPhase[] = ['hypercare', 'done'];

  if (completePhases.includes(phase)) {
    return BASE_STAGES.map((s) => ({ ...s, pct: 100, tone: 'ok', rate: '—', eta: 'done' }));
  }
  if (runningPhases.includes(phase)) {
    return BASE_STAGES.map((s, i) => {
      if (i < 2) return { ...s, pct: 100, tone: 'ok', rate: '12.4k rows/s', eta: 'done' };
      if (i === 2) return { ...s, pct: 42, tone: 'running', rate: '8.1k rows/s', eta: '04:12' };
      return { ...s, pct: 0, tone: 'idle', rate: '—', eta: '—' };
    });
  }
  /* test / sign-off / ready — mostly idle with first stages possibly done. */
  if (phase === 'test') {
    return BASE_STAGES.map((s, i) => i < 2
      ? { ...s, pct: 100, tone: 'ok', rate: '—', eta: 'done' }
      : { ...s, pct: s.defaultPct, tone: s.defaultTone, rate: s.rate, eta: s.eta });
  }
  return BASE_STAGES.map((s) => ({ ...s, pct: s.defaultPct, tone: s.defaultTone }));
}

function animateStages(stages: Stage[], tick: number, running: boolean): Stage[] {
  if (!running) return stages;
  return stages.map((s) =>
    s.tone === 'running'
      ? { ...s, pct: Math.min(s.pct + ((tick * 0.4) % 3.5), 99) }
      : s,
  );
}

function buildPreflightChecks(
  project: Project,
  selectedTables: string[],
  isAll: boolean,
  t: T,
  snapshots: MappingSnapshot[],
  selectedSnapshotId: string | null,
): PreflightCheck[] {
  const asisDdl = project.tableCount > 0;
  const tobeDdl = project.tobeTableCount > 0;
  const bothDdl = asisDdl && tobeDdl;
  // 사용자가 SnapshotSelector 로 직접 선택한 스냅샷의 status 가 'approved' 인지 검사.
  // approved 가 아닌 스냅샷 (draft/pending/rejected) 도 선택은 가능하나 검사 결과는 fail.
  const selectedSnap = selectedSnapshotId
    ? snapshots.find((s) => s.id === selectedSnapshotId)
    : undefined;
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
    {
      id: 'approved-snapshot',
      title: t('execution.preflight.check.approvedSnapshot.title'),
      detail: !isAll
        ? t('execution.preflight.snapshot.skipReason')
        : !selectedSnap
          ? t('execution.preflight.check.approvedSnapshot.unselected')
          : selectedSnap.status === 'approved'
            ? t('execution.preflight.check.approvedSnapshot.passDetail', { name: selectedSnap.name, version: selectedSnap.version })
            : t('execution.preflight.check.approvedSnapshot.notApproved', { name: selectedSnap.name, status: selectedSnap.status }),
      status: !isAll
        ? 'skip'
        : !selectedSnap
          ? 'fail'
          : selectedSnap.status === 'approved' ? 'pass' : 'fail',
    },
  ];
}

/**
 * Demo 결과 — 8개 체크 모두 fail. 사용자가 demo 한 번 진입으로 모든 Fix 흐름
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
    { id: 'approved-snapshot', title: t('execution.preflight.check.approvedSnapshot.title'), detail: t('execution.preflight.check.approvedSnapshot.fail'), status: 'fail' },
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

  section:        { borderBottom: '1px solid var(--border)' },
  sectionToggle:  { padding: '9px 18px', display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' },
  sectionLabel:   { fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.6, color: 'var(--text-3)' },
  chev:           { color: 'var(--text-4)', fontSize: 10, width: 10 },

  dialogGroupLabel: {
    fontSize: 10.5, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8,
  },

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
