import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWorkspaceStore } from '../store/workspace';
import { useAsisDdlStore } from '../store/asisDdl';
import { useTobeDdlStore } from '../store/tobeDdl';
import { useMappingEditsStore } from '../store/mappingEdits';
import type { DdlSchema, DdlTableWithColumns } from '../api/asisDdl';
import { projectApi } from '../api/workspace';
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
      imported: true,  // TODO: 백엔드 CSV import 상태 API 가 생기면 실제 값으로 교체. 현재는 테스트용으로 모두 imported 처리.
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
  useEffect(() => {
    ASIS_TABLES = ddlToAsisTables(asisSchema);
    TOBE_TABLES = ddlToTobeTables(tobeSchema);
    ASIS_COLUMNS = ddlToAsisColumns(asisSchema);
    MAPPING_BY_TOBE = ddlToMappingByTobe(tobeSchema);
    setHydrationTick((t) => t + 1);
  }, [asisSchema, tobeSchema]);

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

  const [selected, setSelected] = useState<Selection>(initialSelection);
  // hydrate 된 데이터에 selected 가 존재하지 않으면 자동으로 첫 TOBE 로 reset.
  // (selected 없음, 새 프로젝트, 또는 영속된 selection 이 이번 프로젝트 데이터에 없는 경우 모두 처리.)
  useEffect(() => {
    if (!initialSelection) return;
    if (!selected) { setSelected(initialSelection); return; }
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
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [q, setQ] = useState('');
  type RuleFilter = 'all' | 'unmapped' | 'auto' | 'rule' | 'null' | 'default';
  const [coverageFilter, setCoverageFilter] = useState<RuleFilter>('all');
  const [activeIdx, setActiveIdx] = useState(0);
  const activeProjectIdForRow = useWorkspaceStore((s) => s.activeProjectId);
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
    useMappingEditsStore.getState().setRowEdit(activeProjectIdForRow, table.internalName, r.tgt, edit);
  }, [activeProjectIdForRow, table.internalName]);
  const [bindingSources, setBindingSources] = useState(bindingEdit?.sources ?? table.sources);
  const [bindingMode, setBindingMode] = useState<'join' | 'union'>(
    bindingEdit?.mode ?? (table.compositionKind === 'union' ? 'union' : 'join'),
  );
  const allRows = useMemo(() => rows.map((r) => {
    const re = rowEdits[r.tgt];
    if (!re) return r;
    const filledSrc = re.savedSrc?.some((s) => s && s.trim() !== '') ?? false;
    const hasRule = !!(re.savedRule && re.savedRule.trim());
    let eff: MappingRow['rule'] = r.rule;
    if (re.savedStrategy === 'null') eff = 'null';
    else if (re.savedStrategy === 'default') eff = 'default';
    else if (re.savedStrategy === 'expression') {
      if (hasRule || filledSrc) eff = filledSrc && !hasRule ? 'auto' : 'rule';
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
  const testDisabled = counts.unmapped > 0 || bindingSources.length === 0 || missingImports.length > 0;
  const testDisabledReason =
    bindingSources.length === 0 ? 'AS-IS source 가 연결되어 있지 않습니다.'
    : missingImports.length > 0 ? `AS-IS extracted data 가 임포트되지 않았습니다: ${missingImports.map((a) => a.short).join(', ')}`
    : counts.unmapped > 0 ? `Unmapped 컬럼이 ${counts.unmapped}개 남아 있습니다.`
    : 'Run test migration for this table';

  return (
    <div style={styles.workspace}>
      {/* Context bar */}
      <div style={styles.contextBar}>
        <span style={{ ...styles.sidePill, color: 'var(--navy)', background: 'var(--navy-50)', borderColor: 'var(--navy)' }}>TO-BE</span>
        <div style={styles.tableChip}>{table.name}</div>
        <div style={{ flex: 1 }} />
        <div style={styles.statusCounts}>
          {counts.unmapped > 0 && <StatusBadge tone="queued">{counts.unmapped} unmapped</StatusBadge>}
          {missingImports.length > 0 && (
            <button
              type="button"
              onClick={() => navigate('/settings', { state: { highlightSide: 'asis-csv' } })}
              title="Project Settings → AS-IS 의 CSV 카드로 이동합니다."
              style={styles.csvMissingBtn}
            >
              <StatusBadge tone="warn">
                {missingImports.length} CSV not imported →
              </StatusBadge>
            </button>
          )}
        </div>
        <button
          style={(testDisabled || testStatus === 'running') ? styles.btnPrimaryDisabled : styles.btnPrimary}
          disabled={testDisabled || testStatus === 'running'}
          onClick={startTest}
          title={
            testStatus === 'running' ? `Testing… ${testProgress}%`
            : testStatus === 'completed' ? 'Test completed. Click to re-run.'
            : testDisabledReason
          }
        >
          <Ic.play /> {testStatus === 'running' ? `Testing ${testProgress}%` : testStatus === 'completed' ? 'Re-test' : 'Test'}
        </button>
      </div>

      {bindingSources.length === 0 && (
        <div style={styles.noSourceBanner}>
          <Ic.warn />
          <span>AS-IS 테이블이 매핑되지 않았습니다. <b>Table binding</b> 패널에서 <b>+ Add source</b>로 테이블을 추가하세요.</span>
        </div>
      )}
      <CollapsibleBinding
        table={table} open={bindingOpen} onToggle={() => setBindingOpen((o) => !o)}
        sources={bindingSources}
        onSourcesChange={(s) => { setBindingSources(s); onBindingChange({ sources: s, mode: bindingMode }); }}
        compositionMode={bindingMode}
        onCompositionModeChange={(m) => { setBindingMode(m); onBindingChange({ sources: bindingSources, mode: m }); }}
      />

      {/* Toolbar */}
      <div style={styles.toolbar}>
        <div style={styles.toolbarSearch}>
          <Ic.search />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by field name…" style={styles.searchInput} />
        </div>
        <div style={{ flex: 1 }} />
        <button style={styles.btnGhost}><Ic.download /> Import YAML</button>
        <button style={styles.btnSecondary}>Auto-map unmapped</button>
      </div>

      {/* Grid + inspector */}
      <div style={styles.gridSplit}>
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
                    onClick={() => setActiveIdx(realIdx)}
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

        <InspectorRail
          open={inspectorOpen}
          onToggle={() => setInspectorOpen((o) => !o)}
        />
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

function CollapsibleBinding({ table, open, onToggle, sources, onSourcesChange, compositionMode, onCompositionModeChange }: {
  table: TobeTable; open: boolean; onToggle: () => void;
  sources: TobeTable['sources']; onSourcesChange: (s: TobeTable['sources']) => void;
  compositionMode: 'join' | 'union'; onCompositionModeChange: (m: 'join' | 'union') => void;
}) {
  const [addingSource, setAddingSource] = useState(false);
  const [pickTable, setPickTable] = useState('');
  const [pickAlias, setPickAlias] = useState('');

  const op = compositionMode === 'union' ? '∪' : '⋈';
  const usedTables = new Set(sources.map((s) => s.table));
  const availableTables = ASIS_TABLES.filter((t) => !usedTables.has(t.name));

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
    <div style={styles.bindingWrap}>
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
              이 TO-BE 테이블에 연결된 AS-IS 소스가 없습니다. [Add source] 로 추가하세요.
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
                      <input
                        value={s.joinOn ?? ''}
                        onChange={(e) => updateSource(s.alias, { joinOn: e.target.value })}
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
                  <option key={t.name} value={t.name}>{t.name}</option>
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
                <span style={styles.whereHint}>이 TO-BE 에 포함할 행 조건. 비우면 전체 rows.</span>
              </div>
              <input
                defaultValue={table.whereFilter ?? ''}
                placeholder={`예: ${sources[0].alias}.party_type = 'P'`}
                style={{
                  ...styles.whereInput,
                  borderColor: table.whereFilter ? 'var(--navy)' : 'var(--border)',
                  background: table.whereFilter ? '#0e1a2b' : 'var(--panel)',
                  color: table.whereFilter ? '#cad7e8' : 'var(--text)',
                }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Per-row saved edits (lifted to TobeMappingDetail so they survive row switches)
type RowEdit = { savedSrc?: string[]; savedRule?: string; savedDefault?: string; savedNotNull?: boolean; savedStrategy?: 'expression' | 'null' | 'default' };

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
    setEditingRule(false); setRuleError(null);
    const re = rowEdit;
    setSavedRule(re?.savedRule ?? null);
    setSavedStrategy(re?.savedStrategy ?? null);
    const src = re?.savedSrc ?? null;
    setSavedSrc(src);
    setSavedSrcType(src ? src.map((s) => resolveSrcType(s, sources)) : null);
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
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
    return (srcT === active.tgtType ? srcCol : `CAST(${srcCol} AS ${active.tgtType})`).toUpperCase();
  };

  const handleEdit = () => {
    const inferredStrategy = savedStrategy ?? (active.rule === 'null' ? 'null' : active.rule === 'default' ? 'default' : 'expression');
    setEditStrategy(inferredStrategy);
    const initialAutoCast =
      active.src !== '—' && active.tgt !== '—'
      && active.srcType !== '—' && active.tgtType !== '—'
      && active.srcType !== active.tgtType
        ? `CAST(${active.src} AS ${active.tgtType})`
        : '';
    prevAutoCastRef.current = initialAutoCast.toUpperCase();
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
    : displaySrcArr.map((s) => s.slice(s.lastIndexOf('.') + 1)).join(' + ');
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

function InspectorRail({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <div
      onClick={onToggle}
      title={open ? 'Hide mapping detail' : 'Show mapping detail'}
      style={styles.inspectorRail}
    >
      <div style={styles.inspectorRailLabel}>
        {open ? '›' : '‹'} Mapping detail
      </div>
    </div>
  );
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
        <div style={styles.tableChip}>{table.name}</div>
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
                <span style={{ color: 'var(--navy)', fontWeight: 500 }}>{to.name}</span>
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
  csvMissingBtn: {
    background: 'transparent', border: 'none', padding: 0,
    cursor: 'pointer', display: 'inline-flex', alignItems: 'center',
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
