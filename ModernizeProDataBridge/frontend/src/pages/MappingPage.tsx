import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useWorkspaceStore, type ProjectPhase } from '../store/workspace';
import { useAsisDdlStore } from '../store/asisDdl';
import { useTobeDdlStore } from '../store/tobeDdl';
import { useT, type TranslationKey } from '../i18n';
import { useMappingEditsStore, type TableBindingEdit } from '../store/mappingEdits';
import { useUiStore } from '../store/ui';
import { useActiveProjectReadOnly } from '../store/readOnly';
import { useSnapshotsStore, usePinnedSnapshotsStore, type FrozenBinding, type FrozenRule } from '../store/snapshots';
import { PinIconSvg } from './VersionsPage';
import type { DdlSchema, DdlTableWithColumns } from '../api/asisDdl';
import { csvPreviewApi, type CsvPreview } from '../api/csvPreview';
import { mappingImportApi, type MappingStatus as MappingStatusDto, type MappingReportResult, type MappingRuleDto, type MappingTableBindingDto, type LinkCandidatesResponse } from '../api/mappingImport';
import { MappingOnboarding } from './DashboardPage';
import { copyText } from '../lib/clipboard';
import { effectiveTobeDb } from '../lib/effectiveTobeDb';
import { Checkbox } from '../components/Checkbox';

/* ============================================================
 * Mapping page — UI scaffold ported from Prototype/src/mapping.jsx.
 * No real data wiring yet; uses inline mock fixtures so the dual-pane
 * layout (inventory · workspace · inspector) is reviewable end-to-end.
 * Color scheme uses the existing CSS variables defined in index.css.
 * ============================================================ */

// ── Mock fixtures ─────────────────────────────────────────────

type Side = 'asis' | 'tobe';

type AsisTable = {
  name: string;
  short: string;
  columnCount: number;
  rows: number;
  unrouted?: boolean;
  /** unrouted 면서 모든 컬럼이 explicit skip 처리됨 → badge 를 'skipped' (회색) 로 표시. */
  allColsSkipped?: boolean;
  /** Whether extracted data (CSV) has been imported into the AS-IS workspace. */
  imported?: boolean;
  /** TO-BE internalNames this AS-IS feeds (mock). */
  routing: string[];
};

type TobeTable = {
  name: string;
  internalName: string;
  short: string;
  columnCount: number;
  rows: number;
  unrouted?: boolean;
  compositionKind: 'single' | 'join' | 'union' | 'none';
  sources: { alias: string; table: string; role: 'primary' | 'join' | 'union'; joinType?: string; joinOn?: string; rows: number }[];
  whereFilter?: string;
  groupByExpr?: string;
  expandExpr?: string;
  /** 부모 project_id — null/undef 면 자체 정의, 값 있으면 자식 link */
  linkedFromProjectId?: string;
  /** 다른 project 의 자식들이 자기를 link 한 부모인지 */
  isParent?: boolean;
};

type MappingRow = {
  src: string;
  tgt: string;
  srcType: string;
  tgtType: string;
  rule: 'auto' | 'rule' | 'unmapped' | 'null' | 'default' | 'added' | 'skip' | 'link';
  status: 'ok' | 'warn' | 'err' | 'skip' | 'queued';
  pk?: boolean;
  sourceAlias?: string;
  tgtNullable?: boolean;
  ddlDefault?: string;
  note?: string;
};

/**
 * Hydrated from /api/v1/projects/{id}/asis-ddl response in MappingPage.useEffect.
 * Mutable module-level so module-scope helpers (resolveSrcType, computeAsisMappings)
 * see the latest values without prop drilling.
 */
let ASIS_TABLES: AsisTable[] = [];

let TOBE_TABLES: TobeTable[] = [];

// AS-IS csv 파일 존재(imported) + data row 수 캐시 — 키 = `${siteId}|${tableName}`.
// hydrationTick 마다 재fetch 되던 회귀 + 동시 중복(stampede) 방지용으로 module-level 에 박제.
// imported 판정은 가벼운 csv-preview(limit 1, 404=missing) 로, rows(무거운 full scan)는
// table 당 1회만 + 직렬 큐로 background fetch (worker thread 포화 회피).
const ASIS_IMPORTED_CACHE = new Map<string, boolean>();
const ASIS_ROWS_CACHE = new Map<string, number>();
const ASIS_EXIST_INFLIGHT = new Set<string>();
const ASIS_ROWS_QUEUE: Array<{ siteId: string; name: string; key: string }> = [];
let asisRowsDraining = false;

/** rows 큐를 한 번에 하나씩 처리 — 동시 다중 full-scan 으로 인한 서버 포화 방지. */
async function drainAsisRowsQueue(onProgress: () => void): Promise<void> {
  if (asisRowsDraining) return;
  asisRowsDraining = true;
  try {
    while (ASIS_ROWS_QUEUE.length > 0) {
      const job = ASIS_ROWS_QUEUE.shift()!;
      if (ASIS_ROWS_CACHE.has(job.key)) continue;
      try {
        const r = await csvPreviewApi.rowCount(job.siteId, job.name);
        ASIS_ROWS_CACHE.set(job.key, r.rowCount);
        onProgress();
      } catch {
        /* 실패 → 미캐시 유지 (rows 0 표시) */
      }
    }
  } finally {
    asisRowsDraining = false;
  }
}

let MAPPING_BY_TOBE: Record<string, MappingRow[]> = {};

type AsisColumn = { name: string; type: string; pk?: boolean; nullPct?: number; distinct?: number };

let ASIS_COLUMNS: Record<string, AsisColumn[]> = {};

/** Site DB type 으로 결정된 DDL dialect — 백엔드 DdlImport.dialect 가 source of truth. */
let ASIS_DIALECT: string = 'oracle';
let TOBE_DIALECT: string = 'oracle';

/** Convert DDL schema response → AsisTable[]. */
function ddlToAsisTables(schema: DdlSchema | undefined | null): AsisTable[] {
  if (!schema) return [];
  return schema.tables.map((t) => {
    const fullName = qualifiedName(t);
    return {
      name: fullName,
      short: t.table.physicalName,
      columnCount: t.columns.length,
      rows: 0,
      routing: [],
      unrouted: true,
      imported: false,
    };
  });
}

/** Convert DDL schema response → TobeTable[]. internalName = DdlTable.id. */
function ddlToTobeTables(schema: DdlSchema | undefined | null): TobeTable[] {
  if (!schema) return [];
  return schema.tables.map((t) => ({
    name: qualifiedName(t),
    internalName: t.table.id,
    short: t.table.physicalName,
    columnCount: t.columns.length,
    rows: 0,
    compositionKind: 'none',
    sources: [],
    unrouted: true,
  }));
}

function ddlToAsisColumns(schema: DdlSchema | undefined | null): Record<string, AsisColumn[]> {
  if (!schema) return {};
  const out: Record<string, AsisColumn[]> = {};
  for (const t of schema.tables) {
    out[qualifiedName(t)] = t.columns.map((c) => ({
      name: c.physicalName,
      type: c.dataTypeRaw || c.dataType || '—',
      pk: (c.pkOrder ?? 0) > 0,
      nullPct: c.nullable ? undefined : 0,
    }));
  }
  return out;
}

/**
 * ASIS_COLUMNS 조회 — schema-lenient. binding 의 source table 은 schema 한정
 * (BANKSYS.CUSTOMERS) 인데 AS-IS DDL 은 schema 빈값(CUSTOMERS)일 수 있어(또는 반대),
 * exact 키 조회가 miss 하면 컬럼 드롭다운/자동매핑이 빈다. TO-BE 매칭(qualifiedName 주석 참조)이
 * 이미 하는 physical 이름 fallback 을 source 쪽에도 적용한다. (대소문자 무시)
 */
/** 테이블 식별자의 physical(bare) 이름 — schema 한정(BANKSYS.X) 든 bare(X) 든 소문자 X 반환. */
function bareTable(name: string | undefined | null): string {
  if (!name) return '';
  const s = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
  return s.toLowerCase();
}

function lookupAsisCols(key: string | undefined | null): AsisColumn[] {
  if (!key) return [];
  const exact = ASIS_COLUMNS[key];
  if (exact) return exact;
  const bare = key.includes('.') ? key.slice(key.lastIndexOf('.') + 1) : key;
  const bl = bare.toLowerCase();
  for (const k of Object.keys(ASIS_COLUMNS)) {
    const kb = k.includes('.') ? k.slice(k.lastIndexOf('.') + 1) : k;
    if (kb.toLowerCase() === bl) return ASIS_COLUMNS[k];
  }
  return [];
}

/**
 * Initial mapping rows for each TO-BE table — all columns start as unmapped
 * (no mapping snapshot in backend yet). User edits accumulate in rowEdits.
 */
function ddlToMappingByTobe(tobe: DdlSchema | undefined | null): Record<string, MappingRow[]> {
  if (!tobe) return {};
  const out: Record<string, MappingRow[]> = {};
  for (const t of tobe.tables) {
    out[t.table.id] = t.columns.map((c) => ({
      src: '—',
      tgt: c.physicalName,
      srcType: '—',
      tgtType: c.dataTypeRaw || c.dataType || '—',
      rule: 'unmapped',
      status: 'queued',
      pk: (c.pkOrder ?? 0) > 0,
      tgtNullable: c.nullable,
      ddlDefault: c.defaultValue ?? undefined,
    }));
  }
  return out;
}

function qualifiedName(t: DdlTableWithColumns): string {
  return t.table.schemaName ? `${t.table.schemaName}.${t.table.physicalName}` : t.table.physicalName;
}

/** quarantine focusRule.tobeTable (= 'schema.physical' 또는 'physical') 을 TO-BE 테이블에 매칭.
   DDL 의 schemaName 과 mapping binding 의 tobeSchema 가 다르거나(대소문자/유무) 한쪽만 스키마를
   가질 수 있어, 정규화 이름뿐 아니라 physical(마지막 '.' 뒷부분) 이름끼리도 비교한다.
   못 맞추면 첫 테이블로 잘못 이동 + 강조 누락 → 반드시 physical fallback 필요. */
function tablePhysical(label: string): string {
  const i = label.lastIndexOf('.');
  return (i >= 0 ? label.slice(i + 1) : label).toLowerCase();
}
function findTobeByLabel(tables: TobeTable[], label: string): TobeTable | undefined {
  const want = label.toLowerCase();
  const wantPhysical = tablePhysical(label);
  return tables.find((tt) =>
    tt.internalName.toLowerCase() === want
    || tt.name.toLowerCase() === want
    || tt.short.toLowerCase() === want
    || tt.short.toLowerCase() === wantPhysical
    || tablePhysical(tt.name) === wantPhysical,
  );
}

/** Site 의 raw DB type 문자열을 dialect 코드로 정규화. 빈 값/모름 → 'oracle' 폴백. */
function normalizeDialect(raw: string | null | undefined): string {
  if (!raw) return 'oracle';
  const s = raw.trim().toLowerCase();
  if (!s) return 'oracle';
  if (s.includes('postgres')) return 'postgresql';
  if (s.includes('sql server') || s === 'mssql' || s.includes('microsoft')) return 'mssql';
  if (s.includes('mysql') || s.includes('mariadb')) return 'mysql';
  if (s.includes('db2')) return 'db2';
  if (s.includes('oracle')) return 'oracle';
  return 'oracle';
}

/** dialect 코드 → UI 표시명. */
function dialectLabel(d: string): string {
  switch (d) {
    case 'oracle':     return 'Oracle';
    case 'postgresql': return 'PostgreSQL';
    case 'mssql':      return 'SQL Server';
    case 'mysql':      return 'MySQL';
    case 'db2':        return 'DB2';
    default:           return d || 'Oracle';
  }
}

/**
 * AS-IS type 문자열을 TO-BE dialect 의 동등 type 으로 변환.
 *   예) VARCHAR2(60) + tobe=postgresql → VARCHAR(60)
 *       NUMBER(11,2) + tobe=postgresql → NUMERIC(11,2)
 *       CLOB         + tobe=postgresql → TEXT
 * 동일/미지원 dialect 에는 입력값 그대로.
 */
function translateTypeToTobe(asisType: string, tobeDialect: string): string {
  if (!asisType || asisType === '—') return asisType;
  const t = asisType.trim();
  const u = t.toUpperCase();
  // Oracle → PostgreSQL
  if (tobeDialect === 'postgresql') {
    if (u.startsWith('VARCHAR2')) return t.replace(/^VARCHAR2/i, 'VARCHAR');
    if (u.startsWith('NVARCHAR2')) return t.replace(/^NVARCHAR2/i, 'VARCHAR');
    if (u.startsWith('NUMBER'))   return t.replace(/^NUMBER/i,   'NUMERIC');
    if (u === 'CLOB' || u === 'NCLOB') return 'TEXT';
    if (u === 'BLOB') return 'BYTEA';
    if (u.startsWith('DATE')) return 'TIMESTAMP';  // Oracle DATE 는 시각 포함
    if (u.startsWith('RAW')) return 'BYTEA';
    if (u.startsWith('LONG RAW')) return 'BYTEA';
  }
  // Oracle → MSSQL / PostgreSQL → MSSQL
  if (tobeDialect === 'mssql') {
    if (u.startsWith('VARCHAR2')) return t.replace(/^VARCHAR2/i, 'VARCHAR');
    if (u.startsWith('NUMBER'))   return t.replace(/^NUMBER/i,   'NUMERIC');
    if (u === 'CLOB' || u === 'TEXT') return 'NVARCHAR(MAX)';
    if (u === 'BOOLEAN') return 'BIT';
  }
  // 미지원 / 동일 dialect → 그대로
  return t;
}

/**
 * 빈 객체 fallback — zustand selector 가 매 호출마다 새 객체 리터럴을 반환하면
 * Object.is 비교가 매번 false 라 무한 재렌더링이 발생한다. 한 번만 만든 같은
 * reference 를 fallback 으로 쓰면 변경 없음을 감지할 수 있다.
 */
const EMPTY_BINDING_EDITS: Record<string, TableBindingEdit> = Object.freeze({}) as Record<string, TableBindingEdit>;

const PHASE_ORDER: ProjectPhase[] = ['planning', 'analysis', 'test', 'sign-off', 'rehearsal', 'ready', 'cutover', 'hypercare', 'done'];
/**
 * mapping 을 편집(rule/binding/skip 저장)하면 phase 가 analysis 보다 진행된 상태일 때
 * analysis 로 되돌린다. 매핑이 바뀌면 이후 단계(test 등)의 검증/스냅샷이 무효가 되므로.
 */
function demoteToAnalysisOnEdit(projectId: string | null) {
  if (!projectId) return;
  const proj = useWorkspaceStore.getState().projects.find((p) => p.id === projectId);
  if (!proj) return;
  if (PHASE_ORDER.indexOf(proj.phase) > PHASE_ORDER.indexOf('analysis')) {
    void useWorkspaceStore.getState().setProjectPhase(projectId, 'analysis');
  }
}

/**
 * binding 편집 시 baseline pin 해제. 편집된 mapping 상태가 frozen snapshot 과 달라졌으니
 * baseline 유지하면 has-changes / 신규 snapshot 생성이 막힘. clearPin 가 backend
 * snapshots.is_baseline=false 도 sync.
 */
function unpinBaselineOnEdit(projectId: string | null) {
  if (!projectId) return;
  const pinnedIds = usePinnedSnapshotsStore.getState().pinnedIds;
  const baseline = useSnapshotsStore.getState().snapshots.find(
    (s) => s.projectId === projectId && pinnedIds.includes(s.id),
  );
  if (baseline) usePinnedSnapshotsStore.getState().clearPin(baseline.id);
}
const EMPTY_SKIP_COLS: Record<string, Record<string, boolean>> = Object.freeze({}) as Record<string, Record<string, boolean>>;
const EMPTY_ROW_EDITS: Record<string, RowEdit> = Object.freeze({}) as Record<string, RowEdit>;


// ── Tiny inline icon set (subset matching prototype Ic.*) ────

const Ic = {
  search: () => svg(<><circle cx="6" cy="6" r="4.2" /><line x1="9.2" y1="9.2" x2="12" y2="12" /></>),
  arrow:  () => svg(<><line x1="2" y1="7" x2="12" y2="7" /><polyline points="9,4 12,7 9,10" /></>),
  plus:   () => svg(<><line x1="7" y1="3" x2="7" y2="11" /><line x1="3" y1="7" x2="11" y2="7" /></>),
  check:  () => svg(<polyline points="3,7 6.5,10.5 12,4" />),
  play:   () => svg(<polygon points="4,3 11,7 4,11" fill="currentColor" stroke="none" />),
  warn:   () => svg(<><path d="M7 1 1 12h12L7 1z" /><line x1="7" y1="5" x2="7" y2="8.5" /><circle cx="7" cy="10.5" r="0.4" fill="currentColor" stroke="none" /></>),
  download: () => svg(<><line x1="7" y1="2" x2="7" y2="10" /><polyline points="3.5,6.5 7,10 10.5,6.5" /><line x1="2" y1="12.5" x2="12" y2="12.5" /></>),
  x:      () => svg(<><line x1="3" y1="3" x2="11" y2="11" /><line x1="11" y1="3" x2="3" y2="11" /></>),
  key:    () => svg(<><circle cx="4.5" cy="7" r="2.5" /><line x1="7" y1="7" x2="12.5" y2="7" /><line x1="11" y1="7" x2="11" y2="9.5" /><line x1="9" y1="7" x2="9" y2="9" /></>),
  refresh: () => svg(<><polyline points="12,2 12,5 9,5" /><path d="M12 5a5 5 0 1 0 1 5" /></>),
};
function svg(children: React.ReactNode) {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block', verticalAlign: 'middle' }}>
      {children}
    </svg>
  );
}

// ── Main page ────────────────────────────────────────────────

type Selection = { side: Side; name: string; internalName?: string } | null;

type TableBindingEdit = { sources: TobeTable['sources']; mode: 'join' | 'union' };

export function MappingPage() {
  const t = useT();
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const projects = useWorkspaceStore((s) => s.projects);
  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId],
  );
  const asisSchema = useAsisDdlStore((s) => activeProjectId ? s.schemasByProject[activeProjectId] : undefined);
  const tobeSchema = useTobeDdlStore((s) => activeProjectId ? s.schemasByProject[activeProjectId] : undefined);
  const asisLoading = useAsisDdlStore((s) => activeProjectId ? !!s.loadingByProject[activeProjectId] : false);
  const tobeLoading = useTobeDdlStore((s) => activeProjectId ? !!s.loadingByProject[activeProjectId] : false);

  useEffect(() => {
    if (!activeProjectId) return;
    useAsisDdlStore.getState().fetch(activeProjectId).catch((e) => console.error('[mapping] asis-ddl fetch failed', e));
    useTobeDdlStore.getState().fetch(activeProjectId).catch((e) => console.error('[mapping] tobe-ddl fetch failed', e));
  }, [activeProjectId]);

  // Hydrate module-level fixtures whenever schemas change, then bump a state value
  // to force a re-render so children see the new ASIS_TABLES / TOBE_TABLES / etc.
  const [hydrationTick, setHydrationTick] = useState(0);
  // 부모 테이블 마킹 — sidebar 의 badge 분기용. mapping 화면 진입 시 link-candidates 한 번 fetch.
  const [parentTableKeys, setParentTableKeys] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!activeProjectId) { setParentTableKeys(new Set()); return; }
    mappingImportApi.getLinkCandidates(activeProjectId)
      .then((r) => {
        const keys = new Set<string>();
        for (const p of r.parentOf) keys.add(p.tobeSchema.toLowerCase() + '|' + p.tobeTable.toLowerCase());
        setParentTableKeys(keys);
      })
      .catch(() => setParentTableKeys(new Set()));
  }, [activeProjectId, hydrationTick]);
  // dialect 는 site 의 DB type 을 1차 source 로 사용 (DDL 재임포트 없이 즉시 반영).
  // site 정보가 없거나 type 이 비어있으면 ddl_imports.dialect 폴백.
  const siteForDialect = useWorkspaceStore((s) => {
    const p = s.projects.find((p) => p.id === s.activeProjectId);
    return p ? s.sites.find((st) => st.id === p.siteId) ?? null : null;
  });
  const projectForDialect = useWorkspaceStore(
    (s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null,
  );
  useEffect(() => {
    // imported/rows 는 module-level 캐시에서 즉시 반영 (가벼움). 실제 fetch 는 아래 별도 effect 가
    // session 당 1회만 수행 — 여기서 매 hydrationTick 마다 무거운 full-scan 을 재발화하지 않는다.
    const siteId = siteForDialect?.id ?? '';
    ASIS_TABLES = ddlToAsisTables(asisSchema).map((t) => {
      const key = siteId + '|' + t.name;
      if (ASIS_IMPORTED_CACHE.get(key) === true) {
        return { ...t, imported: true, rows: ASIS_ROWS_CACHE.get(key) ?? 0 };
      }
      return t;
    });
    TOBE_TABLES = ddlToTobeTables(tobeSchema);
    ASIS_COLUMNS = ddlToAsisColumns(asisSchema);
    MAPPING_BY_TOBE = ddlToMappingByTobe(tobeSchema);
    const asisRaw = siteForDialect?.asisDbType;
    // scope 따라 Site / Project 의 tobeDbByEnv 를 가린다.
    const tobeRaw = siteForDialect
      ? effectiveTobeDb(siteForDialect, projectForDialect)[siteForDialect.environment]?.type
      : undefined;
    ASIS_DIALECT = asisRaw ? normalizeDialect(asisRaw) : (asisSchema?.latestImport?.dialect ?? 'oracle');
    TOBE_DIALECT = tobeRaw ? normalizeDialect(tobeRaw) : (tobeSchema?.latestImport?.dialect ?? 'oracle');
    setHydrationTick((t) => t + 1);
  }, [asisSchema, tobeSchema, siteForDialect, projectForDialect]);

  // AS-IS csv 파일 존재(imported) + row 수 — schema/site 확정 후 table 별 1회만 fetch.
  //  1) 존재 판정: 가벼운 csv-preview(limit 1, 404=missing). 옛 full-scan rowCount 판정 회귀 수정.
  //  2) rows: 파일 존재 확정 + 미캐시일 때만 직렬 큐에 넣어 background full-scan (1개씩, 포화 회피).
  // 캐시/in-flight 가드로 hydrationTick 재발화에도 중복 호출 안 함.
  const asisTableNamesKey = useMemo(
    () => (asisSchema?.tables ?? []).map((t) => qualifiedName(t)).join('\n'),
    [asisSchema],
  );
  useEffect(() => {
    const siteId = siteForDialect?.id;
    const csvPath = siteForDialect?.csvPath;
    if (!siteId || !csvPath || csvPath.trim() === '') return;
    const names = asisTableNamesKey ? asisTableNamesKey.split('\n') : [];
    let queued = false;
    for (const name of names) {
      const key = siteId + '|' + name;
      // 1) 존재 판정 (가벼움)
      if (!ASIS_IMPORTED_CACHE.has(key) && !ASIS_EXIST_INFLIGHT.has(key)) {
        ASIS_EXIST_INFLIGHT.add(key);
        csvPreviewApi.forTable(siteId, name, 1)
          .then(() => { ASIS_IMPORTED_CACHE.set(key, true); setHydrationTick((v) => v + 1); })
          .catch(() => { ASIS_IMPORTED_CACHE.set(key, false); })
          .finally(() => { ASIS_EXIST_INFLIGHT.delete(key); });
      }
      // 2) rows (무거움) — 파일 존재 확정 + 미캐시 + 큐에 없을 때만 1회.
      if (ASIS_IMPORTED_CACHE.get(key) === true
          && !ASIS_ROWS_CACHE.has(key)
          && !ASIS_ROWS_QUEUE.some((j) => j.key === key)) {
        ASIS_ROWS_QUEUE.push({ siteId, name, key });
        queued = true;
      }
    }
    if (queued) void drainAsisRowsQueue(() => setHydrationTick((v) => v + 1));
  }, [siteForDialect?.id, siteForDialect?.csvPath, asisTableNamesKey, hydrationTick]);

  // Pre-flight Fix → 첫 unmapped row 찾아 scrollIntoView + 1초 teal pulse.
  // ExecutionPage 가 navigate('/mapping', { state: { fixTarget: { kind } } }) 로 진입.
  // Dashboard 행 클릭 → state.focusTable.internalName 로 해당 TO-BE 테이블을 active 화.
  const location = useLocation();
  const routerNavigate = useNavigate();
  /** 사용자가 "skip" 으로 끈 navigation 의 location.state 객체 참조. 그 참조와 같은 동안만 강조 숨김.
     navigate 마다 state 는 항상 새 객체 참조라, 새 "매핑 열기" 는 절대 dismiss 와 같지 않아 항상 다시 강조.
     (location.key 는 환경에 따라 안정적이지 않을 수 있어 객체 참조로 식별 — 이게 재진입 보장의 핵심.) */
  const [dismissedState, setDismissedState] = useState<unknown>(null);
  /** focusRule navigation 을 1회만 테이블 점프하도록 식별 — location.state 객체 참조 기준. */
  const jumpedStateRef = useRef<unknown>(null);
  // 同じ focusTable を hydrationTick の度に再適用しないためのガード.
  // window.history.replaceState だけだと React Router の location.state は更新されず, 結果として
  // schema 再 fetch (= hydrationTick++) のたびに同じテーブルへ強制リセットされていた.
  const consumedFocusKeyRef = useRef<string | null>(null);
  // fixTarget 도 同じ理由でガード. hydrationTick 変動のたびに highlight が再適用されると
  // 1 秒後に消える内側 timer よりも先に外側 timer が再スケジュールされ, ハイライトが永続化する.
  const consumedFixTargetKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const state = location.state as {
      fixTarget?: { kind: 'unmapped-tobe' | 'unmapped-asis' | 'unbound-tobe'; table?: string };
      focusTable?: { internalName?: string; tobeSchema?: string; tobeTable?: string };
      focusRule?: { tobeTable: string; tobeColumns: string[] };
    } | null;

    // (LogViewer Quarantine "매핑 열기" → focusRule 점프는 effectiveTobe 가 deps 인 별도 effect 에서
    //  처리 — 아래 quarantineHl 근처. 여기 big effect 는 effectiveTobe 가 deps 가 아니라, 테이블이
    //  늦게 로드되면 점프를 놓치기 때문. quarantineHl(useMemo)과 동일 타이밍으로 맞춘다.)

    // Dashboard row → focus a specific TO-BE table.
    if (state?.focusTable) {
      const ft = state.focusTable;
      const key = ft.internalName ?? `${ft.tobeSchema ?? ''}|${ft.tobeTable ?? ''}`;
      if (consumedFocusKeyRef.current === key) return;  // 既に処理済み
      if (TOBE_TABLES.length === 0) return;             // hydrate 待ち
      const target = ft.internalName
        ? TOBE_TABLES.find((t) => t.internalName === ft.internalName)
        : TOBE_TABLES.find((t) => {
            const i = t.name.indexOf('.');
            const sch = (i > 0 ? t.name.slice(0, i) : '').toLowerCase();
            const tbl = (i > 0 ? t.name.slice(i + 1) : t.name).toLowerCase();
            return sch === (ft.tobeSchema ?? '').toLowerCase()
                && tbl === (ft.tobeTable ?? '').toLowerCase();
          });
      if (target) {
        setSelected({ side: 'tobe', name: target.name, internalName: target.internalName });
        // 自動初期選択を抑止 — 既に欲しい行を選んだ.
        didInitialSelectRef.current = true;
        consumedFocusKeyRef.current = key;
        // React Router の location.state を実際にクリア (history.replaceState だけでは不足).
        routerNavigate(location.pathname, { replace: true });
      }
      return;
    }

    const kind = state?.fixTarget?.kind;
    const targetTable = state?.fixTarget?.table;
    if (!kind) return;
    // location.key 를 키に含めて, 同じ Fix を続けて押した場合は (key 가 다른 location 으로 처리되어)
    // 다시 ハイライト が走るが, 같은 location 内의 hydrationTick 再発火에서는 skip 한다.
    const fixKey = `${location.key}|${kind}|${targetTable ?? ''}`;
    if (consumedFixTargetKeyRef.current === fixKey) return;
    // unmapped-asis: AS-IS 사이드로 자동 전환해야 AsisTableDetail 이 mount 되고
    // [data-fix-row="asis-unmapped"] 마커가 DOM 에 등장. table 명시 시 그 AS-IS table, 없으면 첫번째.
    // matcher: qualified name (`schema.physical`) / physical name (`short`) 둘 다 받기.
    if (kind === 'unmapped-asis' && ASIS_TABLES.length > 0) {
      const target = targetTable
        ? ASIS_TABLES.find((tt) => tt.name === targetTable || tt.short === targetTable)
        : null;
      const pick = target ?? ASIS_TABLES[0];
      setSelected({ side: 'asis', name: pick.name });
    }
    // unbound-tobe / unmapped-tobe: table 指定 → その TO-BE を選択. なければ最初の該当を選択.
    // matcher: qualified name / internalName(uuid) / physical name 全部 OK.
    if (kind === 'unbound-tobe' || kind === 'unmapped-tobe') {
      let chosen = targetTable
        ? effectiveTobe.find((tt) =>
            tt.name === targetTable
            || tt.internalName === targetTable
            || tt.short === targetTable,
          )
        : null;
      if (!chosen && kind === 'unbound-tobe') {
        chosen = effectiveTobe.find((tt) => tt.sources.length === 0);
      }
      if (chosen) {
        setSelected({ side: 'tobe', name: chosen.name, internalName: chosen.internalName });
      }
    }
    const id = window.setTimeout(() => {
      const sel = kind === 'unbound-tobe'
        ? '[data-fix-block="tobe-binding"]'
        : kind === 'unmapped-asis'
          ? '[data-fix-row="asis-unmapped"]'
          : '[data-fix-row="tobe-unmapped"]';
      const els = document.querySelectorAll<HTMLElement>(sel);
      if (els.length === 0) return;
      // DOM 마커가 등장한 시점에만 consumed 로 마킹 — schema 가 아직 hydrate 되지 않은 채
      // 早期 fire 가 일어났을 때는 다시 시도할 여지를 남긴다.
      consumedFixTargetKeyRef.current = fixKey;
      // 첫 element 만 화면 중앙으로 스크롤 — 여러 곳 동시 점프는 혼란.
      els[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
      // 강조는 모든 matching element 에 동시에.
      els.forEach((el) => el.classList.add('mpd-fix-highlight'));
      window.setTimeout(() => {
        els.forEach((el) => el.classList.remove('mpd-fix-highlight'));
      }, 1000);
    }, 200);
    return () => window.clearTimeout(id);
    // effectiveTobe 는 closure 로 캡처 — deps 에 넣으면 binding 편집마다 effect 재실행됨.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state, hydrationTick]);

  const initialSelection: Selection = useMemo(() => {
    if (TOBE_TABLES.length > 0) {
      const first = TOBE_TABLES[0];
      return { side: 'tobe', name: first.name, internalName: first.internalName };
    }
    if (ASIS_TABLES.length > 0) {
      return { side: 'asis', name: ASIS_TABLES[0].name };
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrationTick]);

  const [selected, setSelected] = useState<Selection>(null);

  // 매핑 메뉴 초기 화면은 무조건 TO-BE 첫 테이블. 프로젝트가 바뀌면 다시 reset.
  const didInitialSelectRef = useRef(false);
  // 프로젝트 변경 시 selection lock 해제.
  useEffect(() => {
    didInitialSelectRef.current = false;
    consumedFocusKeyRef.current = null;
    setSelected(null);
  }, [activeProjectId]);
  // hydrate 후 첫 TOBE 자동 선택 (프로젝트당 한 번).
  useEffect(() => {
    if (didInitialSelectRef.current) return;
    if (TOBE_TABLES.length === 0) return;  // TO-BE 아직 안 옴 — 다음 tick 대기
    // Quarantine "매핑 열기"(focusRule) 진입이면 첫 테이블을 자동선택하지 않는다 — 아래 focusRule
    // effect 가 대상 테이블을 고르기 때문. (안 막으면 첫 테이블=customers 가 끼어들어 항상 거기로 이동.)
    if ((location.state as { focusRule?: { tobeTable?: string } } | null)?.focusRule?.tobeTable) return;
    const first = TOBE_TABLES[0];
    setSelected({ side: 'tobe', name: first.name, internalName: first.internalName });
    didInitialSelectRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrationTick, location.state]);
  // hydrate 된 데이터에 selected 가 존재하지 않으면 자동으로 첫 TOBE 로 reset.
  useEffect(() => {
    if (!initialSelection) return;
    if (!selected) return;  // 위 effect 에서 처리
    const existsInTobe = selected.side === 'tobe' && TOBE_TABLES.some((t) => t.internalName === selected.internalName);
    const existsInAsis = selected.side === 'asis' && ASIS_TABLES.some((t) => t.name === selected.name);
    if (!existsInTobe && !existsInAsis) {
      setSelected(initialSelection);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSelection, hydrationTick]);

  const [search, setSearch] = useState('');
  const [showUnrouted, setShowUnrouted] = useState(false);
  // 활성 프로젝트가 read-only (worker 가 미할당/타인 할당 프로젝트를 볼 때 등) 면 모든 편집 commit 을 막는다.
  const readOnly = useActiveProjectReadOnly();

  // 좌측 전체 import 버튼 + 전체(프로젝트 단위) 매핑 정의서 모달용 상태.
  const [projMapStatus, setProjMapStatus] = useState<MappingStatusDto>({ columnFilename: null, codeFilename: null, ruleCount: 0, codeMapCount: 0 });
  const [fullImportOpen, setFullImportOpen] = useState(false);
  const refreshProjMapStatus = useCallback(async () => {
    if (!activeProjectId) return;
    try { setProjMapStatus(await mappingImportApi.status(activeProjectId)); } catch { /* ignore */ }
  }, [activeProjectId]);
  useEffect(() => { void refreshProjMapStatus(); }, [refreshProjMapStatus, hydrationTick]);

  // backend 의 mapping_asis_skip → store. 화면 진입 시 + hydrationTick 변경 시.
  useEffect(() => {
    if (!activeProjectId) return;
    mappingImportApi.listAsisSkips(activeProjectId)
      .then((list) => {
        const byTable: Record<string, Record<string, boolean>> = {};
        for (const s of list) {
          const qualified = (s.asisSchema ? s.asisSchema + '.' : '') + s.asisTable;
          const byCol = byTable[qualified] || {};
          byCol[s.asisColumn] = true;
          byTable[qualified] = byCol;
        }
        useMappingEditsStore.getState().replaceAsisSkips(activeProjectId, byTable);
      })
      .catch((e) => console.warn('[mapping] listAsisSkips failed', e));
  }, [activeProjectId, hydrationTick]);

  const projMappingImported = projMapStatus.columnFilename !== null || projMapStatus.codeFilename !== null;

  const tableBindingEdits = useMappingEditsStore(
    (s) => (activeProjectId ? s.tableBindingEdits[activeProjectId] : undefined) || EMPTY_BINDING_EDITS,
  );
  const asisSkippedCols = useMappingEditsStore(
    (s) => (activeProjectId ? s.asisSkippedCols[activeProjectId] : undefined) || EMPTY_SKIP_COLS,
  );

  const handleBindingChange = useCallback((internalName: string, edit: TableBindingEdit) => {
    if (!activeProjectId || readOnly) return;
    useMappingEditsStore.getState().setBindingEdit(activeProjectId, internalName, edit);

    // DB 영속화 — TO-BE table name 으로 schema/table 분리, AS-IS source 도 동일하게.
    const tobe = TOBE_TABLES.find((t) => t.internalName === internalName);
    if (!tobe) return;
    const splitQualified = (qn: string): { schema: string; table: string } => {
      const i = qn.indexOf('.');
      return i > 0 ? { schema: qn.slice(0, i), table: qn.slice(i + 1) } : { schema: '', table: qn };
    };
    const tobeSplit = splitQualified(tobe.name);
    const sources = edit.sources.map((s, i) => {
      const sp = splitQualified(s.table);
      return {
        ordinal: i,
        asisSchema: sp.schema || null,
        asisTable: sp.table,
        alias: s.alias,
        role: s.role,
        joinType: s.joinType ?? null,
        joinOn: s.joinOn ?? null,
      };
    });
    const compositionKind: 'single' | 'join' | 'union' | 'none' =
      sources.length === 0 ? 'none'
      : sources.length === 1 ? 'single'
      : edit.mode;

    mappingImportApi.upsertBinding(activeProjectId, {
      tobeSchema: tobeSplit.schema,
      tobeTable: tobeSplit.table,
      compositionKind,
      whereFilter: edit.whereFilter ?? null,
      sources,
      sharedFromProjectId: edit.sharedFromProjectId ?? null,
      groupByExpr: edit.groupByExpr ?? null,
      expandExpr: edit.expandExpr ?? null,
    }).catch((e) => console.warn('[mapping] upsertBinding failed', e));
    demoteToAnalysisOnEdit(activeProjectId);
    unpinBaselineOnEdit(activeProjectId);
  }, [activeProjectId, readOnly]);

  const handleToggleAsisSkip = useCallback((tableName: string, colName: string, nextSkip: boolean) => {
    if (!activeProjectId || readOnly) return;
    useMappingEditsStore.getState().setAsisSkip(activeProjectId, tableName, colName, nextSkip);
    // backend persist — has-changes diff + snapshot freeze 에 포함되려면 DB 에 들어가야.
    const i = tableName.indexOf('.');
    const asisSchema = i > 0 ? tableName.slice(0, i) : '';
    const asisTable  = i > 0 ? tableName.slice(i + 1) : tableName;
    mappingImportApi.upsertAsisSkip(activeProjectId, {
      asisSchema: asisSchema || null,
      asisTable,
      asisColumn: colName,
      skipped: nextSkip,
    }).catch((e) => console.warn('[mapping] upsertAsisSkip failed', e));
    demoteToAnalysisOnEdit(activeProjectId);
    unpinBaselineOnEdit(activeProjectId);
  }, [activeProjectId, readOnly]);

  const effectiveTobe = useMemo(() =>
    TOBE_TABLES.map((t) => {
      const i = t.name.indexOf('.');
      const tSchema = (i > 0 ? t.name.slice(0, i) : '').toLowerCase();
      const tTable = (i > 0 ? t.name.slice(i + 1) : t.name).toLowerCase();
      const isParent = parentTableKeys.has(tSchema + '|' + tTable);
      const edit = tableBindingEdits[t.internalName];
      if (!edit) return { ...t, isParent };
      const srcs = edit.sources;
      return {
        ...t,
        sources: srcs,
        // 자식 link 상태면 sources 가 0 이어도 unrouted 로 표시하지 않음 (별도 linked 뱃지로 나옴).
        unrouted: !edit.sharedFromProjectId && srcs.length === 0,
        compositionKind: (srcs.length === 0 ? 'none' : srcs.length === 1 ? 'single' : edit.mode) as TobeTable['compositionKind'],
        whereFilter: edit.whereFilter ?? t.whereFilter,
        groupByExpr: edit.groupByExpr ?? t.groupByExpr,
        expandExpr: edit.expandExpr ?? t.expandExpr,
        linkedFromProjectId: edit.sharedFromProjectId,
        isParent,
      };
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tableBindingEdits, hydrationTick, parentTableKeys]);

  const effectiveAsis = useMemo(() => {
    // schema-lenient — binding source 가 schema 한정(BANKSYS.CUSTOMERS)인데 AS-IS DDL 은
    // bare(CUSTOMERS)면(또는 반대) exact 매칭이 miss 해 AS-IS 테이블이 unrouted 로 잘못 표시.
    // physical(bare) 테이블명으로 매칭(lookupAsisCols/computeUncovered 와 동일 원칙).
    const routedByAsis: Record<string, string[]> = {};
    for (const t of effectiveTobe) {
      for (const s of t.sources) {
        (routedByAsis[bareTable(s.table)] ||= []).push(t.internalName);
      }
    }
    return ASIS_TABLES.map((at) => {
      const r = routedByAsis[bareTable(at.name)] || [];
      const isUnrouted = r.length === 0;
      // unrouted 인데 모든 컬럼이 explicit skip 이면 'skipped' (회색) 표시.
      // asisSkippedCols[table][col] === true 인 컬럼만 skip 으로 카운트.
      const skipMap = asisSkippedCols[at.name] || {};
      const cols = lookupAsisCols(at.name);
      const allColsSkipped = isUnrouted
        && cols.length > 0
        && cols.every((c) => skipMap[c.name] === true);
      return { ...at, routing: r, unrouted: isUnrouted, allColsSkipped };
    });
  }, [effectiveTobe, asisSkippedCols, hydrationTick]);

  /** Quarantine "매핑 열기" 강조 대상 — location.state.focusRule 에서 매 렌더 파생.
     dismiss 는 "그 navigation 의 state 객체" 한정 (location.state === dismissedState). 새 "매핑 열기"
     는 새 state 객체라 절대 dismiss 와 같지 않으므로, 몇 번을 다시 들어와도 항상 강조된다.
     hydrationTick 재렌더는 같은 state 객체 → dismiss 유지 (재발화 없음). */
  const quarantineHl = useMemo<{ internalName: string; cols: string[] } | null>(() => {
    const st = location.state as { focusRule?: { tobeTable: string; tobeColumns: string[] } } | null;
    const fr = st?.focusRule;
    if (!fr?.tobeTable) return null;
    if (st === dismissedState) return null;  // 이 navigation 을 사용자가 skip 함
    if (effectiveTobe.length === 0) return null;
    const target = findTobeByLabel(effectiveTobe, fr.tobeTable);
    return target ? { internalName: target.internalName, cols: fr.tobeColumns ?? [] } : null;
  }, [location.state, dismissedState, effectiveTobe]);
  /** 사용자가 이 navigation 에서 수동으로 테이블을 골랐는지 (= override 해제) 표시하는 location.state 참조. */
  const userNavRef = useRef<unknown>(null);
  /** "skip" — 강조만 끄고 그 테이블 목록은 그대로 둔다. dismiss 하면 quarantineHl 이 null 이 되어
     화면 테이블이 selected 로 돌아가므로, 먼저 현재 강조 테이블을 selected 로 고정한 뒤 dismiss
     (안 그러면 selected 가 비어 GuidePanel "좌측에서 테이블을 선택하세요" 로 빠진다). */
  const clearQuarantineHl = useCallback(() => {
    if (quarantineHl) {
      const tt = effectiveTobe.find((t) => t.internalName === quarantineHl.internalName);
      setSelected({ side: 'tobe', name: tt?.name ?? '', internalName: quarantineHl.internalName });
      userNavRef.current = location.state;  // 이 navigation 에서 사용자 선택으로 간주 → override 해제
    }
    setDismissedState(location.state);
  }, [location.state, quarantineHl, effectiveTobe]);

  /* Quarantine "매핑 열기" → 대상 TO-BE 테이블로 1회 자동 점프.
     deps 에 effectiveTobe 포함 — 테이블 목록이 늦게 로드돼도(quarantineHl useMemo 와 동일 타이밍)
     반드시 그 시점에 다시 실행되어 점프한다. (big effect 는 effectiveTobe 가 deps 가 아니라
     "강조는 맞는 테이블인데 이동만 첫 테이블" 증상이 났음.) jumpedStateRef 로 navigation 당 1회 제한. */
  useEffect(() => {
    const fr = (location.state as { focusRule?: { tobeTable: string; tobeColumns: string[] } } | null)?.focusRule;
    if (!fr?.tobeTable) return;
    if (jumpedStateRef.current === location.state) return;  // 이 navigation 은 이미 점프함
    if (effectiveTobe.length === 0) return;                 // 테이블 로드 대기 — 다음 effectiveTobe 변경 때 재시도
    const target = findTobeByLabel(effectiveTobe, fr.tobeTable);
    if (target) {
      setSelected({ side: 'tobe', name: target.name, internalName: target.internalName });
      didInitialSelectRef.current = true;
    }
    jumpedStateRef.current = location.state;
  }, [location.state, effectiveTobe]);

  /* 화면에 열 테이블 = 파생값. quarantine "매핑 열기" 로 들어왔고 (quarantineHl 존재) 사용자가 이
     navigation 에서 수동으로 다른 테이블을 고르지 않았으면, 강조 대상 테이블을 그대로 연다.
     effect/자동선택 타이밍과 무관하게 quarantineHl(이미 정확히 해석됨)에서 직접 파생하므로
     "항상 customers 로만 열림" 문제가 구조적으로 사라진다. */
  const handleSelect = useCallback((s: Selection) => {
    userNavRef.current = location.state;  // 사용자가 수동 선택 → 이 navigation 동안 override 해제
    setSelected(s);
  }, [location.state]);
  const effectiveSelected = useMemo<Selection>(() => {
    if (quarantineHl && userNavRef.current !== location.state) {
      const tt = effectiveTobe.find((t) => t.internalName === quarantineHl.internalName);
      return { side: 'tobe', name: tt?.name ?? '', internalName: quarantineHl.internalName };
    }
    return selected;
  }, [quarantineHl, selected, location.state, effectiveTobe]);

  if (!activeProjectId) {
    return (
      <div style={styles.fullBleed}>
        <div style={styles.centerEmpty}>
          <div style={{ maxWidth: 460, color: 'var(--text-3)', fontSize: 13, textAlign: 'center' }}>
            활성 프로젝트가 없습니다. 좌측 메뉴에서 사이트·프로젝트를 먼저 선택하세요.
          </div>
        </div>
      </div>
    );
  }

  if ((asisLoading || tobeLoading) && ASIS_TABLES.length === 0 && TOBE_TABLES.length === 0) {
    return (
      <div style={styles.fullBleed}>
        <div style={styles.centerEmpty}>
          <div style={{ color: 'var(--text-3)', fontSize: 13 }}>{t('mapping.loading.ddl')}</div>
        </div>
      </div>
    );
  }

  if (activeProject && (activeProject.tableCount === 0 || activeProject.tobeTableCount === 0)) {
    return <MappingOnboarding project={activeProject} />;
  }

  return (
    <div style={styles.fullBleed}>
      <DualInventory
        asis={effectiveAsis}
        tobe={effectiveTobe}
        selected={effectiveSelected}
        onSelect={handleSelect}
        search={search}
        setSearch={setSearch}
        showUnrouted={showUnrouted}
        setShowUnrouted={setShowUnrouted}
        mappingImported={projMappingImported}
        onOpenFullImport={readOnly ? undefined : () => setFullImportOpen(true)}
      />
      <Workspace
        selected={effectiveSelected}
        onSelect={handleSelect}
        tableBindingEdits={tableBindingEdits}
        onBindingChange={handleBindingChange}
        effectiveTobe={effectiveTobe}
        asisSkippedCols={asisSkippedCols}
        onToggleAsisSkip={handleToggleAsisSkip}
        hydrationTick={hydrationTick}
        quarantineHl={quarantineHl}
        onClearQuarantineHl={clearQuarantineHl}
      />
      {fullImportOpen && (
        <MappingDefinitionImportModal
          projectId={activeProjectId ?? ''}
          activeFiles={{ column: projMapStatus.columnFilename, code: projMapStatus.codeFilename }}
          onClose={() => setFullImportOpen(false)}
          onChanged={async (tf) => {
            await refreshProjMapStatus();
            setHydrationTick((n) => n + 1);
            // project-wide import → tf=null → 전체 DDL 검증.
            return await findUncoveredDdlColumns(activeProjectId ?? '', tf);
          }}
          tableFilter={null}
        />
      )}
    </div>
  );
}

// ── Left: dual inventory ─────────────────────────────────────

function DualInventory({
  asis, tobe, selected, onSelect,
  search, setSearch, showUnrouted, setShowUnrouted,
  mappingImported, onOpenFullImport,
}: {
  asis: AsisTable[]; tobe: TobeTable[];
  selected: Selection;
  onSelect: (s: Selection) => void;
  search: string; setSearch: (v: string) => void;
  showUnrouted: boolean; setShowUnrouted: (v: boolean) => void;
  mappingImported: boolean;
  onOpenFullImport?: () => void;
}) {
  const [activeTab, setActiveTab] = useState<Side>(selected?.side ?? 'tobe');
  useEffect(() => {
    if (selected?.side) setActiveTab(selected.side);
  }, [selected?.side]);
  const matchQ = (name: string) => !search || name.toLowerCase().includes(search.toLowerCase());
  const visAsis = asis.filter((t) => matchQ(t.name) && (!showUnrouted || !!t.unrouted));
  const visTobe = tobe.filter((t) => matchQ(t.name) && (!showUnrouted || !!t.unrouted));

  const tabs: { side: Side; label: string; vis: (AsisTable | TobeTable)[]; all: (AsisTable | TobeTable)[] }[] = [
    { side: 'tobe', label: 'TO-BE', vis: visTobe, all: tobe },
    { side: 'asis', label: 'AS-IS', vis: visAsis, all: asis },
  ];

  return (
    <aside style={styles.inventory}>
      <div style={styles.invTabs}>
        {tabs.map(({ side, label, all }) => {
          const routed = all.filter((t) => !t.unrouted).length;
          const isActive = activeTab === side;
          const accent = side === 'asis' ? 'var(--amber)' : 'var(--navy)';
          return (
            <button
              key={side}
              onClick={() => {
                setActiveTab(side);
                if (selected?.side === side) return;
                if (side === 'tobe') {
                  const first = (visTobe[0] || tobe[0]) as TobeTable | undefined;
                  if (first) onSelect({ side: 'tobe', name: first.name, internalName: first.internalName });
                } else {
                  const first = (visAsis[0] || asis[0]) as AsisTable | undefined;
                  if (first) onSelect({ side: 'asis', name: first.name });
                }
              }}
              style={{
                ...styles.invTab,
                color: isActive ? accent : 'var(--text-3)',
                fontWeight: isActive ? 700 : 500,
                boxShadow: isActive ? `inset 0 -2px 0 ${accent}` : 'none',
              }}
            >
              {label}
              <span style={{
                ...styles.invTabCount,
                background: isActive ? (side === 'asis' ? 'var(--amber-50)' : 'var(--navy-50)') : 'var(--panel-2)',
                color: isActive ? accent : 'var(--text-4)',
                borderColor: isActive ? accent : 'var(--border)',
              }}>{routed}/{all.length}</span>
            </button>
          );
        })}
      </div>

      <div style={styles.inventoryHeader}>
        <div style={styles.searchBox}>
          <Ic.search />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter"
            style={styles.searchInput}
          />
        </div>
        <label style={styles.unroutedToggle} onClick={() => setShowUnrouted(!showUnrouted)}>
          <Checkbox checked={showUnrouted} onChange={setShowUnrouted} />
          unrouted only
        </label>
      </div>

      <div style={styles.inventoryScroll}>
        {tabs.map(({ side, label, vis, all }) =>
          activeTab === side ? (
            <InventoryTree
              key={side}
              label={label}
              side={side}
              tables={vis}
              allTables={all}
              selected={selected}
              onSelect={onSelect}
              alwaysOpen
              mappingImported={mappingImported}
              onOpenFullImport={onOpenFullImport}
            />
          ) : null
        )}
      </div>
    </aside>
  );
}

function InventoryTree({
  label, side, tables, allTables, selected, onSelect, alwaysOpen,
  mappingImported, onOpenFullImport,
}: {
  label: string; side: Side;
  tables: (AsisTable | TobeTable)[];
  allTables: (AsisTable | TobeTable)[];
  selected: Selection;
  onSelect: (s: Selection) => void;
  alwaysOpen?: boolean;
  mappingImported?: boolean;
  onOpenFullImport?: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(true);
  const isOpen = alwaysOpen ?? open;
  const accent = side === 'asis' ? 'var(--amber)' : 'var(--navy)';
  const accentBg = side === 'asis' ? 'var(--amber-50)' : 'var(--navy-50)';
  const routedCount = useMemo(() => allTables.filter((t) => !t.unrouted).length, [allTables]);

  return (
    <div>
      {!alwaysOpen && (
        <div onClick={() => setOpen((o) => !o)} style={styles.treeHeader}>
          <span style={{ width: 8, color: 'var(--text-4)' }}>{isOpen ? '▾' : '▸'}</span>
          <span style={{ ...styles.sideBadge, color: accent, background: accentBg, borderColor: accent }}>{label}</span>
          <span style={{ flex: 1 }} />
          <span style={styles.treeCount}>{routedCount}/{allTables.length}</span>
        </div>
      )}

      {isOpen && (
        <>
          {onOpenFullImport && (
            <button
              onClick={onOpenFullImport}
              title={t('mapping.tooltip.importAll')}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                margin: '4px 10px 8px', padding: '6px 10px',
                width: 'calc(100% - 20px)',
                background: 'var(--panel)',
                border: '1px solid var(--border-strong)',
                borderRadius: 4,
                color: mappingImported ? 'var(--text-3)' : 'var(--text-2)',
                fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
              }}
            >
              {mappingImported
                ? <><Ic.check /> Mapping Imported</>
                : <><i className="fa-solid fa-download" style={{ fontSize: 11 }} /> Import Mapping</>}
            </button>
          )}
          {tables.length === 0 && <div style={styles.treeEmpty}>no tables match</div>}
          {tables.map((t) => (
            <InventoryItem
              key={t.name}
              side={side}
              table={t}
              isSelected={selected?.side === side && selected?.name === t.name}
              onClick={() =>
                onSelect({
                  side,
                  name: t.name,
                  internalName: side === 'tobe' ? (t as TobeTable).internalName : undefined,
                })
              }
            />
          ))}
        </>
      )}
    </div>
  );
}

function InventoryItem({
  side, table, isSelected, onClick,
}: {
  side: Side;
  table: AsisTable | TobeTable;
  isSelected: boolean;
  onClick: () => void;
}) {
  const unrouted = !!table.unrouted;
  const accent = side === 'asis' ? 'var(--amber)' : 'var(--navy)';
  const selBg  = side === 'asis' ? 'var(--amber-50)' : 'var(--navy-50)';

  let badgeText = '';
  let badgeIcon: string | null = null;
  let badgeTone: 'ok' | 'warn' | 'info' | 'muted' | null = null;
  let showParentIcon = false;  // 부모 테이블 — chip 밖 왼쪽에 별도 표시
  if (side === 'tobe') {
    const tt = table as TobeTable;
    if (tt.linkedFromProjectId)                { badgeText = 'linked'; badgeIcon = 'fa-link'; badgeTone = 'info'; }
    else if (unrouted)                         { badgeText = 'no source'; badgeTone = 'warn'; }
    else if (tt.compositionKind === 'join')    { badgeText = `⋈ ${tt.sources.length}`; badgeTone = 'info'; }
    else if (tt.compositionKind === 'union')   { badgeText = `∪ ${tt.sources.length}`; badgeTone = 'info'; }
    else                                       { badgeText = '← 1'; badgeTone = 'ok'; }
    if (tt.isParent && !tt.linkedFromProjectId) showParentIcon = true;
  } else {
    const at = table as AsisTable;
    if (at.allColsSkipped) { badgeText = 'skipped'; badgeTone = 'muted'; }
    else if (unrouted) { badgeText = 'unrouted'; badgeTone = 'warn'; }
    else          { badgeText = `→ ${at.routing.length}`; badgeTone = 'ok'; }
  }
  const toneColor =
    badgeTone === 'warn'  ? 'var(--amber)'
    : badgeTone === 'info'  ? 'var(--navy)'
    : badgeTone === 'muted' ? 'var(--text-3)'
    : 'var(--green)';
  const toneBg =
    badgeTone === 'warn'  ? 'var(--amber-50)'
    : badgeTone === 'info'  ? 'var(--navy-50)'
    : badgeTone === 'muted' ? 'var(--panel-2)'
    : 'var(--green-50)';

  return (
    <div
      onClick={onClick}
      style={{
        ...styles.invItem,
        borderLeft: isSelected ? `2px solid ${accent}` : '2px solid transparent',
        background: isSelected ? selBg : 'transparent',
      }}
      onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = 'var(--panel-2)'; }}
      onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
    >
      <div style={{
        ...styles.invItemRow,
        color: isSelected ? accent : (unrouted ? 'var(--text-3)' : 'var(--text)'),
        fontWeight: isSelected ? 600 : 500,
      }}>
        <span style={styles.invItemName}>{(table as TobeTable).short || table.name}</span>
        {showParentIcon && <i className="fa-solid fa-link" style={{ fontSize: 10, color: 'var(--navy)' }} />}
        <span style={{ ...styles.invItemBadge, color: toneColor, background: toneBg, borderColor: toneColor, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          {badgeIcon && <i className={`fa-solid ${badgeIcon}`} style={{ fontSize: 9 }} />}
          {badgeText}
        </span>
      </div>
      <div style={styles.invItemSub}>
        {side === 'tobe'
          ? `${table.columnCount} cols`
          : `${table.columnCount} cols · ${formatRowCount(table.rows)} rows`}
      </div>
    </div>
  );
}

/** 천 단위 K, 백만 단위 M 압축. Trial preview 의 row 수 표시용. */
function formatRowCount(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toLocaleString();
}

// ── Right: workspace ─────────────────────────────────────────

/** 강조 대상이 아닐 때 TobeMappingDetail 에 넘기는 고정 빈 배열 — 매 렌더 새 [] 생성으로 인한
   useMemo 무효화/scroll effect 재발화 방지. */
const EMPTY_HL_COLS: string[] = [];

function Workspace({ selected, onSelect, tableBindingEdits, onBindingChange, effectiveTobe, asisSkippedCols, onToggleAsisSkip, hydrationTick, quarantineHl, onClearQuarantineHl }: {
  selected: Selection;
  onSelect: (s: Selection) => void;
  tableBindingEdits: Record<string, TableBindingEdit>;
  onBindingChange: (internalName: string, edit: TableBindingEdit) => void;
  effectiveTobe: TobeTable[];
  asisSkippedCols: Record<string, Record<string, boolean>>;
  onToggleAsisSkip: (tableName: string, colName: string, nextSkip: boolean) => void;
  hydrationTick: number;
  quarantineHl: { internalName: string; cols: string[] } | null;
  onClearQuarantineHl: () => void;
}) {
  if (!selected) return <GuidePanel />;
  if (selected.side === 'tobe') {
    const table = TOBE_TABLES.find((t) => t.internalName === selected.internalName);
    if (!table) return <GuidePanel />;
    const bindingEdit = tableBindingEdits[table.internalName];
    const rows = MAPPING_BY_TOBE[table.internalName] || [];
    // quarantine 강조가 현재 보고 있는 테이블 대상인지 + 그 위반 컬럼들. active 면 cols 가 비어도
    // 첫 row 라도 강조한다 (아래 TobeMappingDetail). 아니면 빈 배열(고정 ref).
    const highlightActive = !!quarantineHl && quarantineHl.internalName === table.internalName;
    const highlightCols = highlightActive ? quarantineHl!.cols : EMPTY_HL_COLS;
    return (
      <TobeMappingDetail
        key={table.internalName}
        table={table}
        rows={rows}
        bindingEdit={bindingEdit}
        onBindingChange={(edit) => onBindingChange(table.internalName, edit)}
        hydrationTick={hydrationTick}
        highlightActive={highlightActive}
        highlightCols={highlightCols}
        onSkipHighlight={onClearQuarantineHl}
      />
    );
  }
  const asis = ASIS_TABLES.find((t) => t.name === selected.name);
  if (!asis) return <GuidePanel />;
  return (
    <AsisTableDetail
      key={asis.name}
      table={asis}
      effectiveTobe={effectiveTobe}
      skippedCols={asisSkippedCols[asis.name] || {}}
      onToggleSkip={(colName, nextSkip) => onToggleAsisSkip(asis.name, colName, nextSkip)}
      onJumpTobe={(internalName, name) => onSelect({ side: 'tobe', internalName, name })}
    />
  );
}

/**
 * 검증: DDL 의 (TO-BE table.column) 중 매핑정의서 (mapping_rules) 에 없는 것 목록.
 * MappingPage 의 project-wide import 와 TobeMappingDetail 의 table-remap 양쪽에서 호출하므로
 * 컴포넌트 closure 가 아닌 모듈 함수로 둔다. TOBE_TABLES / MAPPING_BY_TOBE 는 모듈 mutable
 * 라 그대로 접근 가능.
 * tableFilter (스키마 제외 테이블명) 있으면 그 테이블만, 없으면 전체 DDL.
 */
async function findUncoveredDdlColumns(projectId: string, tableFilter: string | null = null): Promise<string[]> {
  if (TOBE_TABLES.length === 0) return [];
  try {
    const [rules, bindings] = await Promise.all([
      mappingImportApi.listRules(projectId),
      mappingImportApi.listBindings(projectId).catch(() => []),
    ]);
    // schema-lenient — rule.tobeSchema 가 DDL schema 와 유무/대소문자가 달라도(예: 정의서는
    // bare `transaction_reissued`, DDL 은 `bigassignseq.transaction_reissued`) 매칭되도록
    // exact (schema|table) 와 bare (table) 두 키를 모두 만든다. 컬럼명도 대소문자 무시.
    const ruleCols = new Map<string, Set<string>>();        // `${schema}|${table}` (lowercase) → Set<column lower>
    const ruleColsByTable = new Map<string, Set<string>>(); // bare `${table}` (lowercase) → Set<column lower>
    const addCol = (m: Map<string, Set<string>>, key: string, col: string) => {
      if (!m.has(key)) m.set(key, new Set());
      m.get(key)!.add(col);
    };
    for (const r of rules) {
      const tbl = (r.tobeTable || '').toLowerCase();
      addCol(ruleCols, (r.tobeSchema || '').toLowerCase() + '|' + tbl, r.tobeColumn.toLowerCase());
      addCol(ruleColsByTable, tbl, r.tobeColumn.toLowerCase());
    }
    // 자식 link 테이블은 master 에서 정의되므로 임포트 검증에서 제외 (bare table 기준).
    const linkedTables = new Set<string>();
    for (const b of bindings) {
      if (b.sharedFromProjectId) linkedTables.add((b.tobeTable || '').toLowerCase());
    }
    const targets = tableFilter
      ? TOBE_TABLES.filter((t) => (t.name.split('.').pop() || t.name) === tableFilter)
      : TOBE_TABLES;
    const uncovered: string[] = [];
    for (const tobe of targets) {
      const i = tobe.name.indexOf('.');
      const schema = (i > 0 ? tobe.name.slice(0, i) : '').toLowerCase();
      const table = (i > 0 ? tobe.name.slice(i + 1) : tobe.name).toLowerCase();
      if (linkedTables.has(table)) continue;  // 자식 link 테이블 — skip
      // exact (schema|table) + bare (table) 합집합 — schema 유무가 행마다 달라도 누락 없이 매칭.
      const haveCols = new Set<string>([
        ...(ruleCols.get(schema + '|' + table) ?? []),
        ...(ruleColsByTable.get(table) ?? []),
      ]);
      const ddlCols = MAPPING_BY_TOBE[tobe.internalName] || [];
      for (const c of ddlCols) {
        if (!haveCols.has(c.tgt.toLowerCase())) uncovered.push(`${tobe.name}.${c.tgt}`);
      }
    }
    return uncovered;
  } catch (e) {
    console.warn('[mapping] failed to compute uncovered DDL columns', e);
    return [];
  }
}

// ── TO-BE mapping detail ─────────────────────────────────────

function TobeMappingDetail({ table, rows, bindingEdit, onBindingChange, hydrationTick, highlightActive = false, highlightCols = EMPTY_HL_COLS, onSkipHighlight }: {
  table: TobeTable;
  rows: MappingRow[];
  bindingEdit?: TableBindingEdit;
  onBindingChange: (edit: TableBindingEdit) => void;
  hydrationTick: number;
  /** Quarantine "매핑 열기" 강조가 이 테이블 대상인지. true 면 cols 가 비어도 첫 row 라도 강조. */
  highlightActive?: boolean;
  /** 강조 위반 컬럼명들 (있으면 매칭 row 강조, 없으면 첫 row fallback). */
  highlightCols?: string[];
  /** 강조 종료 콜백 — 에러 row 의 "skip" 버튼 / 강조 row 클릭 시 호출. */
  onSkipHighlight?: () => void;
}) {
  const navigate = useNavigate();
  const t = useT();
  /** 강조 대상 컬럼 set (lowercase). tgt(=TO-BE) 또는 src(=AS-IS) 컬럼명이 여기 들면 그 row 가 강조. */
  const hlSet = useMemo(
    () => new Set(highlightCols.map((c) => c.toLowerCase())),
    [highlightCols],
  );
  /** 강조 첫 row 로 스크롤 — 강조가 켜질 때 한 번. */
  const firstHlRowRef = useRef<HTMLTableRowElement | null>(null);
  useEffect(() => {
    if (highlightActive) {
      firstHlRowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [highlightActive, hlSet]);
  // Banner 의 프로젝트명을 클릭 가능한 텍스트 버튼으로 — 다른 project 의 같은 테이블 매핑 화면으로 이동.
  const projectLinkStyle: React.CSSProperties = {
    background: 'transparent',
    border: 'none',
    padding: 0,
    cursor: 'pointer',
    fontFamily: 'var(--mono)',
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--navy)',
  };
  // 자식 link 면 binding 패널 closed. 자체 정의 + sources 비어 있으면 열림 (사용자 알림).
  const [bindingOpen, setBindingOpen] = useState(
    !bindingEdit?.sharedFromProjectId
    && (bindingEdit?.sources ?? table.sources).length === 0
  );
  const [bindingPulse, setBindingPulse] = useState(false);
  // bindingEdit.sharedFromProjectId 가 link/unlink 로 변하면 bindingOpen 도 sync.
  useEffect(() => {
    if (bindingEdit?.sharedFromProjectId) setBindingOpen(false);
  }, [bindingEdit?.sharedFromProjectId]);
  const readOnly = useActiveProjectReadOnly();
  const triggerBindingHighlight = () => {
    setBindingOpen(true);
    setBindingPulse(true);
    window.setTimeout(() => setBindingPulse(false), 1500);
  };
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [importMappingOpen, setImportMappingOpen] = useState(false);
  const [importYamlOpen, setImportYamlOpen] = useState(false);
  const [yamlImported, setYamlImported] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  // 슬롯별 현재 활성 파일명 — rules/code_maps 가 실제 비어있으면 null (삭제 후 반영)
  const [mappingStatus, setMappingStatus] = useState<MappingStatusDto>({
    columnFilename: null, codeFilename: null, ruleCount: 0, codeMapCount: 0,
  });
  const mappingImported = mappingStatus.columnFilename !== null || mappingStatus.codeFilename !== null;
  const [q, setQ] = useState('');
  type RuleFilter = 'all' | 'unmapped' | 'auto' | 'rule' | 'null' | 'default';
  const [coverageFilter, setCoverageFilter] = useState<RuleFilter>('all');
  const [activeIdx, setActiveIdx] = useState(0);
  const activeProjectIdForRow = useWorkspaceStore((s) => s.activeProjectId);
  const allProjects = useWorkspaceStore((s) => s.projects);

  // Master-child link 상태. bindingEdit.sharedFromProjectId 가 있으면 자식 — row editor 와
  // binding 패널 모두 lock. master project 이름 lookup 은 workspace store 에서.
  const isLinkedChild = !!bindingEdit?.sharedFromProjectId;
  const masterProject = useMemo(
    () => isLinkedChild ? allProjects.find((p) => p.id === bindingEdit?.sharedFromProjectId) : null,
    [isLinkedChild, allProjects, bindingEdit?.sharedFromProjectId],
  );
  const [linkModalOpen, setLinkModalOpen] = useState(false);
  const [linkCandidates, setLinkCandidates] = useState<LinkCandidatesResponse | null>(null);
  const [linkSelection, setLinkSelection] = useState<string>('');  // "projectId|schema|table" 또는 ""
  const [linkSaving, setLinkSaving] = useState(false);

  // 자기 테이블이 다른 project 의 자식들의 부모인지 확인 — banner 분기용. mapping 화면 진입 시
  // link-candidates 한 번 fetch 해서 parentOf 정보 보관.
  useEffect(() => {
    if (!activeProjectIdForRow) { setLinkCandidates(null); return; }
    mappingImportApi.getLinkCandidates(activeProjectIdForRow)
      .then(setLinkCandidates)
      .catch(() => setLinkCandidates(null));
  }, [activeProjectIdForRow, hydrationTick]);
  const tobeSplitForBanner = useMemo(() => {
    const i = table.name.indexOf('.');
    return {
      schema: i > 0 ? table.name.slice(0, i) : '',
      table: i > 0 ? table.name.slice(i + 1) : table.name,
    };
  }, [table.name]);

  const parentInfo = useMemo(
    () => linkCandidates?.parentOf.find(
      (p) => p.tobeSchema.toLowerCase() === tobeSplitForBanner.schema.toLowerCase()
          && p.tobeTable.toLowerCase() === tobeSplitForBanner.table.toLowerCase(),
    ),
    [linkCandidates, tobeSplitForBanner],
  );
  const isParentTable = !isLinkedChild && !!parentInfo;
  useEffect(() => {
    if (!linkModalOpen || !activeProjectIdForRow) return;
    mappingImportApi.getLinkCandidates(activeProjectIdForRow)
      .then((r) => setLinkCandidates(r))
      .catch((e) => console.warn('[mapping] getLinkCandidates failed', e));
    setLinkSelection(bindingEdit?.sharedFromProjectId
      ? `${bindingEdit.sharedFromProjectId}||${table.short}`
      : '');
  }, [linkModalOpen, activeProjectIdForRow, bindingEdit?.sharedFromProjectId, table.short]);

  const applyLink = async (newSharedFromProjectId: string | null) => {
    if (!activeProjectIdForRow) return;
    setLinkSaving(true);
    try {
      const tobeQualified = table.name;
      const i = tobeQualified.indexOf('.');
      const tobeSchema = i > 0 ? tobeQualified.slice(0, i) : '';
      const tobeTable = i > 0 ? tobeQualified.slice(i + 1) : tobeQualified;
      await mappingImportApi.upsertBinding(activeProjectIdForRow, {
        tobeSchema,
        tobeTable,
        compositionKind: newSharedFromProjectId ? 'none' : (bindingMode === 'union' ? 'union' : (bindingSources.length === 1 ? 'single' : 'join')),
        whereFilter: newSharedFromProjectId ? null : (bindingWhere || null),
        sources: newSharedFromProjectId ? [] : bindingSources.map((s, idx) => {
          const si = s.table.indexOf('.');
          return {
            ordinal: idx,
            asisSchema: si > 0 ? s.table.slice(0, si) : null,
            asisTable: si > 0 ? s.table.slice(si + 1) : s.table,
            alias: s.alias,
            role: s.role,
            joinType: s.joinType ?? null,
            joinOn: s.joinOn ?? null,
          };
        }),
        sharedFromProjectId: newSharedFromProjectId,
        groupByExpr: newSharedFromProjectId ? null : (bindingGroupBy || null),
        expandExpr: newSharedFromProjectId ? null : (bindingExpand || null),
      });
      // store 의 binding edit 도 갱신
      onBindingChange({
        sources: newSharedFromProjectId ? [] : bindingSources,
        mode: bindingMode,
        whereFilter: bindingWhere,
        groupByExpr: newSharedFromProjectId ? undefined : bindingGroupBy,
        expandExpr: newSharedFromProjectId ? undefined : bindingExpand,
        sharedFromProjectId: newSharedFromProjectId ?? undefined,
      });
      demoteToAnalysisOnEdit(activeProjectIdForRow);
      unpinBaselineOnEdit(activeProjectIdForRow);
      setLinkModalOpen(false);
    } catch (e) {
      console.warn('[mapping] applyLink failed', e);
    } finally {
      setLinkSaving(false);
    }
  };

  // 프로젝트의 고정핀(baseline) snapshot — context bar 의 table chip 옆에 version 표시.
  // 진입 시 1 회 fetch (이미 다른 화면에서 불러와 있으면 store 가 채워둠).
  // baselineSnapshot 검색은 usePinnedSnapshotsStore.pinnedIds 기준 — clearPin 호출 시
  // 즉시 store 가 갱신돼 chip 도 자동으로 사라진다 (snapshots[].baseline 은 다음 fetch 까지 stale).
  const snapshots = useSnapshotsStore((s) => s.snapshots);
  const fetchSnapshotsByProject = useSnapshotsStore((s) => s.fetchByProject);
  const pinnedIds = usePinnedSnapshotsStore((s) => s.pinnedIds);
  const clearBaselinePin = usePinnedSnapshotsStore((s) => s.clearPin);
  useEffect(() => {
    if (activeProjectIdForRow) {
      fetchSnapshotsByProject(activeProjectIdForRow).catch(() => { /* polling 에서 재시도 */ });
    }
  }, [activeProjectIdForRow, fetchSnapshotsByProject]);
  const baselineSnapshot = useMemo(
    () => snapshots.find((s) => s.projectId === activeProjectIdForRow && pinnedIds.includes(s.id)),
    [snapshots, activeProjectIdForRow, pinnedIds],
  );
  // mapping rule 수정 시 baseline 핀 자동 해제 — snapshot 이 실제 룰과 어긋나면 안 됨.
  // clearPin 이 backend + store 동시 갱신 → baselineSnapshot 자동 null → chip 사라짐.
  const clearBaselineIfPinned = useCallback(() => {
    if (baselineSnapshot) clearBaselinePin(baselineSnapshot.id);
  }, [baselineSnapshot, clearBaselinePin]);

  /**
   * DB 의 mapping_table_bindings → zustand 의 tableBindingEdits 로 hydrate.
   * 임포트 직후 / 페이지 마운트 시 호출. 해당 project 의 binding edits 전부 교체.
   * AS-IS 테이블명은 `{schema}.{table}` 형태로 변환 (frontend AsisTable.name 컨벤션).
   */
  /**
   * Hydrate bindings from DB into zustand. (검증은 별도 — findUncoveredDdlColumns)
   */
  const hydrateAsisSkipsFromDb = useCallback(async (projectId: string): Promise<void> => {
    try {
      const list = await mappingImportApi.listAsisSkips(projectId);
      const byTable: Record<string, Record<string, boolean>> = {};
      for (const s of list) {
        const qualified = (s.asisSchema ? s.asisSchema + '.' : '') + s.asisTable;
        const byCol = byTable[qualified] || {};
        byCol[s.asisColumn] = true;
        byTable[qualified] = byCol;
      }
      useMappingEditsStore.getState().replaceAsisSkips(projectId, byTable);
    } catch (e) {
      console.warn('[mapping] failed to hydrate asis-skips', e);
    }
  }, []);

  const hydrateBindingsFromDb = useCallback(async (projectId: string): Promise<void> => {
    if (TOBE_TABLES.length === 0) return;
    try {
      const list = await mappingImportApi.listBindings(projectId);
      const edits: Record<string, TableBindingEdit> = {};
      for (const b of list) {
        const tobeQualified = (b.tobeSchema ? b.tobeSchema + '.' : '') + b.tobeTable;
        const tobe = TOBE_TABLES.find(
          (t) => t.name.toLowerCase() === tobeQualified.toLowerCase()
              || t.short.toLowerCase() === b.tobeTable.toLowerCase(),
        );
        if (!tobe) continue; // 매핑정의서 > DDL — 정상 (다른 프로젝트용 룰)
        const mode: 'join' | 'union' = b.compositionKind === 'union' ? 'union' : 'join';
        edits[tobe.internalName] = {
          mode,
          whereFilter: b.whereFilter ?? undefined,
          groupByExpr: b.groupByExpr ?? undefined,
          expandExpr: b.expandExpr ?? undefined,
          sharedFromProjectId: b.sharedFromProjectId ?? undefined,
          sources: b.sources.map((s) => ({
            alias: s.alias,
            table: (s.asisSchema ? s.asisSchema + '.' : '') + s.asisTable,
            role: s.role,
            joinType: s.joinType ?? undefined,
            joinOn: s.joinOn ?? undefined,
            rows: 0,
          })),
        };
      }
      useMappingEditsStore.getState().replaceBindingEdits(projectId, edits);
    } catch (e) {
      console.warn('[mapping] failed to hydrate bindings', e);
    }
  }, []);

  /**
   * DB 의 mapping_rules → zustand 의 rowEdits 로 hydrate.
   * Bindings 를 alias 매핑 소스로 사용 (asis_table → alias).
   */
  const hydrateRowEditsFromDb = useCallback(async (projectId: string) => {
    if (TOBE_TABLES.length === 0) return;
    try {
      const [rules, bindings] = await Promise.all([
        mappingImportApi.listRules(projectId),
        mappingImportApi.listBindings(projectId),
      ]);
      // alias 룩업 — key: `{tobeSchema}|{tobeTable}|{asisTable}` → alias
      const aliasMap = new Map<string, string>();
      // expand alias 룩업 — key: `{tobeSchema}|{tobeTable}` → [{alias, columns}]
      // expand_expr 의 AS u(col1, col2) 같은 펼침 alias 도 hydrate 시 보존.
      const expandMap = new Map<string, { alias: string; columns: string[] }[]>();
      for (const b of bindings) {
        for (const s of b.sources) {
          aliasMap.set(`${b.tobeSchema}|${b.tobeTable}|${s.asisTable}`, s.alias);
        }
        if (b.expandExpr) {
          expandMap.set(`${b.tobeSchema}|${b.tobeTable}`, parseExpandAliases(b.expandExpr));
        }
      }
      // rules 를 internalName / tgtColumn 으로 그룹화
      const edits: Record<string, Record<string, RowEdit>> = {};
      for (const r of rules) {
        const tobeQualified = (r.tobeSchema ? r.tobeSchema + '.' : '') + r.tobeTable;
        const tobe = TOBE_TABLES.find(
          (t) => t.name.toLowerCase() === tobeQualified.toLowerCase()
              || t.short.toLowerCase() === r.tobeTable.toLowerCase(),
        );
        if (!tobe) continue;
        const internalName = tobe.internalName;
        if (!edits[internalName]) edits[internalName] = {};

        // savedSrc: 가능하면 `{alias}.{column}`. asisTable 매칭이 우선, 못 찾으면 expand alias 매칭
        // (CROSS JOIN LATERAL 같이 펼친 컬럼들), 둘 다 없으면 column 만.
        // r.asisColumn 은 PG TEXT[] 매핑 string[] — combine 시 여러 원소.
        let savedSrc: string[] | undefined;
        if (r.asisColumn && r.asisColumn.length > 0) {
          const sourceAlias = r.asisTable
            ? aliasMap.get(`${r.tobeSchema}|${r.tobeTable}|${r.asisTable}`)
            : undefined;
          const expandAliases = expandMap.get(`${r.tobeSchema}|${r.tobeTable}`) ?? [];
          const cols = r.asisColumn.map((c) => c.trim()).filter((c) => c);
          savedSrc = cols.map((c) => {
            if (sourceAlias) return `${sourceAlias}.${c}`;
            // asisTable 매칭 실패 → expand alias 의 column 매칭 시도
            const exp = expandAliases.find((e) => e.columns.includes(c));
            return exp ? `${exp.alias}.${c}` : c;
          });
        }

        const strat = r.strategy === 'skip' ? undefined
          : (r.strategy as 'expression' | 'null' | 'default');
        edits[internalName][r.tobeColumn] = {
          savedSrc,
          savedRule: r.transformRule ?? undefined,
          savedDefault: r.defaultValue ?? undefined,
          savedNotNull: r.notNullOverride || undefined,
          savedStrategy: strat,
          ruleOrigin: r.ruleOrigin,
          savedNotes: r.notes ?? undefined,
        };
      }
      useMappingEditsStore.getState().replaceRowEdits(projectId, edits);
    } catch (e) {
      console.warn('[mapping] failed to hydrate rowEdits', e);
    }
  }, []);

  const refreshMappingStatus = useCallback(async (tableFilter: string | null = null): Promise<string[]> => {
    if (!activeProjectIdForRow) return [];
    try {
      const st = await mappingImportApi.status(activeProjectIdForRow);
      setMappingStatus(st);
    } catch {
      setMappingStatus({ columnFilename: null, codeFilename: null, ruleCount: 0, codeMapCount: 0 });
    }
    await hydrateBindingsFromDb(activeProjectIdForRow);
    await hydrateRowEditsFromDb(activeProjectIdForRow);
    return await findUncoveredDdlColumns(activeProjectIdForRow, tableFilter);
  }, [activeProjectIdForRow, hydrateBindingsFromDb, hydrateRowEditsFromDb]);

  useEffect(() => {
    if (!activeProjectIdForRow) {
      setMappingStatus({ columnFilename: null, codeFilename: null, ruleCount: 0, codeMapCount: 0 });
      return;
    }
    let cancelled = false;
    mappingImportApi.status(activeProjectIdForRow)
      .then((st) => { if (!cancelled) setMappingStatus(st); })
      .catch(() => {
        if (!cancelled) setMappingStatus({ columnFilename: null, codeFilename: null, ruleCount: 0, codeMapCount: 0 });
      });
    // TobeMappingDetail 은 MappingPage 가 DDL 로드 완료 후에야 렌더되므로
    // TOBE_TABLES 는 마운트 시점에 이미 채워져 있음. 추가 trigger 불필요.
    // Restore 모델: baseline 핀이 setBaseline 호출로 live mapping_* 를 snapshot 시점으로
    // 복원함. 따라서 frontend 는 항상 backend 의 live 만 hydrate 하면 됨 (override 불필요).
    // baselineSnapshot 변경 (set/clear) → main effect 가 fresh fetch.
    hydrateBindingsFromDb(activeProjectIdForRow);
    hydrateRowEditsFromDb(activeProjectIdForRow);
    hydrateAsisSkipsFromDb(activeProjectIdForRow);
    return () => { cancelled = true; };
    // hydrationTick: 전체(프로젝트) import 후 status/룰/바인딩을 다시 읽어 toolbar·그리드 갱신.
  }, [activeProjectIdForRow, baselineSnapshot?.id, hydrateBindingsFromDb, hydrateRowEditsFromDb, hydrateAsisSkipsFromDb, hydrationTick]);
  const rowEdits = useMappingEditsStore(
    (s) => (activeProjectIdForRow ? s.rowEdits[activeProjectIdForRow]?.[table.internalName] : undefined) || EMPTY_ROW_EDITS,
  );
  const [testStatus, setTestStatus] = useState<'idle' | 'running' | 'completed' | 'failed'>('idle');
  const [testProgress, setTestProgress] = useState(0);
  /* Trial 결과 캐시 — Trial = 실제 BE 변환(샘플 100행), Report 는 이 결과의 TOP 20 재사용 (#8-1).
     DuckDB 위 in-memory 미리보기라 TO-BE DB 적재·phase 변경은 없음. */
  const [trialResult, setTrialResult] = useState<MappingReportResult | null>(null);
  const TRIAL_SAMPLE = 100;
  // Trial 은 BE runReport 한 번의 round-trip — granular % 가 없으므로 도착 전엔 ~90% 까지
  // 크리프 애니메이션, 성공 시 100, 실패 시 빨강 바.
  const startTest = useCallback(() => {
    if (!activeProjectIdForRow) return;
    const i = table.name.indexOf('.');
    const tobeSchema = i > 0 ? table.name.slice(0, i) : '';
    const tobeTable = i > 0 ? table.name.slice(i + 1) : table.name;
    setTestStatus('running');
    setTestProgress(0);
    setTrialResult(null);
    mappingImportApi.runReport(activeProjectIdForRow, tobeSchema, tobeTable, TRIAL_SAMPLE)
      .then((r) => {
        setTrialResult(r);
        setTestProgress(100);
        setTestStatus(r.error ? 'failed' : 'completed');
      })
      .catch((e) => {
        setTrialResult({
          tobeSchema, tobeTable, headers: [], rows: [], rowCount: 0, truncated: false,
          sql: null, error: e instanceof Error ? e.message : String(e),
        });
        setTestProgress(100);
        setTestStatus('failed');
      });
  }, [activeProjectIdForRow, table.name]);
  // running 동안 progress 크리프 (도착 전 ~90% 까지). 도착 시 startTest 가 100 으로 snap.
  useEffect(() => {
    if (testStatus !== 'running') return;
    const id = window.setInterval(() => {
      setTestProgress((p) => (p >= 90 ? 90 : p + 6));
    }, 80);
    return () => window.clearInterval(id);
  }, [testStatus]);
  const handleSaveEdit = useCallback(async (r: MappingRow, edit: RowEdit) => {
    if (!activeProjectIdForRow || readOnly) return;
    // 자식 link 테이블은 master 에서 수정해야 함 — UI 에서 disable 이지만 안전망.
    if (isLinkedChild) return;
    // 사용자가 row 편집기에서 저장한 것 = manual
    const editWithOrigin: RowEdit = { ...edit, ruleOrigin: 'manual' };
    useMappingEditsStore.getState().setRowEdit(activeProjectIdForRow, table.internalName, r.tgt, editWithOrigin);

    // DB 영속화 — savedSrc 의 {alias}.{column} 들에서 컬럼 부분만 추출해 string[] 로 보냄.
    // asisTable / asisSchema 는 첫 source 의 alias 기준 (combine 은 보통 같은 source table).
    const splitQ = (qn: string) => {
      const i = qn.indexOf('.');
      return i > 0 ? { schema: qn.slice(0, i), table: qn.slice(i + 1) } : { schema: '', table: qn };
    };
    const tobeSplit = splitQ(table.name);
    let asisSchema: string | null = null;
    let asisTable: string | null = null;
    let asisColumn: string[] | null = null;
    const filledSrcs = (edit.savedSrc ?? []).filter((s) => s && s.trim());
    if (filledSrcs.length > 0) {
      asisColumn = filledSrcs.map((src) => {
        const parts = src.split('.');
        return parts[parts.length - 1];
      });
      const firstParts = filledSrcs[0].split('.');
      if (firstParts.length >= 2 && bindingEdit) {
        const alias = firstParts[0];
        const source = bindingEdit.sources.find((s) => s.alias === alias);
        if (source) {
          const ssp = splitQ(source.table);
          asisSchema = ssp.schema || null;
          asisTable = ssp.table;
        }
      }
    }
    const strategy = edit.savedStrategy ?? 'expression';
    try {
      await mappingImportApi.upsertRule(activeProjectIdForRow, {
        tobeSchema: tobeSplit.schema,
        tobeTable: tobeSplit.table,
        tobeColumn: r.tgt,
        asisSchema, asisTable, asisColumn,
        strategy,
        transformRule: edit.savedRule ?? null,
        transformSql: edit.savedRule ?? null,
        defaultValue: edit.savedDefault ?? null,
        notNullOverride: edit.savedNotNull ?? false,
      });
    } catch (e) {
      console.warn('[mapping] upsertRule failed', e);
    }
    // baseline 고정 상태에서의 수정 — 핀 자동 해제. **upsertRule 완료 후** 호출하는 이유:
    // clearPin 이 main hydrate effect 를 트리거 → 그 시점 backend 에 사용자 값이 들어가 있어야
    // listRules 가 사용자 값을 받고 rowEdits 에 정상 반영. 먼저 clearPin 하면 hydrate 가
    // 옛 live 데이터를 가져와 사용자 변경값을 덮어쓰는 race 가 발생.
    clearBaselineIfPinned();
    demoteToAnalysisOnEdit(activeProjectIdForRow);
  }, [activeProjectIdForRow, table.internalName, table.name, bindingEdit, clearBaselineIfPinned, readOnly, isLinkedChild]);
  const [bindingSources, setBindingSources] = useState(bindingEdit?.sources ?? table.sources);
  const [bindingMode, setBindingMode] = useState<'join' | 'union'>(
    bindingEdit?.mode ?? (table.compositionKind === 'union' ? 'union' : 'join'),
  );
  const [bindingWhere, setBindingWhere] = useState(bindingEdit?.whereFilter ?? table.whereFilter ?? '');
  const [bindingGroupBy, setBindingGroupBy] = useState(bindingEdit?.groupByExpr ?? table.groupByExpr ?? '');
  const [bindingExpand, setBindingExpand] = useState(bindingEdit?.expandExpr ?? table.expandExpr ?? '');
  // Apply/hydrate 등으로 외부에서 bindingEdit 가 갱신되면 로컬 state 도 따라가게.
  // (useState 는 첫 렌더의 prop 으로만 초기화되어 이후 prop 변경을 못 받음)
  useEffect(() => {
    setBindingSources(bindingEdit?.sources ?? table.sources);
    setBindingMode(bindingEdit?.mode ?? (table.compositionKind === 'union' ? 'union' : 'join'));
    setBindingWhere(bindingEdit?.whereFilter ?? table.whereFilter ?? '');
    setBindingGroupBy(bindingEdit?.groupByExpr ?? table.groupByExpr ?? '');
    setBindingExpand(bindingEdit?.expandExpr ?? table.expandExpr ?? '');
  }, [bindingEdit, table.internalName, table.sources, table.compositionKind, table.whereFilter, table.groupByExpr, table.expandExpr]);
  const allRows = useMemo(() => rows.map((r) => {
    // 자식 link 테이블 — 모든 컬럼이 'link' state. master 룰은 실행 시점에 read-time inherit
    // 되므로 자식 화면 자체는 단순 'Linked' 단일 표시.
    if (isLinkedChild) return { ...r, rule: 'link' as const };
    const re = rowEdits[r.tgt];
    if (!re) return r;
    const filledSrc = re.savedSrc?.some((s) => s && s.trim() !== '') ?? false;
    const hasRule = !!(re.savedRule && re.savedRule.trim());
    let eff: MappingRow['rule'] = r.rule;
    if (re.savedStrategy === 'null') eff = 'null';
    else if (re.savedStrategy === 'default') eff = 'default';
    else if (re.savedStrategy === 'expression') {
      if (hasRule || filledSrc) {
        // 임포트된 룰 = passthrough(auto), 사용자가 수정한 룰 = transform(rule)
        if (filledSrc && !hasRule) eff = 'auto';
        else if (re.ruleOrigin === 'imported') eff = 'auto';
        else eff = 'rule';
      }
    } else if (filledSrc && r.rule === 'unmapped') {
      eff = 'auto';
    }
    // source 도 SQL 도 모두 비웠으면 다시 unmapped 로
    if (re.savedSrc !== undefined && !filledSrc && !hasRule
        && re.savedStrategy !== 'null' && re.savedStrategy !== 'default') {
      eff = 'unmapped';
    }
    const noteFromEdit = re.savedNotes && re.savedNotes.trim() ? re.savedNotes : undefined;
    if (eff === r.rule && noteFromEdit === r.note) return r;
    return { ...r, rule: eff, note: noteFromEdit ?? r.note };
  }), [rows, rowEdits, isLinkedChild]);

  const visibleRows = useMemo(() => allRows.filter((r) => r.rule !== 'skip'), [allRows]);

  // For Test/Report: overlay user-picked source column into r.src so the CSV
  // lookup (and transformation pipeline) sees the AS-IS column the user mapped.
  const reportRows = useMemo(() => visibleRows.map((r) => {
    const re = rowEdits[r.tgt];
    const picked = re?.savedSrc?.find((s) => s && s.trim() !== '');
    return picked ? { ...r, src: picked.trim() } : r;
  }), [visibleRows, rowEdits]);

  const filtered = visibleRows.filter((r) =>
    (!q || (r.src + ' ' + r.tgt).toLowerCase().includes(q.toLowerCase())) &&
    (coverageFilter === 'all' || r.rule === coverageFilter),
  );
  // 컬럼명 매치 — tgt(TO-BE) 또는 src(AS-IS, 마지막 '.' 뒷부분) 가 hlSet 에 들면 매치.
  const rowColMatch = (r: MappingRow): boolean =>
    (!!r.tgt && hlSet.has(r.tgt.toLowerCase()))
    || (!!r.src && hlSet.has((r.src.split('.').pop() ?? '').toLowerCase()));
  // 강조가 켜져 있으면 (= quarantine "매핑 열기" 로 진입) 컬럼 매치 row 를 강조.
  // 매치가 하나도 없으면 (컬럼명 추출 실패 / 빈 cols / 표현식 source 등) 첫 row 라도 강조 →
  // "이 테이블로 왔다" 시각 신호 (기존 imperative fallback 동작 유지).
  const anyHlMatch = highlightActive && filtered.some(rowColMatch);
  const rowIsHl = (r: MappingRow, i: number): boolean =>
    highlightActive && (anyHlMatch ? rowColMatch(r) : i === 0);
  const firstHlIdx = !highlightActive ? -1 : (anyHlMatch ? filtered.findIndex(rowColMatch) : 0);

  const counts = {
    all:      visibleRows.length,
    unmapped: visibleRows.filter((r) => r.rule === 'unmapped').length,
    auto:     visibleRows.filter((r) => r.rule === 'auto').length,
    rule:     visibleRows.filter((r) => r.rule === 'rule').length,
    null:     visibleRows.filter((r) => r.rule === 'null').length,
    default:  visibleRows.filter((r) => r.rule === 'default').length,
  };
  const active = visibleRows[activeIdx] ?? visibleRows[0];

  const missingImports = bindingSources
    .map((s) => ASIS_TABLES.find((a) => bareTable(a.name) === bareTable(s.table)))
    .filter((a): a is AsisTable => !!a && !a.imported);
  // TO-BE Target DB 가 Site Settings 에서 "configured" 상태인지 검사 — Site Settings 의
  // Trial 은 in-memory 미리보기라 TO-BE DB 연결 여부와 무관 — 매핑 정합성만 검사.
  const testDisabled =
    counts.unmapped > 0
    || bindingSources.length === 0
    || missingImports.length > 0;
  const testDisabledReason =
    bindingSources.length === 0 ? t('mapping.test.disabled.noSource')
    : missingImports.length > 0 ? t('mapping.test.disabled.notImported', { tables: missingImports.map((a) => a.short).join(', ') })
    : counts.unmapped > 0 ? t('mapping.test.disabled.unmapped', { n: String(counts.unmapped) })
    : t('mapping.test.disabled.ready');

  return (
    <div style={styles.workspace}>
      {/* Context bar */}
      <div style={{ ...styles.contextBar, display: reportOpen ? 'none' : 'flex' }}>
        <span style={{ ...styles.sidePill, color: 'var(--navy)', background: 'var(--navy-50)', borderColor: 'var(--navy)' }}>TO-BE</span>
        <div style={styles.tableChip}>{table.short}</div>
        {baselineSnapshot && (
          <button
            type="button"
            onClick={() => navigate('/versions', { state: { selectSnapshotId: baselineSnapshot.id } })}
            style={styles.baselinePinChip}
            title={`Pinned baseline: ${baselineSnapshot.name}  (click → Versions)`}
          >
            <PinIconSvg size={11} />
            {baselineSnapshot.version}
          </button>
        )}
        <div style={{ flex: 1 }} />
        <div style={styles.statusCounts}>
          {(() => {
            // 우선순위 — 매핑 작업 순. 한 번에 하나씩만 표시.
            if (bindingSources.length === 0 && !isLinkedChild) {
              return (
                <button
                  type="button"
                  onClick={triggerBindingHighlight}
                  title={t('mapping.tooltip.openBinding')}
                  style={styles.csvMissingBtn}
                >
                  <StatusBadge tone="warn">AS-IS source not bound →</StatusBadge>
                </button>
              );
            }
            if (missingImports.length > 0) {
              return (
                <button
                  type="button"
                  onClick={() => useUiStore.getState().requestOpenSiteSettings({ focus: 'asis-csv' })}
                  title={t('mapping.tooltip.openCsvPath')}
                  style={styles.csvMissingBtn}
                >
                  <StatusBadge tone="warn">{missingImports.length} CSV not imported →</StatusBadge>
                </button>
              );
            }
            if (counts.unmapped > 0) {
              return <StatusBadge tone="err">{counts.unmapped} unmapped</StatusBadge>;
            }
            return null;
          })()}
        </div>
        <button
          style={(testDisabled || testStatus === 'running' || reportOpen) ? styles.btnPrimaryDisabled : styles.btnPrimary}
          disabled={testDisabled || testStatus === 'running' || reportOpen}
          onClick={startTest}
          title={
            reportOpen ? 'Close the Report to run Trial again'
            : testStatus === 'running' ? `Running ${testProgress}%`
            : testStatus === 'completed' ? 'Trial completed. Click to re-run.'
            : testStatus === 'failed' ? (trialResult?.error ?? 'Trial failed. Click to re-run.')
            : testDisabledReason
          }
        >
          <Ic.play /> {testStatus === 'running' ? `Running ${testProgress}%` : 'Trial'}
        </button>
        {/* 완료/실패 둘 다 Report 열기 가능 — 실패 시 Report 에서 에러 메시지·힌트를 확인한다. */}
        {(testStatus === 'completed' || testStatus === 'failed') && (
          <button
            type="button"
            onClick={() => setReportOpen(true)}
            title={testStatus === 'failed'
              ? (trialResult?.error ?? 'Trial failed — open Report to see the error.')
              : t('mapping.tooltip.openReport')}
            style={testStatus === 'failed'
              ? { ...styles.reportChip, color: 'var(--red)', borderColor: 'var(--red)' }
              : styles.reportChip}
          >
            <Ic.arrow /> {testStatus === 'failed' ? 'Report (error)' : 'Report'}
          </button>
        )}
      </div>

      {!reportOpen && bindingSources.length === 0 && !isLinkedChild && (
        <div style={styles.noSourceBanner}>
          <Ic.warn />
          <span>{t('mapping.banner.noSourceBound.pre')}<b>Table binding</b>{t('mapping.banner.noSourceBound.mid')}<b>+ Add source</b>{t('mapping.banner.noSourceBound.post')}</span>
        </div>
      )}
      {!reportOpen && (
        <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)', background: 'var(--panel-2)', display: 'flex', alignItems: 'center', gap: 8 }}>
          {isLinkedChild ? (
            <>
              <i className="fa-solid fa-link" style={{ fontSize: 11, color: 'var(--text-2)' }} />
              <span style={{ fontSize: 11, color: 'var(--text-2)' }}>{t('mapping.link.inheritedFrom')}</span>
              <button
                type="button"
                onClick={() => {
                  const masterId = bindingEdit?.sharedFromProjectId;
                  if (!masterId) return;
                  navigate('/mapping', {
                    state: {
                      activateProjectId: masterId,
                      focusTable: { tobeSchema: tobeSplitForBanner.schema, tobeTable: tobeSplitForBanner.table },
                    },
                  });
                }}
                style={projectLinkStyle}
                title={t('mapping.link.openInMaster')}
              >
                {masterProject?.name ?? bindingEdit?.sharedFromProjectId}
              </button>
              <div style={{ flex: 1 }} />
              {!readOnly && (
                <button type="button" style={styles.btnSecondary} onClick={() => setLinkModalOpen(true)}>{t('mapping.link.button.changeUnlink')}</button>
              )}
            </>
          ) : isParentTable && parentInfo ? (
            <>
              <i className="fa-solid fa-link" style={{ fontSize: 11, color: 'var(--text-2)' }} />
              <span style={{ fontSize: 11, color: 'var(--text-2)' }}>{t('mapping.link.parentOf')}</span>
              {parentInfo.children.map((c, i) => (
                <span key={c.projectId + '|' + c.tobeTable + '|' + i}>
                  <button
                    type="button"
                    onClick={() => {
                      navigate('/mapping', {
                        state: {
                          activateProjectId: c.projectId,
                          focusTable: { tobeSchema: c.tobeSchema, tobeTable: c.tobeTable },
                        },
                      });
                    }}
                    style={projectLinkStyle}
                    title={t('mapping.link.openInChild')}
                  >
                    {c.projectName}
                  </button>
                  {i < parentInfo.children.length - 1 ? <span style={{ marginRight: 2 }}>,</span> : null}
                </span>
              ))}
              <div style={{ flex: 1 }} />
            </>
          ) : (
            <>
              <i className="fa-solid fa-unlink" style={{ fontSize: 11, color: 'var(--text-3)' }} />
              <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{t('mapping.link.standalone')}</span>
              <div style={{ flex: 1 }} />
              {!readOnly && (
                <button type="button" style={styles.btnSecondary} onClick={() => setLinkModalOpen(true)}>{t('mapping.link.button.link')}</button>
              )}
            </>
          )}
        </div>
      )}
      {!reportOpen && (
        <div style={isLinkedChild ? { pointerEvents: 'none', opacity: 0.55 } : undefined}>
          <CollapsibleBinding
            table={table} open={bindingOpen} pulse={bindingPulse} onToggle={() => setBindingOpen((o) => !o)}
            sources={bindingSources}
            onSourcesChange={(s) => { if (isLinkedChild) return; setBindingSources(s); onBindingChange({ sources: s, mode: bindingMode, whereFilter: bindingWhere, groupByExpr: bindingGroupBy, expandExpr: bindingExpand }); }}
            compositionMode={bindingMode}
            onCompositionModeChange={(m) => { if (isLinkedChild) return; setBindingMode(m); onBindingChange({ sources: bindingSources, mode: m, whereFilter: bindingWhere, groupByExpr: bindingGroupBy, expandExpr: bindingExpand }); }}
            whereFilter={bindingWhere}
            onWhereChange={(v) => { if (isLinkedChild) return; setBindingWhere(v); onBindingChange({ sources: bindingSources, mode: bindingMode, whereFilter: v, groupByExpr: bindingGroupBy, expandExpr: bindingExpand }); }}
            groupByExpr={bindingGroupBy}
            onGroupByChange={(v) => { if (isLinkedChild) return; setBindingGroupBy(v); onBindingChange({ sources: bindingSources, mode: bindingMode, whereFilter: bindingWhere, groupByExpr: v, expandExpr: bindingExpand }); }}
            expandExpr={bindingExpand}
            onExpandChange={(v) => { if (isLinkedChild) return; setBindingExpand(v); onBindingChange({ sources: bindingSources, mode: bindingMode, whereFilter: bindingWhere, groupByExpr: bindingGroupBy, expandExpr: v }); }}
          />
        </div>
      )}

      {/* Toolbar */}
      <div style={{ ...styles.toolbar, display: reportOpen ? 'none' : 'flex' }}>
        <div style={styles.toolbarSearch}>
          <Ic.search />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by field name" style={styles.searchInput} />
        </div>
        <div style={{ flex: 1 }} />
        {!readOnly && (
          <>
            <button
              style={yamlImported
                ? { ...styles.btnSecondary, color: 'var(--text-3)' }
                : styles.btnSecondary}
              onClick={() => setImportYamlOpen(true)}
            >{yamlImported
                ? <><Ic.check /> YAML Imported</>
                : <><i className="fa-solid fa-download" style={{ fontSize: 11 }} /> Import YAML</>}</button>
            <button
              style={mappingImported
                ? { ...styles.btnSecondary, color: 'var(--text-3)' }
                : styles.btnSecondary}
              onClick={() => setImportMappingOpen(true)}
              title={t('mapping.tooltip.rematchTable')}
            >{mappingImported
                ? <><Ic.check /> Table mapped</>
                : <><i className="fa-solid fa-table" style={{ fontSize: 11 }} /> Re-map table</>}</button>
          </>
        )}
      </div>
      {importMappingOpen && (
        <MappingDefinitionImportModal
          projectId={activeProjectIdForRow ?? ''}
          activeFiles={{ column: mappingStatus.columnFilename, code: mappingStatus.codeFilename }}
          onClose={() => setImportMappingOpen(false)}
          onChanged={refreshMappingStatus}
          tableFilter={table.name.split('.').pop() || table.name}
        />
      )}
      {importYamlOpen && (
        <ImportFileModal
          title="Import YAML"
          accept=".yml,.yaml"
          acceptLabel=".yml · .yaml"
          hint={t('mapping.import.yamlHint')}
          onClose={() => setImportYamlOpen(false)}
          onImported={() => setYamlImported(true)}
        />
      )}

      {reportOpen && (
        <ReportView
          table={table}
          rows={reportRows}
          sources={bindingSources}
          prefetched={trialResult}
          onClose={() => setReportOpen(false)}
          onPickColumn={(tgt) => {
            const idx = visibleRows.findIndex((r) => r.tgt === tgt);
            if (idx >= 0) {
              setActiveIdx(idx);
              setInspectorOpen(true);
              setReportOpen(false);
            }
          }}
        />
      )}

      {/* Grid + inspector */}
      <div style={{ ...styles.gridSplit, display: reportOpen ? 'none' : 'flex' }}>
        <div style={styles.gridScroll}>
          <TobeCoverageBar
            total={counts.all}
            ruleCounts={{
              unmapped: counts.unmapped,
              auto: counts.auto,
              rule: counts.rule,
              null: counts.null,
              default: counts.default,
            }}
            filter={coverageFilter}
            onFilter={setCoverageFilter}
            hideFilters={isLinkedChild}
          />
          <table style={{ ...styles.gridTable, tableLayout: 'auto', minWidth: 980 }}>
            <colgroup>
              <col style={{ width: 24 }} />
              <col style={{ width: 220 }} />
              <col style={{ width: 50 }} />
              <col style={{ width: 170 }} />
              <col style={{ width: 28 }} />
              <col style={{ width: 220 }} />
              <col style={{ width: 140 }} />
              <col style={{ width: 110 }} />
            </colgroup>
            <thead>
              <tr>
                {[
                  { l: '',             align: 'left' as const },
                  { l: 'Source field', align: 'left' as const },
                  { l: 'Alias',        align: 'center' as const },
                  { l: 'Source type',  align: 'left' as const },
                  { l: '',             align: 'left' as const },
                  { l: 'Target field', align: 'left' as const },
                  { l: 'Target type',  align: 'left' as const },
                  { l: 'State',        align: 'center' as const },
                ].map((h, i) => (
                  <th key={i} style={{ ...styles.gridTh, textAlign: h.align, top: 56, zIndex: 1 }}>{h.l}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => {
                const realIdx = visibleRows.indexOf(r);
                const isActive = realIdx === activeIdx;
                const isHl = rowIsHl(r, i);
                return (
                  <tr
                    key={`${r.src}>${r.tgt}-${i}`}
                    ref={i === firstHlIdx ? firstHlRowRef : undefined}
                    className={isHl ? 'mpd-quarantine-highlight' : undefined}
                    data-fix-row={r.rule === 'unmapped' ? 'tobe-unmapped' : undefined}
                    data-mpd-tobe-column={r.tgt || undefined}
                    data-mpd-asis-column={r.src || undefined}
                    onClick={() => {
                      // 강조된 row 를 클릭하면 강조 종료 (행 인터랙션과 일체화).
                      if (isHl) onSkipHighlight?.();
                      // 자식 link 테이블은 master 에서만 수정 가능 — Inspector 안 열림.
                      if (isLinkedChild) return;
                      // 같은 행을 다시 누르면 inspector 를 닫는다 (토글). 다른 행이면 그 행으로 열기.
                      if (inspectorOpen && activeIdx === realIdx) {
                        setInspectorOpen(false);
                      } else {
                        setActiveIdx(realIdx);
                        setInspectorOpen(true);
                      }
                    }}
                    style={{
                      background: isActive ? 'var(--navy-50)' : (i % 2 === 1 ? 'var(--zebra)' : 'var(--panel)'),
                      borderBottom: '1px solid var(--border)',
                      borderLeft: isActive ? '2px solid var(--navy)' : '2px solid transparent',
                      cursor: 'pointer',
                    }}
                  >
                    <td style={{ ...styles.gridTd, textAlign: 'center' }}>
                      {r.pk && <span title="primary key" style={{ color: 'var(--navy)', display: 'inline-flex' }}><Ic.key /></span>}
                    </td>
                    <td style={{ ...styles.gridTd, fontFamily: 'var(--mono)', fontWeight: 500, color: rowEdits[r.tgt]?.savedSrc?.some((s) => s && s.trim()) ? 'var(--text)' : srcCellColor(r) }}>
                      {(() => {
                        const eff = rowEdits[r.tgt]?.savedSrc;
                        if (eff !== undefined) {
                          const filled = eff.filter((s) => s && s.trim() !== '');
                          if (filled.length === 0) {
                            return <span style={{ fontStyle: 'italic', color: 'var(--text-4)' }}>(unassigned)</span>;
                          }
                          return <span>{filled.map((s) => s.slice(s.lastIndexOf('.') + 1)).join(' + ')}</span>;
                        }
                        return srcCellContent(r);
                      })()}
                    </td>
                    <td style={{ ...styles.gridTd, padding: '5px 4px', textAlign: 'center' }}>
                      {(() => {
                        const eff = rowEdits[r.tgt]?.savedSrc;
                        if (eff?.length) {
                          // dot 없는 source (alias 미포함) 의 경우 alias undefined — slice(0,-1) 로
                          // column 명 앞 글자가 잘리는 표시 버그 회피.
                          const di = eff[0].indexOf('.');
                          const alias = di >= 0 ? eff[0].slice(0, di) : undefined;
                          return <SourceAliasTag alias={alias} composition={table.compositionKind} />;
                        }
                        return <SourceAliasTag alias={r.sourceAlias} composition={table.compositionKind} />;
                      })()}
                    </td>
                    <td style={styles.gridTd}>
                      {(() => {
                        const savedSrcs = rowEdits[r.tgt]?.savedSrc;
                        if (savedSrcs?.length) {
                          const types = savedSrcs.map((s) => resolveSrcType(s, bindingSources, bindingExpand)).filter((t) => t && t !== '—');
                          return types.length
                            ? <TypeBadge>{types.join(', ')}</TypeBadge>
                            : <span style={{ color: 'var(--text-4)', fontFamily: 'var(--mono)' }}>—</span>;
                        }
                        return r.srcType === '—'
                          ? <span style={{ color: 'var(--text-4)', fontFamily: 'var(--mono)' }}>—</span>
                          : <TypeBadge>{r.srcType}</TypeBadge>;
                      })()}
                    </td>
                    <td style={{ ...styles.gridTd, padding: '5px 0', textAlign: 'center', color: arrowColor(r) }}>
                      {r.rule === 'added' ? '+' : r.rule === 'unmapped' ? '?' : <Ic.arrow />}
                    </td>
                    <td style={{ ...styles.gridTd, fontFamily: 'var(--mono)', fontWeight: 500, color: 'var(--text)' }}>
                      {r.tgt}
                    </td>
                    <td style={styles.gridTd}>
                      {r.tgtType === '—' ? <span style={{ color: 'var(--text-4)', fontFamily: 'var(--mono)' }}>—</span> : <TypeBadge>{r.tgtType}</TypeBadge>}
                    </td>
                    <td style={{ ...styles.gridTd, textAlign: 'center' }}>
                      {isHl ? (
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <RuleTag rule={r.rule} status={r.status} />
                          {/* 강조 종료 버튼 — row onClick(=강조 끄기 + inspector) 로 전파 안 되게 stopPropagation. */}
                          <button
                            type="button"
                            style={styles.rowSkipBtn}
                            onClick={(e) => { e.stopPropagation(); onSkipHighlight?.(); }}
                          >
                            skip
                          </button>
                        </div>
                      ) : (
                        <RuleTag rule={r.rule} status={r.status} />
                      )}
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={8} style={styles.gridEmpty}>no fields match this filter</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {inspectorOpen && (
          <Inspector
            active={active}
            composition={table.compositionKind}
            sources={bindingSources}
            expandExpr={bindingExpand}
            rowEdit={rowEdits[active?.tgt ?? '']}
            onSave={(edit) => handleSaveEdit(active, edit)}
            onClose={() => setInspectorOpen(false)}
          />
        )}
      </div>

      {/* Master-child link 모달 — site 안 다른 project / 테이블 중 master 선택 또는 unlink. */}
      {linkModalOpen && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
          onClick={() => linkSaving ? undefined : setLinkModalOpen(false)}
        >
          <div
            style={{ background: 'var(--panel)', border: '1px solid var(--border-strong)', borderRadius: 6, width: 600, maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>Link {table.short} → parent table</div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>
                같은 site 의 다른 project 의 부모 테이블을 link 하면 이 테이블의 모든 룰을 그 project 에서 inherit 합니다. row editor 와 binding 패널은 read-only 가 됩니다.
              </div>
            </div>
            <div style={{ overflow: 'auto', padding: '12px 18px', flex: 1 }}>
              <label style={{ display: 'flex', gap: 8, padding: 8, border: '1px solid var(--border)', borderRadius: 4, marginBottom: 6, cursor: 'pointer' }}>
                <input type="radio" name="link-target" checked={linkSelection === ''} onChange={() => setLinkSelection('')} />
                <span>{t('mapping.binding.selfDefined')}</span>
              </label>
              {(() => {
                // 같은 (tobeSchema, tobeTable) 이름 매칭되는 후보만 — 그 테이블을 포함한 다른 project 들.
                const i = table.name.indexOf('.');
                const mySchema = i > 0 ? table.name.slice(0, i) : '';
                const myTable = i > 0 ? table.name.slice(i + 1) : table.name;
                const filtered = (linkCandidates?.manualOptions ?? []).filter(
                  (o) => (o.tobeSchema ?? '').toLowerCase() === mySchema.toLowerCase()
                      && o.tobeTable.toLowerCase() === myTable.toLowerCase()
                );
                if (filtered.length === 0) {
                  return (
                    <div style={{ fontSize: 11, color: 'var(--text-3)', padding: 8 }}>
                      같은 site 의 다른 project 에 같은 이름의 테이블이 없습니다.
                    </div>
                  );
                }
                return filtered.map((o) => {
                  const key = `${o.projectId}|${o.tobeSchema}|${o.tobeTable}`;
                  return (
                    <label key={key} style={{ display: 'flex', gap: 8, padding: 8, border: '1px solid var(--border)', borderRadius: 4, marginBottom: 6, cursor: 'pointer' }}>
                      <input type="radio" name="link-target" checked={linkSelection === key} onChange={() => setLinkSelection(key)} />
                      <span>
                        <span style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{o.tobeSchema ? `${o.tobeSchema}.${o.tobeTable}` : o.tobeTable}</span>
                        <span style={{ fontSize: 11, color: 'var(--text-3)', marginLeft: 8 }}>in {o.projectName}</span>
                      </span>
                    </label>
                  );
                });
              })()}
            </div>
            <div style={{ padding: '12px 18px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" style={styles.btnGhost} disabled={linkSaving} onClick={() => setLinkModalOpen(false)}>Cancel</button>
              <button
                type="button"
                style={linkSaving ? { ...styles.btnPrimary, ...styles.btnDisabled } : styles.btnPrimary}
                disabled={linkSaving}
                onClick={() => {
                  if (linkSelection === '') {
                    applyLink(null);
                  } else {
                    const [pid] = linkSelection.split('|');
                    applyLink(pid);
                  }
                }}
              >{linkSaving ? 'Saving' : 'Apply'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function srcCellColor(r: MappingRow): string {
  if (r.rule === 'skip') return 'var(--text-3)';
  if (r.rule === 'link') return 'var(--text-3)';
  if (r.rule === 'added' || r.rule === 'unmapped' || r.rule === 'null' || r.rule === 'default') return 'var(--text-4)';
  return 'var(--text)';
}
function arrowColor(r: MappingRow): string {
  if (r.rule === 'skip')     return 'var(--text-4)';
  if (r.rule === 'added')    return 'var(--green)';
  if (r.rule === 'unmapped') return 'var(--text-4)';
  if (r.rule === 'link')     return 'var(--text-3)';
  return 'var(--text-3)';
}
function srcCellContent(r: MappingRow): React.ReactNode {
  if (r.rule === 'added')    return <span style={{ fontStyle: 'italic' }}>(new in TO-BE)</span>;
  if (r.rule === 'unmapped') return <span style={{ fontStyle: 'italic' }}>(unassigned)</span>;
  if (r.rule === 'null')     return <span style={{ fontStyle: 'italic', color: 'var(--text-3)' }}>NULL</span>;
  if (r.rule === 'default')  return <span style={{ fontStyle: 'italic', color: 'var(--text-3)' }}>DEFAULT</span>;
  if (r.rule === 'link')     return <span style={{ fontStyle: 'italic', color: 'var(--text-3)' }}>(inherited from master)</span>;
  return r.src;
}

function StatusFor({ row }: { row: MappingRow }) {
  if (row.status === 'ok')     return <StatusBadge tone="ok">ok</StatusBadge>;
  if (row.status === 'warn')   return <StatusBadge tone="warn">warn</StatusBadge>;
  if (row.status === 'err')    return <StatusBadge tone="err">error</StatusBadge>;
  if (row.status === 'skip')   return <StatusBadge tone="skip">skip</StatusBadge>;
  return <StatusBadge tone="queued">queued</StatusBadge>;
}

// ── Collapsible binding ──────────────────────────────────────

/**
 * 단일 행 input 에 cursor-aware autocomplete 를 붙임.
 * 사용자가 타이핑하는 현재 단어 ([\w.] 연속체) 가 completions 와 prefix 매칭되면 dropdown.
 * Tab/Enter 로 선택, Esc 로 닫음, ↑↓ 로 이동.
 */
function AutocompleteInput({
  value, onChange, completions, placeholder, style, disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  completions: string[];
  placeholder?: string;
  style?: React.CSSProperties;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const [acItems, setAcItems] = useState<string[]>([]);
  const [acIdx, setAcIdx] = useState(0);
  // Ctrl+Space 로 강제 popup 트리거 — 빈 word 일 때도 전체 completions 표시.
  const [force, setForce] = useState(false);
  const savedCursor = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (savedCursor.current !== null && inputRef.current) {
      inputRef.current.setSelectionRange(savedCursor.current, savedCursor.current);
      savedCursor.current = null;
    }
  }, [value]);

  useEffect(() => {
    if (!focused || !completions.length || !inputRef.current) {
      setAcItems((prev) => { if (prev.length) { setAcIdx(0); return []; } return prev; });
      return;
    }
    const pos = inputRef.current.selectionStart ?? 0;
    let s = pos;
    while (s > 0 && /[\w.]/.test(value[s - 1])) s--;
    const word = value.slice(s, pos);
    if (!force && word.length < 1) {
      setAcItems((prev) => { if (prev.length) { setAcIdx(0); return []; } return prev; });
      return;
    }
    const lo = word.toLowerCase();
    const hits = force && word.length === 0
      ? completions.slice(0, 10)
      : completions.filter((c) => c.toLowerCase().includes(lo) && c.toLowerCase() !== lo).slice(0, 10);
    // hits 가 *실제로 변경됐을 때만* acIdx reset — 사용자 ArrowDown 선택이 effect 재실행으로
    // 첫 항목으로 되돌아가는 것 방지.
    setAcItems((prev) => {
      const same = prev.length === hits.length && prev.every((p, i) => p === hits[i]);
      if (same) return prev;
      setAcIdx(0);
      return hits;
    });
  }, [value, focused, completions, force]);

  const applyAc = (item: string) => {
    if (!inputRef.current) return;
    const pos = inputRef.current.selectionStart ?? 0;
    let s = pos;
    while (s > 0 && /[\w.]/.test(value[s - 1])) s--;
    const before = value.slice(0, s);
    const after = value.slice(pos);
    savedCursor.current = before.length + item.length;
    onChange(before + item + after);
    setAcItems([]);
    setForce(false);
    inputRef.current.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Ctrl+Space — 강제 자동완성 popup 트리거.
    if ((e.ctrlKey || e.metaKey) && e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      setForce(true);
      return;
    }
    if (!acItems.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setAcIdx((i) => Math.min(i + 1, acItems.length - 1)); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setAcIdx((i) => Math.max(i - 1, 0)); return; }
    if (e.key === 'Escape')    { e.stopPropagation(); setForce(false); setAcItems([]); return; }
    if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); applyAc(acItems[acIdx]); return; }
  };

  return (
    <div style={{ position: 'relative', flex: 1, minWidth: 0, width: '100%' }}>
      <input
        ref={inputRef}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          savedCursor.current = e.target.selectionStart;
          onChange(e.target.value);
        }}
        onKeyDown={handleKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); setAcItems([]); setForce(false); }}
        placeholder={placeholder}
        spellCheck={false}
        style={{ width: '100%', boxSizing: 'border-box', ...style }}
      />
      {acItems.length > 0 && (
        <div style={styles.acDropdown}>
          {acItems.map((item, i) => (
            <div
              key={item}
              onMouseDown={(e) => { e.preventDefault(); applyAc(item); }}
              onMouseEnter={() => setAcIdx(i)}
              style={{
                ...styles.acItem,
                background: i === acIdx ? 'var(--navy-50)' : 'transparent',
                color: i === acIdx ? 'var(--navy)' : 'var(--text-2)',
              }}
            >{item}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function CollapsibleBinding({ table, open, pulse, onToggle, sources, onSourcesChange, compositionMode, onCompositionModeChange, whereFilter, onWhereChange, groupByExpr, onGroupByChange, expandExpr, onExpandChange }: {
  table: TobeTable; open: boolean; pulse?: boolean; onToggle: () => void;
  sources: TobeTable['sources']; onSourcesChange: (s: TobeTable['sources']) => void;
  compositionMode: 'join' | 'union'; onCompositionModeChange: (m: 'join' | 'union') => void;
  whereFilter: string; onWhereChange: (v: string) => void;
  groupByExpr: string; onGroupByChange: (v: string) => void;
  expandExpr: string; onExpandChange: (v: string) => void;
}) {
  const t = useT();
  const readOnly = useActiveProjectReadOnly();
  // "AS-IS source not bound →" 배지 클릭 시 pulse 가 켜지면 이 패널로 스크롤 + 강조.
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (pulse && wrapRef.current) {
      wrapRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [pulse]);
  const [addingSource, setAddingSource] = useState(false);
  const [pickTable, setPickTable] = useState('');
  const [pickAlias, setPickAlias] = useState('');

  const op = compositionMode === 'union' ? '∪' : '⋈';
  const usedTables = new Set(sources.map((s) => s.table));
  const availableTables = ASIS_TABLES.filter((t) => !usedTables.has(t.name));

  // {alias}.{column} 자동완성 후보 — sources 의 컬럼들 + expand_expr 의 AS u(...) 컬럼들.
  const datalistId = `mpd-cols-${table.internalName}`;
  const aliasColumnOptions = useMemo(() => {
    const opts: string[] = [];
    for (const s of sources) {
      const cols = lookupAsisCols(s.table);
      for (const c of cols) opts.push(`${s.alias}.${c.name}`);
    }
    for (const e of parseExpandAliases(expandExpr)) {
      for (const c of e.columns) opts.push(`${e.alias}.${c}`);
    }
    return opts;
  }, [sources, expandExpr, table.internalName]);

  const startAdd = () => {
    if (readOnly) return;
    const first = availableTables[0];
    setPickTable(first?.name ?? '');
    setPickAlias(first ? first.short.slice(0, 2).toLowerCase() : '');
    setAddingSource(true);
  };

  const confirmAdd = () => {
    if (readOnly) return;
    const asisTable = ASIS_TABLES.find((t) => t.name === pickTable);
    if (!asisTable || !pickAlias.trim()) return;
    const role = sources.length === 0 ? 'primary' : (compositionMode === 'union' ? 'union' : 'join');
    onSourcesChange([
      ...sources,
      {
        alias: pickAlias.trim(),
        table: pickTable,
        role,
        ...(role === 'join' ? { joinType: 'LEFT JOIN' } : {}),
        rows: asisTable.rows,
      },
    ]);
    setAddingSource(false);
  };

  const updateSource = (alias: string, patch: Partial<typeof sources[0]>) => {
    if (readOnly) return;
    onSourcesChange(sources.map((s) => s.alias === alias ? { ...s, ...patch } : s));
  };

  return (
    <div
      ref={wrapRef}
      style={{
        ...styles.bindingWrap,
        transition: 'box-shadow 0.3s ease',
        ...(pulse ? { boxShadow: 'inset 0 0 0 2px #0E7C7B, 0 0 0 4px rgba(14,124,123,0.22)' } : {}),
      }}
      data-fix-block="tobe-binding"
    >
      <div onClick={onToggle} style={styles.bindingHeader}>
        <span style={{ color: 'var(--text-4)', fontSize: 10, width: 10 }}>{open ? '▾' : '▸'}</span>
        <span style={styles.bindingLabel}>Table binding</span>
        <div style={styles.bindingExpr}>
          {sources.length === 0 ? (
            <>
              <span style={{ color: 'var(--text-3)', fontStyle: 'italic' }}>(no source yet)</span>
              <span style={{ color: 'var(--text-4)' }}><Ic.arrow /></span>
              <span style={{ color: 'var(--navy)', fontWeight: 500 }}>{table.short}</span>
            </>
          ) : sources.length === 1 ? (
            <>
              <span style={{ color: 'var(--text)' }}>{sources[0].table}</span>
              <span style={{ color: 'var(--text-4)' }}><Ic.arrow /></span>
              <span style={{ color: 'var(--navy)', fontWeight: 500 }}>{table.short}</span>
            </>
          ) : (
            <>
              {sources.map((s, i) => (
                <span key={s.alias} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  {i > 0 && <span style={{ color: 'var(--text-3)', fontWeight: 700 }}>{op}</span>}
                  <span style={styles.aliasChip}>{s.alias}</span>
                  <span style={{ color: 'var(--text)' }}>{s.table.split('.').pop()}</span>
                </span>
              ))}
              <span style={{ color: 'var(--text-4)' }}><Ic.arrow /></span>
              <span style={{ color: 'var(--navy)', fontWeight: 500 }}>{table.short}</span>
            </>
          )}
        </div>
        {sources.length === 0 && <StatusBadge tone="warn">no source</StatusBadge>}
        {sources.length > 1 && (
          <StatusBadge tone="info">
            {compositionMode === 'union' ? `UNION · ${sources.length}` : `JOIN · ${sources.length}`}
          </StatusBadge>
        )}
        {table.whereFilter && (
          <span title={`WHERE: ${table.whereFilter}`} style={styles.whereChip}>⚲ WHERE</span>
        )}
      </div>

      {open && (
        <div style={styles.bindingBody}>
          <div style={styles.bindingBodyHeader}>
            <span>AS-IS source tables</span>
            {sources.length >= 2 && (
              <div style={styles.modeToggle}>
                <button
                  onClick={(e) => { e.stopPropagation(); if (!readOnly) onCompositionModeChange('join'); }}
                  disabled={readOnly}
                  style={{ ...styles.modeBtn, ...(compositionMode !== 'union' ? styles.modeBtnActive : {}) }}
                >⋈ JOIN</button>
                <button
                  onClick={(e) => { e.stopPropagation(); if (!readOnly) onCompositionModeChange('union'); }}
                  disabled={readOnly}
                  style={{ ...styles.modeBtn, ...(compositionMode === 'union' ? styles.modeBtnActive : {}) }}
                >∪ UNION</button>
              </div>
            )}
            <div style={{ flex: 1 }} />
            <button
              style={styles.btnGhost}
              onClick={(e) => { e.stopPropagation(); startAdd(); }}
              disabled={availableTables.length === 0 || addingSource || readOnly}
            >
              <Ic.plus /> Add source
            </button>
          </div>

          {sources.length === 0 && !addingSource && (
            <div style={styles.bindingHint}>
              {t('mapping.binding.noSourceHint')}
            </div>
          )}

          {sources.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {sources.map((s) => (
                <div key={s.alias} style={{
                  ...styles.sourceRow,
                  flexDirection: s.role === 'join' ? 'column' : 'row',
                  alignItems: s.role === 'join' ? 'stretch' : 'center',
                  gap: s.role === 'join' ? 6 : 8,
                  border: `1px solid ${s.role === 'primary' ? 'var(--navy)' : 'var(--border)'}`,
                  background: s.role === 'primary' ? 'var(--navy-50)' : 'var(--panel)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
                    <span style={styles.aliasChipFilled}>{s.alias}</span>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.table}</span>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-4)', whiteSpace: 'nowrap' }}>
                      {s.rows.toLocaleString()} rows
                    </span>
                    {s.role === 'primary' && <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--navy)', fontWeight: 600 }}>primary</span>}
                    {s.role === 'union'   && <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-2)', fontWeight: 600 }}>UNION</span>}
                    {s.role === 'join'    && (
                      <select
                        value={s.joinType ?? 'LEFT JOIN'}
                        onChange={(e) => updateSource(s.alias, { joinType: e.target.value })}
                        disabled={readOnly}
                        style={styles.joinSelect}
                      >
                        <option>LEFT JOIN</option><option>INNER JOIN</option><option>RIGHT JOIN</option><option>FULL JOIN</option>
                      </select>
                    )}
                    <div style={{ flex: 1 }} />
                    {!readOnly && (
                      <button
                        onClick={() => onSourcesChange(sources.filter((s2) => s2.alias !== s.alias))}
                        title="Remove source"
                        style={styles.srcRemoveBtn}
                      >×</button>
                    )}
                  </div>
                  {s.role === 'join' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={styles.joinOnLabel}>ON</span>
                      <AutocompleteInput
                        completions={aliasColumnOptions}
                        value={s.joinOn ?? ''}
                        onChange={(v) => updateSource(s.alias, { joinOn: v })}
                        placeholder={`${s.alias}.id = primary.id`}
                        style={styles.joinOnInput}
                        disabled={readOnly}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {addingSource && (
            <div style={styles.addSourceRow}>
              <select
                value={pickTable}
                onChange={(e) => {
                  const t = ASIS_TABLES.find((a) => a.name === e.target.value);
                  setPickTable(e.target.value);
                  setPickAlias(t ? t.short.slice(0, 2).toLowerCase() : '');
                }}
                style={styles.addSourceSelect}
              >
                {availableTables.map((t) => (
                  <option key={t.name} value={t.name}>{t.short}</option>
                ))}
              </select>
              <span style={{ color: 'var(--text-4)', fontSize: 10.5, whiteSpace: 'nowrap' }}>alias</span>
              <input
                value={pickAlias}
                onChange={(e) => setPickAlias(e.target.value)}
                maxLength={8}
                style={styles.addSourceAlias}
              />
              <button onClick={confirmAdd} style={styles.btnPrimarySm}>Add</button>
              <button onClick={() => setAddingSource(false)} style={{ ...styles.btnSecondary, height: 24, fontSize: 11 }}>Cancel</button>
            </div>
          )}

          {sources.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ ...styles.whereLabel, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span>EXPAND (row 1:N)</span>
                <span style={styles.whereHint}>{t('mapping.binding.expandHint')}</span>
                <div style={{ flex: 1 }} />
                <ExpandTemplateMenu
                  onPick={(kind) => {
                    const alias = sources[0]?.alias || 't';
                    onExpandChange(kind === null ? '' : generateExpandTemplate(kind, alias));
                  }}
                  disabled={readOnly}
                />
              </div>
              <AutocompleteInput
                completions={aliasColumnOptions}
                value={expandExpr}
                onChange={onExpandChange}
                placeholder={`${t('mapping.eg')}: CROSS JOIN LATERAL (VALUES ('phone', ${sources[0].alias}.PHONE), ('email', ${sources[0].alias}.EMAIL)) AS u(channel, value)`}
                style={styles.whereInput}
                disabled={readOnly}
              />
            </div>
          )}
          {sources.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={styles.whereLabel}>
                <span>WHERE filter</span>
                <span style={styles.whereHint}>{t('mapping.binding.whereHint')}</span>
              </div>
              <AutocompleteInput
                completions={aliasColumnOptions}
                value={whereFilter}
                onChange={onWhereChange}
                placeholder={`${t('mapping.eg')}: ${sources[0].alias}.party_type = 'P'`}
                style={styles.whereInput}
                disabled={readOnly}
              />
            </div>
          )}
          {sources.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={styles.whereLabel}>
                <span>GROUP BY</span>
                <span style={styles.whereHint}>{t('mapping.binding.groupByHint')}</span>
              </div>
              <AutocompleteInput
                completions={aliasColumnOptions}
                value={groupByExpr}
                onChange={onGroupByChange}
                placeholder={`${t('mapping.eg')}: EXTRACT(MONTH FROM ${sources[0].alias}.txn_date), ${sources[0].alias}.account`}
                style={styles.whereInput}
                disabled={readOnly}
              />
            </div>
          )}
        </div>
      )}
      {/* alias.column 자동완성 — joinOn / whereFilter input 의 list= 가 참조 */}
      <datalist id={datalistId}>
        {aliasColumnOptions.map((opt) => (
          <option key={opt} value={opt} />
        ))}
      </datalist>
    </div>
  );
}

// Per-row saved edits (lifted to TobeMappingDetail so they survive row switches)
type RowEdit = { savedSrc?: string[]; savedRule?: string; savedDefault?: string; savedNotNull?: boolean; savedStrategy?: 'expression' | 'null' | 'default'; ruleOrigin?: 'imported' | 'manual'; savedNotes?: string };

// Module-level helper so it can be called from useEffect closures
/**
 * binding 의 expand_expr 안에서 `AS alias(col1, col2, ...)` 패턴을 모두 추출.
 * row editor / 자동완성이 expand alias.column 도 source 후보로 보여줄 수 있게 한다.
 * type 정보는 expand_expr 에 없으므로 VARCHAR fallback.
 */
/** Inspector 의 RULE 칸 template 종류 — SQL aggregate (Row N:1) + DuckDB UDF (scalar). */
type AggregateTemplateKind =
  | 'count_star' | 'sum' | 'avg' | 'min' | 'max' | 'cond_sum'
  // UDF (scalar functions — backend UdfRegistry 의 12 UDFs)
  | 'apply_scale' | 'unpack_zone_decimal' | 'unpack_comp' | 'unpack_comp_float'
  | 'unpack_signed_separate' | 'unpack_overpunch'
  | 'convert_era' | 'assign_seq' | 'validate_bizno'
  | 'mask_phone' | 'hash_sha256' | 'normalize_corp';

/**
 * RULE 칸 template SQL boilerplate 생성. alias / column 자동 인식 — 없으면 marker {col}.
 * SQL aggregate (Row N:1) + UDF (scalar). 사용자 수정 부분은 {...} 마커.
 */
function generateAggregateTemplate(kind: AggregateTemplateKind, sourceAlias: string, sourceCol?: string): string {
  const a = sourceAlias || 't';
  const col = sourceCol || '{col}';
  const ref = `${a}.${col}`;
  switch (kind) {
    case 'count_star': return 'COUNT(*)';
    case 'sum':        return `SUM(CAST(${ref} AS DECIMAL(20,2)))`;
    case 'avg':        return `AVG(CAST(${ref} AS DECIMAL(20,2)))`;
    case 'min':        return `MIN(${ref})`;
    case 'max':        return `MAX(${ref})`;
    case 'cond_sum':   return `SUM(CASE WHEN ${a}.{cond_col} = '{cond_val}' THEN CAST(${ref} AS DECIMAL(20,2)) ELSE 0 END)`;
    // UDF — backend UdfRegistry 시그니처 기반
    case 'apply_scale':            return `apply_scale(${ref}, {scale})`;
    case 'unpack_zone_decimal':    return `unpack_zone_decimal(${ref}, {scale})`;
    case 'unpack_comp':            return `unpack_comp(${ref}, {scale})`;
    case 'unpack_comp_float':      return `unpack_comp_float(${ref})`;
    case 'unpack_signed_separate': return `unpack_signed_separate(${ref}, {scale})`;
    case 'unpack_overpunch':       return `unpack_overpunch(${ref}, {scale})`;
    case 'convert_era':            return `convert_era(${ref})`;
    case 'assign_seq':             return `assign_seq()`;
    case 'validate_bizno':         return `validate_bizno(${ref})`;
    case 'mask_phone':             return `mask_phone(${ref})`;
    case 'hash_sha256':            return `hash_sha256(${ref})`;
    case 'normalize_corp':         return `normalize_corp(${ref})`;
  }
}

/** EXPAND template kind — dropdown 의 선택 항목. null = Clear. */
type ExpandTemplateKind = 'wide_to_long' | 'array_unnest';

/**
 * binding 의 첫 source alias 를 받아 expand_expr 의 boilerplate SQL 을 생성.
 * 사용자가 dropdown 에서 template 선택 시 호출. -- TODO: 주석으로 수정 위치 안내.
 */
function generateExpandTemplate(kind: ExpandTemplateKind, sourceAlias: string): string {
  const a = sourceAlias || 't';
  // 사용자 수정 부분은 {...} 마커로 표시 — input 안에서 부분 색/이탤릭은 native 로 안 되므로
  // 시각적 구분은 마커 syntax 로. 사용자가 {...} 모두 교체하지 않으면 SQL invalid 라
  // Trial 에서 즉시 피드백.
  if (kind === 'wide_to_long') {
    return `CROSS JOIN LATERAL (VALUES
  ('{label1}', ${a}.{COLUMN_A}),
  ('{label2}', ${a}.{COLUMN_B})
) AS {alias}({label_col}, {value_col})`;
  }
  // array_unnest
  return `, UNNEST([{'A','B','C'}], [${a}.{VAL_A}, ${a}.{VAL_B}, ${a}.{VAL_C}]) AS {alias}({code_col}, {val_col})`;
}

function parseExpandAliases(expr: string | undefined | null): { alias: string; columns: string[] }[] {
  if (!expr) return [];
  const out: { alias: string; columns: string[] }[] = [];
  const re = /\bAS\s+(\w+)\s*\(\s*([^)]+)\s*\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expr)) !== null) {
    const cols = m[2].split(',').map((c) => c.trim()).filter(Boolean);
    if (cols.length > 0) out.push({ alias: m[1], columns: cols });
  }
  return out;
}

/**
 * EXPAND template dropdown — binding 패널의 EXPAND label 우측에 표시.
 * 사용자가 항목 선택 → onPick callback. kind=null 은 Clear (EXPAND 칸 비우기).
 */
function ExpandTemplateMenu({ onPick, disabled }: {
  onPick: (kind: ExpandTemplateKind | null) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDocClick);
    return () => window.removeEventListener('mousedown', onDocClick);
  }, [open]);
  const pick = (kind: ExpandTemplateKind | null) => {
    onPick(kind);
    setOpen(false);
  };
  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        style={{
          background: 'transparent',
          border: '1px solid var(--border)',
          padding: '2px 8px',
          fontSize: 10.5,
          fontFamily: 'var(--mono)',
          color: 'var(--text-2)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          borderRadius: 2,
        }}
      >
        {t('mapping.binding.expandTemplate.button')}
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 2,
            background: 'var(--panel)',
            border: '1px solid var(--border)',
            borderRadius: 2,
            boxShadow: '0 2px 6px rgba(0,0,0,0.08)',
            zIndex: 100,
            minWidth: 200,
            padding: '4px 0',
          }}
        >
          <button
            type="button"
            onClick={() => pick('wide_to_long')}
            style={menuItemStyle}
          >
            {t('mapping.binding.expandTemplate.wideToLong')}
          </button>
          <button
            type="button"
            onClick={() => pick('array_unnest')}
            style={menuItemStyle}
          >
            {t('mapping.binding.expandTemplate.arrayUnnest')}
          </button>
          <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />
          <button
            type="button"
            onClick={() => pick(null)}
            style={{ ...menuItemStyle, color: 'var(--text-3)' }}
          >
            {t('mapping.binding.expandTemplate.clear')}
          </button>
        </div>
      )}
    </div>
  );
}

const menuItemStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  background: 'transparent',
  border: 'none',
  padding: '6px 12px',
  fontSize: 11,
  fontFamily: 'var(--mono)',
  color: 'var(--text)',
  cursor: 'pointer',
};

/**
 * Row N:1 aggregate template dropdown — Inspector 의 RULE 입력 칸 위에 표시.
 * COUNT / SUM / AVG / MIN / MAX / SUM with CASE. kind=null 은 Clear.
 */
function AggregateTemplateMenu({ onPick, disabled }: {
  onPick: (kind: AggregateTemplateKind | null) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [category, setCategory] = useState<'all' | 'sql' | 'udf'>('all');
  const wrapRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDocClick);
    return () => window.removeEventListener('mousedown', onDocClick);
  }, [open]);
  useEffect(() => {
    if (open) { setFilter(''); setCategory('all'); setTimeout(() => searchRef.current?.focus(), 0); }
  }, [open]);
  const pick = (kind: AggregateTemplateKind | null) => {
    onPick(kind);
    setOpen(false);
  };
  // 항목 정의 (section + label). filter 와 매칭 시만 표시.
  type Item = { kind: AggregateTemplateKind; label: string };
  const aggregateItems: Item[] = [
    { kind: 'count_star', label: t('mapping.inspector.aggregate.count') },
    { kind: 'sum',        label: t('mapping.inspector.aggregate.sum') },
    { kind: 'avg',        label: t('mapping.inspector.aggregate.avg') },
    { kind: 'min',        label: t('mapping.inspector.aggregate.min') },
    { kind: 'max',        label: t('mapping.inspector.aggregate.max') },
    { kind: 'cond_sum',   label: t('mapping.inspector.aggregate.condSum') },
  ];
  const udfItems: Item[] = [
    { kind: 'apply_scale',            label: t('mapping.inspector.aggregate.applyScale') },
    { kind: 'unpack_zone_decimal',    label: t('mapping.inspector.aggregate.unpackZoneDecimal') },
    { kind: 'unpack_comp',            label: t('mapping.inspector.aggregate.unpackComp') },
    { kind: 'unpack_comp_float',      label: t('mapping.inspector.aggregate.unpackCompFloat') },
    { kind: 'unpack_signed_separate', label: t('mapping.inspector.aggregate.unpackSignedSeparate') },
    { kind: 'unpack_overpunch',       label: t('mapping.inspector.aggregate.unpackOverpunch') },
    { kind: 'convert_era',            label: t('mapping.inspector.aggregate.convertEra') },
    { kind: 'assign_seq',             label: t('mapping.inspector.aggregate.assignSeq') },
    { kind: 'validate_bizno',         label: t('mapping.inspector.aggregate.validateBizno') },
    { kind: 'mask_phone',             label: t('mapping.inspector.aggregate.maskPhone') },
    { kind: 'hash_sha256',            label: t('mapping.inspector.aggregate.hashSha256') },
    { kind: 'normalize_corp',         label: t('mapping.inspector.aggregate.normalizeCorp') },
  ];
  const lo = filter.toLowerCase().trim();
  const matches = (item: Item) => !lo || item.label.toLowerCase().includes(lo) || item.kind.toLowerCase().includes(lo);
  const aggFiltered = category === 'udf' ? [] : aggregateItems.filter(matches);
  const udfFiltered = category === 'sql' ? [] : udfItems.filter(matches);
  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        style={{
          background: 'transparent',
          border: '1px solid var(--border)',
          padding: '2px 8px',
          fontSize: 10.5,
          fontFamily: 'var(--mono)',
          color: 'var(--text-2)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          borderRadius: 2,
        }}
      >
        {t('mapping.inspector.aggregate.button')}
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 2,
            background: 'var(--panel)',
            border: '1px solid var(--border)',
            borderRadius: 2,
            boxShadow: '0 2px 6px rgba(0,0,0,0.08)',
            zIndex: 100,
            minWidth: 260,
            maxHeight: 360,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          {/* 검색 input + 카테고리 chip. esc 시 닫음. */}
          <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <input
              ref={searchRef}
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}
              placeholder="Filter (e.g. sum, unpack, mask)"
              style={{
                width: '100%',
                fontSize: 11,
                fontFamily: 'var(--mono)',
                padding: '4px 6px',
                border: '1px solid var(--border)',
                borderRadius: 2,
                background: 'var(--bg)',
                color: 'var(--text)',
                outline: 'none',
              }}
            />
            <div style={{ display: 'flex', gap: 4 }}>
              {(['all', 'sql', 'udf'] as const).map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCategory(c)}
                  style={{
                    flex: 1,
                    fontSize: 10,
                    padding: '3px 6px',
                    border: `1px solid ${category === c ? 'var(--navy)' : 'var(--border)'}`,
                    background: category === c ? 'var(--navy-50)' : 'transparent',
                    color: category === c ? 'var(--navy)' : 'var(--text-2)',
                    borderRadius: 10,
                    cursor: 'pointer',
                    fontWeight: category === c ? 600 : 400,
                  }}
                >
                  {c === 'all' ? 'All' : c === 'sql' ? 'SQL' : 'UDF'}
                </button>
              ))}
            </div>
          </div>
          <div style={{ overflowY: 'auto', flex: 1, padding: '4px 0' }}>
            {aggFiltered.length > 0 && (
              <>
                <div style={menuSectionHeader}>SQL Aggregate</div>
                {aggFiltered.map((it) => (
                  <button key={it.kind} type="button" onClick={() => pick(it.kind)} style={menuItemStyle}>
                    {it.label}
                  </button>
                ))}
              </>
            )}
            {udfFiltered.length > 0 && (
              <>
                {aggFiltered.length > 0 && <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />}
                <div style={menuSectionHeader}>DuckDB UDF</div>
                {udfFiltered.map((it) => (
                  <button key={it.kind} type="button" onClick={() => pick(it.kind)} style={menuItemStyle}>
                    {it.label}
                  </button>
                ))}
              </>
            )}
            {aggFiltered.length === 0 && udfFiltered.length === 0 && (
              <div style={{ padding: '8px 12px', fontSize: 11, color: 'var(--text-3)', textAlign: 'center' }}>
                no match
              </div>
            )}
          </div>
          <div style={{ height: 1, background: 'var(--border)' }} />
          <button type="button" onClick={() => pick(null)} style={{ ...menuItemStyle, color: 'var(--text-3)' }}>
            {t('mapping.inspector.aggregate.clear')}
          </button>
        </div>
      )}
    </div>
  );
}

const menuSectionHeader: React.CSSProperties = {
  padding: '4px 12px 2px',
  fontSize: 9.5,
  textTransform: 'uppercase',
  letterSpacing: 0.6,
  color: 'var(--text-3)',
  fontWeight: 600,
};

function resolveSrcType(s: string, sources: TobeTable['sources'], expandExpr?: string): string {
  if (!s) return '—';
  const di = s.indexOf('.');
  if (di < 0) {
    // No alias prefix — search every bound source table for the first matching column.
    for (const src of sources) {
      const col = lookupAsisCols(src.table).find((c) => c.name === s);
      if (col) return col.type;
    }
    return '—';
  }
  const alias = s.slice(0, di);
  const col = s.slice(di + 1);
  const entry = sources.find((e) => e.alias === alias);
  if (entry) {
    return lookupAsisCols(entry.table).find((c) => c.name === col)?.type ?? '—';
  }
  // expand_expr 의 AS u(col1, col2) 같은 펼침 alias 면 type = VARCHAR fallback
  // (expand 의 값은 SQL fragment 라 정확한 type 추론 불가; all_varchar input 의 일관 fallback).
  if (expandExpr) {
    const exp = parseExpandAliases(expandExpr).find((e) => e.alias === alias);
    if (exp && exp.columns.includes(col)) return 'VARCHAR';
  }
  return '—';
}

function validateRule(code: string): string | null {
  const trimmed = code.trim();
  if (!trimmed) return 'Expression cannot be empty.';

  // Must contain at least one letter
  if (!/[A-Za-z]/.test(trimmed)) return 'Expression must contain at least one SQL identifier or keyword.';

  // Balanced parentheses
  let depth = 0;
  for (const ch of trimmed) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (depth < 0) return 'Unbalanced parentheses — unexpected ).';
  }
  if (depth !== 0) return `Unbalanced parentheses — ${depth} unclosed (.`;

  // At depth 0: more than 3 consecutive word-tokens without any operator/paren/comma
  // between them is structurally invalid SQL (e.g. "FOO BAR BAZ QUZZ").
  // Strip -- comments and string literals first to avoid false positives.
  const noStr = trimmed
    .replace(/--[^\n]*/g, '')       // strip line comments
    .replace(/'[^']*'/g, "''");     // strip string literals
  let d = 0, wordRun = 0, inWord = false;
  for (let i = 0; i <= noStr.length; i++) {
    const c = i < noStr.length ? noStr[i] : ' ';
    if      (c === '(') { d++; wordRun = 0; inWord = false; }
    else if (c === ')') { d--; wordRun = 0; inWord = false; }
    else if (d === 0) {
      const isW = /[A-Za-z0-9_]/.test(c);
      if (isW && !inWord) { wordRun++; inWord = true; }
      else if (!isW) { if (!/\s/.test(c)) wordRun = 0; inWord = false; }
    }
    if (wordRun > 3) return 'Invalid SQL — too many consecutive identifiers with no operators or function calls.';
  }

  return null;
}

// ── Syntax highlighters + editor ────────────────────────────

const _e    = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const _kw   = (s: string) => `<span style="color:#e8b86f">${_e(s)}</span>`;
const _func = (s: string) => `<span style="color:#dcdcaa">${_e(s)}</span>`;
const _udf  = (s: string) => `<span style="color:#c8a3ff">${_e(s)}</span>`;
const _str  = (s: string) => `<span style="color:#9fd9b3">${_e(s)}</span>`;
const _cmt  = (s: string) => `<span style="color:#7a8aa6">${_e(s)}</span>`;
const _num  = (s: string) => `<span style="color:#79c0ff">${_e(s)}</span>`;
const _def  = (s: string) => `<span style="color:#cad7e8">${_e(s)}</span>`;
/** template placeholder {...} — 사용자가 채워야 할 marker. 노란 50% alpha 배경 + 흰 글자. */
const _ph   = (s: string) => `<span style="background:rgba(250,204,21,0.5);color:#ffffff;padding:0 3px;border-radius:2px">${_e(s)}</span>`;

// 예약어 / 절 / 타입 — 주황 (#e8b86f) 으로 강조.
const SQL_KW = new Set(['SELECT','FROM','WHERE','AND','OR','NOT','IN','IS','NULL','AS','JOIN','LEFT','RIGHT','INNER','OUTER','FULL','ON','DROP','DEFAULT','UNION','ALL','DISTINCT','CASE','WHEN','THEN','ELSE','END','TRUE','FALSE','WITH','INSERT','UPDATE','DELETE','LIKE','BETWEEN','EXISTS','USING','INTO','RETURNS','ORDER','GROUP','BY','HAVING','LIMIT','OFFSET','NUMERIC','INTEGER','VARCHAR','CHAR','DATE','TIMESTAMP','BOOLEAN','UUID','TEXT','JSONB','INT','BIGINT','FLOAT','DOUBLE']);

// 함수 — VS Code 함수 색 (#dcdcaa, 옅은 yellow) 으로 키워드와 구분.
// 시그니처 맵: 함수명 → 시그니처 문자열. 자동완성 hint 와 삽입 동작에 사용.
//   '': 괄호 없는 함수 (CURRENT_DATE 등) — 그대로 삽입
//   '()': 인자 없는 함수 (NOW 등) — '()' 까지 삽입, 커서는 ')' 뒤
//   '(...)': 인자 있는 함수 — '(' 까지 삽입, 커서는 괄호 안쪽
const SQL_FUNC_SIGS: Record<string, string> = {
  CAST: '(expr AS type)', TRY_CAST: '(expr AS type)',
  TO_DATE: '(text, format)', TO_TIMESTAMP: '(text, format)',
  STRPTIME: '(text, format)', STRFTIME: '(date, format)',
  MAKE_DATE: '(year, month, day)',
  MAKE_TIMESTAMP: '(year, month, day, hour, min, sec)',
  DATE_TRUNC: '(unit, date)', DATE_PART: '(unit, date)',
  AGE: '(timestamp1, timestamp2)', EXTRACT: '(field FROM source)',
  NOW: '()', CURRENT_DATE: '', CURRENT_TIMESTAMP: '',
  COALESCE: '(expr1, expr2, ...)', NULLIF: '(expr1, expr2)',
  GREATEST: '(expr1, expr2, ...)', LEAST: '(expr1, expr2, ...)',
  TRIM: '(text)', LTRIM: '(text)', RTRIM: '(text)',
  UPPER: '(text)', LOWER: '(text)', INITCAP: '(text)',
  SUBSTR: '(text, start, length)', SUBSTRING: '(text, start, length)',
  REPLACE: '(text, from, to)', LENGTH: '(text)',
  CHAR_LENGTH: '(text)', OCTET_LENGTH: '(text)',
  POSITION: '(substring IN text)',
  CONCAT: '(expr1, expr2, ...)', CONCAT_WS: '(sep, expr1, expr2, ...)',
  SPLIT_PART: '(text, sep, n)', LPAD: '(text, length, pad)', RPAD: '(text, length, pad)',
  REGEXP_REPLACE: '(text, pattern, replacement)', REGEXP_MATCHES: '(text, pattern)',
  ROUND: '(number, digits)', FLOOR: '(number)', CEIL: '(number)', CEILING: '(number)',
  ABS: '(number)', MOD: '(number, divisor)', POWER: '(base, exponent)', SQRT: '(number)',
  SUM: '(expr)', AVG: '(expr)', MIN: '(expr)', MAX: '(expr)', COUNT: '(expr)',
  ICONV: '(text, from_encoding, to_encoding)', UNPACK_COMP3: '(text)',
};
const SQL_FUNCS = new Set(Object.keys(SQL_FUNC_SIGS));

// 도구 내장 UDF — DuckDB connection 에 register 되는 Java 번들 함수.
// 보라 (#c8a3ff, _udf) 로 표시해 PG 표준 빌트인과 시각적으로 구분.
// 백엔드: backend/.../common/duckdb/udf/{UdfRegistry, *Udf}.java
const UDF_FUNC_SIGS: Record<string, string> = {
  // 숫자 / 소수점
  APPLY_SCALE:            '(raw_hex, scale)',
  UNPACK_ZONE_DECIMAL:    '(zone_hex)',
  UNPACK_COMP:            '(raw_hex, scale)',
  UNPACK_COMP_FLOAT:      '(raw_hex)',
  UNPACK_SIGNED_SEPARATE: '(raw)',
  UNPACK_OVERPUNCH:       '(raw)',
  // 날짜 / 시간
  CONVERT_ERA:            '(era_text)',
  // 채번
  ASSIGN_SEQ:             '(partition_key)',
  // 식별자 검증
  VALIDATE_BIZNO:         '(bizno)',
  // 마스킹 / 해시
  MASK_PHONE:             '(phone)',
  HASH_SHA256:            '(input)',
  // 문자열 정규화
  NORMALIZE_CORP:         '(corp_name)',
};
const UDF_FUNCS = new Set(Object.keys(UDF_FUNC_SIGS));

/**
 * SQL 키워드/함수만 대문자화. 문자열 리터럴('...') 과 식별자(컬럼/별칭) 는 원본 그대로.
 * Transform 입력에서 사용자가 친 컬럼명/리터럴이 자동으로 대문자화되면 DB 데이터까지 망가지기 때문.
 */
function upperSqlKeywords(s: string): string {
  return s.replace(/'(?:[^']|'')*'|[A-Za-z_][A-Za-z_0-9]*/g, (m) => {
    if (m.startsWith("'")) return m;
    const u = m.toUpperCase();
    return (SQL_KW.has(u) || SQL_FUNCS.has(u) || UDF_FUNCS.has(u)) ? u : m;
  });
}

function highlightSql(raw: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === '{') {
      // {word} placeholder — template marker. {scale}, {cond_col} 등. 일반 코드 block `{` 와
      // 구분 위해 [A-Za-z_]\w* 패턴만. 폐쇄 brace 까지.
      const m = raw.slice(i).match(/^\{[A-Za-z_][\w]*\}/);
      if (m) { out.push(_ph(m[0])); i += m[0].length; continue; }
    }
    if (raw[i] === '-' && raw[i + 1] === '-') {
      const end = raw.indexOf('\n', i);
      const s = end < 0 ? raw.slice(i) : raw.slice(i, end + 1);
      out.push(_cmt(s)); i += s.length;
    } else if (raw[i] === "'") {
      let j = i + 1;
      while (j < raw.length && raw[j] !== "'") j++;
      out.push(_str(raw.slice(i, j + 1))); i = j + 1;
    } else if (/[A-Za-z_]/.test(raw[i])) {
      let j = i;
      while (j < raw.length && /\w/.test(raw[j])) j++;
      const w = raw.slice(i, j);
      const u = w.toUpperCase();
      if (SQL_KW.has(u)) out.push(_kw(w));
      else if (SQL_FUNCS.has(u)) out.push(_func(w));
      else if (UDF_FUNCS.has(u)) out.push(_udf(w));
      else out.push(_def(w));
      i = j;
    } else if (/[0-9]/.test(raw[i])) {
      let j = i;
      while (j < raw.length && /[0-9.]/.test(raw[j])) j++;
      out.push(_num(raw.slice(i, j))); i = j;
    } else {
      out.push(_def(raw[i])); i++;
    }
  }
  return out.join('');
}

const JAVA_KW = new Set(['abstract','assert','boolean','break','byte','case','catch','char','class','continue','default','do','double','else','enum','extends','final','finally','float','for','if','implements','import','instanceof','int','interface','long','native','new','null','package','private','protected','public','return','short','static','super','switch','synchronized','this','throw','throws','transient','try','void','volatile','while','String','Object','Integer','Long','Boolean','Double','Float','List','Map','Set','true','false']);

function highlightJava(raw: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === '{') {
      const m = raw.slice(i).match(/^\{[A-Za-z_][\w]*\}/);
      if (m) { out.push(_ph(m[0])); i += m[0].length; continue; }
    }
    if (raw[i] === '/' && raw[i + 1] === '*') {
      const end = raw.indexOf('*/', i + 2);
      const s = end < 0 ? raw.slice(i) : raw.slice(i, end + 2);
      out.push(_cmt(s)); i += s.length;
    } else if (raw[i] === '/' && raw[i + 1] === '/') {
      const end = raw.indexOf('\n', i);
      const s = end < 0 ? raw.slice(i) : raw.slice(i, end + 1);
      out.push(_cmt(s)); i += s.length;
    } else if (raw[i] === '"') {
      let j = i + 1;
      while (j < raw.length && raw[j] !== '"') { if (raw[j] === '\\') j++; j++; }
      out.push(_str(raw.slice(i, j + 1))); i = j + 1;
    } else if (/[A-Za-z_$]/.test(raw[i])) {
      let j = i;
      while (j < raw.length && /[\w$]/.test(raw[j])) j++;
      const w = raw.slice(i, j);
      out.push(JAVA_KW.has(w) ? _kw(w) : _def(w)); i = j;
    } else if (/[0-9]/.test(raw[i])) {
      let j = i;
      while (j < raw.length && /[0-9._xXa-fA-FbBlL]/.test(raw[j])) j++;
      out.push(_num(raw.slice(i, j))); i = j;
    } else {
      out.push(_def(raw[i])); i++;
    }
  }
  return out.join('');
}

function HighlightEditor({
  value, onChange, language, placeholder, minHeight, hasError, completions, onCancel,
}: {
  value: string;
  onChange: (v: string) => void;
  language: 'sql' | 'java';
  placeholder?: string;
  minHeight?: number;
  hasError?: boolean;
  completions?: string[];
  /** Esc 시 호출 (autocomplete dropdown 떠있지 않을 때만). Cancel 버튼과 동등. */
  onCancel?: () => void;
}) {
  const preRef = useRef<HTMLPreElement>(null);
  const taRef  = useRef<HTMLTextAreaElement>(null);
  const savedCursor = useRef<{ start: number; end: number } | null>(null);
  const [isFocused, setIsFocused] = useState(false);
  const [acItems, setAcItems] = useState<string[]>([]);
  const [acIdx, setAcIdx] = useState(0);
  // Ctrl+Space 로 강제 popup 트리거 — 빈 word 일 때도 전체 completions 표시.
  const [force, setForce] = useState(false);

  useLayoutEffect(() => {
    if (savedCursor.current !== null && taRef.current) {
      taRef.current.setSelectionRange(savedCursor.current.start, savedCursor.current.end);
      savedCursor.current = null;
    }
  }, [value]);

  // Refresh autocomplete after each value/focus change (runs after cursor is restored).
  // acIdx reset 은 hits 가 *실제로 변경됐을 때만* — 사용자가 ArrowDown 으로 선택한 후 같은
  // word 의 effect 재실행 (caret 이동, focus 토글 등) 으로 인해 highlight 가 첫 항목으로
  // 되돌아가지 않도록.
  useEffect(() => {
    if (!isFocused || !completions?.length || !taRef.current) {
      setAcItems((prev) => { if (prev.length) { setAcIdx(0); return []; } return prev; });
      return;
    }
    const pos = taRef.current.selectionStart;
    let s = pos;
    while (s > 0 && /[\w.]/.test(value[s - 1])) s--;
    const word = value.slice(s, pos);
    if (!force && word.length < 1) {
      setAcItems((prev) => { if (prev.length) { setAcIdx(0); return []; } return prev; });
      return;
    }
    const lo = word.toLowerCase();
    const hits = force && word.length === 0
      ? completions.slice(0, 10)
      : completions.filter((c) => c.toLowerCase().includes(lo) && c.toLowerCase() !== lo).slice(0, 10);
    setAcItems((prev) => {
      const same = prev.length === hits.length && prev.every((p, i) => p === hits[i]);
      if (same) return prev;
      setAcIdx(0);
      return hits;
    });
  }, [value, isFocused, force]); // eslint-disable-line react-hooks/exhaustive-deps

  const applyAc = (item: string) => {
    if (!taRef.current) return;
    const pos = taRef.current.selectionStart;
    let s = pos;
    while (s > 0 && /[\w.]/.test(value[s - 1])) s--;
    const before = value.slice(0, s);
    const after = value.slice(pos);

    // 함수면 시그니처에 맞춰 괄호 자동 삽입 + 커서 위치 조정.
    //   '' (괄호 없음)      → 그대로
    //   '()' (인자 없음)    → '()' 삽입, 커서는 ')' 뒤
    //   '(...)' (인자 있음) → '(' 삽입, 커서는 괄호 안쪽
    let inserted = item;
    let cursorOffset = item.length;
    const sig = SQL_FUNC_SIGS[item] ?? UDF_FUNC_SIGS[item];
    if (sig !== undefined) {
      if (sig === '()') {
        inserted = item + '()';
        cursorOffset = item.length + 2;
      } else if (sig !== '') {
        inserted = item + '(';
        cursorOffset = item.length + 1;
      }
    }

    savedCursor.current = { start: before.length + cursorOffset, end: before.length + cursorOffset };
    onChange(before + inserted + after);
    setAcItems([]);
    setForce(false);
    taRef.current.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Ctrl+Space — 강제 자동완성 popup 트리거.
    if ((e.ctrlKey || e.metaKey) && e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      setForce(true);
      return;
    }
    // Esc — dropdown 떠있으면 dropdown 만 닫음, 아니면 onCancel 호출 (Cancel 버튼 동등).
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (acItems.length) {
        setForce(false);
        setAcItems([]);
      } else if (onCancel) {
        e.preventDefault();
        onCancel();
      }
      return;
    }
    if (!acItems.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setAcIdx((i) => Math.min(i + 1, acItems.length - 1)); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setAcIdx((i) => Math.max(i - 1, 0)); return; }
    if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); applyAc(acItems[acIdx]); return; }
  };

  const highlighted = useMemo(() => {
    if (!value) return placeholder ? `<span style="color:#4a5a6a">${_e(placeholder)}</span>` : '';
    return language === 'sql' ? highlightSql(value) : highlightJava(value);
  }, [value, language, placeholder]);
  const syncScroll = () => {
    if (preRef.current && taRef.current) preRef.current.scrollTop = taRef.current.scrollTop;
  };
  const shared: React.CSSProperties = {
    fontFamily: 'var(--mono)', fontSize: 11.5, lineHeight: '1.5',
    padding: '10px', margin: 0,
    minHeight: minHeight ?? 72,
    boxSizing: 'border-box',
    whiteSpace: 'pre-wrap', wordBreak: 'break-all',
    width: '100%', border: 'none', borderRadius: 3, display: 'block',
  };
  return (
    <div style={{
      position: 'relative', borderRadius: 4,
      border: `1px solid ${hasError ? 'var(--red)' : 'var(--navy)'}`,
      background: '#0e1a2b',
    }}>
      <pre
        ref={preRef}
        aria-hidden
        style={{ ...shared, position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, color: '#cad7e8', pointerEvents: 'none', overflow: 'hidden' }}
        dangerouslySetInnerHTML={{ __html: highlighted + '\n' }}
      />
      <textarea
        ref={taRef}
        value={value}
        onChange={(e) => {
          savedCursor.current = { start: e.target.selectionStart, end: e.target.selectionEnd };
          onChange(e.target.value);
        }}
        onKeyDown={handleKeyDown}
        onFocus={() => setIsFocused(true)}
        onBlur={() => { setIsFocused(false); setAcItems([]); setForce(false); }}
        onScroll={syncScroll}
        spellCheck={false}
        style={{ ...shared, position: 'relative', zIndex: 1, color: 'transparent', caretColor: '#cad7e8', background: 'transparent', resize: 'vertical', outline: 'none', overflow: 'auto' }}
      />
      {acItems.length > 0 && (
        <div style={styles.acDropdown}>
          {acItems.map((item, i) => {
            const sig = SQL_FUNC_SIGS[item] ?? UDF_FUNC_SIGS[item];
            return (
              <div
                key={item}
                onMouseDown={(e) => { e.preventDefault(); applyAc(item); }}
                style={{
                  ...styles.acItem,
                  background: i === acIdx ? 'var(--navy-50)' : 'transparent',
                  color: i === acIdx ? 'var(--navy)' : 'var(--text-2)',
                  display: 'flex', alignItems: 'baseline', gap: 6,
                }}
              >
                <span>{item}</span>
                {sig !== undefined && sig !== '' && (
                  <span style={{ fontSize: 10, color: 'var(--text-4)' }}>{sig}</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Inspector ────────────────────────────────────────────────

function Inspector({ active, composition, sources, expandExpr, rowEdit, onSave, onClose }: {
  active: MappingRow | undefined;
  composition: TobeTable['compositionKind'];
  sources: TobeTable['sources'];
  expandExpr?: string;
  rowEdit?: RowEdit;
  onSave: (edit: RowEdit) => void;
  onClose: () => void;
}) {
  const t = useT();
  const readOnly = useActiveProjectReadOnly();
  const [editingRule, setEditingRule] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [savedRule, setSavedRule] = useState<string | null>(null);
  const [ruleError, setRuleError] = useState<string | null>(null);
  const [editSrc, setEditSrc] = useState<string[]>([]);
  const [editSrcType, setEditSrcType] = useState<string[]>([]);
  const [savedSrc, setSavedSrc] = useState<string[] | null>(null);
  const [savedSrcType, setSavedSrcType] = useState<string[] | null>(null);
  const [editStrategy, setEditStrategy] = useState<'expression' | 'null' | 'default'>('expression');
  const [savedStrategy, setSavedStrategy] = useState<'expression' | 'null' | 'default' | null>(null);
  const [savedDefault, setSavedDefault] = useState<string | null>(null);
  const [editDefault, setEditDefault] = useState('');
  const [userFnOpen, setUserFnOpen] = useState(false);
  const [javaCode, setJavaCode] = useState('');
  const [notesOpen, setNotesOpen] = useState(false);
  useEffect(() => { setNotesOpen(false); }, [active?.tgt]);

  // Esc — 편집 중이면 cancel, 아니면 inspector 닫기. textarea/input focus 일 때는
  // 그쪽 (HighlightEditor / AutocompleteInput) 이 우선 처리 — focus 체크로 양보.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable)) return;
      if (editingRule) {
        setEditingRule(false);
        setRuleError(null);
      } else {
        onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [editingRule, onClose]);

  useEffect(() => {
    // 같은 컬럼이면 effective rule 갱신으로 active 객체 reference 가 새로 만들어져도
    // 편집 모드를 종료하지 않는다 — active.tgt 만 dep 로 사용.
    setEditingRule(false); setRuleError(null);
    const re = rowEdit;
    setSavedRule(re?.savedRule ?? null);
    setSavedStrategy(re?.savedStrategy ?? null);
    setSavedDefault(re?.savedDefault ?? null);
    const src = re?.savedSrc ?? null;
    setSavedSrc(src);
    setSavedSrcType(src ? src.map((s) => resolveSrcType(s, sources)) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.tgt]);
  /* hooks 는 반드시 early return 위에 — active 가 null 로 바뀌는 렌더에서 hook 개수가
     줄어 React #300 (Rendered fewer hooks) 발생 (2026-06-03 fix). */
  const prevAutoCastRef = useRef('');
  if (!active) return null;
  const initSrc: string[] = active.src === '—' ? [] : [active.sourceAlias ? `${active.sourceAlias}.${active.src}` : active.src];
  const resolveType = (s: string) => resolveSrcType(s, sources);
  // binding sources 의 alias + expand_expr 의 AS u(...) 의 alias 모두 valid 로 인정.
  // expand alias 가 invalid 로 잡히면 row editor 의 cleanedSrc filter 에서 제거되어 사용자가
  // 선택한 u.channel 같은 source 가 사라짐.
  const validAliases = new Set([
    ...sources.map((s) => s.alias),
    ...parseExpandAliases(expandExpr).map((e) => e.alias),
  ]);

  // 슬롯 i 의 source 값을 새 값으로 바꾸고, 첫 번째 슬롯이면 CAST 자동 입력 갱신.
  // editValue 가 비어있거나 이전 자동 CAST 와 같을 때만 덮어써서 사용자 수동 입력은 보존.
  const computeAutoCast = (srcs: string | string[] | undefined): string => {
    if (!active) return '';
    // 단일 source 면 그대로, multi-source 면 || (concat) 로 합침.
    // 사용자가 row editor 에서 의도에 맞게 수정 (MAKE_DATE / CONCAT with delimiter 등).
    const arr = Array.isArray(srcs) ? srcs : (srcs ? [srcs] : []);
    const filtered = arr.filter((s) => s && s.trim());
    if (!filtered.length) return '';
    const expr = filtered.length === 1 ? filtered[0] : filtered.join(' || ');
    if (!active.tgtType || active.tgtType === '—') return expr;
    // ExtractStage 의 all_varchar=true 로 실데이터 input 이 모두 VARCHAR. asis_type 무시 —
    // tgtType 만 보고 결정 (backend MappingImportService 의 자동 생성 logic 과 일관).
    //   tgtType 이 string 카테고리 → expr 그대로 (VARCHAR → VARCHAR no-op)
    //   그 외 → CAST 박음 (VARCHAR → tgtType 변환 필요)
    const tt = active.tgtType.toUpperCase().trim();
    const isString = tt.startsWith('VARCHAR') || tt.startsWith('CHAR')
      || tt === 'TEXT' || tt === 'CLOB' || tt.startsWith('NVARCHAR');
    return isString ? expr : `CAST(${expr} AS ${active.tgtType})`;
  };

  const handleEdit = () => {
    if (readOnly) return;
    const inferredStrategy = savedStrategy ?? (active.rule === 'null' ? 'null' : active.rule === 'default' ? 'default' : 'expression');
    setEditStrategy(inferredStrategy);
    // default 값은 사용자가 저장한 값 우선, 없으면 매핑 정의서/DDL 의 default 를 초기값으로.
    setEditDefault(savedDefault ?? active.ddlDefault ?? '');
    // Filter out stale alias references no longer present in current binding
    const rawSrc = savedSrc ?? initSrc;
    const cleanedSrc = rawSrc.filter((s) => {
      if (!s) return true;
      const di = s.indexOf('.');
      const alias = di >= 0 ? s.slice(0, di) : '';
      return !alias || validAliases.has(alias);
    });
    const filledSrcs = cleanedSrc.filter((s) => s && s.trim() !== '');

    // 자동 CAST 생성: computeAutoCast 가 single / multi-source 모두 처리
    //   - source ≥ 2 → 모든 source 를 || 로 concat 후 tobe_type 으로 CAST. 사용자가 row editor
    //     에서 의도에 맞게 수정 (MAKE_DATE 같은 specific 함수로)
    //   - source 1 → 단일 src 로 CAST
    //   - source 0 → 빈 자동값
    let initialAutoCast: string;
    if (filledSrcs.length > 0) {
      initialAutoCast = computeAutoCast(filledSrcs);
    } else if (active.src !== '—') {
      const fallback = active.sourceAlias ? `${active.sourceAlias}.${active.src}` : active.src;
      initialAutoCast = computeAutoCast(fallback);
    } else {
      initialAutoCast = '';
    }
    prevAutoCastRef.current = initialAutoCast;
    setEditValue(savedRule ?? initialAutoCast);

    const slots = cleanedSrc.length > 0 ? cleanedSrc : [''];
    setEditSrc(slots);
    setEditSrcType(slots.map(resolveType));
    setEditingRule(true);
  };
  const handleSave = () => {
    const filledSrcs = editSrc.filter((s) => s && s.trim() !== '');
    const isUnassigned = filledSrcs.length === 0;
    // source 가 비어있으면 expression validation 우회 — unmapped 로 저장.
    if (editStrategy === 'expression' && !isUnassigned) {
      const err = validateRule(editValue);
      if (err) { setRuleError(err); return; }
    }
    setRuleError(null);
    setSavedStrategy(editStrategy);
    const ruleToSave = editStrategy === 'expression' && !isUnassigned ? editValue : null;
    setSavedRule(ruleToSave);
    const newSrc = filledSrcs.length > 0 ? filledSrcs : null;
    setSavedSrc(newSrc);
    setSavedSrcType(newSrc ? newSrc.map(resolveType) : null);
    const defaultToSave = editStrategy === 'default' ? (editDefault.trim() || null) : null;
    setSavedDefault(defaultToSave);
    onSave({
      savedRule: ruleToSave ?? undefined,
      savedSrc: newSrc ?? [],
      savedStrategy: editStrategy,
      savedDefault: defaultToSave ?? undefined,
    });
    setEditingRule(false);
  };
  const updateEditSrcAt = (i: number, val: string) => {
    const nextEditSrc = editSrc.map((x, j) => (j === i ? val : x));
    setEditSrc(nextEditSrc);
    setEditSrcType((prev) => prev.map((x, j) => (j === i ? resolveType(val) : x)));

    if (editStrategy !== 'expression') return;
    // 어느 슬롯 변경이든 자동 식을 다시 평가 (combine 추가/제거 시점 캐치).
    // 단, editValue 가 이전 자동값과 다르면 = 사용자가 손댄 식이므로 보존.
    const filledSrcs = nextEditSrc.filter((s) => s && s.trim() !== '');
    // single / multi-source 모두 computeAutoCast 가 처리 (multi 면 || concat 후 CAST)
    const newAutoCast = filledSrcs.length > 0 ? computeAutoCast(filledSrcs) : '';
    if (editValue === prevAutoCastRef.current) {
      setEditValue(newAutoCast);
    }
    prevAutoCastRef.current = newAutoCast;
    if (ruleError) setRuleError(null);
  };

  const displaySrcArr = (savedSrc ?? initSrc).filter((s) => s && s.trim() !== '');
  const displaySrcName = displaySrcArr.length === 0
    ? '(unassigned)'
    : displaySrcArr.join(' + ');  // alias.col 형태 그대로 (예: tr.TX_ID + em.EMP_NM)
  const handleClear = () => {
    setSavedSrc(null);
    setSavedSrcType(null);
    setSavedRule(null);
    setSavedStrategy(null);
    setEditingRule(false);
    setEditValue('');
    setRuleError(null);
    prevAutoCastRef.current = '';
    onSave({
      savedSrc: [],
      savedRule: undefined,
      savedStrategy: undefined,
    });
  };

  return (
    <aside style={styles.inspector}>
      <div style={styles.inspectorHeader}>
        <div style={styles.inspectorHeaderTopRow}>
          <span style={styles.inspectorEyebrow}>Mapping detail</span>
          <div style={{ flex: 1 }} />
          {editingRule && (
            <button
              type="button"
              onClick={handleClear}
              title={t('mapping.tooltip.resetColumn')}
              style={styles.inspectorHeaderIconBtn}
            ><Ic.refresh /></button>
          )}
          <button
            type="button"
            onClick={onClose}
            title={t('mapping.tooltip.closeDetail')}
            style={styles.inspectorHeaderClose}
          ><Ic.x /></button>
        </div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 600 }}>{active.tgt}</div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-3)', wordBreak: 'break-all', lineHeight: 1.4 }}>← {displaySrcName}</div>
      </div>

      <div style={styles.inspectorBody}>
      <div style={styles.inspectorMeta}>
        <MetaRow k="Source column">
          {editingRule ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '100%' }}>
              {editSrc.map((s, i) => (
                <div key={i} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <select
                    value={s}
                    onChange={(e) => updateEditSrcAt(i, e.target.value)}
                    style={{ ...styles.metaSelect, flex: 1 }}
                  >
                    <option value="">— unassigned —</option>
                    {sources.flatMap((src) =>
                      lookupAsisCols(src.table).map((c) => (
                        <option key={`${src.alias}.${c.name}`} value={`${src.alias}.${c.name}`}>
                          [{src.alias}] {c.name}  ({c.type})
                        </option>
                      ))
                    )}
                    {parseExpandAliases(expandExpr).flatMap((e) =>
                      e.columns.map((c) => (
                        <option key={`${e.alias}.${c}`} value={`${e.alias}.${c}`}>
                          [{e.alias}] {c}  (expand)
                        </option>
                      ))
                    )}
                  </select>
                  {editSrc.length > 1 && (
                    <button
                      onClick={() => {
                        setEditSrc((p) => p.filter((_, j) => j !== i));
                        setEditSrcType((p) => p.filter((_, j) => j !== i));
                      }}
                      style={styles.srcRemoveBtn}
                    >×</button>
                  )}
                </div>
              ))}
              <button
                onClick={() => { setEditSrc((p) => [...p, '']); setEditSrcType((p) => [...p, '—']); }}
                style={styles.srcAddBtn}
              ><Ic.plus /> Add column</button>
            </div>
          ) : displaySrcArr.length === 0
            ? <span style={{ color: 'var(--text-4)', fontStyle: 'italic' }}>unassigned</span>
            : <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {displaySrcArr.map((s, i) => (
                  <span key={i} style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{s}</span>
                ))}
              </div>
          }
        </MetaRow>
        <MetaRow k="Source type">
          {(() => {
            const types = (editingRule ? editSrcType : (savedSrcType ?? [active.srcType])).filter((t) => t && t !== '—');
            return types.length
              ? <TypeBadge>{types.join(', ')}</TypeBadge>
              : <span style={{ color: 'var(--text-4)' }}>—</span>;
          })()}
        </MetaRow>
        <MetaRow k="Target type">{active.tgtType === '—' ? <span style={{ color: 'var(--text-4)' }}>—</span> : <TypeBadge>{active.tgtType}</TypeBadge>}</MetaRow>
        <MetaRow k="Rule"><RuleTag rule={active.rule} /></MetaRow>
        <MetaRow k="Source table"><SourceAliasTag alias={active.sourceAlias} composition={composition} /></MetaRow>
        <MetaRow k="Primary key">{active.pk ? <StatusBadge tone="info">yes</StatusBadge> : <span style={{ color: 'var(--text-4)' }}>—</span>}</MetaRow>
        <MetaRow k="Not null">
          {active.tgtNullable === false
            ? <StatusBadge tone="warn">required</StatusBadge>
            : <span style={{ color: 'var(--text-4)' }}>nullable</span>}
        </MetaRow>
        <MetaRow k="Default">
          {active.ddlDefault
            ? <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--text-2)' }}>{active.ddlDefault}</span>
            : <span style={{ color: 'var(--text-4)' }}>—</span>}
        </MetaRow>
        <MetaRow k="Notes">
          {active.note ? (
            <button
              type="button"
              onClick={() => setNotesOpen((v) => !v)}
              title={notesOpen ? 'Collapse' : 'Expand'}
              style={{
                background: 'transparent',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                color: 'var(--navy)',
                lineHeight: 1,
                fontFamily: 'inherit',
              }}
            >
              <i
                className="fa-regular"
                style={{
                  fontSize: 13,
                  color: 'var(--navy)',
                  transform: notesOpen ? 'rotate(180deg)' : 'none',
                  transition: 'transform 0.15s',
                  display: 'inline-block',
                }}
              >&#xf150;</i>
            </button>
          ) : (
            <span style={{ color: 'var(--text-4)' }}>—</span>
          )}
        </MetaRow>
        {active.note && notesOpen && (
          <div style={{
            margin: '4px 0 8px',
            padding: '6px 8px',
            background: 'var(--panel-2)',
            border: '1px solid var(--border-strong)',
            borderRadius: 4,
            fontSize: 11.5,
            color: 'var(--text-2)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}>
            {active.note}
          </div>
        )}
      </div>

      <div style={styles.section}>
        <div style={styles.sectionLabel}>Rule</div>
        {editingRule ? (
          <>
            {(() => {
              const hasMappedSrc = editSrc.some((s) => s && s.trim() !== '');
              return (
                <div style={styles.strategyBtnGroup}>
                  {(['expression', 'null', 'default'] as const).map((s) => {
                    const blockedByMappedSrc = hasMappedSrc && (s === 'null' || s === 'default');
                    const blockedByNotNull = active.tgtNullable === false && s === 'null';
                    const disabled = blockedByMappedSrc || blockedByNotNull;
                    const reason = blockedByNotNull
                      ? 'NOT NULL 이 체크된 컬럼은 NULL 로 채울 수 없습니다.'
                      : blockedByMappedSrc
                        ? 'AS-IS 소스가 매핑된 컬럼에는 NULL/Default 를 사용할 수 없습니다. 먼저 Source field 를 비우세요.'
                        : undefined;
                    return (
                      <button
                        key={s}
                        disabled={disabled}
                        onClick={() => { if (disabled) return; setEditStrategy(s); setRuleError(null); }}
                        title={reason}
                        style={{
                          ...styles.strategyBtn,
                          ...(editStrategy === s ? styles.strategyBtnActive : {}),
                          ...(disabled ? { opacity: 0.4, cursor: 'not-allowed' } : {}),
                        }}
                      >
                        {s === 'expression' ? 'Expression' : s === 'null' ? 'NULL' : 'Default'}
                      </button>
                    );
                  })}
                </div>
              );
            })()}
            {editStrategy === 'expression' && (() => {
              // 자동완성 후보: 현재 매핑된 source 컬럼 + SQL 함수 라이브러리.
              // 키워드(SELECT/CASE 등)는 사용자가 거의 안 치니까 제외, 함수는 적극 추천.
              const localCompletions = (() => {
                const set = new Set<string>();
                editSrc.forEach((s) => {
                  if (!s) return;
                  set.add(s);
                  const di = s.indexOf('.');
                  if (di > 0) set.add(s.slice(di + 1));
                });
                SQL_FUNCS.forEach((fn) => set.add(fn));
                UDF_FUNCS.forEach((fn) => set.add(fn));
                return Array.from(set);
              })();
              return (
                <>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
                    <AggregateTemplateMenu
                      onPick={(kind) => {
                        if (kind === null) {
                          setEditValue('');
                          return;
                        }
                        // 첫 source 의 alias / column 자동 인식.
                        const firstSrc = editSrc.find((s) => s && s.trim());
                        const di = firstSrc?.indexOf('.') ?? -1;
                        const alias = di >= 0 ? firstSrc!.slice(0, di) : '';
                        const col = di >= 0 ? firstSrc!.slice(di + 1) : firstSrc || '';
                        setEditValue(generateAggregateTemplate(kind, alias, col));
                        if (ruleError) setRuleError(null);
                      }}
                      disabled={readOnly}
                    />
                  </div>
                  <HighlightEditor
                    value={editValue}
                    onChange={(v) => { setEditValue(upperSqlKeywords(v)); if (ruleError) setRuleError(null); }}
                    language="sql"
                    placeholder={transformPlain(active, t('mapping.inspector.combineHint'))}
                    hasError={!!ruleError}
                    completions={localCompletions}
                    minHeight={72}
                    onCancel={() => setEditingRule(false)}
                  />
                  {ruleError && <div style={styles.ruleErrorMsg}>{ruleError}</div>}
                </>
              );
            })()}
            {editStrategy === 'null' && (
              <div style={styles.codeBlock}>
                <span style={{ color: '#e8b86f' }}>NULL</span>
                <span style={{ color: '#7a8aa6' }}>{' '}-- 이 컬럼은 항상 NULL 로 출력됩니다</span>
              </div>
            )}
            {editStrategy === 'default' && (
              <HighlightEditor
                value={editDefault}
                onChange={setEditDefault}
                language="sql"
                placeholder={`${t('mapping.eg')}: 0  /  'N'  /  CURRENT_TIMESTAMP  ${t('mapping.placeholder.defaultEmptyNote')}`}
                minHeight={48}
                onCancel={() => setEditingRule(false)}
              />
            )}
          </>
        ) : (() => {
          const effectiveStrategy = savedStrategy ?? (active.rule === 'null' ? 'null' : active.rule === 'default' ? 'default' : 'expression');
          if (effectiveStrategy === 'null') {
            return (
              <div style={styles.codeBlock}>
                <span style={{ color: '#e8b86f' }}>NULL</span>
                <span style={{ color: '#7a8aa6' }}>::{active.tgtType}</span>
              </div>
            );
          }
          if (effectiveStrategy === 'default') {
            const dv = (savedDefault ?? active.ddlDefault ?? '').trim();
            if (!dv) {
              return (
                <div style={styles.codeBlock}>
                  <span style={{ color: '#e8b86f' }}>DEFAULT</span>
                  <span style={{ color: '#7a8aa6' }}>{' '}-- (no default set)</span>
                </div>
              );
            }
            return (
              <div style={styles.codeBlock}>
                <div>
                  <span style={{ color: '#9fd9b3' }}>{dv}</span>
                  <span style={{ color: '#7a8aa6' }}>{' '}<span style={{ color: '#e8b86f' }}>AS</span> {active.tgt}</span>
                </div>
              </div>
            );
          }
          return savedRule !== null ? (
            <div style={styles.codeBlock}>
              {savedRule.split('\n').map((line, i) => (
                <div key={i} dangerouslySetInnerHTML={{ __html: highlightSql(line) }} />
              ))}
            </div>
          ) : (
            <div style={styles.codeBlock}>
              {transformPreview(active, t('mapping.inspector.combineHint')).map((line, i) => (
                <div key={i} dangerouslySetInnerHTML={{ __html: line }} />
              ))}
            </div>
          );
        })()}
      </div>

      <div style={styles.section}>
        <div onClick={() => setUserFnOpen((o) => !o)} style={styles.sectionLabelToggle}>
          <span style={{ fontSize: 9, color: 'var(--text-4)' }}>{userFnOpen ? '▾' : '▸'}</span>
          User Function
        </div>
        {userFnOpen && (
          <HighlightEditor
            value={javaCode}
            onChange={setJavaCode}
            language="java"
            placeholder={'// Java function\npublic Object transform(Object value) {\n  return value;\n}'}
            minHeight={100}
          />
        )}
      </div>

      <div style={styles.inspectorActions}>
        {editingRule ? (
          <>
            <button onClick={handleSave} style={styles.btnPrimarySm}>Save</button>
            <button onClick={() => setEditingRule(false)} style={styles.btnSecondary}>Cancel</button>
          </>
        ) : readOnly ? (
          <span style={{ fontSize: 11, color: 'var(--text-3)', fontStyle: 'italic' }}>Read-only</span>
        ) : (
          <>
            <button onClick={handleEdit} style={styles.btnPrimarySm}>Edit rule</button>
          </>
        )}
      </div>
      </div>
    </aside>
  );
}

function ImportFileModal({
  title, accept, acceptLabel, templateHref, templateFilename, hint, onClose, onImported,
}: {
  title: string;
  accept: string;
  acceptLabel: string;
  templateHref?: string;
  templateFilename?: string;
  hint: string;
  onClose: () => void;
  onImported?: () => void;
}) {
  const t = useT();
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const handlePick = (f: File | null) => {
    if (!f) return;
    setFile(f);
  };
  return (
    <div style={styles.modalBackdrop} onClick={onClose}>
      <div style={styles.modalCard} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <div style={styles.modalTitle}>{title}</div>
          <div style={{ flex: 1 }} />
          {templateHref && (
            <a
              href={templateHref}
              download={templateFilename}
              style={styles.modalTemplateBtn}
            >
              <Ic.download /> Download template
            </a>
          )}
        </div>
        <div style={styles.modalBody}>
          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const f = e.dataTransfer.files?.[0];
              if (f) handlePick(f);
            }}
            onClick={() => inputRef.current?.click()}
            style={{
              ...styles.modalDropZone,
              borderColor: dragging ? 'var(--navy)' : 'var(--border-strong)',
              background: dragging ? 'var(--navy-50)' : 'var(--panel-2)',
            }}
          >
            <input
              ref={inputRef}
              type="file"
              accept={accept}
              onChange={(e) => handlePick(e.target.files?.[0] ?? null)}
              style={{ display: 'none' }}
            />
            {file ? (
              <div style={{ textAlign: 'center', maxWidth: '100%', minWidth: 0 }}>
                <div
                  style={{ fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}
                  title={file.name}
                >{file.name}</div>
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>
                  {(file.size / 1024).toFixed(1)} KB · {t('mapping.import.reselectHint')}
                </div>
              </div>
            ) : (
              <div style={{ textAlign: 'center', color: 'var(--text-3)' }}>
                <div style={{ fontSize: 13, marginBottom: 4 }}>{t('mapping.import.dropHint')}</div>
                <div style={{ fontSize: 11 }}>{acceptLabel}</div>
              </div>
            )}
          </div>
          <div style={styles.modalHint}>
            <Ic.warn />
            <span>{hint}</span>
          </div>
        </div>
        <div style={styles.modalFooter}>
          <button style={styles.btnSecondary} onClick={onClose}>Cancel</button>
          <button
            style={file ? styles.btnPrimary : styles.btnPrimaryDisabled}
            disabled={!file}
            onClick={() => {
              // TODO: 백엔드 import API 가 생기면 여기서 호출.
              console.log(`[${title}] would import`, file?.name);
              onImported?.();
              onClose();
            }}
          >Import</button>
        </div>
      </div>
    </div>
  );
}

// ── Mapping definition import modal (stage → save 모델) ──
//
// 폴더 아이콘으로 파일 픽 / 휴지통으로 슬롯 삭제 — 둘 다 일단 모달 안 state 에만
// stage 됨. Save 누를 때 한꺼번에 DB 에 commit (POST /mapping/import + DELETE).
// Close 누르면 staged 변경 전부 폐기.

type SlotPending =
  | { kind: 'none' }
  | { kind: 'upload'; file: File }
  | { kind: 'delete' };

/**
 * Snapshot baseline 비교용 시그니처 helper.
 * snapshot 의 frozen rules/bindings 와 apply 후 live mapping_rules/bindings 가 의미적으로 같은지 판단.
 * id / timestamp / createdBy 같은 메타 필드는 무시하고, 사용자 의도가 담긴 필드만 비교.
 */
function ruleSignature(r: {
  tobeSchema: string; tobeTable: string; tobeColumn: string;
  asisSchema?: string | null; asisTable?: string | null;
  asisColumn?: string[] | null; strategy: string;
  transformRule?: string | null; transformSql?: string | null;
  defaultValue?: string | null; notNullOverride: boolean;
  notes?: string | null;
}): string {
  return JSON.stringify({
    k: `${r.tobeSchema}|${r.tobeTable}|${r.tobeColumn}`,
    aS: r.asisSchema ?? null,
    aT: r.asisTable ?? null,
    aC: r.asisColumn ?? null,
    st: r.strategy,
    tr: r.transformRule ?? null,
    ts: r.transformSql ?? null,
    dv: r.defaultValue ?? null,
    nn: !!r.notNullOverride,
    nt: r.notes ?? null,
  });
}

function rulesEqual(a: FrozenRule[], b: MappingRuleDto[]): boolean {
  if (a.length !== b.length) return false;
  const sa = a.map(ruleSignature).sort();
  const sb = b.map(ruleSignature).sort();
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
  return true;
}

function bindingSignature(b: {
  tobeSchema: string; tobeTable: string;
  compositionKind: string; whereFilter?: string | null;
  groupByExpr?: string | null; expandExpr?: string | null;
  sharedFromProjectId?: string | null;
  sources: Array<{
    ordinal: number; asisSchema?: string | null; asisTable: string;
    alias: string; role: string; joinType?: string | null; joinOn?: string | null;
  }>;
}): string {
  const srcs = [...b.sources].sort((x, y) => x.ordinal - y.ordinal).map((s) => ({
    o: s.ordinal, aS: s.asisSchema ?? null, aT: s.asisTable,
    al: s.alias, r: s.role, jt: s.joinType ?? null, jo: s.joinOn ?? null,
  }));
  return JSON.stringify({
    k: `${b.tobeSchema}|${b.tobeTable}`,
    ck: b.compositionKind,
    wf: b.whereFilter ?? null,
    gb: b.groupByExpr ?? null,
    ex: b.expandExpr ?? null,
    sf: b.sharedFromProjectId ?? null,
    srcs,
  });
}

function bindingsEqual(a: FrozenBinding[], b: MappingTableBindingDto[]): boolean {
  if (a.length !== b.length) return false;
  const sa = a.map(bindingSignature).sort();
  const sb = b.map(bindingSignature).sort();
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
  return true;
}

function MappingDefinitionImportModal({
  projectId, activeFiles, onClose, onChanged, tableFilter,
}: {
  projectId: string;
  activeFiles: { column: string | null; code: string | null };
  onClose: () => void;
  /** Returns the list of TO-BE qualified names that are in the DDL but missing from mapping rules.
   *  Caller passes tableFilter so table-remap narrows the check to that single TO-BE table; project-wide
   *  import passes null and checks the entire DDL. */
  onChanged: (tableFilter: string | null) => Promise<string[]>;
  /** null/undefined = 프로젝트 전체. 값이 있으면 그 TO-BE 테이블만 적용 (스키마 제외 테이블명). */
  tableFilter?: string | null;
}) {
  const t = useT();
  const [columnPending, setColumnPending] = useState<SlotPending>({ kind: 'none' });
  const [codePending, setCodePending]     = useState<SlotPending>({ kind: 'none' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  /**
   * Apply — pending 변경이 있으면 처리 + 매번 bindings 재구성 (멱등).
   * pending 변경 없어도 활성. 파일 안 바꿔도 재맵핑 가능.
   */
  const handleApply = async () => {
    if (!projectId) return;
    setSaving(true);
    setError(null);
    setWarning(null);
    try {
      if (columnPending.kind === 'delete') await mappingImportApi.deleteRules(projectId);
      if (codePending.kind === 'delete')   await mappingImportApi.deleteCodeMaps(projectId);
      const colFile = columnPending.kind === 'upload' ? columnPending.file : null;
      const codFile = codePending.kind   === 'upload' ? codePending.file   : null;
      const anyPending = columnPending.kind !== 'none' || codePending.kind !== 'none';
      if (colFile || codFile) {
        await mappingImportApi.importCsv(projectId, colFile, codFile, tableFilter ?? null);
      } else if (!anyPending && (activeFiles.column || activeFiles.code)) {
        // 사용자가 파일 다시 안 고르고 Apply 만 누름 → 마지막 임포트 CSV 로 재적용
        // (수동 수정된 룰 reset). tableFilter 있으면 그 테이블만.
        await mappingImportApi.reapplyLatest(projectId, tableFilter ?? null);
      }
      await mappingImportApi.rebuildBindings(projectId);
      // mapping 을 건드린 셈이므로 phase 를 analysis 로 demote — rule 직접 편집과 동일 정책.
      // import / reapply / delete / 단순 rebuild 어떤 경로든 일관되게 적용.
      demoteToAnalysisOnEdit(projectId);

      // Snapshot baseline 자동 해제: apply 후 데이터가 frozen snapshotData 와 달라지면 핀 해제.
      // - code CSV 변경 (codePending != 'none') → frozen codeMaps 와 다를 가능성 매우 큼.
      //   (현재 listCodeMaps API 미존재 → pending 신호로 보조 판단.)
      // - rules / bindings 는 fetch 후 시그니처 비교 — id/timestamp 제외한 의미상 동일성 확인.
      // 같은 파일로 단순 reapply 라 결과가 동일하면 핀 유지.
      const pinnedIds = usePinnedSnapshotsStore.getState().pinnedIds;
      const baseline = useSnapshotsStore.getState().snapshots.find(
        (s) => s.projectId === projectId && pinnedIds.includes(s.id),
      );
      if (baseline?.snapshotData) {
        const sd = baseline.snapshotData;
        let changed = codePending.kind !== 'none';
        if (!changed) {
          const [newRules, newBindings] = await Promise.all([
            mappingImportApi.listRules(projectId),
            mappingImportApi.listBindings(projectId),
          ]);
          changed = !rulesEqual(sd.rules, newRules) || !bindingsEqual(sd.bindings, newBindings);
        }
        if (changed) {
          usePinnedSnapshotsStore.getState().clearPin(baseline.id);
        }
      }

      const unmatched = await onChanged(tableFilter ?? null);
      if (unmatched.length > 0) {
        const shown = unmatched.slice(0, 5).join(', ');
        const more = unmatched.length > 5 ? ` 외 ${unmatched.length - 5}개` : '';
        setWarning(t('mapping.import.warning.uncoveredCols', { cols: shown + more }));
        // 경고만 표시하고 모달은 그대로 유지 — 사용자가 직접 Close
        return;
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const displayName = (slot: 'column' | 'code'): { name: string | null; mode: 'normal' | 'pending' } => {
    const pending = slot === 'column' ? columnPending : codePending;
    const active = slot === 'column' ? activeFiles.column : activeFiles.code;
    if (pending.kind === 'upload') return { name: pending.file.name, mode: 'pending' };
    if (pending.kind === 'delete') return { name: null, mode: 'normal' };
    return { name: active, mode: 'normal' };
  };

  const colDisp = displayName('column');
  const codDisp = displayName('code');

  return (
    <div style={styles.modalBackdrop}>
      <div style={{ ...styles.modalCard, width: 520 }}>
        <div style={styles.modalHeader}>
          <div style={styles.modalTitle}>Mapping Definition{tableFilter ? ` · ${tableFilter}` : ''}</div>
          <div style={{ flex: 1 }} />
          <a
            href="/templates/mapping_definition_template.csv"
            download="column_mapping_template.csv"
            style={styles.modalTemplateBtn}
          >
            <Ic.download /> column template
          </a>
          <a
            href="/templates/code_mapping_template.csv"
            download="code_mapping_template.csv"
            style={{ ...styles.modalTemplateBtn, marginLeft: 6 }}
          >
            <Ic.download /> code template
          </a>
        </div>
        <div style={styles.modalBody}>
          <MappingFileRow
            label="Column mapping"
            displayName={colDisp.name}
            displayMode={colDisp.mode}
            onPick={(f) => setColumnPending({ kind: 'upload', file: f })}
            onDelete={() => setColumnPending({ kind: 'delete' })}
            canDelete={!tableFilter && activeFiles.column !== null && columnPending.kind !== 'delete'}
          />
          <MappingFileRow
            label="Code mapping"
            displayName={codDisp.name}
            displayMode={codDisp.mode}
            onPick={(f) => setCodePending({ kind: 'upload', file: f })}
            onDelete={() => setCodePending({ kind: 'delete' })}
            canDelete={!tableFilter && activeFiles.code !== null && codePending.kind !== 'delete'}
          />
          {warning && (
            <div style={{ ...styles.modalHint, background: 'var(--amber-50)', borderColor: 'var(--amber)', color: 'var(--amber)' }}>
              <Ic.warn />
              <span>{warning}</span>
            </div>
          )}
          {error && (
            <div style={{ ...styles.modalHint, background: 'var(--red-50)', borderColor: 'var(--red)', color: 'var(--red)' }}>
              <Ic.warn />
              <span>{error}</span>
            </div>
          )}
        </div>
        <div style={styles.modalFooter}>
          <button
            style={!saving ? styles.btnPrimary : styles.btnPrimaryDisabled}
            disabled={saving}
            onClick={handleApply}
          >{saving ? 'Applying' : 'Apply'}</button>
          <button style={styles.btnSecondary} disabled={saving} onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

/**
 * 한 슬롯의 행 — [라벨] [흰 박스: 파일명 ... 📁 🗑]
 * 폴더 아이콘 / 휴지통은 흰 박스 내부의 단일 컨테이너에 묶여 있음.
 */
function MappingFileRow({
  label, displayName, displayMode, onPick, onDelete, canDelete,
}: {
  label: string;
  displayName: string | null;
  displayMode: 'normal' | 'pending';
  onPick: (f: File) => void;
  onDelete: () => void;
  canDelete: boolean;
}) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);

  const nameStyle: React.CSSProperties = {
    flex: 1,
    minWidth: 0, // flex item 기본 min-width:auto 면 ellipsis 가 작동 안 해 긴 파일명이 박스를 뚫는다.
    fontFamily: 'var(--mono)',
    fontSize: 12,
    color: displayName == null ? 'var(--text-4)' : 'var(--text)',
    fontStyle: displayMode === 'pending' ? 'italic' : 'normal',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  };

  const iconBtnStyle: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 22, height: 22,
    background: 'transparent', border: 'none', borderRadius: 3,
    cursor: 'pointer', color: 'var(--text-3)', fontSize: 12,
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ minWidth: 110, fontSize: 11.5, color: 'var(--text-2)' }}>{label}</div>
        {/* 흰 박스 — 파일명과 아이콘 모두 감싼다 */}
        <div style={{
          flex: 1,
          minWidth: 0,
          display: 'flex', alignItems: 'center', gap: 4,
          padding: '6px 10px',
          background: 'var(--panel)',
          border: '1px solid var(--border-strong)',
          borderRadius: 4,
          minHeight: 30,
        }}>
          <div style={nameStyle}>{displayName ?? '—'}</div>
          {canDelete && (
            <button
              type="button"
              onClick={onDelete}
              title={t('mapping.import.deleteSlotTooltip')}
              style={iconBtnStyle}
            >
              <i className="fa-solid fa-trash" />
            </button>
          )}
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            title={t('mapping.import.pickFileTooltip')}
            style={iconBtnStyle}
          >
            <i className="fa-solid fa-folder-open" />
          </button>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".csv"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onPick(f);
            e.target.value = '';
          }}
          style={{ display: 'none' }}
        />
      </div>
    </div>
  );
}

// ── Report view (Test 결과 미리보기) ─────────────────────────

/**
 * Fetch the CSV preview for `{site.csvPath}/{tableName}.csv` via the backend
 * (browsers can't read arbitrary local paths). Cached per (siteId, tableName).
 * Returns null while loading, or when the file is missing / unreadable.
 */
const CSV_CACHE = new Map<string, CsvPreview | null>();

function useTableCsv(siteId: string | null, tableShortName: string | undefined): CsvPreview | null {
  const cacheKey = siteId && tableShortName ? `${siteId}::${tableShortName.toLowerCase()}` : null;
  const [data, setData] = useState<CsvPreview | null>(() =>
    cacheKey ? CSV_CACHE.get(cacheKey) ?? null : null,
  );
  useEffect(() => {
    if (!siteId || !tableShortName) { setData(null); return; }
    const key = `${siteId}::${tableShortName.toLowerCase()}`;
    if (CSV_CACHE.has(key)) { setData(CSV_CACHE.get(key) ?? null); return; }
    let cancelled = false;
    csvPreviewApi.forTable(siteId, tableShortName.toLowerCase(), 50)
      .then((preview) => {
        CSV_CACHE.set(key, preview);
        if (!cancelled) setData(preview);
      })
      .catch(() => {
        CSV_CACHE.set(key, null);
        if (!cancelled) setData(null);
      });
    return () => { cancelled = true; };
  }, [siteId, tableShortName]);
  return data;
}

/**
 * Run the mapping Report — call backend which executes the generated SELECT
 * (transform_sql per rule + read_csv per binding source) via DuckDB.
 * Returns transformed rows where columns are named by TO-BE column name.
 */
function useReportRows(
  projectId: string | null,
  tobeSchema: string,
  tobeTable: string | undefined,
  prefetched?: MappingReportResult | null,
): { result: MappingReportResult | null; loading: boolean; durationMs: number | null; executedAt: Date | null } {
  const [result, setResult] = useState<MappingReportResult | null>(null);
  const [loading, setLoading] = useState(false);
  // 실제 Report 쿼리 round-trip 소요시간 + 완료 시각 (상태바 표시용 — 가짜 0.0s/렌더타임 대체).
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [executedAt, setExecutedAt] = useState<Date | null>(null);
  useEffect(() => {
    if (!projectId || !tobeTable) { setResult(null); setDurationMs(null); setExecutedAt(null); return; }
    // Trial 이 이미 변환한 결과(prefetched)가 있으면 재변환 없이 재사용 (#8-1) — 이중 변환 방지.
    if (prefetched) {
      setResult(prefetched);
      setDurationMs(0);
      setExecutedAt(new Date());
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const startedAt = performance.now();
    mappingImportApi.runReport(projectId, tobeSchema, tobeTable, 20)
      .then((r) => { if (!cancelled) setResult(r); })
      .catch((e) => {
        if (!cancelled) setResult({
          tobeSchema, tobeTable, headers: [], rows: [], rowCount: 0, truncated: false,
          sql: null, error: e instanceof Error ? e.message : String(e),
        });
      })
      .finally(() => {
        if (cancelled) return;
        setDurationMs(performance.now() - startedAt);
        setExecutedAt(new Date());
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [projectId, tobeSchema, tobeTable, prefetched]);
  return { result, loading, durationMs, executedAt };
}

/**
 * Pipe one AS-IS CSV row through the mapping rule for `r` and produce the TO-BE cell value.
 * No DB write — purely in-memory preview of what the test run will emit.
 *
 *   rule = unmapped / null / default / added → rule-driven literal
 *   rule = auto / rule with CSV loaded       → CSV[r.src] with applyTransform
 *   anything else (no CSV, source missing)   → empty cell ([NULL])
 *
 * Dummies are intentionally never shown here — the Report is a Test-result view,
 * and a blank means "no source row" which is a more honest signal than fake data.
 */
function computeReportCell(
  r: MappingRow,
  rowIdx: number,
  csv: CsvPreview | null,
  csvColIdx: Map<string, number> | null,
): string {
  if (r.rule === 'unmapped') return '';
  if (r.rule === 'null')     return 'NULL';
  if (r.rule === 'default')  return r.ddlDefault ?? 'DEFAULT';
  if (r.rule === 'added')    return r.ddlDefault ?? 'NULL';
  // 'auto' / 'rule'
  if (!csv || !csvColIdx) return '';
  if (!r.src || r.src === '—') return '';
  // savedSrc 는 row editor 가 `{alias}.{column}` (예: "c.CUST_ID") 로 저장하므로
  // CSV 헤더 (alias 없음) 와 맞추려면 마지막 세그먼트만 사용.
  const colName = r.src.includes('.') ? r.src.split('.').pop()! : r.src;
  const idx = csvColIdx.get(colName.trim().toLowerCase());
  if (idx === undefined) return '';
  const raw = csv.rows[rowIdx]?.[idx];
  return raw === undefined ? '' : applyTransform(raw, r);
}

/**
 * Minimal AS-IS → TO-BE value transformation. Covers the common Oracle → PG
 * cases the rule editor lets users express implicitly via type changes.
 * Anything richer (code maps, unit conversion, regex split) should live in
 * `RowEdit.savedRule` and ultimately be executed in DuckDB SQL — out of scope
 * for this preview path.
 */
function applyTransform(raw: string, r: MappingRow): string {
  if (raw === '') return r.tgtNullable === false ? '' : 'NULL'; // Oracle empty == NULL
  const t = r.tgtType.toUpperCase();
  if (t.startsWith('BOOL') || t === 'BIT') {
    const u = raw.trim().toUpperCase();
    if (u === 'Y' || u === 'TRUE' || u === '1' || u === 'T') return 'true';
    if (u === 'N' || u === 'FALSE' || u === '0' || u === 'F') return 'false';
  }
  return raw;
}

function excelColLabel(i: number): string {
  // 0 → A, 25 → Z, 26 → AA, ...
  let s = '';
  let n = i;
  while (true) {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
    if (n < 0) break;
  }
  return s;
}

function typeIconLabel(t: string): string {
  const u = t.toLowerCase();
  if (u === 'uuid') return 'UUID';
  if (u.startsWith('varchar') || u.startsWith('char') || u === 'text' || u.includes('nvarchar')) return 'ABC';
  if (u === 'int' || u === 'integer' || u === 'bigint' || u === 'smallint' || u === 'serial' || u === 'bigserial') return '123';
  if (u.startsWith('numeric') || u.startsWith('decimal') || u.startsWith('number')) return '1.2';
  if (u.startsWith('timestamp')) return 'TS';
  if (u === 'date') return 'DT';
  if (u === 'time') return 'TM';
  if (u === 'bool' || u === 'boolean' || u === 'bit') return 'T/F';
  if (u === 'bytea' || u.includes('blob') || u.includes('binary') || u === 'raw') return 'BIN';
  if (u === 'json' || u === 'jsonb') return '{}';
  return u.slice(0, 3).toUpperCase();
}

function isNumericType(t: string): boolean {
  const u = t.toLowerCase();
  return u === 'int' || u === 'integer' || u === 'bigint' || u === 'smallint'
    || u.startsWith('numeric') || u.startsWith('number') || u.startsWith('decimal');
}

function ReportView({ table, rows, sources, prefetched, onClose, onPickColumn }: {
  table: TobeTable;
  rows: MappingRow[];
  /** Editor 가 현재 보유한 binding sources. table.sources (TOBE_TABLES) 가 module-level 이라
   * binding edit 으로 추가된 source 가 반영 안 되어, 명시적으로 받아서 사용. */
  sources: TobeTable['sources'];
  /** Trial 이 이미 변환한 결과 — 있으면 재변환 없이 재사용 (#8-1). */
  prefetched?: MappingReportResult | null;
  onClose: () => void;
  onPickColumn: (tgt: string) => void;
}) {
  const t = useT();
  const PREVIEW_ROWS = 20;
  const shortName = table.short || (table.name.includes('.') ? table.name.split('.').pop()! : table.name);
  const tobeDbLabel = dialectLabel(TOBE_DIALECT);

  const ws = useWorkspaceStore.getState();
  const activeSite = ws.getActiveSite();
  const activeSiteName = activeSite?.name || 'modernize';
  const activeProject = ws.getActiveProject();
  const activeProjectName = activeProject?.name || 'project';

  // Mapping report — 백엔드가 transform_sql 들을 묶어 read_csv 위에서 한 방에 실행.
  // header 는 TO-BE 컬럼명, row 값은 변환식 적용 결과.
  const tobeSplit = useMemo(() => {
    const i = table.name.indexOf('.');
    return i > 0
      ? { schema: table.name.slice(0, i), table: table.name.slice(i + 1) }
      : { schema: '', table: table.name };
  }, [table.name]);
  const { result: report, loading: reportLoading, durationMs: reportDurationMs, executedAt: reportExecutedAt } = useReportRows(activeProject?.id ?? null, tobeSplit.schema, tobeSplit.table, prefetched);
  const reportColIdx = useMemo(() => {
    if (!report) return null;
    const m = new Map<string, number>();
    report.headers.forEach((h, i) => m.set(h.trim().toLowerCase(), i));
    return m;
  }, [report]);

  // viewMode: 'tobe' (기본, 변환 결과) / 'asis' (raw csv VARCHAR 그대로).
  // ↶ 버튼 → asis 로 되돌리기 / ↷ 버튼 → tobe 로 앞으로.
  const [viewMode, setViewMode] = useState<'tobe' | 'asis'>('tobe');
  // binding edit 의 sources 우선, 없으면 module-level fallback.
  const effectiveSources = sources && sources.length > 0 ? sources : table.sources;
  const firstSource = effectiveSources[0];
  const [asisPreview, setAsisPreview] = useState<CsvPreview | null>(null);
  const [asisPreviewLoading, setAsisPreviewLoading] = useState(false);
  useEffect(() => {
    if (viewMode !== 'asis' || !firstSource || !activeSite) return;
    if (asisPreview) return; // cache
    let alive = true;
    setAsisPreviewLoading(true);
    csvPreviewApi.forTable(activeSite.id, firstSource.table, PREVIEW_ROWS)
      .then((p) => { if (alive) setAsisPreview(p); })
      .catch(() => { if (alive) setAsisPreview(null); })
      .finally(() => { if (alive) setAsisPreviewLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, firstSource?.table, activeSite?.id]);

  const dataRowCount = viewMode === 'tobe'
    ? (report ? Math.min(report.rows.length, PREVIEW_ROWS) : 0)
    : (asisPreview ? Math.min(asisPreview.rows.length, PREVIEW_ROWS) : 0);
  // 디버그 — 결과가 도착했을 때 한 번만 찍음
  useEffect(() => {
    if (!report) return;
    console.log('[Report]', {
      tobeSplit,
      headers: report.headers,
      rowCount: report.rowCount,
      error: report.error,
      sql: report.sql,
      firstRow: report.rows[0],
    });
  }, [report, tobeSplit]);

  return (
    <div style={styles.dbvWindow}>
      {/* ① 타이틀바 */}
      <div style={styles.dbvTitlebar}>
        <div style={styles.dbvTitlebarLeft}>
          <img src="/mpd.png" alt="" style={styles.dbvLogo} />
          <span style={styles.dbvTitleText}>{shortName} - Report</span>
        </div>
        <div style={styles.dbvTitlebarRight}>
          <span style={styles.dbvTitleBtn} aria-hidden="true">
            <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
              <line x1="2" y1="8" x2="8" y2="8" />
            </svg>
          </span>
          <span style={styles.dbvTitleBtn} aria-hidden="true">
            <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3">
              <rect x="1.3" y="1.3" width="7.4" height="7.4" rx="1" />
            </svg>
          </span>
          <button
            type="button"
            onClick={onClose}
            title={t('mapping.tooltip.backToMapping')}
            style={{ ...styles.dbvTitleBtn, ...styles.dbvTitleBtnClose }}
            aria-label="Close report"
          >✕</button>
        </div>
      </div>

      {/* ② 메뉴바 */}
      <div style={styles.dbvMenubar}>
        {['File', 'Edit', 'Navigate', 'Search', 'SQL Editor', 'Database', 'Window', 'Help'].map((m) => (
          <span key={m} style={styles.dbvMenuItem}>{m}</span>
        ))}
      </div>

      {/* ③ 툴바 */}
      <div style={styles.dbvToolbar}>
        {['📄','📂','💾'].map((s, i) => <span key={`g1-${i}`} style={styles.dbvToolBtn}>{s}</span>)}
        <span style={styles.dbvToolSep} />
        <button
          type="button"
          onClick={() => setViewMode('asis')}
          disabled={viewMode === 'asis' || !firstSource}
          title={viewMode === 'asis' ? t('mapping.report.toAsisTitle.already') : t('mapping.report.toAsisTitle.revert')}
          style={{
            ...styles.dbvToolBtn,
            background: 'transparent',
            border: 'none',
            cursor: viewMode === 'asis' || !firstSource ? 'not-allowed' : 'pointer',
            opacity: viewMode === 'asis' || !firstSource ? 0.35 : 1,
          }}
        >↶</button>
        <button
          type="button"
          onClick={() => setViewMode('tobe')}
          disabled={viewMode === 'tobe'}
          title={viewMode === 'tobe' ? t('mapping.report.toTobeTitle.already') : t('mapping.report.toTobeTitle.forward')}
          style={{
            ...styles.dbvToolBtn,
            background: 'transparent',
            border: 'none',
            cursor: viewMode === 'tobe' ? 'not-allowed' : 'pointer',
            opacity: viewMode === 'tobe' ? 0.35 : 1,
          }}
        >↷</button>
        <span style={styles.dbvToolSep} />
        {['▶','⏹'].map((s, i) => <span key={`g3-${i}`} style={styles.dbvToolBtn}>{s}</span>)}
        <span style={styles.dbvToolSep} />
        <span style={styles.dbvToolDropdown}>Auto<span style={styles.dbvToolDropArrow}>▾</span></span>
        <span style={styles.dbvToolDropdown}>{tobeDbLabel}<span style={styles.dbvToolDropArrow}>▾</span></span>
        <span style={styles.dbvToolDropdown}>{activeProjectName}@{shortName}<span style={styles.dbvToolDropArrow}>▾</span></span>
        <span style={styles.dbvToolSep} />
        {['⚙','🔍','⤓','⤴'].map((s, i) => <span key={`g4-${i}`} style={styles.dbvToolBtn}>{s}</span>)}
      </div>

      {/* ④ 탭바 — 프로젝트의 모든 TO-BE 테이블 */}
      <div style={styles.dbvTabbar}>
        {TOBE_TABLES.map((t) => {
          const active = t.internalName === table.internalName;
          const name = t.short || t.name.split('.').pop() || t.name;
          return (
            <div
              key={t.internalName}
              style={active
                ? { ...styles.dbvTab, ...styles.dbvTabActive }
                : styles.dbvTab}
            >
              <i className="fa-solid fa-table" style={{ color: '#2DBD96', fontSize: 12 }} />
              <span>{name}</span>
              {active && <span style={styles.dbvTabClose}>✕</span>}
            </div>
          );
        })}
      </div>

      {/* ⑥ 필터바 */}
      <div style={styles.dbvFilterbar}>
        <span style={styles.dbvFilterShowSql}>Show SQL</span>
        <span style={styles.dbvFilterInput}>{t('mapping.report.notPersisted')}</span>
        <span style={styles.dbvFilterIcons}>
          {['▾','▶','✕','⟳','⊞','⚙'].map((s, i) => <span key={i} style={styles.dbvFilterIcon}>{s}</span>)}
        </span>
      </div>

      {/* 상태 배너 — loading / error / 빈 결과 */}
      {viewMode === 'tobe' && reportLoading && (
        <div style={{ padding: '8px 14px', background: '#fff8e1', color: '#856404', borderBottom: '1px solid #e8e8e8', fontSize: 11.5 }}>
          ⏳ {t('mapping.report.loading')}
        </div>
      )}
      {viewMode === 'asis' && asisPreviewLoading && (
        <div style={{ padding: '8px 14px', background: '#fff8e1', color: '#856404', borderBottom: '1px solid #e8e8e8', fontSize: 11.5 }}>
          ⏳ {t('mapping.report.asisLoading')}
        </div>
      )}
      {viewMode === 'asis' && !asisPreviewLoading && !asisPreview && firstSource && (
        <div style={{ padding: '8px 14px', background: '#fde2e2', color: '#a02020', borderBottom: '1px solid #e8e8e8', fontSize: 11.5 }}>
          ⚠ {t('mapping.report.csvLoadFailed', { table: firstSource.table })}
        </div>
      )}
      {viewMode === 'asis' && firstSource && effectiveSources.length > 1 && (
        <div style={{ padding: '6px 14px', background: '#eef4ff', color: '#3a5a8c', borderBottom: '1px solid #e8e8e8', fontSize: 10.5 }}>
          ℹ {t('mapping.report.firstSourceOnly', { n: String(effectiveSources.length), alias: firstSource.alias, table: firstSource.table })}
        </div>
      )}

      {/* 데이터 그리드 */}
      <div style={styles.dbvGridArea}>
        <table style={styles.dbvGrid}>
          <thead>
            <tr>
              <th style={styles.dbvGridCorner}> </th>
              {viewMode === 'tobe' ? rows.map((r) => (
                <th
                  key={r.tgt}
                  onClick={() => onPickColumn(r.tgt)}
                  title={t('mapping.report.cellTitle', { col: r.tgt, type: r.tgtType })}
                  style={styles.dbvGridCol}
                >
                  <div style={styles.dbvColHeaderInner}>
                    <span style={styles.dbvColTypeIcon}>{typeIconLabel(r.tgtType)}</span>
                    <span>{r.tgt}</span>
                    <span style={styles.dbvColCaret}>▾</span>
                  </div>
                </th>
              )) : (asisPreview?.headers ?? []).map((h) => {
                // AS-IS DDL 의 컬럼 type lookup (대소문자 무관 매칭).
                const asisType = firstSource
                  ? lookupAsisCols(firstSource.table).find((c) => c.name.toLowerCase() === h.toLowerCase())?.type
                  : undefined;
                const typeLabel = asisType || 'VARCHAR';
                return (
                  <th key={h} title={`${h} (${typeLabel}) · AS-IS raw`} style={styles.dbvGridCol}>
                    <div style={styles.dbvColHeaderInner}>
                      <span style={styles.dbvColTypeIcon}>{typeIconLabel(typeLabel)}</span>
                      <span>{h}</span>
                      <span style={styles.dbvColCaret}>▾</span>
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {viewMode === 'tobe' && report?.error ? (
              <tr>
                <td
                  colSpan={rows.length + 1}
                  style={{
                    padding: '14px 16px',
                    background: '#fde2e2',
                    color: '#a02020',
                    fontFamily: 'var(--mono)',
                    fontSize: 11.5,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    verticalAlign: 'top',
                    borderBottom: '1px solid #f5b5b5',
                    userSelect: 'text',
                    cursor: 'text',
                    position: 'relative',
                  }}
                >
                  <button
                    type="button"
                    onClick={() => { void copyText(buildReportErrorMessage(report, t)); }}
                    title={t('mapping.tooltip.copyError')}
                    style={{
                      position: 'absolute', top: 8, right: 10,
                      padding: '2px 8px', fontSize: 10.5,
                      fontFamily: 'var(--mono)',
                      color: '#a02020', background: '#fff5f5',
                      border: '1px solid #f5b5b5', borderRadius: 3,
                      cursor: 'pointer', userSelect: 'none',
                    }}
                  >Copy</button>
                  <div style={{ userSelect: 'text' }}>⚠ {buildReportErrorMessage(report, t)}</div>
                </td>
              </tr>
            ) : Array.from({ length: dataRowCount }, (_, i) => {
              const zebra = i % 2 === 1;
              return (
                <tr key={i}>
                  <td style={styles.dbvRowNum}>{i + 1}</td>
                  {viewMode === 'tobe' ? rows.map((r) => {
                    // TO-BE 컬럼명으로 report 결과에서 lookup
                    let v = '';
                    if (report && reportColIdx) {
                      const idx = reportColIdx.get(r.tgt.toLowerCase());
                      if (idx !== undefined) v = report.rows[i]?.[idx] ?? '';
                    }
                    const isNull = v === 'NULL' || v === '';
                    const numeric = isNumericType(r.tgtType);
                    return (
                      <td
                        key={r.tgt}
                        style={{
                          ...styles.dbvCell,
                          ...(zebra ? styles.dbvCellZebra : {}),
                          ...(numeric ? styles.dbvCellNum : {}),
                        }}
                      >
                        {isNull
                          ? <span style={styles.dbvCellNull}>[NULL]</span>
                          : v}
                      </td>
                    );
                  }) : (asisPreview?.headers ?? []).map((h, hi) => {
                    // AS-IS raw csv 의 row 값 — string 그대로
                    const v = asisPreview?.rows[i]?.[hi] ?? '';
                    const isNull = v === '' || v === 'NULL';
                    return (
                      <td
                        key={h}
                        style={{
                          ...styles.dbvCell,
                          ...(zebra ? styles.dbvCellZebra : {}),
                        }}
                      >
                        {isNull
                          ? <span style={styles.dbvCellNull}>[NULL]</span>
                          : v}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 하단 상태바 */}
      <div style={styles.dbvStatusbar}>
        <span style={{ ...styles.dbvStatusBtn, ...styles.dbvStatusBtnDropdown }}>Refresh</span>
        <span style={styles.dbvStatusSep} />
        <span style={styles.dbvStatusBtn}>💾 Save</span>
        <span style={styles.dbvStatusBtn}>✕ Cancel</span>
        <span style={styles.dbvStatusSep} />
        <span style={styles.dbvStatusBtn}>⏮</span>
        <span style={styles.dbvStatusBtn}>◀</span>
        <span style={styles.dbvStatusBtn}>▶</span>
        <span style={styles.dbvStatusBtn}>⏭</span>
        <span style={styles.dbvStatusSep} />
        <span style={{ ...styles.dbvStatusBtn, ...styles.dbvStatusBtnDropdown }}>Export data</span>
        <span style={styles.dbvStatusSep} />
        <span style={styles.dbvStatusCenter}>
          {rows.length} column(s), {dataRowCount} row(s) fetched
          {reportDurationMs != null ? ` - ${(reportDurationMs / 1000).toFixed(3)}s` : ''}
          {reportExecutedAt ? `, on ${fmtDate(reportExecutedAt)} at ${fmtTime(reportExecutedAt)}` : ''}
        </span>
      </div>

      {/* 브레드크럼 */}
      <div style={styles.dbvBreadcrumb}>
        <span style={styles.dbvCrumb}>
          <i className="fa-solid fa-database" style={{ color: '#2DBD96', fontSize: 12 }} />
          <span>{tobeDbLabel} - {activeSiteName}</span>
        </span>
        <span style={styles.dbvCrumbSep}>▸</span>
        <span style={styles.dbvCrumb}>
          <i className="fa-solid" style={{ color: '#2DBD96', fontSize: 12 }}>&#xf46d;</i>
          <span>{activeProjectName}</span>
        </span>
        <span style={styles.dbvCrumbSep}>▸</span>
        <span style={styles.dbvCrumb}>
          <i className="fa-solid fa-table" style={{ color: '#2DBD96', fontSize: 12 }} />
          <span>{shortName}</span>
        </span>
      </div>
    </div>
  );
}

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fmtTime(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

/**
 * 백엔드의 구조화된 ReportResult error 필드를 현재 언어 메시지로 합성.
 * 키 정의: i18n/{ko,ja,en}.ts 의 `mapping.report.error.*`.
 */
function buildReportErrorMessage(
  report: MappingReportResult,
  t: ReturnType<typeof useT>,
): string {
  const typeKey = report.errorType ?? 'UNKNOWN';
  const typeLabel = t(`mapping.report.error.type.${typeKey}` as TranslationKey);
  const typeLine = `${t('mapping.report.error.typeLabel')}: ${typeLabel}`;
  const hintLine = report.errorHint
    ? `\n${t('mapping.report.error.hintLabel')}: ${report.errorHint}`
    : '';
  if (report.errorKind === 'EXPRESSION_FAILED' && report.errorColumn) {
    const head = t('mapping.report.error.expressionFailed', { column: report.errorColumn });
    const expr = `${t('mapping.report.error.expressionLabel')}: ${report.errorExpression ?? ''}`;
    return `${head}\n${expr}\n${typeLine}${hintLine}`;
  }
  if (report.errorKind === 'FROM_FAILED') {
    return `${t('mapping.report.error.fromFailed')}\n${typeLine}${hintLine}`;
  }
  if (report.errorKind === 'NO_RULES') {
    return t('mapping.report.error.noRules');
  }
  if (report.errorKind === 'NO_RULES_LINKED') {
    // backend 가 errorColumn 자리에 master project_id 를 실어보냄 — name 으로 lookup.
    const masterId = report.errorColumn ?? '';
    const master = useWorkspaceStore.getState().projects.find((p) => p.id === masterId);
    return t('mapping.report.error.noRulesLinked', { project: master?.name ?? masterId });
  }
  // UNKNOWN 또는 누락 — 일반 메시지 + 분류 라벨 + 힌트
  return `${t('mapping.report.error.unknown')}\n${typeLine}${hintLine}`;
}

function MetaRow({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div style={styles.metaRow}>
      <div style={styles.metaRowKey}>{k}</div>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}

function transformPreview(r: MappingRow, combineHint?: string): string[] {
  const kw  = (s: string) => `<span style="color:#e8b86f">${s}</span>`;
  const str = (s: string) => `<span style="color:#9fd9b3">${s}</span>`;
  const cmt = (s: string) => `<span style="color:#7a8aa6">${s}</span>`;
  if (r.rule === 'unmapped') return [cmt('-- not mapped yet — pick a strategy')];
  if (r.rule === 'null')     return [cmt('-- explicitly mapped to NULL'), `${kw('NULL')}::${r.tgtType}`];
  if (r.rule === 'default')  return [cmt('-- explicitly mapped to DDL DEFAULT'), `${kw('DEFAULT')}`];
  if (r.rule === 'skip')     return [cmt('-- column is dropped from TO-BE'), `${kw('DROP')}(${r.src})`];
  if (r.rule === 'added')    return [cmt('-- no AS-IS source'), `${kw('DEFAULT')} ${str(r.ddlDefault || 'NULL')}`];
  // multi-source (combine) 케이스 — r.src 가 '—' 로 떨어져 단일 표현 불가. 직접 입력 안내.
  // combineHint 는 caller (Inspector 내 useT) 에서 i18n 처리한 문자열을 전달. 없으면 영문 fallback.
  if (!r.src || r.src === '—') return [cmt(combineHint ?? '-- combine: enter your own expression (e.g. MAKE_DATE / CONCAT)')];
  if (r.srcType.includes('YYYYMMDD'))                                       return [cmt('-- date parse'), `${kw('TO_DATE')}(${r.src}, ${str("'YYYYMMDD'")})`];
  if (r.srcType.includes('CHAR(14)') && r.tgtType.includes('TIMESTAMP'))    return [cmt('-- timestamp parse'), `${kw('TO_TIMESTAMP')}(${r.src}, ${str("'YYYYMMDDHH24MISS'")})`];
  // 아래 두 제안은 실제 등록된 UDF/함수여야 한다 — 예전엔 존재하지 않는 unpack_comp3 / iconv 를
  // 제안해서 그대로 쓰면 Transform 단계에서 "함수 없음" 으로 깨졌다.
  if (r.srcType.includes('COMP-3'))                                         return [cmt('-- COMP-3 → NUMERIC'), `${kw('CAST')}(${kw('apply_scale')}(${r.src}, 2) ${kw('AS')} ${r.tgtType})`];
  // EBCDIC → UTF-8 은 site.asisEncoding 을 보고 extract 단계에서 이미 끝난다 (SourceReader SPI).
  // 컬럼별로 다시 변환할 일은 없고, 남는 실제 문제는 EBCDIC 익스포트의 0x40 공백 패딩이다.
  if (r.srcType.includes('EBCDIC'))                                         return [cmt('-- EBCDIC 는 extract 에서 UTF-8 변환 완료 · 남은 건 패딩 제거'), `${kw('TRIM')}(${r.src})`];
  if (r.rule === 'rule')                                                    return [cmt('-- cast'), `${kw('CAST')}(${r.src} ${kw('AS')} ${r.tgtType})`];
  return [cmt('-- direct pass-through'), `${r.src} ${kw('AS')} ${r.tgt}`];
}

function transformPlain(r: MappingRow, combineHint?: string): string {
  return transformPreview(r, combineHint).map((line) => line.replace(/<[^>]+>/g, '')).join('\n');
}

// ── AS-IS table detail ───────────────────────────────────────

type AsisColMapping = { tobeInternalName: string; tobeShortName: string; tobeColumn: string; rule: MappingRow['rule'] };

function computeAsisMappings(
  asisTableName: string,
  effectiveTobe: TobeTable[],
  rowEditsByTobe: Record<string, Record<string, RowEdit>>,
): Record<string, AsisColMapping[]> {
  const out: Record<string, AsisColMapping[]> = {};
  for (const tobe of effectiveTobe) {
    // schema-lenient — binding source 와 AS-IS DDL 의 schema 유무가 달라도 physical 이름으로 매칭.
    const aliases = new Set(tobe.sources.filter((s) => bareTable(s.table) === bareTable(asisTableName)).map((s) => s.alias));
    if (aliases.size === 0) continue;
    const rows = MAPPING_BY_TOBE[tobe.internalName] || [];
    const edits = rowEditsByTobe[tobe.internalName] || {};
    for (const r of rows) {
      const edit: RowEdit | undefined = edits[r.tgt];

      // 1. effectiveRule — savedStrategy/savedRule/savedSrc 반영
      let effRule: MappingRow['rule'] = r.rule;
      if (edit?.savedStrategy === 'null') effRule = 'null';
      else if (edit?.savedStrategy === 'default') effRule = 'default';
      else if (edit?.savedStrategy === 'expression') {
        if (edit.savedRule && edit.savedRule.trim()) effRule = 'rule';
      }
      if (effRule === r.rule && edit?.savedSrc && edit.savedSrc.length > 0 && r.rule === 'unmapped') {
        effRule = 'auto';
      }
      if (effRule === 'added' || effRule === 'unmapped' || effRule === 'null' || effRule === 'default') continue;

      // 2. AS-IS column 추출 — 사용자가 savedSrc 로 설정한 게 우선
      let srcCol: string | undefined;
      let sourceAlias: string | undefined;
      const savedSrcs = edit?.savedSrc;
      if (savedSrcs && savedSrcs.length > 0 && savedSrcs[0]) {
        const f = savedSrcs[0];
        const di = f.indexOf('.');
        if (di >= 0) {
          sourceAlias = f.slice(0, di);
          srcCol = f.slice(di + 1);
        } else {
          srcCol = f;
        }
      } else {
        sourceAlias = r.sourceAlias;
        srcCol = r.src === '—' ? undefined : r.src;
      }
      if (!srcCol || srcCol === '—' || srcCol === '(new)') continue;

      // alias 가 있으면 그 alias 가 현재 AS-IS 테이블의 alias 중 하나여야 함
      if (sourceAlias && !aliases.has(sourceAlias)) continue;
      // alias 가 없으면, srcCol 이 현재 AS-IS 테이블에 실제로 존재해야 함
      if (!sourceAlias && !lookupAsisCols(asisTableName).some((c) => c.name === srcCol)) continue;

      (out[srcCol] ||= []).push({
        tobeInternalName: tobe.internalName,
        tobeShortName: tobe.short,
        tobeColumn: r.tgt,
        rule: effRule,
      });
    }
  }
  return out;
}

type AsisColFilter = 'all' | 'mapped' | 'unmapped' | 'skip';

const EMPTY_ROW_EDITS_BY_TOBE: Record<string, Record<string, RowEdit>> = Object.freeze({}) as Record<string, Record<string, RowEdit>>;

function AsisTableDetail({ table, effectiveTobe, skippedCols, onToggleSkip, onJumpTobe }: {
  table: AsisTable;
  effectiveTobe: TobeTable[];
  skippedCols: Record<string, boolean>;
  onToggleSkip: (colName: string, nextSkip: boolean) => void;
  onJumpTobe: (internalName: string, name: string) => void;
}) {
  const readOnly = useActiveProjectReadOnly();
  const cols = lookupAsisCols(table.name);
  const [colFilter, setColFilter] = useState<AsisColFilter>('all');
  const routedTobe = effectiveTobe.filter((t) => t.sources.some((s) => bareTable(s.table) === bareTable(table.name)));

  const activeProjectIdForAsis = useWorkspaceStore((s) => s.activeProjectId);
  const navigate = useNavigate();
  const rowEditsByTobe = useMappingEditsStore(
    (s) => (activeProjectIdForAsis ? s.rowEdits[activeProjectIdForAsis] : undefined) || EMPTY_ROW_EDITS_BY_TOBE,
  );
  // baseline snapshot pin chip (TobeMappingDetail 과 동일 패턴) — AS-IS 화면도 표시.
  const snapshots = useSnapshotsStore((s) => s.snapshots);
  const pinnedIds = usePinnedSnapshotsStore((s) => s.pinnedIds);
  const baselineSnapshot = useMemo(
    () => snapshots.find((s) => s.projectId === activeProjectIdForAsis && pinnedIds.includes(s.id)),
    [snapshots, activeProjectIdForAsis, pinnedIds],
  );

  const mappings = useMemo(
    () => computeAsisMappings(table.name, effectiveTobe, rowEditsByTobe),
    [table.name, effectiveTobe, rowEditsByTobe],
  );
  const colStatus = (colName: string): 'mapped' | 'skip' | 'unmapped' => {
    const ms = mappings[colName] || [];
    if (ms.some((m) => m.rule !== 'skip')) return 'mapped';
    const override = skippedCols[colName];
    if (override === true) return 'skip';
    if (override === false) return 'unmapped';
    if (ms.some((m) => m.rule === 'skip')) return 'skip';
    return 'unmapped';
  };

  const coverage = useMemo(() => {
    let mapped = 0, skip = 0, unmapped = 0;
    for (const c of cols) {
      const s = colStatus(c.name);
      if (s === 'mapped') mapped++;
      else if (s === 'skip') skip++;
      else unmapped++;
    }
    return { mapped, skip, unmapped, total: cols.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cols, mappings, skippedCols]);

  const filteredCols = colFilter === 'all'
    ? cols
    : cols.filter((c) => colStatus(c.name) === colFilter);

  return (
    <div style={styles.workspace}>
      <div style={styles.contextBar}>
        <span style={{ ...styles.sidePill, color: 'var(--amber)', background: 'var(--amber-50)', borderColor: 'var(--amber)' }}>AS-IS</span>
        <div style={styles.tableChip}>{table.short}</div>
        {baselineSnapshot && (
          <button
            type="button"
            onClick={() => navigate('/versions', { state: { selectSnapshotId: baselineSnapshot.id } })}
            style={styles.baselinePinChip}
            title={`Pinned baseline: ${baselineSnapshot.name}  (click → Versions)`}
          >
            <PinIconSvg size={11} />
            {baselineSnapshot.version}
          </button>
        )}
        <div style={{ flex: 1 }} />
      </div>

      <div style={styles.routingPanel}>
        <div style={styles.routingHeader}>Routing</div>
        {routedTobe.length === 0 ? (
          <div style={styles.routingEmpty}>
            이 AS-IS 테이블은 아직 어느 TO-BE 테이블에도 연결되어 있지 않습니다. 좌측 TO-BE 트리에서 대상 테이블을 선택해 <b>Table binding</b>에 이 AS-IS 소스를 추가하세요.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {routedTobe.map((to) => (
              <div key={to.internalName} style={styles.routeRow} onClick={() => onJumpTobe(to.internalName, to.name)}>
                <span style={{ color: 'var(--text-2)' }}>{table.short}</span>
                <span style={{ color: 'var(--text-4)' }}><Ic.arrow /></span>
                <span style={{ color: 'var(--navy)', fontWeight: 500 }}>{to.short}</span>
                {to.whereFilter && (
                  <span style={styles.whereTag} title={`WHERE: ${to.whereFilter}`}>
                    WHERE {to.whereFilter.length > 40 ? to.whereFilter.slice(0, 40) : to.whereFilter}
                  </span>
                )}
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 10, color: 'var(--text-3)', fontFamily: 'var(--mono)' }}>
                  {to.compositionKind === 'join' ? 'JOIN' : to.compositionKind === 'union' ? 'UNION' : 'primary'}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ flex: 1, overflow: 'auto', background: 'var(--panel)' }}>
        <CoverageBar {...coverage} filter={colFilter} onFilter={setColFilter} />
            <table style={{ ...styles.gridTable, tableLayout: 'fixed' }}>
              <colgroup>
                <col style={{ width: '20%' }} />
                <col style={{ width: '16%' }} />
                <col style={{ width: '90px' }} />
                <col />
                <col style={{ width: '110px' }} />
              </colgroup>
              <thead>
                <tr>
                  <th style={{ ...styles.gridTh, textAlign: 'left',   top: 56, zIndex: 1 }}>Column</th>
                  <th style={{ ...styles.gridTh, textAlign: 'left',   top: 56, zIndex: 1 }}>Type</th>
                  <th style={{ ...styles.gridTh, textAlign: 'center', top: 56, zIndex: 1 }}>Not Null</th>
                  <th style={{ ...styles.gridTh, textAlign: 'left',   top: 56, zIndex: 1 }}>Mapped TO-BE</th>
                  <th style={{ ...styles.gridTh, textAlign: 'right',  top: 56, zIndex: 1 }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredCols.map((c, i) => {
                  const status = colStatus(c.name);
                  const ms = mappings[c.name] || [];
                  const realMappings = ms.filter((m) => m.rule !== 'skip');
                  const notNull = (c.nullPct ?? 0) === 0;
                  return (
                    <tr key={c.name}
                      data-fix-row={status === 'unmapped' ? 'asis-unmapped' : undefined}
                      style={{
                      background: i % 2 === 1 ? 'var(--zebra)' : 'var(--panel)',
                      borderBottom: '1px solid var(--border)',
                      opacity: status === 'skip' ? 0.62 : 1,
                    }}>
                      <td style={{ ...styles.gridTd, fontFamily: 'var(--mono)', fontWeight: 500 }}>
                        {c.pk && <span style={{ color: 'var(--navy)', marginRight: 5, fontSize: 9, fontWeight: 700 }}>PK</span>}
                        {c.name}
                      </td>
                      <td style={styles.gridTd}><TypeBadge>{c.type}</TypeBadge></td>
                      <td style={{ ...styles.gridTd, textAlign: 'center' }}>
                        {notNull
                          ? <StatusBadge tone="info">NOT NULL</StatusBadge>
                          : <span style={{ color: 'var(--text-4)', fontSize: 10, fontFamily: 'var(--mono)' }}>—</span>}
                      </td>
                      <td style={styles.gridTd}>
                        {realMappings.length === 0 ? (
                          status === 'skip' ? (
                            <StatusBadge tone="skip">skip</StatusBadge>
                          ) : (
                            <StatusBadge tone="err">unmapped</StatusBadge>
                          )
                        ) : (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                            {realMappings.map((m, j) => (
                              <button
                                key={`${m.tobeInternalName}-${j}`}
                                style={styles.tobeTargetChip}
                                title={`Go to ${m.tobeShortName}.${m.tobeColumn}`}
                                onClick={() => onJumpTobe(m.tobeInternalName, TOBE_TABLES.find((t) => t.internalName === m.tobeInternalName)?.name || m.tobeShortName)}
                              >
                                <span style={{ color: 'var(--text-3)' }}>{m.tobeShortName}</span>
                                <span style={{ color: 'var(--text-4)', margin: '0 3px' }}>.</span>
                                <span style={{ color: 'var(--navy)', fontWeight: 600 }}>{m.tobeColumn}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </td>
                      <td style={{ ...styles.gridTd, textAlign: 'right' }}>
                        {status === 'mapped' ? (
                          <span style={{ color: 'var(--text-4)', fontSize: 10 }}>—</span>
                        ) : status === 'skip' ? (
                          <button style={styles.skipBtnOn} disabled={readOnly} onClick={() => onToggleSkip(c.name, false)}>
                            ✓ Skipped
                          </button>
                        ) : (
                          <button style={styles.skipBtnOff} disabled={readOnly} onClick={() => onToggleSkip(c.name, true)}>
                            Skip
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {filteredCols.length === 0 && (
                  <tr><td colSpan={5} style={styles.gridEmpty}>
                    {cols.length === 0
                      ? '(no column schema available for this table)'
                      : `(no ${colFilter} columns)`}
                  </td></tr>
                )}
              </tbody>
            </table>
      </div>
    </div>
  );
}

function CoverageBar({ mapped, skip, unmapped, total, filter, onFilter }: {
  mapped: number; skip: number; unmapped: number; total: number;
  filter: AsisColFilter;
  onFilter: (f: AsisColFilter) => void;
}) {
  const pct = (n: number) => (total === 0 ? 0 : (n / total) * 100);
  const btn = (key: AsisColFilter, label: string, count: number, dotColor?: string) => {
    const isActive = filter === key;
    return (
      <button
        key={key}
        onClick={() => onFilter(key)}
        style={{
          ...styles.coverageFilterBtn,
          background: isActive ? 'var(--panel)' : 'transparent',
          borderColor: isActive ? 'var(--border-strong)' : 'transparent',
          color: isActive ? 'var(--text)' : 'var(--text-2)',
          fontWeight: isActive ? 700 : 500,
        }}
      >
        {dotColor && <span style={{ ...styles.coverageDot, background: dotColor }} />}
        <span>{label}</span>
        <span style={{ ...styles.coverageFilterCount, color: isActive ? 'var(--text)' : 'var(--text-3)' }}>{count}</span>
      </button>
    );
  };
  return (
    <div style={styles.coverageWrap}>
      <div style={styles.coverageHeader}>
        <span style={styles.coverageLabel}>Coverage</span>
        <div style={styles.coverageFilters}>
          {btn('all', 'All', total)}
          {btn('mapped', 'Mapped', mapped, 'var(--green)')}
          {btn('unmapped', 'Unmapped', unmapped, 'var(--red)')}
          {btn('skip', 'Skip', skip, 'var(--border-strong)')}
        </div>
      </div>
      <div style={styles.coverageTrack}>
        <div style={{ width: `${pct(mapped)}%`, background: 'var(--green)' }} />
        <div style={{ width: `${pct(unmapped)}%`, background: 'var(--red)' }} />
        <div style={{ width: `${pct(skip)}%`, background: 'var(--border-strong)' }} />
      </div>
    </div>
  );
}

// ── Empty / guide ────────────────────────────────────────────

function GuidePanel() {
  return (
    <div style={styles.centerEmpty}>
      <div style={{ maxWidth: 420, textAlign: 'center', color: 'var(--text-3)', fontSize: 12.5 }}>
        좌측에서 테이블을 선택하세요.
        <div style={{ marginTop: 6 }}>
          TO-BE 테이블을 선택하면 컬럼 매핑을 편집할 수 있고, AS-IS 테이블을 선택하면 스키마와 라우팅을 확인할 수 있습니다.
        </div>
      </div>
    </div>
  );
}

type TobeRuleFilter = 'all' | 'unmapped' | 'auto' | 'rule' | 'null' | 'default';

// Unmapped 만 빨강; 나머지는 #059669 → #8aedc3 사이를 RGB 직선 보간으로 균등 4 분할.
// 순서 (진함 → 옅음): Pass · Rule · Default · Null
const TOBE_RULE_COLORS: Record<Exclude<TobeRuleFilter, 'all'>, string> = {
  unmapped: 'var(--red)',
  auto:     '#059669',  // step 0/3 — darkest
  rule:     '#31B387',  // step 1/3
  default:  '#5ED0A5',  // step 2/3
  null:     '#8AEDC3',  // step 3/3 — lightest
};

function TobeCoverageBar({ total, ruleCounts, filter, onFilter, hideFilters }: {
  total: number;
  ruleCounts: { unmapped: number; auto: number; rule: number; null: number; default: number };
  filter: TobeRuleFilter;
  onFilter: (f: TobeRuleFilter) => void;
  /** 자식 link 시 필터 chip 들만 숨김 (progress track / state 라벨은 유지). */
  hideFilters?: boolean;
}) {
  const pct = (n: number) => (total === 0 ? 0 : (n / total) * 100);
  const btn = (key: TobeRuleFilter, label: string, count: number, dotColor?: string) => {
    const isActive = filter === key;
    return (
      <button
        key={key}
        onClick={() => onFilter(key)}
        style={{
          ...styles.coverageFilterBtn,
          background: isActive ? 'var(--panel)' : 'transparent',
          borderColor: isActive ? 'var(--border-strong)' : 'transparent',
          color: isActive ? 'var(--text)' : 'var(--text-2)',
          fontWeight: isActive ? 700 : 500,
        }}
      >
        {dotColor && <span style={{ ...styles.coverageDot, background: dotColor }} />}
        <span>{label}</span>
        <span style={{ ...styles.coverageFilterCount, color: isActive ? 'var(--text)' : 'var(--text-3)' }}>{count}</span>
      </button>
    );
  };
  return (
    <div style={{ ...styles.coverageWrap, minWidth: 980 }}>
      <div style={styles.coverageHeader}>
        <span style={styles.coverageLabel}>State</span>
        <div style={{ ...styles.coverageFilters, visibility: hideFilters ? 'hidden' : 'visible' }}>
          {btn('all',      'All',         total)}
          {btn('unmapped', 'Unmapped',    ruleCounts.unmapped, TOBE_RULE_COLORS.unmapped)}
          {btn('auto',     'Pass',        ruleCounts.auto,     TOBE_RULE_COLORS.auto)}
          {btn('rule',     'Rule',        ruleCounts.rule,     TOBE_RULE_COLORS.rule)}
          {btn('default',  'Default',     ruleCounts.default,  TOBE_RULE_COLORS.default)}
          {btn('null',     'Null',        ruleCounts.null,     TOBE_RULE_COLORS.null)}
        </div>
      </div>
      <div style={styles.coverageTrack}>
        <div style={{ width: `${pct(ruleCounts.unmapped)}%`, background: TOBE_RULE_COLORS.unmapped }} />
        <div style={{ width: `${pct(ruleCounts.auto)}%`,     background: TOBE_RULE_COLORS.auto }} />
        <div style={{ width: `${pct(ruleCounts.rule)}%`,     background: TOBE_RULE_COLORS.rule }} />
        <div style={{ width: `${pct(ruleCounts.default)}%`,  background: TOBE_RULE_COLORS.default }} />
        <div style={{ width: `${pct(ruleCounts.null)}%`,     background: TOBE_RULE_COLORS.null }} />
      </div>
    </div>
  );
}

function TobeBindingEmpty({ tableName }: { tableName: string }) {
  return (
    <div style={styles.centerEmpty}>
      <div style={styles.emptyCard}>
        <div style={styles.emptyEyebrow}>No source binding yet</div>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8, fontFamily: 'var(--mono)' }}>{tableName}</div>
        <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.6, marginBottom: 14 }}>
          이 TO-BE 테이블에 아직 AS-IS 소스가 지정되지 않았습니다. 어느 AS-IS 테이블에서 데이터를 가져올지 먼저 정의해야 컬럼 매핑을 시작할 수 있습니다.
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button style={styles.btnPrimary}><Ic.plus /> Bind AS-IS source</button>
          <button style={styles.btnSecondary}>Auto-suggest by name</button>
        </div>
      </div>
    </div>
  );
}

// ── Small reusable UI atoms ──────────────────────────────────

function StatusBadge({ tone, children }: { tone: 'ok' | 'warn' | 'err' | 'info' | 'blue' | 'skip' | 'queued'; children: React.ReactNode }) {
  const palette = {
    ok:     { color: 'var(--green)', bg: 'var(--green-50)', border: 'var(--green)' },
    warn:   { color: 'var(--amber)', bg: 'var(--amber-50)', border: 'var(--amber)' },
    err:    { color: 'var(--red)',   bg: 'var(--red-50)',   border: 'var(--red)' },
    info:   { color: 'var(--navy)',  bg: 'var(--navy-50)',  border: 'var(--navy)' },
    blue:   { color: '#01589C',      bg: 'rgba(1, 88, 156, 0.12)', border: '#01589C' },
    skip:   { color: 'var(--text-3)', bg: 'var(--panel-2)', border: 'var(--border-strong)' },
    queued: { color: 'var(--text-2)', bg: 'var(--panel-2)', border: 'var(--border-strong)' },
  }[tone];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '1px 6px', borderRadius: 2,
      fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
      color: palette.color, background: palette.bg, border: `1px solid ${palette.border}`,
      letterSpacing: 0.3, whiteSpace: 'nowrap',
    }}>{children}</span>
  );
}

function RuleTag({ rule, status }: { rule: MappingRow['rule']; status?: MappingRow['status'] }) {
  const labels: Record<MappingRow['rule'], string> = {
    auto: 'Pass', rule: 'Rule', null: 'Null', default: 'Default',
    unmapped: 'Unmapped', added: 'New', skip: 'Skip', link: 'Link',
  };
  if (rule === 'link') return <StatusBadge tone="info">Linked</StatusBadge>;
  // status err/warn 은 색을 덮어쓴다 (룰과 무관하게 위험 신호 우선).
  if (status === 'err') return <StatusBadge tone="err">{labels[rule]}</StatusBadge>;
  if (status === 'warn') return <StatusBadge tone="warn">{labels[rule]}</StatusBadge>;
  if (rule === 'skip') return <StatusBadge tone="skip">{labels[rule]}</StatusBadge>;
  if (rule === 'added') return <StatusBadge tone="info">{labels[rule]}</StatusBadge>;
  // Pass / Rule / Null / Default / Unmapped — 필터바 dot 색을 좌측 dot 으로 가져오고
  // 칩 자체는 같은 hue 의 옅은 배경 + 진한 텍스트로 통일. unmapped 만 red 팔레트.
  const dot = TOBE_RULE_COLORS[rule];
  const isUnmapped = rule === 'unmapped';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '1px 7px 1px 6px', borderRadius: 10,
      fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
      color: isUnmapped ? '#b91c1c' : '#065f46',
      background: isUnmapped ? '#fef2f2' : '#ecfdf5',
      border: `1px solid ${dot}`,
      letterSpacing: 0.2, whiteSpace: 'nowrap',
    }}>
      <span style={{
        display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
        background: dot, flexShrink: 0,
      }} />
      {labels[rule]}
    </span>
  );
}

function TypeBadge({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      display: 'inline-block',
      padding: '1px 5px',
      borderRadius: 2,
      fontFamily: 'var(--mono)', fontSize: 10.5,
      color: 'var(--text-2)', background: 'var(--panel-2)',
      border: '1px solid var(--border)',
      whiteSpace: 'nowrap',
    }}>{children}</span>
  );
}

function SourceAliasTag({ alias }: { alias?: string; composition?: TobeTable['compositionKind'] }) {
  if (!alias) {
    return <span style={{ color: 'var(--text-4)', fontSize: 10 }}>—</span>;
  }
  return (
    <span style={{
      fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
      color: 'var(--navy)', background: 'var(--navy-50)',
      border: '1px solid var(--navy)', borderRadius: 2,
      padding: '1px 5px',
    }}>{alias}</span>
  );
}

// ── Styles ───────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  // Break out of AppShell's content padding (18px) so the dual-pane fills.
  fullBleed: {
    display: 'flex',
    margin: -18,
    height: 'calc(100% + 36px)',
    minHeight: 0,
    background: 'var(--panel)',
  },

  // Left inventory tabs
  invTabs: {
    display: 'flex', height: 34, flexShrink: 0,
    borderBottom: '1px solid var(--border)',
    background: 'var(--panel)',
  },
  invTab: {
    flex: 1, border: 'none', background: 'transparent',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
    cursor: 'pointer', fontSize: 11.5, fontFamily: 'var(--mono)',
    letterSpacing: 0.3,
  },
  invTabCount: {
    fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
    padding: '0 5px', borderRadius: 2,
    border: '1px solid',
  },

  // Left inventory
  inventory: {
    width: 260, minWidth: 260,
    borderRight: '1px solid var(--border)',
    background: 'var(--panel)',
    display: 'flex', flexDirection: 'column',
  },
  inventoryHeader: { padding: '10px 12px 8px', borderBottom: '1px solid var(--border)' },
  invHeaderLabel: {
    fontSize: 10.5, color: 'var(--text-3)',
    textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6,
  },
  searchBox: {
    display: 'flex', alignItems: 'center', gap: 5,
    height: 22, padding: '0 6px',
    border: '1px solid var(--border)', borderRadius: 3,
    background: 'var(--panel-2)', color: 'var(--text-3)',
  },
  searchInput: {
    flex: 1, border: 'none', background: 'transparent', outline: 'none',
    fontSize: 11.5, color: 'var(--text)', fontFamily: 'var(--mono)',
    minWidth: 0,
  },
  unroutedToggle: {
    display: 'flex', alignItems: 'center', gap: 5, marginTop: 6,
    fontSize: 10.5, color: 'var(--text-3)', cursor: 'pointer',
  },
  inventoryScroll: { flex: 1, overflow: 'auto', padding: '4px 0' },

  treeHeader: {
    padding: '4px 12px 3px', cursor: 'pointer',
    display: 'flex', alignItems: 'center', gap: 6,
    fontSize: 10, color: 'var(--text-2)',
    textTransform: 'uppercase', letterSpacing: 0.7, fontWeight: 600,
  },
  sideBadge: {
    fontFamily: 'var(--mono)', fontSize: 9.5,
    padding: '0 5px', borderRadius: 2,
    border: '1px solid', // color set inline
  },
  treeCount: { color: 'var(--text-4)', fontFamily: 'var(--mono)', fontSize: 10 },
  treeStats: {
    margin: '0 10px 4px 28px',
    display: 'flex', flexWrap: 'wrap', gap: 4,
    fontSize: 9.5, fontFamily: 'var(--mono)',
  },
  statChip: { padding: '0 5px', borderRadius: 2, border: '1px solid' },
  treeEmpty: { padding: '8px 14px', fontSize: 10.5, color: 'var(--text-3)' },

  invItem: { padding: '4px 12px', cursor: 'pointer' },
  invItemRow: {
    display: 'flex', alignItems: 'center', gap: 6,
    fontFamily: 'var(--mono)', fontSize: 11.5,
  },
  invItemName: { fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 },
  invItemBadge: {
    fontSize: 9, fontFamily: 'var(--mono)', fontWeight: 600,
    padding: '0 4px', borderRadius: 2,
    border: '1px solid',
    whiteSpace: 'nowrap', flexShrink: 0,
  },
  invItemSub: {
    fontSize: 9.5, color: 'var(--text-4)', fontFamily: 'var(--mono)',
    marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },

  // Workspace
  workspace: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 },

  /* Quarantine 강조 row 의 종료(skip) 버튼 — State 칼럼, 빨강 톤. */
  rowSkipBtn: {
    padding: '2px 9px', border: '1px solid #e85d75', borderRadius: 999,
    background: 'var(--panel)', color: '#c92a3f',
    fontSize: 10.5, fontWeight: 700, cursor: 'pointer', lineHeight: 1.4,
  },

  contextBar: {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '10px 14px',
    borderBottom: '1px solid var(--border)',
    background: 'var(--panel)',
  },
  sidePill: {
    fontSize: 9.5, fontFamily: 'var(--mono)', fontWeight: 700,
    border: '1px solid', borderRadius: 2, padding: '1px 5px',
  },
  tableChip: {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '3px 8px', borderRadius: 4,
    border: '1px solid var(--border)', background: 'var(--panel-2)',
    fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 500,
  },
  // 프로젝트의 고정핀 snapshot version 표시. green 강조 + 클릭 시 Versions 페이지로 이동.
  baselinePinChip: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '3px 8px', borderRadius: 4,
    border: '1px solid var(--green)', background: 'var(--green-50)',
    color: 'var(--green)',
    fontFamily: 'var(--mono)', fontSize: 11.5, fontWeight: 600,
    whiteSpace: 'nowrap',
    cursor: 'pointer',
  },
  statusCounts: {
    display: 'flex', alignItems: 'center', gap: 6,
    fontSize: 11.5, color: 'var(--text-3)', fontFamily: 'var(--mono)',
  },

  noSourceBanner: {
    padding: '6px 14px',
    background: 'var(--amber-50)', borderBottom: '1px solid var(--amber)',
    display: 'flex', alignItems: 'center', gap: 8,
    fontSize: 11, color: 'var(--amber)',
  },

  // Binding
  bindingWrap: { borderBottom: '1px solid var(--border)', background: 'var(--panel-2)' },
  bindingHeader: {
    padding: '7px 14px',
    display: 'flex', alignItems: 'center', gap: 10,
    cursor: 'pointer',
  },
  bindingLabel: {
    fontSize: 10, color: 'var(--text-3)',
    textTransform: 'uppercase', letterSpacing: 0.7,
  },
  bindingExpr: {
    display: 'flex', alignItems: 'center', gap: 6,
    fontFamily: 'var(--mono)', fontSize: 11.5, minWidth: 0, flex: 1,
    flexWrap: 'wrap',
  },
  aliasChip: {
    fontSize: 9.5, fontWeight: 700, color: 'var(--navy)',
    background: 'var(--panel)', padding: '0 4px', borderRadius: 2,
    border: '1px solid var(--navy)', fontFamily: 'var(--mono)',
  },
  aliasChipFilled: {
    fontSize: 10, fontWeight: 700, color: 'var(--navy)',
    background: 'var(--panel)', padding: '1px 5px', borderRadius: 2,
    border: '1px solid var(--navy)', fontFamily: 'var(--mono)',
  },
  whereChip: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '1px 6px', borderRadius: 2,
    background: 'var(--amber-50)', color: 'var(--amber)',
    border: '1px solid var(--amber)',
    fontSize: 9.5, fontWeight: 700, fontFamily: 'var(--mono)',
    letterSpacing: 0.3,
  },
  bindingBody: { padding: '10px 14px 14px', borderTop: '1px dashed var(--border)' },
  bindingBodyHeader: {
    display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8,
    fontSize: 10.5, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.7,
  },
  modeToggle: {
    display: 'inline-flex',
    border: '1px solid var(--border-strong)', borderRadius: 3,
    overflow: 'hidden', marginLeft: 4,
  },
  modeBtn: {
    padding: '2px 9px', border: 'none', background: 'var(--panel)',
    color: 'var(--text-2)', fontWeight: 500,
    fontSize: 10.5, fontFamily: 'var(--mono)',
    letterSpacing: 0.3, cursor: 'pointer',
  },
  modeBtnActive: { background: 'var(--navy-50)', color: 'var(--navy)', fontWeight: 600 },
  bindingHint: {
    padding: 10, borderRadius: 3,
    border: '1px dashed var(--border-strong)', background: 'var(--panel)',
    fontSize: 11, color: 'var(--text-3)',
  },
  sourceRow: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '6px 10px',
    borderRadius: 3,
  },
  joinSelect: {
    height: 22, padding: '0 6px',
    border: '1px solid var(--border-strong)', borderRadius: 3,
    background: 'var(--panel)', fontSize: 11, fontFamily: 'var(--mono)',
    color: 'var(--text-2)',
  },
  joinOnLabel: {
    fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 700,
    color: 'var(--navy)', width: 22, flexShrink: 0,
  },
  joinOnInput: {
    flex: 1, height: 22, padding: '0 7px',
    border: '1px solid var(--border-strong)', borderRadius: 3,
    background: 'var(--panel)', color: 'var(--text)',
    fontFamily: 'var(--mono)', fontSize: 11, outline: 'none',
  },
  whereLabel: {
    fontSize: 10.5, color: 'var(--text-3)',
    textTransform: 'uppercase', letterSpacing: 0.7,
    marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6,
  },
  whereHint: { fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-4)', textTransform: 'none', letterSpacing: 0 },
  whereInput: {
    width: '100%', height: 28, padding: '0 10px',
    border: '1px solid', borderRadius: 3,
    fontFamily: 'var(--mono)', fontSize: 11.5,
    boxSizing: 'border-box',
  },

  // Toolbar
  toolbar: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '8px 14px',
    borderBottom: '1px solid var(--border)',
    background: 'var(--panel)',
  },
  toolbarSearch: {
    display: 'flex', alignItems: 'center', gap: 6,
    height: 26, padding: '0 8px', minWidth: 240,
    border: '1px solid var(--border)', borderRadius: 4,
    background: 'var(--panel-2)', color: 'var(--text-3)',
  },
  ruleFilter: {
    display: 'flex', height: 26, flexShrink: 0,
    border: '1px solid var(--border)', borderRadius: 4,
    overflow: 'hidden', background: 'var(--panel)',
  },
  ruleFilterBtn: {
    padding: '0 8px', border: 'none',
    fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap' as const,
  },

  // Grid
  gridSplit: { flex: 1, display: 'flex', minHeight: 0 },
  gridScroll: { flex: 1, overflow: 'auto', background: 'var(--panel)' },
  gridTable: { width: '100%', borderCollapse: 'collapse', fontSize: 12.5 },
  gridTh: {
    padding: '6px 10px', textAlign: 'left',
    fontWeight: 500, fontSize: 11,
    color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.6,
    background: 'var(--panel-2)',
    borderBottom: '1px solid var(--border)',
    position: 'sticky', top: 0,
    whiteSpace: 'nowrap',
  },
  gridTd: { padding: '5px 10px' },
  gridEmpty: { padding: 24, textAlign: 'center', color: 'var(--text-3)', fontSize: 12 },

  // Inspector
  inspector: {
    width: 340, minWidth: 340,
    borderLeft: '1px solid var(--border)',
    background: 'var(--panel)',
    display: 'flex', flexDirection: 'column',
    overflow: 'hidden',  // outer 는 스크롤 없음 — 내부 영역만 스크롤
  },
  inspectorHeader: {
    padding: '12px 14px', borderBottom: '1px solid var(--border)',
    position: 'sticky', top: 0, zIndex: 1, background: 'var(--panel)',
    flexShrink: 0,
  },
  inspectorHeaderTopRow: {
    display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6,
  },
  inspectorHeaderBtn: {
    height: 22, padding: '0 10px', borderRadius: 3,
    background: 'transparent', color: 'var(--text-2)',
    border: '1px solid var(--border-strong)',
    fontSize: 10.5, fontWeight: 600, cursor: 'pointer',
    fontFamily: 'var(--mono)', letterSpacing: 0.3,
  },
  inspectorHeaderIconBtn: {
    width: 22, height: 22, padding: 0, borderRadius: 3,
    background: 'transparent', color: 'var(--text-3)',
    border: '1px solid transparent',
    cursor: 'pointer',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  },
  inspectorHeaderClose: {
    width: 22, height: 22, padding: 0, borderRadius: 3,
    background: 'transparent', color: 'var(--text-3)',
    border: '1px solid transparent',
    cursor: 'pointer',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  },
  inspectorBody: {
    flex: 1, minHeight: 0, overflow: 'auto',
  },
  inspectorEyebrow: {
    fontSize: 10.5, color: 'var(--text-3)',
    textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 4,
  },
  inspectorMeta: { padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10, fontSize: 12 },
  metaRow: { display: 'flex', alignItems: 'center', gap: 10, minHeight: 20 },
  metaRowKey: { width: 110, color: 'var(--text-3)', fontSize: 11.5 },
  metaInput: {
    height: 22, padding: '0 7px',
    border: '1px solid var(--border-strong)', borderRadius: 3,
    background: 'var(--panel-2)', color: 'var(--text)',
    fontFamily: 'var(--mono)', fontSize: 11.5, outline: 'none',
    width: '100%', boxSizing: 'border-box',
  },
  metaSelect: {
    height: 22, padding: '0 6px',
    border: '1px solid var(--border-strong)', borderRadius: 3,
    background: 'var(--panel-2)', color: 'var(--text)',
    fontFamily: 'var(--mono)', fontSize: 11, outline: 'none',
    width: '100%', boxSizing: 'border-box',
  },
  addSourceRow: {
    display: 'flex', alignItems: 'center', gap: 6, marginTop: 8,
    padding: '8px 10px',
    background: 'var(--panel)', borderRadius: 3,
    border: '1px dashed var(--border-strong)',
  },
  addSourceSelect: {
    flex: 1, height: 24, padding: '0 6px',
    border: '1px solid var(--border-strong)', borderRadius: 3,
    background: 'var(--panel-2)', fontSize: 11, fontFamily: 'var(--mono)',
    color: 'var(--text-2)', minWidth: 0,
  },
  addSourceAlias: {
    width: 56, height: 24, padding: '0 6px',
    border: '1px solid var(--border-strong)', borderRadius: 3,
    background: 'var(--panel-2)', fontSize: 11, fontFamily: 'var(--mono)',
    color: 'var(--text)', outline: 'none', textAlign: 'center' as const,
  },
  acDropdown: {
    position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 200,
    background: 'var(--panel)', border: '1px solid var(--navy)',
    borderTop: 'none', borderRadius: '0 0 4px 4px',
    boxShadow: '0 6px 16px rgba(0,0,0,0.35)',
    overflow: 'hidden',
  },
  acItem: {
    padding: '5px 10px',
    fontFamily: 'var(--mono)', fontSize: 11.5,
    cursor: 'pointer', whiteSpace: 'nowrap',
  },
  srcAddBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    height: 22, padding: '0 8px',
    background: 'transparent', color: 'var(--text-3)',
    border: '1px dashed var(--border-strong)', borderRadius: 3,
    fontSize: 10.5, cursor: 'pointer', fontFamily: 'var(--mono)',
    alignSelf: 'flex-start',
  },
  srcRemoveBtn: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 20, height: 22, flexShrink: 0,
    background: 'transparent', color: 'var(--text-4)',
    border: '1px solid var(--border-strong)', borderRadius: 3,
    fontSize: 13, cursor: 'pointer', lineHeight: 1,
  },

  strategyBtnGroup: {
    display: 'inline-flex', marginBottom: 8,
    border: '1px solid var(--border-strong)', borderRadius: 3, overflow: 'hidden',
  },
  strategyBtn: {
    padding: '2px 10px', border: 'none', background: 'var(--panel)',
    color: 'var(--text-2)', fontWeight: 500,
    fontSize: 10.5, fontFamily: 'var(--mono)', cursor: 'pointer',
    borderRight: '1px solid var(--border-strong)',
  },
  strategyBtnActive: { background: 'var(--navy-50)', color: 'var(--navy)', fontWeight: 700 },

  section: { padding: '10px 14px 6px', borderTop: '1px solid var(--border)' },
  sectionLabel: {
    fontSize: 10.5, color: 'var(--text-3)',
    textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6,
    display: 'flex', alignItems: 'center', gap: 6,
  },
  sectionLabelToggle: {
    fontSize: 10.5, color: 'var(--text-3)',
    textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6,
    display: 'flex', alignItems: 'center', gap: 6,
    cursor: 'pointer', userSelect: 'none',
  },
  ruleErrorMsg: {
    marginTop: 5,
    padding: '4px 8px',
    background: 'var(--red-50)',
    border: '1px solid var(--red)',
    borderRadius: 3,
    fontSize: 11, color: 'var(--red)',
    fontFamily: 'var(--mono)',
    lineHeight: 1.4,
  },
  javaEditor: {
    width: '100%', minHeight: 100,
    padding: 10, background: '#0e1a2b', color: '#cad7e8',
    fontFamily: 'var(--mono)', fontSize: 11.5, borderRadius: 4, lineHeight: 1.5,
    border: '1px solid var(--border-strong)', resize: 'vertical',
    boxSizing: 'border-box', outline: 'none',
  },
  codeBlock: {
    padding: 10, background: '#0e1a2b', color: '#cad7e8',
    fontFamily: 'var(--mono)', fontSize: 11.5, borderRadius: 4, lineHeight: 1.5,
  },
  mockChip: {
    padding: '0 5px', fontSize: 9, fontFamily: 'var(--mono)', fontWeight: 600,
    background: 'var(--amber-50)', color: 'var(--amber)',
    border: '1px solid var(--amber)', borderRadius: 2,
    textTransform: 'none', letterSpacing: 0,
  },
  sampleTable: {
    border: '1px solid var(--border)', borderRadius: 3,
    background: 'var(--panel-2)', overflow: 'hidden',
  },
  sampleHeader: {
    display: 'grid', gridTemplateColumns: '1fr 1fr',
    padding: '3px 8px', fontSize: 10, fontFamily: 'var(--mono)',
    color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.5,
    background: 'var(--panel)', borderBottom: '1px solid var(--border)',
    gap: 0,
  },
  sampleRow: {
    display: 'grid', gridTemplateColumns: '1fr 1fr',
    padding: '2px 8px',
    fontFamily: 'var(--mono)', fontSize: 11,
    borderBottom: '1px solid var(--border)',
    gap: 0,
  },
  inspectorActions: {
    padding: 14, marginTop: 'auto',
    borderTop: '1px solid var(--border)',
    display: 'flex', gap: 6,
  },
  inspectorRail: {
    width: 22, minWidth: 22,
    borderLeft: '1px solid var(--border)',
    borderRight: '1px solid var(--border)',
    background: 'var(--panel-2)',
    cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  ruleEditor: {
    width: '100%', minHeight: 72,
    padding: 10, background: '#0e1a2b', color: '#cad7e8',
    fontFamily: 'var(--mono)', fontSize: 11.5, borderRadius: 4, lineHeight: 1.5,
    border: '1px solid var(--navy)', resize: 'vertical',
    boxSizing: 'border-box', outline: 'none',
  },
  inspectorRailLabel: {
    writingMode: 'vertical-rl', transform: 'rotate(180deg)',
    fontSize: 10.5, fontFamily: 'var(--mono)', color: 'var(--text-3)',
    letterSpacing: 0.5, textTransform: 'uppercase',
  },

  // AS-IS detail
  asisHint: {
    padding: '6px 14px',
    background: 'var(--amber-50)', borderBottom: '1px solid var(--amber)',
    display: 'flex', alignItems: 'center', gap: 8,
    fontSize: 11, color: 'var(--amber)',
  },
  routingPanel: { padding: '10px 14px', borderBottom: '1px solid var(--border)', background: 'var(--panel-2)' },
  routingHeader: {
    fontSize: 10, color: 'var(--text-3)',
    textTransform: 'uppercase', letterSpacing: 0.7, marginBottom: 6,
  },
  routingEmpty: {
    padding: 10, borderRadius: 3,
    border: '1px dashed var(--amber)', background: 'var(--amber-50)',
    fontSize: 11, color: 'var(--amber)',
  },
  routeRow: {
    display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
    padding: '4px 8px',
    border: '1px solid var(--border)', borderRadius: 3, background: 'var(--panel)',
    fontFamily: 'var(--mono)', fontSize: 11.5,
    cursor: 'pointer',
  },
  whereTag: {
    padding: '1px 6px', borderRadius: 2,
    background: 'var(--amber-50)', color: 'var(--amber)',
    border: '1px solid var(--amber)',
    fontSize: 10, fontWeight: 600, letterSpacing: 0.2,
  },

  // Coverage bar (AS-IS Columns tab)
  coverageWrap: {
    padding: '10px 14px',
    borderBottom: '1px solid var(--border)',
    background: 'var(--panel-2)',
    position: 'sticky', top: 0, zIndex: 2,
  },
  coverageHeader: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    fontSize: 11, marginBottom: 6,
  },
  coverageLabel: {
    fontSize: 10, color: 'var(--text-3)',
    textTransform: 'uppercase', letterSpacing: 0.7,
  },
  coverageLegend: {
    display: 'inline-flex', alignItems: 'center',
    fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-2)',
  },
  coverageDot: {
    display: 'inline-block', width: 8, height: 8, borderRadius: 2, marginRight: 4,
  },
  coverageFilters: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
  },
  coverageFilterBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    height: 22, padding: '0 10px', borderRadius: 4,
    border: '1px solid transparent',
    fontSize: 11, cursor: 'pointer',
    fontFamily: 'inherit',
  },
  coverageFilterCount: {
    fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 700,
    padding: '0 5px', borderRadius: 6,
    background: 'var(--panel-2)', border: '1px solid var(--border)',
  },
  coverageTrack: {
    display: 'flex', height: 6, borderRadius: 3, overflow: 'hidden',
    background: 'var(--border)',
  },

  // TO-BE target chip (AS-IS Columns "Mapped TO-BE")
  tobeTargetChip: {
    display: 'inline-flex', alignItems: 'center',
    padding: '1px 6px', borderRadius: 3,
    border: '1px solid var(--border)', background: 'var(--panel)',
    fontFamily: 'var(--mono)', fontSize: 11,
    cursor: 'pointer',
  },

  // Skip toggle (AS-IS Columns Action)
  skipBtnOff: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    height: 20, padding: '0 8px', borderRadius: 3,
    background: 'var(--panel)', color: 'var(--text-2)',
    border: '1px solid var(--border-strong)',
    fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600,
    cursor: 'pointer', whiteSpace: 'nowrap',
  },
  skipBtnOn: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    height: 20, padding: '0 8px', borderRadius: 3,
    background: 'var(--panel-2)', color: 'var(--text-3)',
    border: '1px solid var(--border-strong)',
    fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600,
    cursor: 'pointer', whiteSpace: 'nowrap',
  },

  // Empty states
  centerEmpty: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 32 },
  emptyCard: {
    maxWidth: 460, padding: 22,
    border: '1px dashed var(--border-strong)', borderRadius: 6,
    background: 'var(--panel)',
  },
  emptyEyebrow: {
    fontSize: 11, color: 'var(--text-3)',
    textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6,
  },

  // Buttons
  btnPrimary: {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    height: 26, padding: '0 10px',
    background: 'var(--navy)', color: '#fff',
    border: '1px solid var(--navy)', borderRadius: 4,
    fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  // Test 옆 Report chip
  reportChip: {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    height: 26, padding: '0 10px', marginLeft: -6,
    background: 'var(--panel)', color: 'var(--navy)',
    border: '1px solid var(--navy)', borderRadius: 4,
    fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
    fontFamily: 'inherit',
  },

  // ── Report view (Excel UI prototype 그대로) ───────────────
  // ── Report view (DBeaver UI prototype) ───────────────
  dbvWindow: {
    flex: 1, minHeight: 0, minWidth: 0,
    margin: 10,
    display: 'flex', flexDirection: 'column',
    background: '#ffffff',
    fontFamily: '"Segoe UI", "맑은 고딕", "Malgun Gothic", system-ui, sans-serif',
    fontSize: 12, color: '#1f1f1f',
    userSelect: 'none',
    border: '1px solid #c8c6c4', borderRadius: 8, overflow: 'hidden',
    boxShadow: '0 2px 10px rgba(0,0,0,0.06)',
  },
  dbvTitlebar: {
    height: 28, background: '#FFFFFF', color: '#000',
    display: 'flex', alignItems: 'center', padding: '0 8px',
    fontSize: 12, flexShrink: 0,
  },
  dbvTitlebarLeft: { display: 'flex', alignItems: 'center', gap: 8 },
  dbvLogo: { width: 18, height: 18, objectFit: 'contain', display: 'inline-block' },
  dbvTitleText: { color: '#000', fontSize: 12, fontWeight: 500 },
  dbvTitlebarRight: { marginLeft: 'auto', display: 'flex', alignItems: 'stretch', height: '100%' },
  dbvTitleBtn: {
    width: 40, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    color: '#555', fontSize: 13, cursor: 'default',
    background: 'transparent', border: 'none', fontFamily: 'inherit',
  },
  dbvTitleBtnClose: { cursor: 'pointer' },

  dbvMenubar: {
    height: 24, background: '#FFFFFF', color: '#000',
    display: 'flex', alignItems: 'center', padding: '0 8px',
    fontSize: 12, flexShrink: 0,
  },
  dbvMenuItem: {
    padding: '0 10px', height: 24, lineHeight: '24px',
    cursor: 'default', color: '#000',
  },

  dbvToolbar: {
    height: 32, background: '#ECECEC',
    borderBottom: '1px solid #c8c8c8',
    display: 'flex', alignItems: 'center', padding: '0 4px', gap: 4,
    flexShrink: 0,
  },
  dbvToolBtn: {
    width: 24, height: 24,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    color: '#555', fontSize: 12, borderRadius: 2, cursor: 'default',
  },
  dbvToolSep: { width: 1, height: 18, background: '#c0c0c0', margin: '0 2px' },
  dbvToolDropdown: {
    display: 'inline-flex', alignItems: 'center',
    height: 22, padding: '0 6px',
    background: '#ffffff', border: '1px solid #c0c0c0', borderRadius: 2,
    fontSize: 11, color: '#1f1f1f', margin: '0 2px', gap: 4, cursor: 'default',
  },
  dbvToolDropArrow: { color: '#888', fontSize: 9 },

  dbvTabbar: {
    height: 28, background: '#ECECEC',
    display: 'flex', alignItems: 'flex-end',
    padding: '0 4px', flexShrink: 0,
    overflowX: 'auto', overflowY: 'hidden',
  },
  dbvTab: {
    height: 24, padding: '0 10px', marginTop: 4,
    background: '#ECECEC', color: '#555', fontSize: 12,
    display: 'inline-flex', alignItems: 'center', gap: 6,
    cursor: 'default',
    borderTopLeftRadius: 2, borderTopRightRadius: 2,
    whiteSpace: 'nowrap', flexShrink: 0,
  },
  dbvTabActive: {
    background: '#FFFFFF', color: '#000',
    borderBottom: '2px solid #2DBD96',
    height: 26, marginTop: 2,
    fontWeight: 600,
  },
  dbvTabClose: { color: '#555', fontSize: 11, marginLeft: 2 },

  dbvSubtabs: {
    height: 28, background: '#ECECEC',
    display: 'flex', alignItems: 'stretch', padding: 0,
    flexShrink: 0,
  },
  dbvSubtab: {
    padding: '0 14px', height: 28,
    display: 'inline-flex', alignItems: 'center',
    color: '#555', fontSize: 12, cursor: 'default',
    background: '#ECECEC',
  },
  dbvSubtabActive: {
    background: '#FFFFFF', color: '#000', fontWeight: 600,
    boxShadow: 'inset 0 -2px 0 #2DBD96',
  },

  dbvFilterbar: {
    height: 30, background: '#F5F5F5',
    borderBottom: '1px solid #d0d0d0',
    display: 'flex', alignItems: 'center', padding: '0 6px', gap: 6,
    flexShrink: 0,
  },
  dbvFilterShowSql: {
    height: 22, padding: '0 10px',
    background: '#ffffff', border: '1px solid #c0c0c0', borderRadius: 2,
    fontSize: 11, color: '#1f1f1f',
    display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'default',
  },
  dbvFilterInput: {
    flex: 1, height: 22,
    background: '#ffffff', border: '1px solid #c0c0c0', borderRadius: 2,
    padding: '0 8px',
    fontSize: 11, color: '#a0a0a0', fontStyle: 'italic',
    display: 'flex', alignItems: 'center',
  },
  dbvFilterIcons: { display: 'flex', alignItems: 'center', gap: 2 },
  dbvFilterIcon: {
    width: 22, height: 22,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    color: '#555', fontSize: 11, borderRadius: 2, cursor: 'default',
  },

  dbvGridArea: {
    flex: 1, overflow: 'auto', background: '#ffffff', minHeight: 0, minWidth: 0,
  },
  dbvGrid: {
    borderCollapse: 'collapse',
    fontFamily: '"Segoe UI", "맑은 고딕", system-ui, sans-serif',
    fontSize: 12, background: '#ffffff',
    width: 'max-content', minWidth: '100%',
  },
  dbvGridCorner: {
    position: 'sticky', top: 0, left: 0, zIndex: 3,
    width: 44, height: 32,
    background: '#F0F0F0',
    borderRight: '1px solid #CCCCCC', borderBottom: '1px solid #CCCCCC',
    padding: 0,
  },
  dbvGridCol: {
    position: 'sticky', top: 0, zIndex: 1,
    minWidth: 120, height: 32,
    background: '#F0F0F0',
    borderRight: '1px solid #CCCCCC', borderBottom: '1px solid #CCCCCC',
    color: '#000', fontSize: 11.5, fontWeight: 600,
    textAlign: 'left', padding: '0 6px',
    whiteSpace: 'nowrap', cursor: 'pointer',
  },
  dbvColHeaderInner: { display: 'flex', alignItems: 'center', width: '100%' },
  dbvColTypeIcon: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    minWidth: 22, height: 16, padding: '0 2px',
    color: '#2DBD96', fontSize: 10, fontWeight: 700,
    fontFamily: '"Segoe UI", sans-serif',
    marginRight: 5,
    background: 'transparent',
    letterSpacing: 0.2, textTransform: 'uppercase',
  },
  dbvColCaret: { color: '#2DBD96', fontSize: 9, marginLeft: 'auto', paddingLeft: 8 },

  dbvRowNum: {
    position: 'sticky', left: 0, zIndex: 1,
    width: 44, height: 22,
    background: '#F0F0F0',
    borderRight: '1px solid #CCCCCC', borderBottom: '1px solid #ebebeb',
    color: '#555', fontSize: 11, textAlign: 'center', padding: '0 4px',
    fontFamily: '"Consolas", "Courier New", monospace',
  },
  dbvCell: {
    minWidth: 120, height: 22, padding: '0 6px',
    background: '#FFFFFF', color: '#000',
    borderRight: '1px solid #ebebeb', borderBottom: '1px solid #ebebeb',
    fontSize: 12, verticalAlign: 'middle',
    whiteSpace: 'nowrap',
    fontFamily: '"Consolas", "Segoe UI", monospace',
  },
  dbvCellZebra: { background: '#F0FBF7' },
  dbvCellNum: { textAlign: 'right' },
  dbvCellNull: { color: '#BBBBBB', fontStyle: 'italic' },

  dbvStatusbar: {
    height: 28, background: '#ECECEC',
    borderTop: '1px solid #d0d0d0',
    display: 'flex', alignItems: 'center', padding: '0 6px', gap: 4,
    fontSize: 11, color: '#555555', flexShrink: 0,
  },
  dbvStatusBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    height: 22, padding: '0 6px', borderRadius: 2,
    background: 'transparent', color: '#555555', cursor: 'default',
  },
  dbvStatusBtnDropdown: {},  // 화살표는 텍스트로 직접 (CSS ::after 안 쓰는 인라인 한계)
  dbvStatusSep: { width: 1, height: 16, background: '#c8c8c8', margin: '0 2px' },
  dbvStatusCenter: { flex: 1, textAlign: 'center', color: '#555555', fontSize: 11 },
  dbvStatusRight: { color: '#555555', fontSize: 11, padding: '0 8px' },

  dbvBreadcrumb: {
    height: 24, background: '#ECECEC',
    borderTop: '1px solid #d0d0d0',
    display: 'flex', alignItems: 'center', padding: '0 8px', gap: 4,
    fontSize: 11, color: '#1A9E7A', flexShrink: 0,
  },
  dbvCrumb: { display: 'inline-flex', alignItems: 'center', gap: 4 },
  dbvCrumbSep: { color: '#999', margin: '0 2px' },

  xlWindow: {
    flex: 1, minHeight: 0, minWidth: 0,
    margin: 10,
    display: 'flex', flexDirection: 'column',
    background: '#ffffff',
    fontFamily: '"Calibri", "Segoe UI", "맑은 고딕", "Malgun Gothic", system-ui, sans-serif',
    fontSize: 11,
    color: '#201f1e',
    userSelect: 'none',
    border: '1px solid #c8c6c4',
    borderRadius: 8,
    overflow: 'hidden',
    boxShadow: '0 2px 10px rgba(0, 0, 0, 0.06)',
  },
  xlTitlebar: {
    height: 28, background: '#217346', color: '#ffffff',
    display: 'flex', alignItems: 'center', padding: 0,
    fontSize: 11.5, flexShrink: 0, position: 'relative',
  },
  xlTitleCenter: {
    position: 'absolute', left: '50%', transform: 'translateX(-50%)',
    color: '#ffffff', fontSize: 11.5, letterSpacing: 0.2,
  },
  xlTitleRight: {
    marginLeft: 'auto', display: 'flex', alignItems: 'stretch', height: '100%',
  },
  xlTitleBtn: {
    width: 46, height: 28, padding: 0,
    background: 'transparent', color: '#ffffff',
    border: 'none', fontSize: 13,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    cursor: 'default',
    fontFamily: 'inherit',
  },
  xlTitleBtnClose: { cursor: 'pointer' },

  xlRibbon: {
    height: 28, background: '#217346', color: '#ffffff',
    display: 'flex', alignItems: 'flex-end',
    padding: '0 8px', fontSize: 12, flexShrink: 0,
  },
  xlRibbonTab: {
    padding: '4px 12px', height: 24, lineHeight: '16px',
    color: 'rgba(255,255,255,0.92)', cursor: 'default',
  },
  xlRibbonTabFile: { background: '#185c37', fontWeight: 600 },
  xlRibbonTabActive: {
    background: '#f3f2f1', color: '#201f1e', fontWeight: 600,
    borderTopLeftRadius: 2, borderTopRightRadius: 2,
  },
  xlRibbonBody: {
    height: 4, background: '#f3f2f1',
    borderBottom: '1px solid #d0d0d0', flexShrink: 0,
  },

  xlFormulaBar: {
    height: 24, background: '#F3F3F3',
    display: 'flex', alignItems: 'stretch',
    borderBottom: '1px solid #D0D0D0',
    flexShrink: 0, padding: '2px 4px', gap: 4,
  },
  xlNameBox: {
    width: 110, background: '#FFFFFF',
    border: '1px solid #D0D0D0',
    display: 'flex', alignItems: 'center', padding: '0 8px',
    fontSize: 11, color: '#201f1e',
  },
  xlNameBoxCaret: { marginLeft: 'auto', fontSize: 9, color: '#605e5c' },
  xlFormulaButtons: {
    display: 'flex', alignItems: 'center', gap: 2, padding: '0 4px',
  },
  xlFormulaBtn: {
    width: 20, height: 18,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent', color: '#888', fontSize: 11,
    cursor: 'default',
  },
  xlFormulaBtnCancel: { color: '#b40000' },
  xlFormulaBtnConfirm: { color: '#006400' },
  xlFormulaBtnFx: {
    color: '#605e5c',
    fontFamily: '"Cambria Math", "Times New Roman", serif',
    fontStyle: 'italic', fontSize: 12,
  },
  xlFormulaInput: {
    flex: 1, background: '#FFFFFF', border: '1px solid #D0D0D0',
    padding: '0 8px', display: 'flex', alignItems: 'center',
    fontSize: 11, color: '#201f1e',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },

  xlSheetArea: {
    flex: 1, overflow: 'auto', background: '#ffffff', minHeight: 0, minWidth: 0,
  },
  xlSheet: {
    borderCollapse: 'collapse',
    fontFamily: '"Calibri", "Segoe UI", system-ui, sans-serif',
    fontSize: 11, background: '#ffffff',
    width: 'max-content', minWidth: '100%',
  },
  xlCorner: {
    position: 'sticky', top: 0, left: 0, zIndex: 3,
    width: 32, height: 20, background: '#e1e1e1',
    borderRight: '1px solid #b8b8b8', borderBottom: '1px solid #b8b8b8',
    padding: 0,
  },
  xlColHeader: {
    position: 'sticky', top: 0, zIndex: 1,
    minWidth: 100, height: 20, background: '#e1e1e1', color: '#555',
    borderRight: '1px solid #c8c8c8', borderBottom: '1px solid #b8b8b8',
    fontSize: 11, fontWeight: 400, textAlign: 'center',
  },
  xlRowHeader: {
    position: 'sticky', left: 0, zIndex: 1,
    width: 32, height: 20, background: '#e1e1e1', color: '#555',
    borderRight: '1px solid #b8b8b8', borderBottom: '1px solid #d8d8d8',
    fontSize: 11, fontWeight: 400, textAlign: 'center', padding: 0,
  },
  xlRowHeaderName: { top: 20, left: 0, zIndex: 2, borderBottom: 'none' },
  xlRowHeaderType: { top: 42, left: 0, zIndex: 2, borderBottom: '1px solid #b8b8b8' },
  xlColName: {
    position: 'sticky', top: 20, zIndex: 1,
    minWidth: 100, height: 22,
    padding: '3px 6px 0 6px',
    background: '#f3f2f1', color: '#217346',
    fontSize: 12, fontWeight: 700, textAlign: 'left',
    borderRight: '1px solid #c8c8c8', borderBottom: 'none',
    verticalAlign: 'bottom', whiteSpace: 'nowrap',
    cursor: 'pointer',
  },
  xlColType: {
    position: 'sticky', top: 42, zIndex: 1,
    minWidth: 100, height: 20,
    padding: '0 6px 3px 6px',
    background: '#f3f2f1', color: '#605e5c',
    fontSize: 10.5, fontWeight: 400, textAlign: 'left',
    borderRight: '1px solid #c8c8c8', borderBottom: '1px solid #b8b8b8',
    verticalAlign: 'top', whiteSpace: 'nowrap',
    cursor: 'pointer',
  },
  xlCell: {
    minWidth: 100, height: 20, padding: '0 6px',
    background: '#ffffff', color: '#201f1e',
    borderRight: '1px solid #e1e1e1', borderBottom: '1px solid #e1e1e1',
    fontSize: 11, verticalAlign: 'middle',
  },

  xlSheetTabs: {
    height: 22, background: '#f3f2f1',
    borderTop: '1px solid #d0d0d0',
    display: 'flex', alignItems: 'center', padding: '0 8px', gap: 4,
    flexShrink: 0,
  },
  xlSheetTab: {
    padding: '2px 14px', fontSize: 11, color: '#444',
    background: '#ffffff', border: '1px solid #c8c8c8',
    borderBottom: 'none', marginTop: 2, cursor: 'default',
  },
  xlSheetTabActive: {
    color: '#217346', fontWeight: 700,
    borderBottom: '2px solid #217346',
  },
  xlStatusBar: {
    height: 22, background: '#217346', color: '#ffffff',
    display: 'flex', alignItems: 'center', padding: '0 12px',
    fontSize: 11, flexShrink: 0,
  },

  // ── 옛 report* (사용 안 함, 유지하면 컴파일 OK) ────────
  reportWrap: {
    flex: 1, minHeight: 0,
    display: 'flex', flexDirection: 'column',
    background: '#ffffff',
    fontFamily: '"Segoe UI", "Calibri", system-ui, sans-serif',
  },
  // 짙은 녹색 Excel title bar (Artifacts 와 같은 #217346)
  reportTitleBar: {
    display: 'flex', alignItems: 'center', gap: 10,
    height: 30,
    padding: '0 0 0 0',
    background: '#217346',
    color: '#ffffff',
    fontSize: 11.5, fontWeight: 400,
    flexShrink: 0,
  },
  reportTitleText: {
    fontSize: 11.5, color: '#ffffff', fontWeight: 400,
    letterSpacing: 0.1,
    textAlign: 'center',
  },
  // Formula bar — 진한 회색 (Artifacts formulaSpacer 와 같은 회색 tone 통일).
  // Name box / fx 도 같은 회색.
  reportFormulaBar: {
    display: 'flex', alignItems: 'stretch', gap: 0,
    height: 22,
    background: '#e1e1e1',
    borderBottom: '1px solid #d0cfce',
    flexShrink: 0,
  },
  reportNameBox: {
    display: 'inline-flex', alignItems: 'center',
    width: 80, padding: '0 8px',
    background: '#e1e1e1',
    color: '#201f1e',
    fontFamily: '"Calibri", "Segoe UI", system-ui, sans-serif',
    fontSize: 11,
    borderRight: '1px solid #d0cfce',
  },
  reportFxBtn: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 28,
    background: '#e1e1e1',
    color: '#605e5c',
    fontFamily: '"Cambria Math", "Times New Roman", serif',
    fontSize: 12, fontStyle: 'italic',
    borderRight: '1px solid #d0cfce',
  },
  reportFormulaInput: {
    flex: 1, padding: '0 10px',
    background: '#ffffff',
    display: 'flex', alignItems: 'center',
    fontFamily: '"Calibri", "Segoe UI", system-ui, sans-serif',
    fontSize: 11, color: '#201f1e',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  reportTitleClose: {
    width: 46, height: 32, padding: 0,
    background: 'transparent',
    color: '#ffffff',
    border: 'none',
    fontSize: 16, fontWeight: 400,
    cursor: 'pointer',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    fontFamily: 'inherit',
  },
  // 시트 영역
  reportBody: {
    flex: 1, minHeight: 0, overflow: 'auto',
    background: '#ffffff',
  },
  reportTable: {
    borderCollapse: 'collapse',
    fontFamily: '"Calibri", "Segoe UI", system-ui, sans-serif',
    fontSize: 11,
    width: 'max-content',
    minWidth: '100%',
    background: '#ffffff',
  },
  // 좌상단 corner cell (A 위, 1 왼쪽) — 진한 회색 (formula bar / 헤더 톤과 통일)
  reportCornerCell: {
    position: 'sticky', top: 0, left: 0, zIndex: 3,
    width: 36, height: 20,
    background: '#e1e1e1',
    borderRight: '1px solid #d0cfce',
    borderBottom: '1px solid #d0cfce',
    padding: 0,
  },
  // A B C ... 알파벳 컬럼 헤더 — 진한 회색
  reportAlphaCell: {
    position: 'sticky', top: 0, zIndex: 1,
    minWidth: 110,
    height: 20,
    padding: '0 4px',
    background: '#e1e1e1',
    color: '#444',
    borderRight: '1px solid #d0cfce',
    borderBottom: '1px solid #d0cfce',
    fontSize: 11, fontWeight: 400,
    textAlign: 'center',
    userSelect: 'none',
  },
  // 데이터 row 번호 (3, 4, 5...) — 진한 회색 (헤더 톤)
  reportRowNumCell: {
    position: 'sticky', left: 0, zIndex: 1,
    width: 36, height: 20,
    background: '#e1e1e1',
    color: '#444',
    borderRight: '1px solid #d0cfce',
    borderBottom: '1px solid #e8e8e8',
    fontSize: 11, fontWeight: 400,
    textAlign: 'center',
    padding: 0,
  },
  // Row 1: 컬럼명 — 옅은 회색 (Artifacts ribbon 톤), 셀 병합 효과로 아래 가로 border 제거
  reportHeaderRowNumName: {
    position: 'sticky', top: 20, left: 0, zIndex: 3,
    width: 36, height: 22,
    background: '#e1e1e1',
    color: '#444',
    borderRight: '1px solid #d0cfce',
    borderBottom: 'none',  // ← Row 2 와 셀 병합 효과
    fontSize: 11, fontWeight: 400,
    textAlign: 'center',
    padding: 0,
  },
  reportHeaderNameOnly: {
    position: 'sticky', top: 20, zIndex: 1,
    minWidth: 110, height: 22,
    padding: '4px 6px 0 6px',
    background: '#f3f2f1',
    color: '#217346',
    borderRight: '1px solid #d0cfce',
    borderBottom: 'none',  // ← Row 2 와 셀 병합 효과
    textAlign: 'left',
    fontSize: 11.5, fontWeight: 700,
    cursor: 'pointer',
    userSelect: 'none',
    whiteSpace: 'nowrap',
    overflow: 'hidden', textOverflow: 'ellipsis',
    verticalAlign: 'bottom',
  },
  // Row 2: 타입 — 옅은 회색, sticky top 42
  reportHeaderRowNumType: {
    position: 'sticky', top: 42, left: 0, zIndex: 3,
    width: 36, height: 20,
    background: '#e1e1e1',
    color: '#444',
    borderRight: '1px solid #d0cfce',
    borderBottom: '1px solid #d0cfce',
    fontSize: 11, fontWeight: 400,
    textAlign: 'center',
    padding: 0,
  },
  reportHeaderTypeOnly: {
    position: 'sticky', top: 42, zIndex: 1,
    minWidth: 110, height: 20,
    padding: '0 6px 4px 6px',
    background: '#f3f2f1',
    color: '#605e5c',
    borderRight: '1px solid #d0cfce',
    borderBottom: '1px solid #d0cfce',
    textAlign: 'left',
    fontSize: 10.5, fontWeight: 400,
    cursor: 'pointer',
    userSelect: 'none',
    whiteSpace: 'nowrap',
    verticalAlign: 'top',
  },
  reportCell: {
    minWidth: 110, height: 20,
    padding: '0 6px',
    background: '#ffffff',
    color: '#201f1e',
    borderRight: '1px solid #e8e8e8',
    borderBottom: '1px solid #e8e8e8',
    fontSize: 11,
    verticalAlign: 'middle',
  },
  reportStatusBar: {
    height: 22,
    padding: '0 12px',
    borderTop: '1px solid #d0cfce',
    background: '#217346',
    fontSize: 11, color: '#ffffff',
    display: 'flex', alignItems: 'center',
    flexShrink: 0,
    fontFamily: '"Segoe UI", "Calibri", system-ui, sans-serif',
  },

  dialectChip: {
    display: 'inline-flex', alignItems: 'center',
    padding: '2px 8px', borderRadius: 3,
    fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600,
    color: 'var(--text-3)', background: 'var(--panel-2)',
    border: '1px solid var(--border-strong)',
    whiteSpace: 'nowrap', letterSpacing: 0.3,
  },
  csvMissingBtn: {
    background: 'transparent', border: 'none', padding: 0,
    cursor: 'pointer', display: 'inline-flex', alignItems: 'center',
  },

  // Import mapping spec modal
  modalBackdrop: {
    position: 'fixed', inset: 0, zIndex: 1000,
    background: 'rgba(0, 0, 0, 0.45)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 20,
  },
  modalCard: {
    background: 'var(--panel)',
    border: '1px solid var(--border-strong)',
    borderRadius: 6,
    width: 520, maxWidth: '100%',
    display: 'flex', flexDirection: 'column',
    boxShadow: '0 10px 32px rgba(0, 0, 0, 0.2)',
  },
  modalHeader: {
    padding: '14px 16px',
    borderBottom: '1px solid var(--border)',
    display: 'flex', alignItems: 'center', gap: 8,
  },
  modalTemplateBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    height: 26, padding: '0 10px',
    border: '1px solid var(--border-strong)', borderRadius: 4,
    background: 'var(--panel)', color: '#1A9E7A',
    fontSize: 11.5, fontFamily: 'var(--mono)', fontWeight: 600,
    cursor: 'pointer', textDecoration: 'none',
    whiteSpace: 'nowrap',
  },
  modalTitle: {
    fontSize: 14, fontWeight: 700, color: 'var(--text)',
    marginBottom: 4,
  },
  modalSubtitle: {
    fontSize: 11.5, color: 'var(--text-3)',
  },
  modalBody: {
    padding: 16,
    display: 'flex', flexDirection: 'column', gap: 12,
  },
  modalDropZone: {
    border: '2px dashed var(--border-strong)',
    borderRadius: 6,
    padding: '28px 16px',
    cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    minHeight: 100,
    transition: 'background 120ms, border-color 120ms',
  },
  modalHint: {
    display: 'flex', alignItems: 'flex-start', gap: 6,
    padding: 10,
    background: 'var(--amber-50)',
    border: '1px solid var(--amber)',
    borderRadius: 4,
    color: 'var(--amber)',
    fontSize: 11, lineHeight: 1.5,
  },
  modalFooter: {
    padding: '12px 16px',
    borderTop: '1px solid var(--border)',
    display: 'flex', justifyContent: 'flex-end', gap: 6,
  },
  btnPrimaryDisabled: {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    height: 26, padding: '0 10px',
    background: 'var(--panel-2)', color: 'var(--text-4)',
    border: '1px solid var(--border-strong)', borderRadius: 4,
    fontSize: 11.5, fontWeight: 600, cursor: 'not-allowed',
    whiteSpace: 'nowrap', opacity: 0.7,
  },
  btnPrimarySm: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    height: 24, padding: '0 9px',
    background: 'var(--navy)', color: '#fff',
    border: '1px solid var(--navy)', borderRadius: 4,
    fontSize: 11, fontWeight: 600, cursor: 'pointer',
  },
  btnSecondary: {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    height: 26, padding: '0 10px',
    background: 'var(--panel)', color: 'var(--text-2)',
    border: '1px solid var(--border-strong)', borderRadius: 4,
    fontSize: 11.5, fontWeight: 500, cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  btnGhost: {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    height: 26, padding: '0 9px',
    background: 'transparent', color: 'var(--text-2)',
    border: '1px solid transparent', borderRadius: 4,
    fontSize: 11.5, fontWeight: 500, cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
};
