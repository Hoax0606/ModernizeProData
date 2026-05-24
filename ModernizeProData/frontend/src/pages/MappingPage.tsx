import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWorkspaceStore } from '../store/workspace';
import { useAsisDdlStore } from '../store/asisDdl';
import { useTobeDdlStore } from '../store/tobeDdl';
import { useT } from '../i18n';
import { useMappingEditsStore, type TableBindingEdit } from '../store/mappingEdits';
import { useUiStore } from '../store/ui';
import type { DdlSchema, DdlTableWithColumns } from '../api/asisDdl';
import { projectApi } from '../api/workspace';
import { csvPreviewApi, type CsvPreview } from '../api/csvPreview';
import { mappingImportApi, type MappingStatus as MappingStatusDto, type MappingReportResult } from '../api/mappingImport';
import { MappingOnboarding } from './DashboardPage';

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
};

type MappingRow = {
  src: string;
  tgt: string;
  srcType: string;
  tgtType: string;
  rule: 'auto' | 'rule' | 'unmapped' | 'null' | 'default' | 'added' | 'skip';
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
  // dialect 는 site 의 DB type 을 1차 source 로 사용 (DDL 재임포트 없이 즉시 반영).
  // site 정보가 없거나 type 이 비어있으면 ddl_imports.dialect 폴백.
  const siteForDialect = useWorkspaceStore((s) => {
    const p = s.projects.find((p) => p.id === s.activeProjectId);
    return p ? s.sites.find((st) => st.id === p.siteId) ?? null : null;
  });
  useEffect(() => {
    ASIS_TABLES = ddlToAsisTables(asisSchema);
    // PoC: Site 의 csvPath 가 채워져 있으면 모든 AS-IS 테이블을 imported 로 간주.
    // (실제 파일 존재 / 행 수 검증은 백엔드 CSV import API 가 생기면 그 응답으로 교체.)
    if (siteForDialect?.csvPath && siteForDialect.csvPath.trim() !== '') {
      ASIS_TABLES = ASIS_TABLES.map((t) => ({ ...t, imported: true }));
    }
    TOBE_TABLES = ddlToTobeTables(tobeSchema);
    ASIS_COLUMNS = ddlToAsisColumns(asisSchema);
    MAPPING_BY_TOBE = ddlToMappingByTobe(tobeSchema);
    const asisRaw = siteForDialect?.asisDbType;
    const tobeRaw = siteForDialect?.tobeDbByEnv?.[siteForDialect.environment]?.type;
    ASIS_DIALECT = asisRaw ? normalizeDialect(asisRaw) : (asisSchema?.latestImport?.dialect ?? 'oracle');
    TOBE_DIALECT = tobeRaw ? normalizeDialect(tobeRaw) : (tobeSchema?.latestImport?.dialect ?? 'oracle');
    setHydrationTick((t) => t + 1);
  }, [asisSchema, tobeSchema, siteForDialect]);

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
    setSelected(null);
  }, [activeProjectId]);
  // hydrate 후 첫 TOBE 자동 선택 (프로젝트당 한 번).
  useEffect(() => {
    if (didInitialSelectRef.current) return;
    if (TOBE_TABLES.length === 0) return;  // TO-BE 아직 안 옴 — 다음 tick 대기
    const first = TOBE_TABLES[0];
    setSelected({ side: 'tobe', name: first.name, internalName: first.internalName });
    didInitialSelectRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrationTick]);
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

  const tableBindingEdits = useMappingEditsStore(
    (s) => (activeProjectId ? s.tableBindingEdits[activeProjectId] : undefined) || EMPTY_BINDING_EDITS,
  );
  const asisSkippedCols = useMappingEditsStore(
    (s) => (activeProjectId ? s.asisSkippedCols[activeProjectId] : undefined) || EMPTY_SKIP_COLS,
  );

  const handleBindingChange = useCallback((internalName: string, edit: TableBindingEdit) => {
    if (!activeProjectId) return;
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
    }).catch((e) => console.warn('[mapping] upsertBinding failed', e));
  }, [activeProjectId]);

  const handleToggleAsisSkip = useCallback((tableName: string, colName: string, nextSkip: boolean) => {
    if (!activeProjectId) return;
    useMappingEditsStore.getState().setAsisSkip(activeProjectId, tableName, colName, nextSkip);
  }, [activeProjectId]);

  const effectiveTobe = useMemo(() =>
    TOBE_TABLES.map((t) => {
      const edit = tableBindingEdits[t.internalName];
      if (!edit) return t;
      const srcs = edit.sources;
      return {
        ...t,
        sources: srcs,
        unrouted: srcs.length === 0,
        compositionKind: (srcs.length === 0 ? 'none' : srcs.length === 1 ? 'single' : edit.mode) as TobeTable['compositionKind'],
        whereFilter: edit.whereFilter ?? t.whereFilter,
      };
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tableBindingEdits, hydrationTick]);

  const effectiveAsis = useMemo(() => {
    const routedByAsis: Record<string, string[]> = {};
    for (const t of effectiveTobe) {
      for (const s of t.sources) {
        (routedByAsis[s.table] ||= []).push(t.internalName);
      }
    }
    return ASIS_TABLES.map((at) => {
      const r = routedByAsis[at.name] || [];
      return { ...at, routing: r, unrouted: r.length === 0 };
    });
  }, [effectiveTobe]);

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
          <div style={{ color: 'var(--text-3)', fontSize: 13 }}>DDL 로딩 중…</div>
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
        selected={selected}
        onSelect={setSelected}
        search={search}
        setSearch={setSearch}
        showUnrouted={showUnrouted}
        setShowUnrouted={setShowUnrouted}
      />
      <Workspace
        selected={selected}
        onSelect={setSelected}
        tableBindingEdits={tableBindingEdits}
        onBindingChange={handleBindingChange}
        effectiveTobe={effectiveTobe}
        asisSkippedCols={asisSkippedCols}
        onToggleAsisSkip={handleToggleAsisSkip}
      />
    </div>
  );
}

// ── Left: dual inventory ─────────────────────────────────────

function DualInventory({
  asis, tobe, selected, onSelect,
  search, setSearch, showUnrouted, setShowUnrouted,
}: {
  asis: AsisTable[]; tobe: TobeTable[];
  selected: Selection;
  onSelect: (s: Selection) => void;
  search: string; setSearch: (v: string) => void;
  showUnrouted: boolean; setShowUnrouted: (v: boolean) => void;
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
            placeholder="Filter…"
            style={styles.searchInput}
          />
        </div>
        <label style={styles.unroutedToggle}>
          <input
            type="checkbox"
            checked={showUnrouted}
            onChange={(e) => setShowUnrouted(e.target.checked)}
            style={{ margin: 0 }}
          />
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
            />
          ) : null
        )}
      </div>
    </aside>
  );
}

function InventoryTree({
  label, side, tables, allTables, selected, onSelect, alwaysOpen,
}: {
  label: string; side: Side;
  tables: (AsisTable | TobeTable)[];
  allTables: (AsisTable | TobeTable)[];
  selected: Selection;
  onSelect: (s: Selection) => void;
  alwaysOpen?: boolean;
}) {
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
          <div style={styles.ddlPath} title="imported 2026-05-19 14:02">
            ↳ {side === 'asis' ? 'asis_schema_v2.ddl' : 'tobe_schema_v1.sql'}
          </div>
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
  let badgeTone: 'ok' | 'warn' | 'info' | null = null;
  if (side === 'tobe') {
    const tt = table as TobeTable;
    if (unrouted)                              { badgeText = 'no source'; badgeTone = 'warn'; }
    else if (tt.compositionKind === 'join')    { badgeText = `⋈ ${tt.sources.length}`; badgeTone = 'info'; }
    else if (tt.compositionKind === 'union')   { badgeText = `∪ ${tt.sources.length}`; badgeTone = 'info'; }
    else                                       { badgeText = '← 1'; badgeTone = 'ok'; }
  } else {
    const at = table as AsisTable;
    if (unrouted) { badgeText = 'unrouted'; badgeTone = 'warn'; }
    else          { badgeText = `→ ${at.routing.length}`; badgeTone = 'ok'; }
  }
  const toneColor = badgeTone === 'warn' ? 'var(--amber)' : badgeTone === 'info' ? 'var(--navy)' : 'var(--green)';
  const toneBg    = badgeTone === 'warn' ? 'var(--amber-50)' : badgeTone === 'info' ? 'var(--navy-50)' : 'var(--green-50)';

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
        <span style={{ ...styles.invItemBadge, color: toneColor, background: toneBg, borderColor: toneColor }}>{badgeText}</span>
      </div>
      <div style={styles.invItemSub}>
        {table.columnCount} cols · {table.rows >= 1e6 ? (table.rows / 1e6).toFixed(1) + 'M' : table.rows.toLocaleString()} rows
      </div>
    </div>
  );
}

// ── Right: workspace ─────────────────────────────────────────

function Workspace({ selected, onSelect, tableBindingEdits, onBindingChange, effectiveTobe, asisSkippedCols, onToggleAsisSkip }: {
  selected: Selection;
  onSelect: (s: Selection) => void;
  tableBindingEdits: Record<string, TableBindingEdit>;
  onBindingChange: (internalName: string, edit: TableBindingEdit) => void;
  effectiveTobe: TobeTable[];
  asisSkippedCols: Record<string, Record<string, boolean>>;
  onToggleAsisSkip: (tableName: string, colName: string, nextSkip: boolean) => void;
}) {
  if (!selected) return <GuidePanel />;
  if (selected.side === 'tobe') {
    const table = TOBE_TABLES.find((t) => t.internalName === selected.internalName);
    if (!table) return <GuidePanel />;
    const bindingEdit = tableBindingEdits[table.internalName];
    const rows = MAPPING_BY_TOBE[table.internalName] || [];
    return (
      <TobeMappingDetail
        key={table.internalName}
        table={table}
        rows={rows}
        bindingEdit={bindingEdit}
        onBindingChange={(edit) => onBindingChange(table.internalName, edit)}
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

// ── TO-BE mapping detail ─────────────────────────────────────

function TobeMappingDetail({ table, rows, bindingEdit, onBindingChange }: {
  table: TobeTable;
  rows: MappingRow[];
  bindingEdit?: TableBindingEdit;
  onBindingChange: (edit: TableBindingEdit) => void;
}) {
  const navigate = useNavigate();
  const [bindingOpen, setBindingOpen] = useState((bindingEdit?.sources ?? table.sources).length === 0);
  const [bindingPulse, setBindingPulse] = useState(false);
  const triggerBindingHighlight = () => {
    setBindingOpen(true);
    setBindingPulse(true);
    window.setTimeout(() => setBindingPulse(false), 1500);
  };
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [importMappingOpen, setImportMappingOpen] = useState(false);
  const [importYamlOpen, setImportYamlOpen] = useState(false);
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

  /**
   * DB 의 mapping_table_bindings → zustand 의 tableBindingEdits 로 hydrate.
   * 임포트 직후 / 페이지 마운트 시 호출. 해당 project 의 binding edits 전부 교체.
   * AS-IS 테이블명은 `{schema}.{table}` 형태로 변환 (frontend AsisTable.name 컨벤션).
   */
  /**
   * Hydrate bindings from DB into zustand. (검증은 별도 — findUncoveredDdlColumns)
   */
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
   * 검증: DDL 의 (TO-BE table.column) 중 매핑정의서 (mapping_rules) 에 없는 것 목록.
   * 사이트의 맵핑정의서는 슈퍼셋이어야 하고, 프로젝트 DDL 은 부분집합. DDL 컬럼이
   * 매핑정의서에 없으면 그 컬럼을 채울 명세가 없는 것 → 사용자에게 경고.
   */
  const findUncoveredDdlColumns = useCallback(async (projectId: string): Promise<string[]> => {
    if (TOBE_TABLES.length === 0) return [];
    try {
      const rules = await mappingImportApi.listRules(projectId);
      const ruleCols = new Map<string, Set<string>>();  // `${schema}|${table}` → Set<column>
      for (const r of rules) {
        const key = (r.tobeSchema || '') + '|' + r.tobeTable;
        if (!ruleCols.has(key)) ruleCols.set(key, new Set());
        ruleCols.get(key)!.add(r.tobeColumn);
      }
      const uncovered: string[] = [];
      for (const tobe of TOBE_TABLES) {
        const i = tobe.name.indexOf('.');
        const schema = i > 0 ? tobe.name.slice(0, i) : '';
        const table = i > 0 ? tobe.name.slice(i + 1) : tobe.name;
        const haveCols = ruleCols.get(schema + '|' + table) || new Set();
        const ddlCols = MAPPING_BY_TOBE[tobe.internalName] || [];
        for (const c of ddlCols) {
          if (!haveCols.has(c.tgt)) uncovered.push(`${tobe.name}.${c.tgt}`);
        }
      }
      return uncovered;
    } catch (e) {
      console.warn('[mapping] failed to compute uncovered DDL columns', e);
      return [];
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
      for (const b of bindings) {
        for (const s of b.sources) {
          aliasMap.set(`${b.tobeSchema}|${b.tobeTable}|${s.asisTable}`, s.alias);
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

        // savedSrc: 가능하면 `{alias}.{column}`, alias 못 찾으면 column 만
        let savedSrc: string[] | undefined;
        if (r.asisColumn) {
          const alias = r.asisTable
            ? aliasMap.get(`${r.tobeSchema}|${r.tobeTable}|${r.asisTable}`)
            : undefined;
          savedSrc = [alias ? `${alias}.${r.asisColumn}` : r.asisColumn];
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
        };
      }
      useMappingEditsStore.getState().replaceRowEdits(projectId, edits);
    } catch (e) {
      console.warn('[mapping] failed to hydrate rowEdits', e);
    }
  }, []);

  const refreshMappingStatus = useCallback(async (): Promise<string[]> => {
    if (!activeProjectIdForRow) return [];
    try {
      const st = await mappingImportApi.status(activeProjectIdForRow);
      setMappingStatus(st);
    } catch {
      setMappingStatus({ columnFilename: null, codeFilename: null, ruleCount: 0, codeMapCount: 0 });
    }
    await hydrateBindingsFromDb(activeProjectIdForRow);
    await hydrateRowEditsFromDb(activeProjectIdForRow);
    return await findUncoveredDdlColumns(activeProjectIdForRow);
  }, [activeProjectIdForRow, hydrateBindingsFromDb, hydrateRowEditsFromDb, findUncoveredDdlColumns]);

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
    hydrateBindingsFromDb(activeProjectIdForRow);
    hydrateRowEditsFromDb(activeProjectIdForRow);
    return () => { cancelled = true; };
  }, [activeProjectIdForRow, hydrateBindingsFromDb, hydrateRowEditsFromDb]);
  const rowEdits = useMappingEditsStore(
    (s) => (activeProjectIdForRow ? s.rowEdits[activeProjectIdForRow]?.[table.internalName] : undefined) || EMPTY_ROW_EDITS,
  );
  const [testStatus, setTestStatus] = useState<'idle' | 'running' | 'completed'>('idle');
  const [testProgress, setTestProgress] = useState(0);
  const startTest = useCallback(async () => {
    setTestStatus('running');
    setTestProgress(0);
    const active = useWorkspaceStore.getState().getActiveProject();
    if (active) {
      try {
        await projectApi.update(active.id, { phase: 'test', runStatus: 'running' });
        const siteId = useWorkspaceStore.getState().activeSiteId;
        if (siteId) await useWorkspaceStore.getState().fetchProjects(siteId);
      } catch (e) {
        console.error('[mapping] phase update (start) failed', e);
      }
    }
  }, []);
  useEffect(() => {
    if (testStatus !== 'running') return;
    const id = window.setInterval(() => {
      setTestProgress((p) => {
        if (p >= 100) {
          window.clearInterval(id);
          setTestStatus('completed');
          const active = useWorkspaceStore.getState().getActiveProject();
          if (active) {
            projectApi.update(active.id, { phase: 'test', runStatus: 'completed' })
              .then(() => {
                const siteId = useWorkspaceStore.getState().activeSiteId;
                if (siteId) return useWorkspaceStore.getState().fetchProjects(siteId);
              })
              .catch((e) => console.error('[mapping] phase update (complete) failed', e));
          }
          return 100;
        }
        return Math.min(100, p + 4);
      });
    }, 80);
    return () => window.clearInterval(id);
  }, [testStatus]);
  const handleSaveEdit = useCallback((r: MappingRow, edit: RowEdit) => {
    if (!activeProjectIdForRow) return;
    // 사용자가 row 편집기에서 저장한 것 = manual
    const editWithOrigin: RowEdit = { ...edit, ruleOrigin: 'manual' };
    useMappingEditsStore.getState().setRowEdit(activeProjectIdForRow, table.internalName, r.tgt, editWithOrigin);

    // DB 영속화 — savedSrc 의 {alias}.{column} 에서 alias 룩업으로 asis_table 복원
    const splitQ = (qn: string) => {
      const i = qn.indexOf('.');
      return i > 0 ? { schema: qn.slice(0, i), table: qn.slice(i + 1) } : { schema: '', table: qn };
    };
    const tobeSplit = splitQ(table.name);
    let asisSchema: string | null = null;
    let asisTable: string | null = null;
    let asisColumn: string | null = null;
    const firstSrc = edit.savedSrc?.find((s) => s && s.trim());
    if (firstSrc) {
      const parts = firstSrc.split('.');
      asisColumn = parts[parts.length - 1];
      if (parts.length >= 2 && bindingEdit) {
        const alias = parts[0];
        const source = bindingEdit.sources.find((s) => s.alias === alias);
        if (source) {
          const ssp = splitQ(source.table);
          asisSchema = ssp.schema || null;
          asisTable = ssp.table;
        }
      }
    }
    const strategy = edit.savedStrategy ?? 'expression';
    mappingImportApi.upsertRule(activeProjectIdForRow, {
      tobeSchema: tobeSplit.schema,
      tobeTable: tobeSplit.table,
      tobeColumn: r.tgt,
      asisSchema, asisTable, asisColumn,
      strategy,
      transformRule: edit.savedRule ?? null,
      transformSql: edit.savedRule ?? null,
      defaultValue: edit.savedDefault ?? null,
      notNullOverride: edit.savedNotNull ?? false,
    }).catch((e) => console.warn('[mapping] upsertRule failed', e));
  }, [activeProjectIdForRow, table.internalName, table.name, bindingEdit]);
  const [bindingSources, setBindingSources] = useState(bindingEdit?.sources ?? table.sources);
  const [bindingMode, setBindingMode] = useState<'join' | 'union'>(
    bindingEdit?.mode ?? (table.compositionKind === 'union' ? 'union' : 'join'),
  );
  const [bindingWhere, setBindingWhere] = useState(bindingEdit?.whereFilter ?? table.whereFilter ?? '');
  // Apply/hydrate 등으로 외부에서 bindingEdit 가 갱신되면 로컬 state 도 따라가게.
  // (useState 는 첫 렌더의 prop 으로만 초기화되어 이후 prop 변경을 못 받음)
  useEffect(() => {
    setBindingSources(bindingEdit?.sources ?? table.sources);
    setBindingMode(bindingEdit?.mode ?? (table.compositionKind === 'union' ? 'union' : 'join'));
    setBindingWhere(bindingEdit?.whereFilter ?? table.whereFilter ?? '');
  }, [bindingEdit, table.internalName, table.sources, table.compositionKind, table.whereFilter]);
  const allRows = useMemo(() => rows.map((r) => {
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
    return eff === r.rule ? r : { ...r, rule: eff };
  }), [rows, rowEdits]);

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
    .map((s) => ASIS_TABLES.find((a) => a.name === s.table))
    .filter((a): a is AsisTable => !!a && !a.imported);
  // TO-BE Target DB 가 Site Settings 에서 "configured" 상태인지 검사 — Site Settings 의
  // 녹색 stage 와 동일 로직 (type/host/database/username 4 개 필드 모두 채워졌는지).
  // tobeDbLocks 는 저장 시 자동 true 가 되어 신뢰할 수 없어 사용하지 않는다.
  const activeSite = useWorkspaceStore((s) => {
    const ap = s.projects.find((p) => p.id === s.activeProjectId);
    return ap ? (s.sites.find((st) => st.id === ap.siteId) ?? null) : null;
  });
  const tobeDb = activeSite ? activeSite.tobeDbByEnv?.[activeSite.environment] : undefined;
  const tobeDbConnected = !!tobeDb
    && !!tobeDb.type?.trim()
    && !!tobeDb.host?.trim()
    && !!tobeDb.database?.trim()
    && !!tobeDb.username?.trim();
  const testDisabled =
    counts.unmapped > 0
    || bindingSources.length === 0
    || missingImports.length > 0
    || !tobeDbConnected;
  const testDisabledReason =
    !tobeDbConnected ? 'TO-BE Target DB connection 정보가 Site Settings 에 완전히 채워져 있지 않습니다. (Site 의 현재 stage 가 녹색이어야 합니다.)'
    : bindingSources.length === 0 ? 'AS-IS source 가 연결되어 있지 않습니다.'
    : missingImports.length > 0 ? `AS-IS extracted data 가 임포트되지 않았습니다: ${missingImports.map((a) => a.short).join(', ')}`
    : counts.unmapped > 0 ? `Unmapped 컬럼이 ${counts.unmapped}개 남아 있습니다.`
    : 'Run test migration for this table';

  return (
    <div style={styles.workspace}>
      {/* Context bar */}
      <div style={styles.contextBar}>
        <span style={{ ...styles.sidePill, color: 'var(--navy)', background: 'var(--navy-50)', borderColor: 'var(--navy)' }}>TO-BE</span>
        <div style={styles.tableChip}>{table.short}</div>
        <div style={{ flex: 1 }} />
        <div style={styles.statusCounts}>
          {(() => {
            // 우선순위 — 환경 설정부터 매핑 작업 순. 한 번에 하나씩만 표시.
            if (!tobeDbConnected) {
              return (
                <button
                  type="button"
                  onClick={() => useUiStore.getState().requestOpenSiteSettings({ focus: 'tobe-db' })}
                  title="Site Settings → TO-BE Target DB 카드를 엽니다."
                  style={styles.csvMissingBtn}
                >
                  <StatusBadge tone="warn">TO-BE DB not configured →</StatusBadge>
                </button>
              );
            }
            if (bindingSources.length === 0) {
              return (
                <button
                  type="button"
                  onClick={triggerBindingHighlight}
                  title="Table binding 패널을 엽니다."
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
                  title="Site Settings → AS-IS CSV path 필드를 엽니다."
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
            : testStatus === 'running' ? `Running… ${testProgress}%`
            : testStatus === 'completed' ? 'Trial completed. Click to re-run.'
            : testDisabledReason
          }
        >
          <Ic.play /> {testStatus === 'running' ? `Running ${testProgress}%` : 'Trial'}
        </button>
        {testStatus === 'completed' && (
          <button
            type="button"
            onClick={() => setReportOpen(true)}
            title="변환 룰을 적용한 TO-BE 데이터 미리보기를 봅니다."
            style={styles.reportChip}
          >
            <Ic.arrow /> Report
          </button>
        )}
      </div>

      {!reportOpen && bindingSources.length === 0 && (
        <div style={styles.noSourceBanner}>
          <Ic.warn />
          <span>AS-IS 테이블이 매핑되지 않았습니다. <b>Table binding</b> 패널에서 <b>+ Add source</b>로 테이블을 추가하세요.</span>
        </div>
      )}
      {!reportOpen && (
        <CollapsibleBinding
          table={table} open={bindingOpen} pulse={bindingPulse} onToggle={() => setBindingOpen((o) => !o)}
          sources={bindingSources}
          onSourcesChange={(s) => { setBindingSources(s); onBindingChange({ sources: s, mode: bindingMode, whereFilter: bindingWhere }); }}
          compositionMode={bindingMode}
          onCompositionModeChange={(m) => { setBindingMode(m); onBindingChange({ sources: bindingSources, mode: m, whereFilter: bindingWhere }); }}
          whereFilter={bindingWhere}
          onWhereChange={(v) => { setBindingWhere(v); onBindingChange({ sources: bindingSources, mode: bindingMode, whereFilter: v }); }}
        />
      )}

      {/* Toolbar */}
      <div style={{ ...styles.toolbar, display: reportOpen ? 'none' : 'flex' }}>
        <div style={styles.toolbarSearch}>
          <Ic.search />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by field name…" style={styles.searchInput} />
        </div>
        <div style={{ flex: 1 }} />
        <button
          style={styles.btnGhost}
          onClick={() => setImportYamlOpen(true)}
        ><Ic.download /> Import YAML</button>
        <button
          style={styles.btnSecondary}
          onClick={() => setImportMappingOpen(true)}
        >{mappingImported ? 'Auto-mapping' : 'Auto-map unmapped'}</button>
      </div>
      {importMappingOpen && (
        <MappingDefinitionImportModal
          projectId={activeProjectIdForRow ?? ''}
          activeFiles={{ column: mappingStatus.columnFilename, code: mappingStatus.codeFilename }}
          onClose={() => setImportMappingOpen(false)}
          onChanged={refreshMappingStatus}
        />
      )}
      {importYamlOpen && (
        <ImportFileModal
          title="Import YAML"
          accept=".yml,.yaml"
          acceptLabel=".yml · .yaml"
          hint="YAML 정의서로 매핑을 일괄 임포트합니다. 매칭된 unmapped 행만 채워지고, 이미 매핑된 행은 덮어쓰지 않습니다."
          onClose={() => setImportYamlOpen(false)}
        />
      )}

      {reportOpen && (
        <ReportView
          table={table}
          rows={reportRows}
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
                return (
                  <tr
                    key={`${r.src}>${r.tgt}-${i}`}
                    onClick={() => {
                      if (inspectorOpen && realIdx === activeIdx) {
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
                          const alias = eff[0].slice(0, eff[0].indexOf('.')) || undefined;
                          return <SourceAliasTag alias={alias} composition={table.compositionKind} />;
                        }
                        return <SourceAliasTag alias={r.sourceAlias} composition={table.compositionKind} />;
                      })()}
                    </td>
                    <td style={styles.gridTd}>
                      {(() => {
                        const savedSrcs = rowEdits[r.tgt]?.savedSrc;
                        if (savedSrcs?.length) {
                          const types = savedSrcs.map((s) => resolveSrcType(s, bindingSources)).filter((t) => t && t !== '—');
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
                    <td style={{ ...styles.gridTd, textAlign: 'center' }}><RuleTag rule={r.rule} status={r.status} /></td>
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
            rowEdit={rowEdits[active?.tgt ?? '']}
            onSave={(edit) => handleSaveEdit(active, edit)}
            onClose={() => setInspectorOpen(false)}
          />
        )}
      </div>
    </div>
  );
}

function srcCellColor(r: MappingRow): string {
  if (r.rule === 'skip') return 'var(--text-3)';
  if (r.rule === 'added' || r.rule === 'unmapped' || r.rule === 'null' || r.rule === 'default') return 'var(--text-4)';
  return 'var(--text)';
}
function arrowColor(r: MappingRow): string {
  if (r.rule === 'skip')     return 'var(--text-4)';
  if (r.rule === 'added')    return 'var(--green)';
  if (r.rule === 'unmapped') return 'var(--text-4)';
  return 'var(--text-3)';
}
function srcCellContent(r: MappingRow): React.ReactNode {
  if (r.rule === 'added')    return <span style={{ fontStyle: 'italic' }}>(new in TO-BE)</span>;
  if (r.rule === 'unmapped') return <span style={{ fontStyle: 'italic' }}>(unassigned)</span>;
  if (r.rule === 'null')     return <span style={{ fontStyle: 'italic', color: 'var(--text-3)' }}>NULL</span>;
  if (r.rule === 'default')  return <span style={{ fontStyle: 'italic', color: 'var(--text-3)' }}>DEFAULT</span>;
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
  value, onChange, completions, placeholder, style,
}: {
  value: string;
  onChange: (v: string) => void;
  completions: string[];
  placeholder?: string;
  style?: React.CSSProperties;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const [acItems, setAcItems] = useState<string[]>([]);
  const [acIdx, setAcIdx] = useState(0);
  const savedCursor = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (savedCursor.current !== null && inputRef.current) {
      inputRef.current.setSelectionRange(savedCursor.current, savedCursor.current);
      savedCursor.current = null;
    }
  }, [value]);

  useEffect(() => {
    if (!focused || !completions.length || !inputRef.current) { setAcItems([]); return; }
    const pos = inputRef.current.selectionStart ?? 0;
    let s = pos;
    while (s > 0 && /[\w.]/.test(value[s - 1])) s--;
    const word = value.slice(s, pos);
    if (word.length < 1) { setAcItems([]); return; }
    const lo = word.toLowerCase();
    const hits = completions.filter((c) => c.toLowerCase().startsWith(lo) && c.toLowerCase() !== lo).slice(0, 10);
    setAcItems(hits);
    setAcIdx(0);
  }, [value, focused, completions]);

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
    inputRef.current.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!acItems.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setAcIdx((i) => Math.min(i + 1, acItems.length - 1)); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setAcIdx((i) => Math.max(i - 1, 0)); return; }
    if (e.key === 'Escape')    { setAcItems([]); return; }
    if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); applyAc(acItems[acIdx]); return; }
  };

  return (
    <div style={{ position: 'relative', flex: 1, minWidth: 0, width: '100%' }}>
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => {
          savedCursor.current = e.target.selectionStart;
          onChange(e.target.value);
        }}
        onKeyDown={handleKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); setAcItems([]); }}
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

function CollapsibleBinding({ table, open, pulse, onToggle, sources, onSourcesChange, compositionMode, onCompositionModeChange, whereFilter, onWhereChange }: {
  table: TobeTable; open: boolean; pulse?: boolean; onToggle: () => void;
  sources: TobeTable['sources']; onSourcesChange: (s: TobeTable['sources']) => void;
  compositionMode: 'join' | 'union'; onCompositionModeChange: (m: 'join' | 'union') => void;
  whereFilter: string; onWhereChange: (v: string) => void;
}) {
  const t = useT();
  const [addingSource, setAddingSource] = useState(false);
  const [pickTable, setPickTable] = useState('');
  const [pickAlias, setPickAlias] = useState('');

  const op = compositionMode === 'union' ? '∪' : '⋈';
  const usedTables = new Set(sources.map((s) => s.table));
  const availableTables = ASIS_TABLES.filter((t) => !usedTables.has(t.name));

  // {alias}.{column} 자동완성 후보 — 현재 binding 의 모든 source 의 컬럼들.
  const datalistId = `mpd-cols-${table.internalName}`;
  const aliasColumnOptions = useMemo(() => {
    const opts: string[] = [];
    for (const s of sources) {
      const cols = ASIS_COLUMNS[s.table] || [];
      for (const c of cols) opts.push(`${s.alias}.${c.name}`);
    }
    return opts;
  }, [sources, table.internalName]);

  const startAdd = () => {
    const first = availableTables[0];
    setPickTable(first?.name ?? '');
    setPickAlias(first ? first.short.slice(0, 2).toLowerCase() : '');
    setAddingSource(true);
  };

  const confirmAdd = () => {
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

  const updateSource = (alias: string, patch: Partial<typeof sources[0]>) =>
    onSourcesChange(sources.map((s) => s.alias === alias ? { ...s, ...patch } : s));

  return (
    <div style={{
      ...styles.bindingWrap,
      ...(pulse ? { boxShadow: 'inset 0 0 0 3px var(--green)', transition: 'box-shadow 200ms' } : {}),
    }}>
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
                  onClick={(e) => { e.stopPropagation(); onCompositionModeChange('join'); }}
                  style={{ ...styles.modeBtn, ...(compositionMode !== 'union' ? styles.modeBtnActive : {}) }}
                >⋈ JOIN</button>
                <button
                  onClick={(e) => { e.stopPropagation(); onCompositionModeChange('union'); }}
                  style={{ ...styles.modeBtn, ...(compositionMode === 'union' ? styles.modeBtnActive : {}) }}
                >∪ UNION</button>
              </div>
            )}
            <div style={{ flex: 1 }} />
            <button
              style={styles.btnGhost}
              onClick={(e) => { e.stopPropagation(); startAdd(); }}
              disabled={availableTables.length === 0 || addingSource}
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
                        style={styles.joinSelect}
                      >
                        <option>LEFT JOIN</option><option>INNER JOIN</option><option>RIGHT JOIN</option><option>FULL JOIN</option>
                      </select>
                    )}
                    <div style={{ flex: 1 }} />
                    <button
                      onClick={() => onSourcesChange(sources.filter((s2) => s2.alias !== s.alias))}
                      title="Remove source"
                      style={styles.srcRemoveBtn}
                    >×</button>
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
              <div style={styles.whereLabel}>
                <span>WHERE filter</span>
                <span style={styles.whereHint}>{t('mapping.binding.whereHint')}</span>
              </div>
              <AutocompleteInput
                completions={aliasColumnOptions}
                value={whereFilter}
                onChange={onWhereChange}
                placeholder={`예: ${sources[0].alias}.party_type = 'P'`}
                style={styles.whereInput}
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
type RowEdit = { savedSrc?: string[]; savedRule?: string; savedDefault?: string; savedNotNull?: boolean; savedStrategy?: 'expression' | 'null' | 'default'; ruleOrigin?: 'imported' | 'manual' };

// Module-level helper so it can be called from useEffect closures
function resolveSrcType(s: string, sources: TobeTable['sources']): string {
  if (!s) return '—';
  const di = s.indexOf('.');
  if (di < 0) {
    // No alias prefix — search every bound source table for the first matching column.
    for (const src of sources) {
      const col = (ASIS_COLUMNS[src.table] || []).find((c) => c.name === s);
      if (col) return col.type;
    }
    return '—';
  }
  const alias = s.slice(0, di);
  const col = s.slice(di + 1);
  const entry = sources.find((e) => e.alias === alias);
  return (entry ? (ASIS_COLUMNS[entry.table] || []).find((c) => c.name === col)?.type : undefined) ?? '—';
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

const _e   = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const _kw  = (s: string) => `<span style="color:#e8b86f">${_e(s)}</span>`;
const _str = (s: string) => `<span style="color:#9fd9b3">${_e(s)}</span>`;
const _cmt = (s: string) => `<span style="color:#7a8aa6">${_e(s)}</span>`;
const _num = (s: string) => `<span style="color:#79c0ff">${_e(s)}</span>`;
const _def = (s: string) => `<span style="color:#cad7e8">${_e(s)}</span>`;

const SQL_KW = new Set(['SELECT','FROM','WHERE','AND','OR','NOT','IN','IS','NULL','AS','CAST','JOIN','LEFT','RIGHT','INNER','OUTER','FULL','ON','TO_DATE','TO_TIMESTAMP','ICONV','UNPACK_COMP3','DROP','DEFAULT','UNION','ALL','DISTINCT','CASE','WHEN','THEN','ELSE','END','TRUE','FALSE','WITH','INSERT','UPDATE','DELETE','LIKE','BETWEEN','EXISTS','COALESCE','NULLIF','TRIM','UPPER','LOWER','SUBSTR','SUBSTRING','LENGTH','CONCAT','EXTRACT','NOW','CURRENT_DATE','CURRENT_TIMESTAMP','NUMERIC','INTEGER','VARCHAR','CHAR','DATE','TIMESTAMP','BOOLEAN','UUID','TEXT','JSONB','INT','BIGINT','FLOAT','DOUBLE','USING','INTO','RETURNS','ORDER','GROUP','BY','HAVING','LIMIT','OFFSET']);

function highlightSql(raw: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < raw.length) {
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
      out.push(SQL_KW.has(w.toUpperCase()) ? _kw(w) : _def(w)); i = j;
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
  value, onChange, language, placeholder, minHeight, hasError, completions,
}: {
  value: string;
  onChange: (v: string) => void;
  language: 'sql' | 'java';
  placeholder?: string;
  minHeight?: number;
  hasError?: boolean;
  completions?: string[];
}) {
  const preRef = useRef<HTMLPreElement>(null);
  const taRef  = useRef<HTMLTextAreaElement>(null);
  const savedCursor = useRef<{ start: number; end: number } | null>(null);
  const [isFocused, setIsFocused] = useState(false);
  const [acItems, setAcItems] = useState<string[]>([]);
  const [acIdx, setAcIdx] = useState(0);

  useLayoutEffect(() => {
    if (savedCursor.current !== null && taRef.current) {
      taRef.current.setSelectionRange(savedCursor.current.start, savedCursor.current.end);
      savedCursor.current = null;
    }
  }, [value]);

  // Refresh autocomplete after each value/focus change (runs after cursor is restored)
  useEffect(() => {
    if (!isFocused || !completions?.length || !taRef.current) { setAcItems([]); return; }
    const pos = taRef.current.selectionStart;
    let s = pos;
    while (s > 0 && /[\w.]/.test(value[s - 1])) s--;
    const word = value.slice(s, pos);
    if (word.length < 1) { setAcItems([]); return; }
    const lo = word.toLowerCase();
    const hits = completions.filter((c) => c.toLowerCase().startsWith(lo) && c.toLowerCase() !== lo).slice(0, 10);
    setAcItems(hits);
    setAcIdx(0);
  }, [value, isFocused]); // eslint-disable-line react-hooks/exhaustive-deps

  const applyAc = (item: string) => {
    if (!taRef.current) return;
    const pos = taRef.current.selectionStart;
    let s = pos;
    while (s > 0 && /[\w.]/.test(value[s - 1])) s--;
    const before = value.slice(0, s);
    const after = value.slice(pos);
    savedCursor.current = { start: before.length + item.length, end: before.length + item.length };
    onChange(before + item + after);
    setAcItems([]);
    taRef.current.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!acItems.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setAcIdx((i) => Math.min(i + 1, acItems.length - 1)); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setAcIdx((i) => Math.max(i - 1, 0)); return; }
    if (e.key === 'Escape')    { setAcItems([]); return; }
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
        onBlur={() => { setIsFocused(false); setAcItems([]); }}
        onScroll={syncScroll}
        spellCheck={false}
        style={{ ...shared, position: 'relative', zIndex: 1, color: 'transparent', caretColor: '#cad7e8', background: 'transparent', resize: 'vertical', outline: 'none', overflow: 'auto' }}
      />
      {acItems.length > 0 && (
        <div style={styles.acDropdown}>
          {acItems.map((item, i) => (
            <div
              key={item}
              onMouseDown={(e) => { e.preventDefault(); applyAc(item); }}
              style={{
                ...styles.acItem,
                background: i === acIdx ? 'var(--navy-50)' : 'transparent',
                color: i === acIdx ? 'var(--navy)' : 'var(--text-2)',
              }}
            >
              {item}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Inspector ────────────────────────────────────────────────

function Inspector({ active, composition, sources, rowEdit, onSave, onClose }: {
  active: MappingRow | undefined;
  composition: TobeTable['compositionKind'];
  sources: TobeTable['sources'];
  rowEdit?: RowEdit;
  onSave: (edit: RowEdit) => void;
  onClose: () => void;
}) {
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
  const [userFnOpen, setUserFnOpen] = useState(false);
  const [javaCode, setJavaCode] = useState('');
  useEffect(() => {
    // 같은 컬럼이면 effective rule 갱신으로 active 객체 reference 가 새로 만들어져도
    // 편집 모드를 종료하지 않는다 — active.tgt 만 dep 로 사용.
    setEditingRule(false); setRuleError(null);
    const re = rowEdit;
    setSavedRule(re?.savedRule ?? null);
    setSavedStrategy(re?.savedStrategy ?? null);
    const src = re?.savedSrc ?? null;
    setSavedSrc(src);
    setSavedSrcType(src ? src.map((s) => resolveSrcType(s, sources)) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.tgt]);
  if (!active) return null;
  const initSrc: string[] = active.src === '—' ? [] : [active.sourceAlias ? `${active.sourceAlias}.${active.src}` : active.src];
  const resolveType = (s: string) => resolveSrcType(s, sources);
  const validAliases = new Set(sources.map((s) => s.alias));
  const prevAutoCastRef = useRef('');

  // 슬롯 i 의 source 값을 새 값으로 바꾸고, 첫 번째 슬롯이면 CAST 자동 입력 갱신.
  // editValue 가 비어있거나 이전 자동 CAST 와 같을 때만 덮어써서 사용자 수동 입력은 보존.
  const computeAutoCast = (firstSrc: string | undefined): string => {
    if (!firstSrc || !active) return '';
    const srcCol = firstSrc.includes('.') ? firstSrc.slice(firstSrc.indexOf('.') + 1) : firstSrc;
    const srcT = resolveSrcType(firstSrc, sources);
    if (!srcT || srcT === '—' || active.tgtType === '—') return '';
    // AS-IS type 을 TO-BE dialect 로 정규화한 결과가 TO-BE 컬럼 type 과 같으면 단순 컬럼.
    const translatedSrcT = translateTypeToTobe(srcT, TOBE_DIALECT);
    const same = translatedSrcT.toUpperCase() === active.tgtType.toUpperCase();
    return (same ? srcCol : `CAST(${srcCol} AS ${active.tgtType})`).toUpperCase();
  };

  const handleEdit = () => {
    const inferredStrategy = savedStrategy ?? (active.rule === 'null' ? 'null' : active.rule === 'default' ? 'default' : 'expression');
    setEditStrategy(inferredStrategy);
    // 자동 CAST 생성 — savedSrc 우선, 없으면 active.sourceAlias.src.
    // computeAutoCast 헬퍼를 그대로 써서 TO-BE dialect 변환표가 동일하게 적용됨.
    const firstSrcForCast = (savedSrc && savedSrc.find((s) => s && s.trim() !== ''))
      || (active.src !== '—' ? (active.sourceAlias ? `${active.sourceAlias}.${active.src}` : active.src) : undefined);
    const initialAutoCast = computeAutoCast(firstSrcForCast);
    prevAutoCastRef.current = initialAutoCast;
    setEditValue((savedRule ?? initialAutoCast).toUpperCase());
    // Filter out stale alias references no longer present in current binding
    const rawSrc = savedSrc ?? initSrc;
    const cleanedSrc = rawSrc.filter((s) => {
      if (!s) return true;
      const di = s.indexOf('.');
      const alias = di >= 0 ? s.slice(0, di) : '';
      return !alias || validAliases.has(alias);
    });
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
    onSave({
      savedRule: ruleToSave ?? undefined,
      savedSrc: newSrc ?? [],
      savedStrategy: editStrategy,
    });
    setEditingRule(false);
  };
  const updateEditSrcAt = (i: number, val: string) => {
    const nextEditSrc = editSrc.map((x, j) => (j === i ? val : x));
    setEditSrc(nextEditSrc);
    setEditSrcType((prev) => prev.map((x, j) => (j === i ? resolveType(val) : x)));

    // 1번째 슬롯이 변경되면 expression 자동 채움.
    if (editStrategy !== 'expression') return;
    if (i !== 0) return;
    const firstSrc = nextEditSrc.find((s) => s && s.trim() !== '');
    const newAutoCast = firstSrc
      ? computeAutoCast(firstSrc)
      : '-- NOT MAPPED YET — PICK A STRATEGY';
    setEditValue(newAutoCast);
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
          <button
            type="button"
            onClick={handleClear}
            title="이 컬럼의 매핑·룰 흔적을 모두 초기화합니다."
            style={styles.inspectorHeaderIconBtn}
          ><Ic.refresh /></button>
          <button
            type="button"
            onClick={onClose}
            title="Mapping detail 닫기"
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
                      (ASIS_COLUMNS[src.table] || []).map((c) => (
                        <option key={`${src.alias}.${c.name}`} value={`${src.alias}.${c.name}`}>
                          [{src.alias}] {c.name}  ({c.type})
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
      </div>

      <div style={styles.section}>
        <div style={styles.sectionLabel}>Transform</div>
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
              const localCompletions = (() => {
                const set = new Set<string>();
                editSrc.forEach((s) => {
                  if (!s) return;
                  set.add(s);
                  const di = s.indexOf('.');
                  if (di > 0) set.add(s.slice(di + 1));
                });
                return Array.from(set);
              })();
              return (
                <>
                  <HighlightEditor
                    value={editValue}
                    onChange={(v) => { setEditValue(v.toUpperCase()); if (ruleError) setRuleError(null); }}
                    language="sql"
                    placeholder={transformPlain(active)}
                    hasError={!!ruleError}
                    completions={localCompletions}
                    minHeight={72}
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
            {editStrategy === 'default' && (() => {
              const dv = (active.ddlDefault || 'NULL').trim();
              const t = active.tgtType.toUpperCase();
              const isText = t.includes('CHAR') || t.includes('TEXT') || t.includes('VARCHAR') || t.includes('JSONB') || t.includes('UUID');
              const isNumber = /^-?\d+(\.\d+)?$/.test(dv);
              const isKeyword = ['NULL', 'TRUE', 'FALSE', 'CURRENT_TIMESTAMP', 'NOW()'].includes(dv.toUpperCase());
              const literal = isKeyword ? dv.toUpperCase()
                : isNumber ? dv
                : isText ? `'${dv.replace(/'/g, "''")}'`
                : dv;
              return (
                <div style={styles.codeBlock}>
                  <div>
                    <span style={{ color: '#7a8aa6' }}>-- 모든 행에 대해 이 값으로 채움</span>
                  </div>
                  <div>
                    <span style={{ color: '#9fd9b3' }}>{literal}</span>
                    <span style={{ color: '#7a8aa6' }}>::{active.tgtType}</span>
                    <span style={{ color: '#7a8aa6' }}>{' '}<span style={{ color: '#e8b86f' }}>AS</span> {active.tgt}</span>
                  </div>
                </div>
              );
            })()}
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
            const dv = (active.ddlDefault || '').trim();
            if (!dv) {
              return (
                <div style={styles.codeBlock}>
                  <span style={{ color: '#e8b86f' }}>DEFAULT</span>
                  <span style={{ color: '#7a8aa6' }}>{' '}-- (no default set)</span>
                </div>
              );
            }
            const t = active.tgtType.toUpperCase();
            const isText = t.includes('CHAR') || t.includes('TEXT') || t.includes('VARCHAR') || t.includes('JSONB') || t.includes('UUID');
            const isNumber = /^-?\d+(\.\d+)?$/.test(dv);
            const isKeyword = ['NULL', 'TRUE', 'FALSE', 'CURRENT_TIMESTAMP', 'NOW()'].includes(dv.toUpperCase());
            const literal = isKeyword ? dv.toUpperCase()
              : isNumber ? dv
              : isText ? `'${dv.replace(/'/g, "''")}'`
              : dv;
            return (
              <div style={styles.codeBlock}>
                <div>
                  <span style={{ color: '#9fd9b3' }}>{literal}</span>
                  <span style={{ color: '#7a8aa6' }}>::{active.tgtType}</span>
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
              {transformPreview(active).map((line, i) => (
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
  title, accept, acceptLabel, templateHref, templateFilename, hint, onClose,
}: {
  title: string;
  accept: string;
  acceptLabel: string;
  templateHref?: string;
  templateFilename?: string;
  hint: string;
  onClose: () => void;
}) {
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
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 13 }}>{file.name}</div>
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>
                  {(file.size / 1024).toFixed(1)} KB · 다른 파일을 선택하려면 다시 클릭
                </div>
              </div>
            ) : (
              <div style={{ textAlign: 'center', color: 'var(--text-3)' }}>
                <div style={{ fontSize: 13, marginBottom: 4 }}>파일을 끌어다 놓거나 클릭해서 선택</div>
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

function MappingDefinitionImportModal({
  projectId, activeFiles, onClose, onChanged,
}: {
  projectId: string;
  activeFiles: { column: string | null; code: string | null };
  onClose: () => void;
  /** Returns the list of TO-BE qualified names from DB bindings that didn't match TOBE_TABLES. */
  onChanged: () => Promise<string[]>;
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
        await mappingImportApi.importCsv(projectId, colFile, codFile);
      } else if (!anyPending && (activeFiles.column || activeFiles.code)) {
        // 사용자가 파일 다시 안 고르고 Apply 만 누름 → 마지막 임포트 CSV 로 재적용
        // (수동 수정된 룰 reset)
        await mappingImportApi.reapplyLatest(projectId);
      }
      await mappingImportApi.rebuildBindings(projectId);
      const unmatched = await onChanged();
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
    <div style={styles.modalBackdrop} onClick={saving ? undefined : onClose}>
      <div style={{ ...styles.modalCard, width: 520 }} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <div style={styles.modalTitle}>Mapping Definition</div>
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
            canDelete={activeFiles.column !== null && columnPending.kind !== 'delete'}
          />
          <MappingFileRow
            label="Code mapping"
            displayName={codDisp.name}
            displayMode={codDisp.mode}
            onPick={(f) => setCodePending({ kind: 'upload', file: f })}
            onDelete={() => setCodePending({ kind: 'delete' })}
            canDelete={activeFiles.code !== null && codePending.kind !== 'delete'}
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
          >{saving ? 'Applying…' : 'Apply'}</button>
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
): { result: MappingReportResult | null; loading: boolean } {
  const [result, setResult] = useState<MappingReportResult | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!projectId || !tobeTable) { setResult(null); return; }
    let cancelled = false;
    setLoading(true);
    mappingImportApi.runReport(projectId, tobeSchema, tobeTable, 20)
      .then((r) => { if (!cancelled) setResult(r); })
      .catch((e) => {
        if (!cancelled) setResult({
          tobeSchema, tobeTable, headers: [], rows: [], rowCount: 0, truncated: false,
          sql: null, error: e instanceof Error ? e.message : String(e),
        });
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId, tobeSchema, tobeTable]);
  return { result, loading };
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

function ReportView({ table, rows, onClose, onPickColumn }: {
  table: TobeTable;
  rows: MappingRow[];
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
  const { result: report, loading: reportLoading } = useReportRows(activeProject?.id ?? null, tobeSplit.schema, tobeSplit.table);
  const reportColIdx = useMemo(() => {
    if (!report) return null;
    const m = new Map<string, number>();
    report.headers.forEach((h, i) => m.set(h.trim().toLowerCase(), i));
    return m;
  }, [report]);
  const dataRowCount = report ? Math.min(report.rows.length, PREVIEW_ROWS) : 0;
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
          <span style={styles.dbvTitleBtn}>─</span>
          <span style={styles.dbvTitleBtn}>▢</span>
          <button
            type="button"
            onClick={onClose}
            title="Mapping 화면으로 돌아가기"
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
        {['↶','↷'].map((s, i) => <span key={`g2-${i}`} style={styles.dbvToolBtn}>{s}</span>)}
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

      {/* ⑤ 서브탭 */}
      <div style={styles.dbvSubtabs}>
        <span style={styles.dbvSubtab}>Properties</span>
        <span style={{ ...styles.dbvSubtab, ...styles.dbvSubtabActive }}>Data</span>
        <span style={styles.dbvSubtab}>Diagram</span>
      </div>

      {/* ⑥ 필터바 */}
      <div style={styles.dbvFilterbar}>
        <span style={styles.dbvFilterShowSql}>Show SQL</span>
        <span style={styles.dbvFilterInput}>이 데이터는 DB에 저장되지 않습니다.</span>
        <span style={styles.dbvFilterIcons}>
          {['▾','▶','✕','⟳','⊞','⚙'].map((s, i) => <span key={i} style={styles.dbvFilterIcon}>{s}</span>)}
        </span>
      </div>

      {/* 상태 배너 — loading / error / 빈 결과 */}
      {reportLoading && (
        <div style={{ padding: '8px 14px', background: '#fff8e1', color: '#856404', borderBottom: '1px solid #e8e8e8', fontSize: 11.5 }}>
          ⏳ {t('mapping.report.loading')}
        </div>
      )}
      {report && report.error && (
        <div style={{ padding: '8px 14px', background: '#fde2e2', color: '#a02020', borderBottom: '1px solid #e8e8e8', fontSize: 11.5, fontFamily: 'var(--mono)' }}>
          ⚠ {report.error}
          {report.sql && <div style={{ marginTop: 4, fontSize: 10.5, opacity: 0.8 }}>SQL: {report.sql}</div>}
        </div>
      )}

      {/* 데이터 그리드 */}
      <div style={styles.dbvGridArea}>
        <table style={styles.dbvGrid}>
          <thead>
            <tr>
              <th style={styles.dbvGridCorner}> </th>
              {rows.map((r) => (
                <th
                  key={r.tgt}
                  onClick={() => onPickColumn(r.tgt)}
                  title={`${r.tgt} (${r.tgtType}) · 클릭해서 매핑 상세 보기`}
                  style={styles.dbvGridCol}
                >
                  <div style={styles.dbvColHeaderInner}>
                    <span style={styles.dbvColTypeIcon}>{typeIconLabel(r.tgtType)}</span>
                    <span>{r.tgt}</span>
                    <span style={styles.dbvColCaret}>▾</span>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: dataRowCount }, (_, i) => {
              const zebra = i % 2 === 1;
              return (
                <tr key={i}>
                  <td style={styles.dbvRowNum}>{i + 1}</td>
                  {rows.map((r) => {
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
          {rows.length} column(s), {dataRowCount} row(s) fetched - 0.0s, on {fmtDate(new Date())} at {fmtTime(new Date())}
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

function MetaRow({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div style={styles.metaRow}>
      <div style={styles.metaRowKey}>{k}</div>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}

function transformPreview(r: MappingRow): string[] {
  const kw  = (s: string) => `<span style="color:#e8b86f">${s}</span>`;
  const str = (s: string) => `<span style="color:#9fd9b3">${s}</span>`;
  const cmt = (s: string) => `<span style="color:#7a8aa6">${s}</span>`;
  if (r.rule === 'unmapped') return [cmt('-- not mapped yet — pick a strategy')];
  if (r.rule === 'null')     return [cmt('-- explicitly mapped to NULL'), `${kw('NULL')}::${r.tgtType}`];
  if (r.rule === 'default')  return [cmt('-- explicitly mapped to DDL DEFAULT'), `${kw('DEFAULT')}`];
  if (r.rule === 'skip')     return [cmt('-- column is dropped from TO-BE'), `${kw('DROP')}(${r.src})`];
  if (r.rule === 'added')    return [cmt('-- no AS-IS source'), `${kw('DEFAULT')} ${str(r.ddlDefault || 'NULL')}`];
  if (r.srcType.includes('YYYYMMDD'))                                       return [cmt('-- date parse'), `${kw('TO_DATE')}(${r.src}, ${str("'YYYYMMDD'")})`];
  if (r.srcType.includes('CHAR(14)') && r.tgtType.includes('TIMESTAMP'))    return [cmt('-- timestamp parse'), `${kw('TO_TIMESTAMP')}(${r.src}, ${str("'YYYYMMDDHH24MISS'")})`];
  if (r.srcType.includes('COMP-3'))                                         return [cmt('-- COMP-3 → NUMERIC'), `${kw('unpack_comp3')}(${r.src})`];
  if (r.srcType.includes('EBCDIC'))                                         return [cmt('-- iconv'), `${kw('iconv')}(${str("'ebcdic-kanji'")}, ${str("'utf-8'")}, ${r.src})`];
  if (r.rule === 'rule')                                                    return [cmt('-- cast'), `${kw('CAST')}(${r.src} ${kw('AS')} ${r.tgtType})`];
  return [cmt('-- direct pass-through'), `${r.src} ${kw('AS')} ${r.tgt}`];
}

function transformPlain(r: MappingRow): string {
  return transformPreview(r).map((line) => line.replace(/<[^>]+>/g, '')).join('\n');
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
    const aliases = new Set(tobe.sources.filter((s) => s.table === asisTableName).map((s) => s.alias));
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
      if (!sourceAlias && !(ASIS_COLUMNS[asisTableName] || []).some((c) => c.name === srcCol)) continue;

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
  const cols = ASIS_COLUMNS[table.name] || [];
  const [colFilter, setColFilter] = useState<AsisColFilter>('all');
  const routedTobe = effectiveTobe.filter((t) => t.sources.some((s) => s.table === table.name));

  const activeProjectIdForAsis = useWorkspaceStore((s) => s.activeProjectId);
  const rowEditsByTobe = useMappingEditsStore(
    (s) => (activeProjectIdForAsis ? s.rowEdits[activeProjectIdForAsis] : undefined) || EMPTY_ROW_EDITS_BY_TOBE,
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
                    WHERE {to.whereFilter.length > 40 ? to.whereFilter.slice(0, 40) + '…' : to.whereFilter}
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
                    <tr key={c.name} style={{
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
                          <button style={styles.skipBtnOn} onClick={() => onToggleSkip(c.name, false)}>
                            ✓ Skipped
                          </button>
                        ) : (
                          <button style={styles.skipBtnOff} onClick={() => onToggleSkip(c.name, true)}>
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

// Unmapped 만 빨강; 나머지는 같은 초록 계열, Default 를 기준으로 점점 옅어진다.
const TOBE_RULE_COLORS: Record<Exclude<TobeRuleFilter, 'all'>, string> = {
  unmapped: 'var(--red)',
  auto:     '#059669',  // green 600 (darkest)
  rule:     '#34d399',  // green 400
  null:     '#6ee7b7',  // green 200
  default:  '#a7f3d0',  // green 100 (lightest)
};

function TobeCoverageBar({ total, ruleCounts, filter, onFilter }: {
  total: number;
  ruleCounts: { unmapped: number; auto: number; rule: number; null: number; default: number };
  filter: TobeRuleFilter;
  onFilter: (f: TobeRuleFilter) => void;
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
        <div style={styles.coverageFilters}>
          {btn('all',      'All',         total)}
          {btn('unmapped', 'Unmapped',    ruleCounts.unmapped, TOBE_RULE_COLORS.unmapped)}
          {btn('auto',     'Passthrough', ruleCounts.auto,     TOBE_RULE_COLORS.auto)}
          {btn('rule',     'Transform',   ruleCounts.rule,     TOBE_RULE_COLORS.rule)}
          {btn('null',     'Null',        ruleCounts.null,     TOBE_RULE_COLORS.null)}
          {btn('default',  'Default',     ruleCounts.default,  TOBE_RULE_COLORS.default)}
        </div>
      </div>
      <div style={styles.coverageTrack}>
        <div style={{ width: `${pct(ruleCounts.unmapped)}%`, background: TOBE_RULE_COLORS.unmapped }} />
        <div style={{ width: `${pct(ruleCounts.auto)}%`,     background: TOBE_RULE_COLORS.auto }} />
        <div style={{ width: `${pct(ruleCounts.rule)}%`,     background: TOBE_RULE_COLORS.rule }} />
        <div style={{ width: `${pct(ruleCounts.null)}%`,     background: TOBE_RULE_COLORS.null }} />
        <div style={{ width: `${pct(ruleCounts.default)}%`,  background: TOBE_RULE_COLORS.default }} />
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
    auto: 'pass', rule: 'rule', null: 'null', default: 'def',
    unmapped: 'unmapped', added: 'new', skip: 'skip',
  };
  let tone: Parameters<typeof StatusBadge>[0]['tone'];
  if (rule === 'skip') tone = 'skip';
  else if (rule === 'unmapped') tone = 'err';
  else if (status === 'err') tone = 'err';
  else if (status === 'warn') tone = 'warn';
  else if (rule === 'auto') tone = 'blue';
  else tone = 'ok';
  return <StatusBadge tone={tone}>{labels[rule]}</StatusBadge>;
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
  ddlPath: {
    margin: '2px 10px 4px', padding: '4px 8px',
    background: 'var(--panel-2)', borderRadius: 2,
    fontSize: 9.5, fontFamily: 'var(--mono)', color: 'var(--text-3)',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  treeEmpty: { padding: '8px 14px', fontSize: 10.5, color: 'var(--text-3)' },

  invItem: { padding: '4px 12px', cursor: 'pointer' },
  invItemRow: {
    display: 'flex', alignItems: 'center', gap: 6,
    fontFamily: 'var(--mono)', fontSize: 11.5,
  },
  invItemName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 },
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
