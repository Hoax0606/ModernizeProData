import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { tobeDdlApi, type DdlSchema } from '../api/tobeDdl';
import { mappingImportApi, type MappingRuleDto, type MappingTableBindingDto } from '../api/mappingImport';
import { useWorkspaceStore, type Project } from '../store/workspace';
import { useUsersStore } from '../store/users';
import { useAuthStore } from '../store/auth';
import { useSnapshotsStore } from '../store/snapshots';
import { useMappingEditsStore, type RowEdit, type TableBindingEdit } from '../store/mappingEdits';
import { useQuery } from '@tanstack/react-query';
import { runsApi, type RunHistoryDto } from '../api/runs';
import { CreateSiteModal } from '../components/CreateSiteModal';
import { CreateProjectModal } from '../components/CreateProjectModal';
import { DdlImportButton } from '../components/DdlImportButton';
import { HourglassHalfIcon } from '../components/HourglassHalfIcon';
import { csvPreviewApi } from '../api/csvPreview';
import { useT } from '../i18n';

/**
 * Migration readiness dashboard.
 *
 * 3 단계 empty state:
 *  1. 사이트 없음    → 사이트 만들기 CTA
 *  2. 프로젝트 없음 → 프로젝트 만들기 CTA
 *  3. 프로젝트 있음 → 정상 stat row + 테이블
 */
export function DashboardPage() {
  const t = useT();
  const sites = useWorkspaceStore((s) => s.sites);
  const projects = useWorkspaceStore((s) => s.projects);
  const activeSiteId = useWorkspaceStore((s) => s.activeSiteId);
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);

  const site = useMemo(() => sites.find((s) => s.id === activeSiteId) ?? null, [sites, activeSiteId]);
  const project = useMemo(() => projects.find((p) => p.id === activeProjectId) ?? null, [projects, activeProjectId]);
  const siteProjects = useMemo(() => projects.filter((p) => p.siteId === activeSiteId), [projects, activeSiteId]);

  return (
    <>
      {!site ? <SiteOnboarding />
        : siteProjects.length === 0 ? <ProjectOnboarding siteName={site.name} />
        : !project ? <SiteOverview siteName={site.name} projects={siteProjects} />
        : (project.tableCount === 0 || project.tobeTableCount === 0)
          ? <MappingOnboarding project={project} />
        : <ProjectDashboard project={project} />}
    </>
  );
}

/* ─── 1단계: 사이트 없음 ─────────────────────────────────── */

function SiteOnboarding() {
  const t = useT();
  const [open, setOpen] = useState(false);

  return (
    <>
      <div style={styles.welcomeCard}>
        <div style={styles.welcomeIconWrap}><img src="/mpd.png" alt="" width={48} height={48} /></div>
        <h1 style={styles.welcomeTitle}>{t('onboarding.welcomeTitle')}</h1>
        <p style={styles.welcomeDesc}>{t('onboarding.welcomeDesc')}</p>

        <div style={styles.steps}>
          <Step n={1} title={t('onboarding.step.site')} active />
          <Step n={2} title={t('onboarding.step.project')} />
          <Step n={3} title={t('onboarding.step.mapping')} />
        </div>

        <button style={styles.btnPrimary} onClick={() => setOpen(true)}>
          {t('onboarding.siteCta')}
        </button>
      </div>

      <CreateSiteModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}

/* ─── 2단계: 사이트는 있고 프로젝트 없음 ────────────────── */

function ProjectOnboarding({ siteName }: { siteName: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);

  return (
    <>
      <div style={styles.welcomeCard}>
        <div style={styles.welcomeIconWrap}><img src="/mpd.png" alt="" width={48} height={48} /></div>
        <h1 style={styles.welcomeTitle}>{siteName} {t('onboarding.projectTitle')}</h1>
        <p style={styles.welcomeDesc}>{t('onboarding.projectDesc')}</p>

        <div style={styles.steps}>
          <Step n={1} title={t('onboarding.step.site')} done />
          <Step n={2} title={t('onboarding.step.project')} active />
          <Step n={3} title={t('onboarding.step.mapping')} />
        </div>

        <button style={styles.btnPrimary} onClick={() => setOpen(true)}>
          {t('onboarding.projectCta')}
        </button>
      </div>

      <CreateProjectModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}

/* ─── 3단계: 프로젝트 생성 직후 — DDL · 매핑 안내 ─────── */

export function MappingOnboarding({ project }: { project: Project }) {
  const t = useT();
  const asisDone = project.tableCount > 0;
  const tobeDone = project.tobeTableCount > 0;
  return (
    <div style={styles.welcomeCard}>
      <div style={styles.welcomeIconWrap}><img src="/mpd.png" alt="" width={48} height={48} /></div>
      <h1 style={styles.welcomeTitle}>{project.name} {t('onboarding.mappingTitle')}</h1>
      <p style={styles.welcomeDesc}>{t('onboarding.mappingDesc')}</p>

      <div style={styles.steps}>
        <Step n={1} title={t('onboarding.step.site')} done />
        <Step n={2} title={t('onboarding.step.project')} done />
        <Step n={3} title={t('onboarding.step.mapping')} active />
      </div>

      <div style={{ display: 'flex', gap: 10, justifyContent: 'center', alignItems: 'flex-start' }}>
        <DdlImportButton
          projectId={project.id}
          siteId={project.siteId}
          side="asis"
          disabled={asisDone}
          label={asisDone ? t('asisDdl.button.imported') : undefined}
        />
        <DdlImportButton
          projectId={project.id}
          siteId={project.siteId}
          side="tobe"
          disabled={tobeDone}
          label={tobeDone ? t('tobeDdl.button.imported') : undefined}
        />
      </div>
    </div>
  );
}

/* ─── 4단계: 정상 Dashboard ──────────────────────────────── */

/**
 * Per-TO-BE-table dashboard row.
 *
 * mapping 機能はまだ未実装なので、現状は全テーブルが 'unbound' に着地する.
 * mapping データができたら mappedColumns/issuesCount をその値で埋めれば
 * coverage / readiness が自然に推移する.
 */
interface DashboardRow {
  tableId: string;
  schemaName: string;
  physicalName: string;
  totalColumns: number;
  mappedColumns: number;
  issuesCount: number;
  readiness: 'ready' | 'review' | 'unbound';
  sourceTables: string[];
}

function ProjectDashboard({ project }: { project: import('../store/workspace').Project }) {
  const t = useT();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<'all' | 'ready' | 'review' | 'unbound'>('all');
  const [tobeSchema, setTobeSchema] = useState<DdlSchema | null>(null);
  const allSnapshots = useSnapshotsStore((s) => s.snapshots);
  const fetchSnapshots = useSnapshotsStore((s) => s.fetchByProject);
  const snapshots = useMemo(
    () => allSnapshots.filter((sn) => sn.projectId === project.id),
    [allSnapshots, project.id],
  );

  // RUN STATUS card — BE 의 run_history 최신 1건을 10s polling 으로 가져와 표시.
  // (이전 demo 모드는 store 의 mock activeRun 참조; 이번 PoC1 real 모드 wiring 으로 교체.)
  const runsQuery = useQuery({
    queryKey: ['run-history', project.id],
    queryFn: () => runsApi.listByProject(project.id),
    refetchInterval: 10_000,
    staleTime: 5_000,
  });
  const activeRun: RunHistoryDto | null = runsQuery.data?.[0] ?? null;

  // mapping edits store — TO-BE table 別の bindings / row mapping (mapped 数 と AS-IS source の出所).
  const tableBindings = useMappingEditsStore((s) => s.tableBindingEdits[project.id]) as
    Record<string, TableBindingEdit> | undefined;
  const rowEditsByTable = useMappingEditsStore((s) => s.rowEdits[project.id]) as
    Record<string, Record<string, RowEdit>> | undefined;

  // BE truth — mapping store 는 MappingPage 방문 시에만 hydrate 되므로, 새 세션에서
  // Dashboard 먼저 열면 전부 unbound 로 보이는 stale 버그 (2026-06-03). server rules /
  // bindings 를 직접 fetch 해 store 미존재 테이블의 fallback 으로 사용.
  // refetchOnMount:'always' — Mapping 편집 후 Dashboard 로 돌아올 때마다(route remount)
  // 무조건 최신 rules/bindings 재조회 → 매핑 진행률 거의 실시간 (편집은 항상 MappingPage
  // 에서 일어나고 Dashboard 는 그 뒤에 열리므로). idle 폴링 0 (2026-06-04).
  const serverRulesQuery = useQuery({
    queryKey: ['mapping-rules', project.id],
    queryFn: () => mappingImportApi.listRules(project.id),
    staleTime: 10_000,
    refetchOnMount: 'always',
  });
  const serverBindingsQuery = useQuery({
    queryKey: ['mapping-bindings', project.id],
    queryFn: () => mappingImportApi.listBindings(project.id),
    staleTime: 10_000,
    refetchOnMount: 'always',
  });
  const serverRules = serverRulesQuery.data;
  const serverBindings = serverBindingsQuery.data;

  useEffect(() => {
    let alive = true;
    tobeDdlApi.get(project.id)
      .then((s) => { if (alive) setTobeSchema(s); })
      .catch(() => { if (alive) setTobeSchema({ latestImport: null, tables: [] }); });
    fetchSnapshots(project.id);
    return () => { alive = false; };
  }, [project.id, fetchSnapshots]);

  // 当該プロジェクトの承認済み snapshot 中の最新バージョン.
  // per-table 関連付けはまだないので、全行に同じ値を表示する.
  const latestApprovedVersion = useMemo(() => {
    const approved = snapshots.filter((s) => s.status === 'approved');
    if (approved.length === 0) return null;
    // createdAt 降順の最新を採用
    return approved.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0].version;
  }, [snapshots]);

  // 자식 link 테이블의 mapped 카운트를 master 의 server-side rules 로 계산하기 위해
  // 자식 binding 이 가리키는 master project 들의 rules 를 fetch.
  const masterIdsKey = useMemo(() => {
    const ids = new Set<string>();
    for (const b of Object.values(tableBindings ?? {})) {
      if (b?.sharedFromProjectId) ids.add(b.sharedFromProjectId);
    }
    // store 미hydrate 세션 — server bindings 의 link 도 포함.
    for (const b of serverBindings ?? []) {
      if (b.sharedFromProjectId) ids.add(b.sharedFromProjectId);
    }
    return [...ids].sort().join(',');
  }, [tableBindings, serverBindings]);
  const [masterRulesByProject, setMasterRulesByProject] = useState<Map<string, MappingRuleDto[]>>(new Map());
  useEffect(() => {
    if (!masterIdsKey) { setMasterRulesByProject(new Map()); return; }
    const masterIds = masterIdsKey.split(',');
    let alive = true;
    (async () => {
      const m = new Map<string, MappingRuleDto[]>();
      await Promise.all(masterIds.map(async (id) => {
        const rs = await mappingImportApi.listRules(id).catch(() => [] as MappingRuleDto[]);
        m.set(id, rs);
      }));
      if (alive) setMasterRulesByProject(m);
    })();
    return () => { alive = false; };
  }, [masterIdsKey]);

  const rows: DashboardRow[] = useMemo(() => {
    if (!tobeSchema) return [];

    // server bindings 를 qualified ("schema.table") / short ("table") 두 색인으로 —
    // SiteOverview 와 같은 qualified-first, short-fallback 해석.
    const bindingByQualified = new Map<string, MappingTableBindingDto>();
    const bindingByShort = new Map<string, MappingTableBindingDto>();
    for (const b of serverBindings ?? []) {
      const qualified = ((b.tobeSchema ? b.tobeSchema + '.' : '') + b.tobeTable).toLowerCase();
      const short = b.tobeTable.toLowerCase();
      bindingByQualified.set(qualified, b);
      if (!bindingByShort.has(short)) bindingByShort.set(short, b);
    }
    // server rules → per-table mapped count (store 미hydrate fallback).
    const serverMappedByKey = new Map<string, number>();
    for (const r of serverRules ?? []) {
      if (!isMappingRuleMapped(r)) continue;
      const qualified = ((r.tobeSchema ? r.tobeSchema + '.' : '') + r.tobeTable).toLowerCase();
      serverMappedByKey.set(qualified, (serverMappedByKey.get(qualified) ?? 0) + 1);
    }

    return tobeSchema.tables.map((tw) => {
      const total = tw.columns.length;
      const qualified = ((tw.table.schemaName ? tw.table.schemaName + '.' : '') + tw.table.physicalName).toLowerCase();
      const short = tw.table.physicalName.toLowerCase();
      const binding = tableBindings?.[tw.table.id];
      const serverBinding = bindingByQualified.get(qualified) ?? bindingByShort.get(short);
      const sourceTables = binding
        ? uniqueSourceTables(binding)
        : [...new Set((serverBinding?.sources ?? []).map((s) => s.asisTable.trim()).filter(Boolean))];
      // 자식 link 테이블 — master 의 server-side rules 로 mapped 카운트.
      // 자체 정의 — store hydrate 済이면 rowEdits 로 즉시 반응, 아니면 server rules fallback.
      const sharedFrom = binding?.sharedFromProjectId ?? serverBinding?.sharedFromProjectId ?? null;
      let mapped: number;
      if (sharedFrom) {
        const masterRules = masterRulesByProject.get(sharedFrom) ?? [];
        const tobeTable = tw.table.physicalName.toLowerCase();
        const tobeSchemaLc = (tw.table.schemaName ?? '').toLowerCase();
        mapped = masterRules.filter((r) =>
          r.tobeTable.toLowerCase() === tobeTable
          && (r.tobeSchema ?? '').toLowerCase() === tobeSchemaLc
          && isMappingRuleMapped(r),
        ).length;
      } else {
        const storeEdits = rowEditsByTable?.[tw.table.id];
        mapped = storeEdits && Object.keys(storeEdits).length > 0
          ? countMapped(storeEdits)
          : (serverMappedByKey.get(qualified)
              ?? serverMappedByKey.get(((serverBinding?.tobeSchema ? serverBinding.tobeSchema + '.' : '') + short).toLowerCase())
              ?? 0);
      }
      let readiness: DashboardRow['readiness'];
      if (mapped === 0) readiness = 'unbound';
      else if (mapped >= total) readiness = 'ready';
      else readiness = 'review';
      return {
        tableId: tw.table.id,
        schemaName: tw.table.schemaName ?? '',
        physicalName: tw.table.physicalName,
        totalColumns: total,
        mappedColumns: mapped,
        issuesCount: Math.max(total - mapped, 0),
        readiness,
        sourceTables,
      };
    });
  }, [tobeSchema, rowEditsByTable, tableBindings, masterRulesByProject, serverRules, serverBindings]);

  const counts = useMemo(() => ({
    total: rows.length,
    ready: rows.filter((r) => r.readiness === 'ready').length,
    review: rows.filter((r) => r.readiness === 'review').length,
    unbound: rows.filter((r) => r.readiness === 'unbound').length,
  }), [rows]);

  const filtered = filter === 'all' ? rows : rows.filter((r) => r.readiness === filter);

  const goToMapping = (internalName: string) => {
    navigate('/mapping', { state: { focusTable: { internalName } } });
  };

  return (
    <div>
      {/* Stat row */}
      <div style={styles.statRow}>
        <Stat label="TO-BE TABLES" value={String(counts.total)} />
        <Stat label="READY"   value={String(counts.ready)}   tone="ok" />
        <Stat label="REVIEW"  value={String(counts.review)}  tone="warn" />
        <Stat label="UNBOUND" value={String(counts.unbound)} tone="err" />
        <Stat
          label="SNAPSHOT"
          value={latestApprovedVersion ?? '—'}
          sub={latestApprovedVersion ? 'approved' : 'no approved snapshot'}
          tone={latestApprovedVersion ? 'ok' : 'idle'}
          mono
        />
        <Stat
          label="RUN STATUS"
          value={activeRun ? activeRunDisplay(activeRun).label : '—'}
          sub={activeRun ? activeRun.id : 'no active run'}
          tone={activeRun ? activeRunDisplay(activeRun).tone : 'idle'}
          mono
          small={!!activeRun}
        />
      </div>

      {/* Filter */}
      <div style={styles.toolbar}>
        <div style={styles.filterGroup}>
          <FilterPill active={filter === 'all'}     onClick={() => setFilter('all')}>All       <Cnt>{counts.total}</Cnt></FilterPill>
          <FilterPill active={filter === 'ready'}   onClick={() => setFilter('ready')}>Ready   <Cnt>{counts.ready}</Cnt></FilterPill>
          <FilterPill active={filter === 'review'}  onClick={() => setFilter('review')}>Review <Cnt>{counts.review}</Cnt></FilterPill>
          <FilterPill active={filter === 'unbound'} onClick={() => setFilter('unbound')}>Unbound <Cnt>{counts.unbound}</Cnt></FilterPill>
        </div>
        <div style={{ flex: 1 }} />
        <span style={styles.filterCount}>
          {filtered.length} of {rows.length} tables
        </span>
      </div>

      {/* Table */}
      <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <Th width={28} align="center" />
              <Th width={300}>TO-BE TABLE</Th>
              <Th width={280}>AS-IS SOURCE</Th>
              <Th width={300} align="center">MAPPING PROGRESS</Th>
              <Th width={130} align="center">READINESS</Th>
              <Th width={36} />
            </tr>
          </thead>
          <tbody>
            {tobeSchema === null ? (
              <tr>
                <td colSpan={6} style={styles.emptyRow}>
                  <div style={styles.emptyHint}>Loading</div>
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={6} style={styles.emptyRow}>
                  <div style={styles.emptyTitle}>{t('dashboard.empty.title')}</div>
                  <div style={styles.emptyHint}>{t('dashboard.empty.hint')}</div>
                </td>
              </tr>
            ) : filtered.map((r, i) => (
              <tr
                key={r.tableId}
                onClick={() => goToMapping(r.tableId)}
                style={{
                  background: i % 2 === 1 ? 'var(--zebra)' : 'var(--panel)',
                  borderBottom: '1px solid var(--border)',
                  cursor: 'pointer',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--panel-2)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = i % 2 === 1 ? 'var(--zebra)' : 'var(--panel)'; }}
              >
                <td style={{ ...styles.td, textAlign: 'center' }}><ReadinessDot kind={r.readiness} /></td>
                <td style={{ ...styles.td, fontFamily: 'var(--mono)', fontWeight: 500 }}>
                  {r.schemaName && (
                    <span style={{ color: 'var(--text)' }}>{r.schemaName}.</span>
                  )}
                  {r.physicalName}
                </td>
                <td style={{ ...styles.td, fontFamily: 'var(--mono)', fontSize: 11 }}>
                  <AsisSourceCell tables={r.sourceTables} />
                </td>
                <td style={{ ...styles.td, textAlign: 'center' }}>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, width: '100%', maxWidth: 260 }}>
                    <ProgressBar
                      pct={r.totalColumns > 0 ? (r.mappedColumns / r.totalColumns) * 100 : 0}
                    />
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-2)', minWidth: 56, textAlign: 'right' }}>
                      {r.mappedColumns}/{r.totalColumns}
                    </span>
                  </div>
                </td>
                <td style={{ ...styles.td, textAlign: 'center' }}><ReadinessBadge kind={r.readiness} /></td>
                <td style={{ ...styles.td, textAlign: 'center', color: 'var(--text-4)', fontSize: 16, lineHeight: 1 }}>›</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** rowEdits[targetCol] → "mapped" 判定. MappingPage と同じロジック. */
function countMapped(edits: Record<string, RowEdit> | undefined): number {
  if (!edits) return 0;
  let n = 0;
  for (const re of Object.values(edits)) {
    if (re.savedStrategy === 'null' || re.savedStrategy === 'default') { n++; continue; }
    const hasSrc = re.savedSrc?.some((s) => s && s.trim() !== '') ?? false;
    const hasRule = !!(re.savedRule && re.savedRule.trim());
    if (hasSrc || hasRule) n++;
  }
  return n;
}

function uniqueSourceTables(binding: TableBindingEdit): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of binding.sources) {
    const tbl = (s.table ?? '').trim();
    if (!tbl) continue;
    if (seen.has(tbl)) continue;
    seen.add(tbl);
    out.push(tbl);
  }
  return out;
}

function AsisSourceCell({ tables }: { tables: string[] }) {
  if (tables.length === 0) {
    return <span style={{ color: 'var(--text-4)', fontStyle: 'italic' }}>(no source)</span>;
  }
  // 一覧では最大 2 個まで, 残りは "+N more".
  const head = tables.slice(0, 2);
  const more = tables.length - head.length;
  return (
    <span title={tables.join(', ')}>
      <span style={{ color: 'var(--text)' }}>{head.join(', ')}</span>
      {more > 0 && (
        <span style={{ color: 'var(--text-4)' }}>{' '}+{more} more</span>
      )}
    </span>
  );
}

/**
 * 최신 run 의 표시 라벨 + 색. ExecutionPage 의 StatusBadge 와 같은 매핑:
 *   failed/timed_out → err / aborted → warn / success(=completed) → idle / paused → warn / running/pending → ok
 */
function activeRunDisplay(run: RunHistoryDto): { label: string; tone: 'ok' | 'warn' | 'err' | 'idle' } {
  if (run.status === 'failed' || run.status === 'timed_out') return { label: 'failed', tone: 'err' };
  if (run.status === 'aborted') return { label: 'aborted', tone: 'warn' };
  if (run.status === 'success') return { label: 'completed', tone: 'idle' };
  if (run.status === 'paused') return { label: 'paused', tone: 'warn' };
  return { label: 'running', tone: 'ok' };
}

/**
 * Mapping ページの TobeCoverageBar と同じスタイル — mapped 部分は緑, 未 mapped 部分は赤の
 * 2 セグメント. 全部 mapped → 全部緑 / 何も mapped されてない → 全部赤 / 途中なら緑+赤.
 */
function ProgressBar({ pct }: { pct: number }) {
  const mapped = Math.min(100, Math.max(0, pct));
  const unmapped = 100 - mapped;
  return (
    <div style={{
      flex: 1, display: 'flex', height: 6,
      border: '1px solid var(--border)', borderRadius: 3, overflow: 'hidden',
      background: 'var(--border)',
    }}>
      <div style={{ width: `${mapped}%`, background: 'var(--green)' }} />
      <div style={{ width: `${unmapped}%`, background: 'var(--red)' }} />
    </div>
  );
}

function ReadinessDot({ kind }: { kind: DashboardRow['readiness'] }) {
  const color = kind === 'ready' ? 'var(--green)'
              : kind === 'unbound' ? 'var(--red)'
              : 'var(--amber)';
  return <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: color }} />;
}

function ReadinessBadge({ kind }: { kind: DashboardRow['readiness'] }) {
  const tone = kind === 'ready' ? { bg: 'var(--green-50)', fg: 'var(--green)', br: 'var(--green)' }
             : kind === 'unbound' ? { bg: 'var(--red-50)', fg: 'var(--red)', br: 'var(--red)' }
             : { bg: 'var(--amber-50)', fg: 'var(--amber)', br: 'var(--amber)' };
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', fontSize: 10.5,
      fontWeight: 700, fontFamily: 'var(--mono)',
      background: tone.bg, color: tone.fg, border: `1px solid ${tone.br}`,
      borderRadius: 3, textTransform: 'uppercase', letterSpacing: 0.4,
    }}>{kind}</span>
  );
}

/* ─── Sub-components ─────────────────────────────────── */

function Step({ n, title, active, done }: { n: number; title: string; active?: boolean; done?: boolean }) {
  const state: 'active' | 'done' | 'idle' = done ? 'done' : active ? 'active' : 'idle';
  return (
    <div style={styles.step}>
      <div style={{
        ...styles.stepNum,
        ...(state === 'active' ? styles.stepNumActive : state === 'done' ? styles.stepNumDone : {}),
      }}>
        {state === 'done' ? '✓' : n}
      </div>
      <div style={{
        ...styles.stepTitle,
        ...(state === 'active' ? { color: 'var(--navy)', fontWeight: 600 } : {}),
      }}>{title}</div>
    </div>
  );
}

function Stat({ label, value, sub, tone, mono, small }: { label: string; value: React.ReactNode; sub?: string; tone?: 'ok' | 'warn' | 'err' | 'idle'; mono?: boolean; small?: boolean }) {
  const valueColor = tone === 'ok'   ? 'var(--green)'
                   : tone === 'warn' ? 'var(--amber)'
                   : tone === 'err'  ? 'var(--red)'
                   : tone === 'idle' ? 'var(--text-3)'
                   : 'var(--text)';
  // small: 「test · aborted」みたいに長めの compound 値を 1 行に収めるため.
  // 上下中央そろえも調整してほかの大きい value と base line を合わせる.
  const valueStyle: React.CSSProperties = {
    ...styles.statValue,
    color: valueColor,
    ...(mono ? { fontFamily: 'var(--mono)' } : {}),
    ...(small ? { fontSize: 14, fontWeight: 600, paddingTop: 6, whiteSpace: 'nowrap' } : {}),
  };
  return (
    <div style={styles.stat}>
      <div style={styles.statLabel}>{label}</div>
      <div style={valueStyle}>{value}</div>
      {sub && <div style={styles.statSub}>{sub}</div>}
    </div>
  );
}

function FilterPill({ active, onClick, children }: { active?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{
      padding: '4px 10px',
      background: active ? 'var(--navy-50)' : 'var(--panel)',
      border: '1px solid ' + (active ? 'var(--navy)' : 'var(--border)'),
      color: active ? 'var(--navy)' : 'var(--text-2)',
      borderRadius: 4,
      fontSize: 12,
      fontWeight: active ? 600 : 500,
      cursor: 'pointer',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
    }}>
      {children}
    </button>
  );
}

function Cnt({ children }: { children: React.ReactNode }) {
  return <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-4)' }}>{children}</span>;
}

function Th({ children, align, width }: { children?: React.ReactNode; align?: 'left' | 'right' | 'center'; width?: number }) {
  return (
    <th style={{
      padding: '6px 12px',
      textAlign: align ?? 'left',
      width,
      fontWeight: 500,
      color: 'var(--text-3)',
      fontSize: 10.5,
      textTransform: 'uppercase',
      letterSpacing: 0.6,
      background: 'var(--panel-2)',
      borderBottom: '1px solid var(--border)',
    }}>{children}</th>
  );
}

/* ─── Site overview: All projects (사이트 선택, 프로젝트 미선택) ── */

const PHASES: Project['phase'][] = ['planning', 'analysis', 'test', 'sign-off', 'rehearsal', 'ready', 'cutover', 'hypercare', 'done'];

function SiteOverview({ siteName, projects }: { siteName: string; projects: Project[] }) {
  const t = useT();
  const navigate = useNavigate();
  const setActiveProject = useWorkspaceStore((s) => s.setActiveProject);
  const setProjectAssignee = useWorkspaceStore((s) => s.setProjectAssignee);
  const activeSiteId = useWorkspaceStore((s) => s.activeSiteId);
  const user = useAuthStore((s) => s.user);
  const isMaster = user?.role === 'master';
  const users = useUsersStore((s) => s.users);
  // Coordinator(master) 만 dropdown 으로 변경 가능. 그 외 사용자는 본인 row 도 text 로 표시.
  const canEditRow = (_p: Project) => isMaster;

  // Snapshot pending 표시 — 프로젝트별로 pending snapshot 이 1개 이상이면 이름 옆에 아이콘.
  // 사이트 단위 fetch (Approvals 이전에 들렀어도 store 가 비어있을 수 있어서).
  const allSnapshots = useSnapshotsStore((s) => s.snapshots);
  const fetchSnapshotsBySite = useSnapshotsStore((s) => s.fetchBySite);
  useEffect(() => {
    if (activeSiteId) void fetchSnapshotsBySite(activeSiteId);
  }, [activeSiteId, fetchSnapshotsBySite]);
  const pendingProjectIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of allSnapshots) {
      if (s.status === 'pending') ids.add(s.projectId);
    }
    return ids;
  }, [allSnapshots]);
  // 프로젝트별 최신 approved snapshot 버전 — Version 컬럼용. 없으면 undefined.
  const approvedVersionByProject = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of allSnapshots) {
      if (s.status !== 'approved') continue;
      const cur = m.get(s.projectId);
      if (cur === undefined || String(s.version).localeCompare(cur, undefined, { numeric: true }) > 0) {
        m.set(s.projectId, String(s.version));
      }
    }
    return m;
  }, [allSnapshots]);

  // 'Rows' KPI — AS-IS CSV 전체 data row 수 합 (2026-06-03: TO-BE 컬럼 기준 → AS-IS 기준).
  // 첫 호출은 전체 CSV scan 이라 느릴 수 있어 도착 전엔 '—' 표시. BE 가 mtime+size 캐시 보유.
  const { data: asisRowTotal } = useQuery({
    queryKey: ['site-csv-row-total', activeSiteId],
    enabled: !!activeSiteId,
    queryFn: () => csvPreviewApi.siteRowTotal(activeSiteId!),
    staleTime: 60_000,
    retry: false,
  });

  // 담당자 변경 draft — Save 누르기 전까지는 backend / store 에 반영 안 됨.
  const [assigneeDraft, setAssigneeDraft] = useState<Record<string, string>>({});
  const [savingAssignees, setSavingAssignees] = useState(false);
  const dirtyAssigneeIds = useMemo(() => Object.keys(assigneeDraft).filter((id) => {
    const p = projects.find((pp) => pp.id === id);
    if (!p) return false;
    return (assigneeDraft[id] ?? '') !== (p.assignee ?? '');
  }), [assigneeDraft, projects]);
  const handleSaveAssignees = async () => {
    if (dirtyAssigneeIds.length === 0 || savingAssignees) return;
    setSavingAssignees(true);
    try {
      await Promise.all(
        dirtyAssigneeIds.map((id) =>
          setProjectAssignee(id, assigneeDraft[id] || undefined),
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

  // Per-project mapping stats — BE 집계 endpoint 1 호출 (2026-06-04). 이전엔 프로젝트마다
  // DDL+rules+bindings 3 API 를 client 에서 호출(N×3 라운드트립)해 진행률 막대가 늦게 떴다.
  // mapped 판정은 BE MappingProgressService 가 isMappingRuleMapped 와 동치로 수행.
  // refetchOnMount:'always' — 매핑 편집 후 이 화면 열 때마다 최신 (idle 폴링 0). MappingPage
  // 의 invalidateQueries(['site-mapping-progress']) 로도 갱신.
  const mappingProgressQuery = useQuery({
    queryKey: ['site-mapping-progress', activeSiteId],
    enabled: !!activeSiteId,
    queryFn: () => mappingImportApi.siteMappingProgress(activeSiteId!),
    staleTime: 10_000,
    refetchOnMount: 'always',
  });
  const mappingStats: Record<string, ProjectMappingStats> = useMemo(() => {
    const m: Record<string, ProjectMappingStats> = {};
    for (const r of mappingProgressQuery.data ?? []) {
      m[r.projectId] = {
        totalTables: r.totalTables,
        totalColumns: r.totalColumns,
        mappedColumns: r.mappedColumns,
        readyTables: r.readyTables,
      };
    }
    return m;
  }, [mappingProgressQuery.data]);


  // 필터 — 그리드 위에 표시. KPI · phase mix 는 전체 기준.
  const [phaseFilter, setPhaseFilter] = useState<string>('');
  const [userFilter, setUserFilter] = useState<string>('');
  // assignee 변경에도 행 순서가 바뀌지 않도록 createdAt asc 로 명시 정렬.
  const sortedProjects = useMemo(
    () => projects.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [projects],
  );
  // username 비교 정규화 — backend 가 null / empty string / 대소문자 다른 표기로 보낼 때
  // dropdown 의 selection 과 매치 못 해 모든 row 가 Unassigned 로 떨어지는 회귀 방지.
  const normAssignee = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();
  const filteredProjects = sortedProjects.filter((p) => {
    if (phaseFilter && p.phase !== phaseFilter) return false;
    const pa = normAssignee(p.assignee);
    if (userFilter === '__unassigned') return pa === '';
    if (userFilter && pa !== normAssignee(userFilter)) return false;
    return true;
  });

  // KPI — TO-BE schema (total) + mapping_rules (mapped) を全 project で集計.
  // mappedTables = 全列 mapped 済 (READY) のテーブル数.
  // "Projects" KPI = mapping 이 끝난(全 TO-BE 테이블이 READY) project 수 / 전체.
  // phase==='done' 기준이면 planning~rehearsal 동안 항상 0/N 이라 무의미 → mapping 완료
  // 기준으로 진행률을 보여준다 (2026-06-10).
  const doneProjects = projects.filter((p) => {
    const ms = mappingStats[p.id];
    return !!ms && ms.totalTables > 0 && ms.readyTables >= ms.totalTables;
  }).length;
  const totalTables = projects.reduce((a, p) => a + (mappingStats[p.id]?.totalTables ?? 0), 0);
  const mappedTables = projects.reduce((a, p) => a + (mappingStats[p.id]?.readyTables ?? 0), 0);
  const totalColumns = projects.reduce((a, p) => a + (mappingStats[p.id]?.totalColumns ?? 0), 0);
  const mappedColumns = projects.reduce((a, p) => a + (mappingStats[p.id]?.mappedColumns ?? 0), 0);
  const overallPct = totalColumns > 0 ? (mappedColumns / totalColumns) * 100 : 0;

  const openProject = (id: string) => {
    setActiveProject(id);
    navigate('/');
  };

  return (
    <div>
      <div style={styles.overviewWrap}>
        {/* Left column — KPI · Overall progress · Filter · Table */}
        <div style={styles.overviewLeft}>
          {/* KPI strip — 3 타일 (Projects done/total · Tables mapped/total · Rows mapped/total) */}
          <div style={styles.kpiRow}>
            <KpiTile label={t('siteOverview.kpi.projects')} value={`${doneProjects} / ${projects.length}`} tone="info" />
            <KpiTile label={t('siteOverview.kpi.tables')}   value={`${mappedTables} / ${totalTables}`} />
            <KpiTile label={t('siteOverview.kpi.rows')}     value={asisRowTotal ? asisRowTotal.totalRows.toLocaleString() : '—'} />
          </div>

          {/* Overall mapping progress — Execution overview 와 같은 크기 */}
          <div style={styles.overallProgressBox}>
            <div style={styles.overallProgressHeader}>
              <span style={styles.overallProgressLabel}>{t('siteOverview.kpi.overall')}</span>
              <span style={styles.overallProgressPct}>{overallPct.toFixed(1)}%</span>
              <div style={{ flex: 1 }} />
              <span style={styles.overallProgressDim}>{t('siteOverview.noRunYet')}</span>
            </div>
            <div style={styles.overallProgressOuter}>
              <div style={{ ...styles.overallProgressInner, width: `${overallPct}%` }} />
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
                <option value="__unassigned">— {t('siteOverview.unassigned')} —</option>
                {users.map((u) => <option key={u.id} value={u.username}>{u.username}</option>)}
              </select>
            </label>
            <div style={{ flex: 1 }} />
            {dirtyAssigneeIds.length > 0 && (
              <>
                <button
                  onClick={handleDiscardAssignees}
                  disabled={savingAssignees}
                  style={{ ...styles.btnGhost, ...(savingAssignees ? styles.btnDisabled : {}) }}
                >
                  {t('siteOverview.btn.discardAssignees')}
                </button>
                <button
                  onClick={handleSaveAssignees}
                  disabled={savingAssignees}
                  style={{
                    padding: '5px 14px',
                    background: 'var(--navy)', color: '#fff',
                    border: '1px solid var(--navy)', borderRadius: 3,
                    fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
                    ...(savingAssignees ? styles.btnDisabled : {}),
                  }}
                >
                  {savingAssignees
                    ? t('siteOverview.btn.savingAssignees')
                    : t('siteOverview.btn.saveAssignees', { n: dirtyAssigneeIds.length })}
                </button>
              </>
            )}
            <span style={styles.filterCount}>
              {t('filter.count', { shown: filteredProjects.length, total: projects.length })}
            </span>
          </div>

          {/* Projects table — 매핑 진행률 + Username dropdown */}
          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <Th>{t('siteOverview.col.project')}</Th>
                  <Th>{t('siteOverview.col.phase')}</Th>
                  <Th align="center">{t('siteOverview.col.version')}</Th>
                  <Th>{t('siteOverview.col.username')}</Th>
                  <Th align="right">{t('siteOverview.col.tables')}</Th>
                  <Th>{t('siteOverview.col.mapping')}</Th>
                </tr>
              </thead>
              <tbody>
                {filteredProjects.length === 0 ? (
                  <tr><td colSpan={6} style={styles.emptyRow}>{t('siteOverview.empty')}</td></tr>
                ) : (
                  filteredProjects.map((p, i) => {
                    const stats = mappingStats[p.id];
                    const rowTotal = stats?.totalColumns ?? 0;
                    const rowMapped = stats?.mappedColumns ?? 0;
                    const rowTableTotal = stats?.totalTables ?? 0;
                    const rowTableReady = stats?.readyTables ?? 0;
                    const pct = rowTotal > 0 ? (rowMapped / rowTotal) * 100 : 0;
                    return (
                      <tr
                        key={p.id}
                        onClick={() => openProject(p.id)}
                        style={{
                          background: i % 2 ? 'var(--zebra)' : 'transparent',
                          borderBottom: '1px solid var(--border)',
                          cursor: 'pointer',
                        }}
                      >
                        <td style={styles.td}>
                          <span style={styles.projectNameCell}>
                            <span style={{ fontWeight: 500 }}>{p.name}</span>
                            {/* pending snapshot 모래시계 — AppShell 사이드바와 동일 기준 (pending 만으로 표시). */}
                            {pendingProjectIds.has(p.id) && (
                              <span
                                style={styles.pendingSnapshotIcon}
                                title={t('siteOverview.pendingSnapshotIcon.title')}
                                aria-label={t('siteOverview.pendingSnapshotIcon.title')}
                              >
                                <HourglassHalfIcon size={12} />
                              </span>
                            )}
                          </span>
                        </td>
                        <td style={styles.td}>
                          <span style={{ ...styles.phaseChip, ...phaseChipColor(p.phase, p.runStatus) }}>{p.phase}</span>
                        </td>
                        <td style={{ ...styles.td, textAlign: 'center', fontFamily: 'var(--mono)', fontSize: 11.5,
                                     color: approvedVersionByProject.has(p.id) ? 'var(--text-2)' : 'var(--text-4)' }}>
                          {approvedVersionByProject.get(p.id) ?? '—'}
                        </td>
                        <td style={styles.td} onClick={(e) => e.stopPropagation()}>
                          {canEditRow(p) ? (
                            (() => {
                              const draftValue = assigneeDraft[p.id];
                              const effective = draftValue !== undefined ? draftValue : (p.assignee ?? '');
                              const isDirty = draftValue !== undefined && (draftValue ?? '') !== (p.assignee ?? '');
                              return (
                                <select
                                  value={effective}
                                  onChange={(e) => setAssigneeDraft((cur) => ({ ...cur, [p.id]: e.target.value }))}
                                  disabled={savingAssignees}
                                  style={{ ...styles.assigneeSelect, ...(isDirty ? styles.assigneeSelectDirty : {}) }}
                                >
                                  <option value="">— {t('siteOverview.unassigned')} —</option>
                                  {users.map((u) => (
                                    <option key={u.id} value={u.username}>{u.username}</option>
                                  ))}
                                </select>
                              );
                            })()
                          ) : (
                            <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: p.assignee ? 'var(--text)' : 'var(--text-4)' }}>
                              {p.assignee ?? t('siteOverview.unassigned')}
                            </span>
                          )}
                        </td>
                        <td style={{ ...styles.td, textAlign: 'right', fontFamily: 'var(--mono)' }}>
                          {rowTableReady} / {rowTableTotal}
                        </td>
                        <td style={styles.td}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 200 }}>
                            <ProgressBar pct={pct} />
                            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-2)', minWidth: 96, textAlign: 'right' }}>
                              {pct.toFixed(0)}% ({rowMapped}/{rowTotal})
                            </span>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right column — Phase mix only */}
        <div style={styles.overviewRight}>
          <Panel title={t('siteOverview.panel.phaseMix')} last>
            <PhaseList projects={projects} />
          </Panel>
        </div>
      </div>
    </div>
  );
}

function KpiTile({ label, value, tone }: { label: string; value: string | number; tone?: 'info' | 'ok' | 'err' | 'warn' }) {
  const color = tone === 'ok'   ? 'var(--green)'
              : tone === 'err'  ? 'var(--red)'
              : tone === 'warn' ? 'var(--amber)'
              : tone === 'info' ? 'var(--navy)'
              : 'var(--text)';
  return (
    <div style={styles.kpiTile}>
      <div style={styles.kpiLabel}>{label}</div>
      <div style={{ ...styles.kpiValue, color }}>{value}</div>
    </div>
  );
}

function Panel({ title, children, last }: { title: string; children: React.ReactNode; last?: boolean }) {
  return (
    <div style={{ ...styles.panel, ...(last ? { borderBottom: 'none' } : {}) }}>
      <div style={styles.panelTitle}>{title}</div>
      {children}
    </div>
  );
}

/**
 * Phase mix — 9 フェーズ全部を CLAUDE.md 既定の順序で表示. 該当 project 0 件でも表示.
 * test / rehearsal は runStatus===running と それ以外 (idle/completed/failed/aborted) で
 * 2 行に分割し, 色付き (= 実行中) と 色なし (= 待機) を区別.
 * cutover は実行中フェーズ専用 (実行前=ready / 実行後=hypercare) なので 1 行のみ.
 */
function PhaseList({ projects }: { projects: Project[] }) {
  // Bar の比率は project 総数で割る. 0 件のときは 0% (空バー) で並ぶ.
  const total = projects.length;
  const splitPhases = new Set(['test', 'rehearsal']);
  const phaseOrder: Project['phase'][] = [
    'planning', 'analysis', 'test', 'sign-off', 'rehearsal', 'ready', 'cutover', 'hypercare', 'done',
  ];
  type Row = { key: string; phase: string; variant: 'colored' | 'idle'; count: number };
  const rows: Row[] = [];
  for (const ph of phaseOrder) {
    if (splitPhases.has(ph)) {
      const running = projects.filter((p) => p.phase === ph && p.runStatus === 'running').length;
      const idle = projects.filter((p) => p.phase === ph && p.runStatus !== 'running').length;
      rows.push({ key: `${ph}-idle`,    phase: ph, variant: 'idle',    count: idle });
      rows.push({ key: `${ph}-running`, phase: ph, variant: 'colored', count: running });
    } else {
      const count = projects.filter((p) => p.phase === ph).length;
      rows.push({ key: ph, phase: ph, variant: 'colored', count });
    }
  }
  return (
    <div>
      {rows.map((r) => {
        // phaseChipColor は test/rehearsal/cutover で runStatus===running 以外を渡すと
        // 色なし variant を返すので, colored 側は明示的に 'running' を渡して強制する.
        const chipStyle = r.variant === 'idle'
          ? { background: 'var(--panel)', color: 'var(--text)', borderColor: 'var(--border-strong)' }
          : phaseChipColor(r.phase, 'running');
        const barColor = r.variant === 'idle'
          ? 'var(--border-strong)'
          : `var(--phase-${phaseSlug(r.phase)})`;
        return (
          <div key={r.key} style={styles.mixRow}>
            <span style={{ ...styles.phaseChip, ...chipStyle }}>{r.phase}</span>
            <div style={styles.mixBarOuter}>
              <div style={{ ...styles.mixBarInner, width: `${total > 0 ? (r.count / total) * 100 : 0}%`, background: barColor }} />
            </div>
            <span style={styles.mixCount}>{r.count}</span>
          </div>
        );
      })}
    </div>
  );
}

interface ProjectMappingStats {
  totalTables: number;
  totalColumns: number;
  mappedColumns: number;
  /** 全列 mapped 済 (READY) のテーブル数. */
  readyTables: number;
}

/** Dashboard countMapped と同じ判定 — backend MappingRuleDto 版. */
function isMappingRuleMapped(r: MappingRuleDto): boolean {
  if (r.strategy === 'skip') return false;
  if (r.strategy === 'null' || r.strategy === 'default') return true;
  const hasSrc = (r.asisColumn ?? []).some((c) => c && c.trim() !== '');
  const hasRule = !!(r.transformRule && r.transformRule.trim());
  return hasSrc || hasRule;
}


function phaseSlug(phase: string): string {
  const slugMap: Record<string, string> = {
    'planning':  'planning',
    'analysis':  'analysis',
    'test':      'test',
    'rehearsal': 'rehearsal',
    'sign-off':  'signoff',
    'ready':     'ready',
    'cutover':   'cutover',
    'hypercare': 'hypercare',
    'done':      'done',
  };
  return slugMap[phase] ?? 'done';
}

function statusDotColor(phase: string): React.CSSProperties {
  return { background: `var(--phase-${phaseSlug(phase)})` };
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
  const slug = phaseSlug(phase);
  return {
    background: `var(--phase-${slug}-50)`,
    color:      `var(--phase-${slug})`,
    borderColor:`var(--phase-${slug})`,
  };
}

const styles: Record<string, React.CSSProperties> = {
  /* Welcome (onboarding) */
  welcomeCard: {
    background: 'var(--panel)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: '40px 32px',
    textAlign: 'center',
    maxWidth: 640,
    margin: '40px auto',
  },
  welcomeIcon: { fontSize: 40, marginBottom: 14 },
  welcomeIconWrap: {
    margin: '0 auto 14px',
    display: 'grid',
    placeItems: 'center',
  },
  welcomeTitle: {
    margin: '0 0 8px',
    fontSize: 19,
    fontWeight: 700,
    color: 'var(--text)',
    letterSpacing: -0.3,
  },
  welcomeDesc: {
    margin: '0 0 24px',
    fontSize: 13,
    color: 'var(--text-2)',
    lineHeight: 1.6,
  },
  steps: {
    display: 'flex',
    justifyContent: 'space-around',
    gap: 8,
    marginBottom: 26,
    padding: '0 8px',
  },
  step: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 6,
    flex: 1,
    minWidth: 0,
  },
  stepNum: {
    width: 28,
    height: 28,
    borderRadius: '50%',
    background: 'var(--panel-2)',
    color: 'var(--text-4)',
    display: 'grid',
    placeItems: 'center',
    fontSize: 12,
    fontWeight: 700,
    border: '1px solid var(--border)',
  },
  stepNumActive: {
    background: 'var(--navy)',
    color: '#fff',
    border: '1px solid var(--navy)',
  },
  stepNumDone: {
    background: 'var(--navy-50)',
    color: 'var(--navy)',
    border: '1px solid var(--navy)',
  },
  stepTitle: { fontSize: 11, color: 'var(--text-3)', whiteSpace: 'nowrap' },

  /* Buttons */
  btnPrimary: {
    padding: '10px 24px',
    background: 'var(--navy)',
    color: '#fff',
    border: '1px solid var(--navy)',
    borderRadius: 4,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
  },

  /* Stat row */
  statRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(6, 1fr)',
    gap: 1,
    background: 'var(--border)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    overflow: 'hidden',
    marginBottom: 14,
  },
  stat: { background: 'var(--panel)', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 4 },
  statLabel: { fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.6, fontWeight: 600 },
  statValue: { fontSize: 24, fontWeight: 700, color: 'var(--text)', letterSpacing: -0.5, lineHeight: 1 },
  statSub: { fontSize: 10.5, color: 'var(--text-3)', fontFamily: 'var(--mono)' },

  /* Toolbar */
  toolbar: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 },
  filterGroup: { display: 'flex', gap: 4 },

  /* Table */
  tableWrap: { background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
  td: { padding: '11px 12px', verticalAlign: 'middle' },
  emptyRow: { padding: '60px 20px', textAlign: 'center', background: 'var(--zebra)' },
  emptyTitle: { fontSize: 13, fontWeight: 600, color: 'var(--text-3)', marginBottom: 6 },
  emptyHint: { fontSize: 11, color: 'var(--text-4)', fontFamily: 'var(--mono)' },

  /* Username dropdown / mapping progress */
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
  btnGhost: {
    padding: '5px 10px', border: '1px solid var(--border-strong)', borderRadius: 3,
    background: 'var(--panel)', color: 'var(--text-2)', fontSize: 11.5, cursor: 'pointer',
  },
  btnDisabled: { opacity: 0.45, cursor: 'not-allowed' },

  /* Site overview */
  overviewWrap: {
    display: 'grid',
    gridTemplateColumns: '1fr 300px',
    gap: 14,
    alignItems: 'stretch',
  },
  overviewLeft: { display: 'flex', flexDirection: 'column', gap: 12 },
  overviewRight: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  overviewHeaderRow: {
    background: 'var(--panel)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '12px 14px',
    display: 'flex',
    alignItems: 'flex-end',
    gap: 8,
  },
  overviewEyebrow: {
    fontSize: 10,
    color: 'var(--text-3)',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    fontFamily: 'var(--mono)',
    marginBottom: 3,
  },
  overviewTitle: { fontSize: 18, fontWeight: 600, letterSpacing: -0.2, color: 'var(--text)' },
  overviewSummary: { fontSize: 11, color: 'var(--text-3)', marginTop: 2, fontFamily: 'var(--mono)' },
  toolbarBtnGhost: {
    padding: '5px 11px',
    background: 'var(--panel)',
    border: '1px solid var(--border-strong)',
    color: 'var(--text-2)',
    borderRadius: 3,
    fontSize: 11.5,
    cursor: 'not-allowed',
    opacity: 0.6,
  },
  toolbarBtnPrimary: {
    padding: '5px 11px',
    background: 'var(--navy)',
    color: '#fff',
    border: '1px solid var(--navy)',
    borderRadius: 3,
    fontSize: 11.5,
    fontWeight: 600,
    cursor: 'not-allowed',
    opacity: 0.6,
  },

  /* KPI tiles row */
  kpiRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: 1,
    background: 'var(--border)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    overflow: 'hidden',
    marginBottom: 10,
  },

  /* Page header — Execution overview 와 동일한 단순 디자인 */
  pageHeader: { marginBottom: 14 },
  pageH1: { margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--text)', letterSpacing: -0.2 },
  pageSubtitle: { margin: '4px 0 0', fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--mono)' },

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
    outline: 'none', fontFamily: 'var(--mono)', minWidth: 110,
  },
  filterCount: { fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--mono)' },

  /* Overall progress box — Execution overview 와 동일 */
  overallProgressBox: {
    padding: '10px 14px', background: 'var(--panel)',
    border: '1px solid var(--border)', borderRadius: 6, marginBottom: 12,
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
  ownerCell: { display: 'inline-flex', alignItems: 'center', gap: 6 },
  ownerAvatar: {
    width: 18,
    height: 18,
    borderRadius: '50%',
    background: 'var(--navy)',
    color: '#fff',
    display: 'grid',
    placeItems: 'center',
    fontSize: 10,
    fontWeight: 700,
    flexShrink: 0,
  },
  ownerName: { fontSize: 11.5, color: 'var(--text)', fontFamily: 'var(--mono)' },
  kpiTile: {
    background: 'var(--panel)',
    padding: '10px 14px 12px',
  },
  kpiLabel: {
    fontSize: 10,
    color: 'var(--text-3)',
    textTransform: 'uppercase',
    letterSpacing: 0.7,
    fontFamily: 'var(--mono)',
    marginBottom: 4,
    fontWeight: 600,
  },
  kpiValue: {
    fontSize: 22,
    fontWeight: 600,
    letterSpacing: -0.4,
  },
  kpiSub: {
    fontSize: 10.5,
    color: 'var(--text-3)',
    marginTop: 2,
    fontFamily: 'var(--mono)',
  },

  /* Progress box */
  progressBox: {
    padding: '10px 14px',
    background: 'var(--panel)',
    border: '1px solid var(--border)',
    borderRadius: 6,
  },
  progressHeader: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 8,
    marginBottom: 6,
  },
  progressLabel: { fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.6, color: 'var(--text-2)' },
  progressMono: { fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-3)' },
  progressMonoDim: { fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-4)' },
  progressBarOuter: {
    height: 8,
    borderRadius: 4,
    background: 'var(--panel-2)',
    border: '1px solid var(--border)',
    overflow: 'hidden',
  },
  progressBarInner: { height: '100%', background: 'var(--navy)' },

  /* Right column panels */
  panel: {
    padding: '10px 14px 12px',
    background: 'var(--panel)',
    border: '1px solid var(--border)',
    borderRadius: 6,
  },
  panelTitle: {
    fontSize: 10,
    color: 'var(--text-3)',
    textTransform: 'uppercase',
    letterSpacing: 0.7,
    fontFamily: 'var(--mono)',
    marginBottom: 8,
    fontWeight: 600,
  },
  feedEmpty: {
    fontSize: 11.5,
    color: 'var(--text-3)',
    fontFamily: 'var(--mono)',
  },

  /* Pending approvals */
  pendingRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 0',
  },
  pendingRowSep: { borderTop: '1px solid var(--border)' },
  pendingName: {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--text)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  pendingMeta: {
    fontSize: 10.5,
    color: 'var(--text-3)',
    fontFamily: 'var(--mono)',
    marginTop: 2,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  pendingActions: { display: 'flex', gap: 4 },
  pendingApproveBtn: {
    width: 24,
    height: 24,
    border: '1px solid var(--green)',
    background: 'var(--panel)',
    color: 'var(--green)',
    borderRadius: 3,
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 700,
    lineHeight: 1,
    padding: 0,
  },
  pendingRejectBtn: {
    width: 24,
    height: 24,
    border: '1px solid var(--red)',
    background: 'var(--panel)',
    color: 'var(--red)',
    borderRadius: 3,
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 700,
    lineHeight: 1,
    padding: 0,
  },
  pendingCoordTag: {
    padding: '2px 7px',
    fontSize: 9.5,
    fontWeight: 700,
    fontFamily: 'var(--mono)',
    background: 'var(--amber-50)',
    color: 'var(--amber)',
    border: '1px solid var(--amber)',
    borderRadius: 3,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    whiteSpace: 'nowrap',
  },
  feedEmptySub: { fontSize: 10.5, color: 'var(--text-4)', marginTop: 2 },

  mixRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 5,
  },
  mixLabel: { fontSize: 11, color: 'var(--text)', fontWeight: 500, fontFamily: 'var(--mono)', width: 72, flexShrink: 0 },
  mixBarOuter: { flex: 1, height: 6, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' },
  mixBarInner: { height: '100%' },
  mixCount: { fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-3)', width: 22, textAlign: 'right' },

  stageRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 5,
  },
  stageLabel: { fontSize: 11, color: 'var(--text-2)', width: 68 },
  stageBarOuter: { flex: 1, height: 5, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' },
  stageBarInner: { height: '100%', background: 'var(--text-4)' },
  stageCount: { fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-4)', width: 28, textAlign: 'right' },

  statusDot: {
    display: 'inline-block',
    width: 7,
    height: 7,
    borderRadius: '50%',
    verticalAlign: 'middle',
  },
  phaseChips: { display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 },
  phaseChip: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 72,
    padding: '2px 0',
    fontSize: 10,
    fontWeight: 600,
    fontFamily: 'var(--mono)',
    border: '1px solid',
    borderRadius: 3,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    textAlign: 'center',
    flexShrink: 0,
  },
  phaseChipCount: { fontWeight: 700, opacity: 0.85 },
  projectNameCell: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
  },
  pendingSnapshotIcon: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--amber)',
    // flex 기하 중심 → 텍스트 caps 옵티컬 중심 보정 (1px 위)
    transform: 'translateY(-1px)',
  },
  miniBtn: {
    padding: '3px 9px',
    fontSize: 11,
    border: '1px solid var(--border-strong)',
    background: 'var(--panel)',
    color: 'var(--text-2)',
    borderRadius: 3,
    cursor: 'pointer',
  },

  /* Status bar */
  statusbar: {
    display: 'flex',
    gap: 12,
    marginTop: 8,
    padding: '0 4px',
    fontSize: 11,
    color: 'var(--text-3)',
    fontFamily: 'var(--mono)',
  },
  dim: { color: 'var(--text-4)' },
};
