import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

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

const ASIS_TABLES: AsisTable[] = [
  { name: 'HR.EMPLOYEE_MASTER',    short: 'EMPLOYEE_MASTER',    columnCount: 28, rows: 3_120,     routing: ['TOBE_employees', 'TOBE_employee_audit'] },
  { name: 'HR.DEPARTMENT',         short: 'DEPARTMENT',         columnCount:  6, rows:    48,     routing: ['TOBE_departments'] },
  { name: 'HR.POSITION_HISTORY',   short: 'POSITION_HISTORY',   columnCount:  9, rows: 12_580,    routing: ['TOBE_combined_history'] },
  { name: 'CRM.CUST_PROFILE_OLD',  short: 'CUST_PROFILE_OLD',   columnCount: 12, rows:  8_450,    routing: ['TOBE_user_view'] },
  { name: 'LEGACY.USER_LOG',       short: 'USER_LOG',           columnCount: 14, rows: 1_240_000, routing: [], unrouted: true },
  { name: 'LEGACY.AUDIT_RAW',      short: 'AUDIT_RAW',          columnCount:  7, rows: 4_800_000, routing: [], unrouted: true },
];

const TOBE_TABLES: TobeTable[] = [
  {
    name: 'public.employees', internalName: 'TOBE_employees', short: 'employees',
    columnCount: 26, rows: 3_120,
    compositionKind: 'single',
    sources: [{ alias: 'em', table: 'HR.EMPLOYEE_MASTER', role: 'primary', rows: 3_120 }],
  },
  {
    name: 'public.employee_audit', internalName: 'TOBE_employee_audit', short: 'employee_audit',
    columnCount: 8, rows: 1_500,
    compositionKind: 'single',
    sources: [{ alias: 'em', table: 'HR.EMPLOYEE_MASTER', role: 'primary', rows: 3_120 }],
    whereFilter: "em.audit_flag = 'Y'",
  },
  {
    name: 'public.departments', internalName: 'TOBE_departments', short: 'departments',
    columnCount: 5, rows: 48,
    compositionKind: 'single',
    sources: [{ alias: 'de', table: 'HR.DEPARTMENT', role: 'primary', rows: 48 }],
  },
  {
    name: 'public.user_view', internalName: 'TOBE_user_view', short: 'user_view',
    columnCount: 18, rows: 8_450,
    compositionKind: 'join',
    sources: [
      { alias: 'em', table: 'HR.EMPLOYEE_MASTER',  role: 'primary', rows: 3_120 },
      { alias: 'cu', table: 'CRM.CUST_PROFILE_OLD', role: 'join', joinType: 'LEFT JOIN', joinOn: 'em.user_id = cu.user_id', rows: 8_450 },
    ],
  },
  {
    name: 'public.combined_history', internalName: 'TOBE_combined_history', short: 'combined_history',
    columnCount: 9, rows: 12_580,
    compositionKind: 'union',
    sources: [
      { alias: 'ph', table: 'HR.POSITION_HISTORY', role: 'union', rows: 12_580 },
    ],
  },
  {
    name: 'public.activity_log', internalName: 'TOBE_activity_log', short: 'activity_log',
    columnCount: 6, rows: 0,
    unrouted: true,
    compositionKind: 'none',
    sources: [],
  },
];

const MAPPING_BY_TOBE: Record<string, MappingRow[]> = {
  TOBE_employees: [
    { src: 'EMP_ID',         tgt: 'employee_id',  srcType: 'CHAR(8)',     tgtType: 'UUID',           rule: 'rule',     status: 'ok',   pk: true,  sourceAlias: 'em', tgtNullable: false, note: 'CHAR(8) → UUID v5(namespace, emp_id)' },
    { src: 'EMP_NM',         tgt: 'employee_name', srcType: 'EBCDIC-KANJI(40)', tgtType: 'VARCHAR(120)', rule: 'rule',  status: 'warn', sourceAlias: 'em', tgtNullable: false, note: 'iconv: ebcdic-kanji → utf-8 · 1 char hit fallback' },
    { src: 'HIRE_YMD',       tgt: 'hire_date',    srcType: 'CHAR(8) YYYYMMDD', tgtType: 'DATE',     rule: 'rule',     status: 'ok',   sourceAlias: 'em', tgtNullable: false },
    { src: 'BIRTH_YMD',      tgt: 'birth_date',   srcType: 'CHAR(8) YYYYMMDD', tgtType: 'DATE',     rule: 'rule',     status: 'ok',   sourceAlias: 'em', tgtNullable: true },
    { src: 'DEPT_CD',        tgt: 'department_id', srcType: 'CHAR(4)',   tgtType: 'INTEGER',         rule: 'rule',     status: 'ok',   sourceAlias: 'em', tgtNullable: false },
    { src: 'POSITION_CD',    tgt: 'position_code', srcType: 'CHAR(3)',   tgtType: 'CHAR(3)',         rule: 'auto',     status: 'ok',   sourceAlias: 'em', tgtNullable: true },
    { src: 'GENDER_CD',      tgt: 'gender',       srcType: 'CHAR(1)',     tgtType: 'CHAR(1)',         rule: 'auto',     status: 'ok',   sourceAlias: 'em', tgtNullable: true },
    { src: 'EMAIL',          tgt: 'email',        srcType: 'VARCHAR(64)', tgtType: 'VARCHAR(255)',    rule: 'auto',     status: 'ok',   sourceAlias: 'em', tgtNullable: true },
    { src: 'SALARY',         tgt: 'salary',       srcType: 'COMP-3(9,2)', tgtType: 'NUMERIC(11,2)',   rule: 'rule',     status: 'ok',   sourceAlias: 'em', tgtNullable: true },
    { src: 'ENTRY_TS',       tgt: 'created_at',   srcType: 'CHAR(14)',    tgtType: 'TIMESTAMP',       rule: 'rule',     status: 'ok',   sourceAlias: 'em', tgtNullable: false },
    { src: 'STATUS_CD',      tgt: 'status',       srcType: 'CHAR(1)',     tgtType: 'VARCHAR(16)',     rule: 'rule',     status: 'err',  sourceAlias: 'em', tgtNullable: false, note: '5 distinct values in source, only 3 mapped in transform' },
    { src: 'PHONE_NUM',      tgt: 'phone',        srcType: 'CHAR(20)',    tgtType: 'VARCHAR(32)',     rule: 'auto',     status: 'ok',   sourceAlias: 'em', tgtNullable: true },
    { src: '—',              tgt: 'phone_e164',   srcType: '—',           tgtType: 'VARCHAR(20)',     rule: 'unmapped', status: 'queued', tgtNullable: true },
    { src: '—',              tgt: 'manager_id',   srcType: '—',           tgtType: 'UUID',            rule: 'null',     status: 'queued', tgtNullable: true },
    { src: '—',              tgt: 'tenant_id',    srcType: '—',           tgtType: 'INTEGER',         rule: 'default',  status: 'queued', tgtNullable: false, ddlDefault: '1' },
    { src: '(new)',          tgt: 'mfa_enabled',  srcType: '—',           tgtType: 'BOOLEAN',         rule: 'added',    status: 'ok',   tgtNullable: false, ddlDefault: 'false', note: 'default = false' },
    { src: 'OBSOLETE_FLAG',  tgt: '—',            srcType: 'CHAR(1)',     tgtType: '—',               rule: 'skip',     status: 'skip', sourceAlias: 'em' },
    { src: 'UPDATE_TS',      tgt: 'updated_at',   srcType: 'CHAR(14)',    tgtType: 'TIMESTAMP',       rule: 'rule',     status: 'ok',   sourceAlias: 'em', tgtNullable: false },
  ],
  TOBE_employee_audit: [
    { src: 'EMP_ID',         tgt: 'employee_id',  srcType: 'CHAR(8)',     tgtType: 'UUID',           rule: 'rule',     status: 'ok',   pk: true, sourceAlias: 'em', tgtNullable: false },
    { src: 'AUDIT_KIND',     tgt: 'kind',         srcType: 'CHAR(2)',     tgtType: 'VARCHAR(16)',     rule: 'rule',     status: 'ok',   sourceAlias: 'em', tgtNullable: false },
    { src: 'AUDIT_TS',       tgt: 'audited_at',   srcType: 'CHAR(14)',    tgtType: 'TIMESTAMP',       rule: 'rule',     status: 'ok',   sourceAlias: 'em', tgtNullable: false },
    { src: '—',              tgt: 'note',         srcType: '—',           tgtType: 'TEXT',            rule: 'null',     status: 'queued', tgtNullable: true },
  ],
  TOBE_departments: [
    { src: 'DEPT_CD',  tgt: 'department_id',   srcType: 'CHAR(4)',    tgtType: 'INTEGER',         rule: 'rule', status: 'ok', pk: true, sourceAlias: 'de', tgtNullable: false },
    { src: 'DEPT_NM',  tgt: 'department_name', srcType: 'VARCHAR(80)',tgtType: 'VARCHAR(120)',    rule: 'auto', status: 'ok', sourceAlias: 'de', tgtNullable: false },
    { src: 'PARENT_CD',tgt: 'parent_id',       srcType: 'CHAR(4)',    tgtType: 'INTEGER',         rule: 'rule', status: 'ok', sourceAlias: 'de', tgtNullable: true },
  ],
  TOBE_user_view: [
    { src: 'EMP_ID',    tgt: 'user_id',     srcType: 'CHAR(8)',     tgtType: 'UUID',          rule: 'rule', status: 'ok', pk: true, sourceAlias: 'em', tgtNullable: false },
    { src: 'EMAIL',     tgt: 'email',       srcType: 'VARCHAR(64)', tgtType: 'VARCHAR(255)',  rule: 'auto', status: 'ok', sourceAlias: 'em', tgtNullable: true },
    { src: 'PROFILE',   tgt: 'profile_blob', srcType: 'CLOB',       tgtType: 'JSONB',         rule: 'rule', status: 'warn', sourceAlias: 'cu', tgtNullable: true, note: 'free-text → JSONB; 14% of rows are non-JSON' },
    { src: '—',         tgt: 'last_seen_at', srcType: '—',          tgtType: 'TIMESTAMP',     rule: 'unmapped', status: 'queued', tgtNullable: true },
  ],
  TOBE_combined_history: [
    { src: 'EMP_ID',     tgt: 'employee_id', srcType: 'CHAR(8)',  tgtType: 'UUID',      rule: 'rule', status: 'ok', sourceAlias: 'ph', tgtNullable: false },
    { src: 'CHANGE_YMD', tgt: 'changed_on',  srcType: 'CHAR(8)',  tgtType: 'DATE',      rule: 'rule', status: 'ok', sourceAlias: 'ph', tgtNullable: false },
    { src: 'NEW_POS_CD', tgt: 'position_code', srcType: 'CHAR(3)', tgtType: 'CHAR(3)', rule: 'auto', status: 'ok', sourceAlias: 'ph', tgtNullable: true },
  ],
};

const ASIS_COLUMNS: Record<string, { name: string; type: string; pk?: boolean; nullPct?: number; distinct?: number }[]> = {
  'HR.EMPLOYEE_MASTER': [
    { name: 'EMP_ID',        type: 'CHAR(8)',          pk: true, nullPct: 0,    distinct: 3120 },
    { name: 'EMP_NM',        type: 'EBCDIC-KANJI(40)', nullPct: 0.2,  distinct: 3045 },
    { name: 'HIRE_YMD',      type: 'CHAR(8)',          nullPct: 0,    distinct: 1820 },
    { name: 'BIRTH_YMD',     type: 'CHAR(8)',          nullPct: 4.1,  distinct: 2900 },
    { name: 'DEPT_CD',       type: 'CHAR(4)',          nullPct: 0.6,  distinct: 47 },
    { name: 'POSITION_CD',   type: 'CHAR(3)',          nullPct: 1.3,  distinct: 12 },
    { name: 'GENDER_CD',     type: 'CHAR(1)',          nullPct: 0.0,  distinct: 2 },
    { name: 'EMAIL',         type: 'VARCHAR(64)',      nullPct: 18.4, distinct: 3010 },
    { name: 'SALARY',        type: 'COMP-3(9,2)',      nullPct: 0,    distinct: 2840 },
    { name: 'ENTRY_TS',      type: 'CHAR(14)',         nullPct: 0,    distinct: 3120 },
    { name: 'STATUS_CD',     type: 'CHAR(1)',          nullPct: 0,    distinct: 5 },
    { name: 'PHONE_NUM',     type: 'CHAR(20)',         nullPct: 22.6, distinct: 2820 },
    { name: 'OBSOLETE_FLAG', type: 'CHAR(1)',          nullPct: 0,    distinct: 2 },
    { name: 'UPDATE_TS',     type: 'CHAR(14)',         nullPct: 0,    distinct: 3120 },
  ],
  'CRM.CUST_PROFILE_OLD': [
    { name: 'USER_ID',       type: 'VARCHAR(32)',  pk: true, nullPct: 0,    distinct: 8450 },
    { name: 'CUST_NM',       type: 'EBCDIC-KANJI(60)', nullPct: 0.5,  distinct: 7980 },
    { name: 'PROFILE',       type: 'CLOB',              nullPct: 14.0, distinct: 7200 },
    { name: 'REGIST_YMD',    type: 'CHAR(8)',           nullPct: 2.1,  distinct: 3800 },
    { name: 'LAST_LOGIN_TS', type: 'CHAR(14)',          nullPct: 5.4,  distinct: 7800 },
    { name: 'STATUS_CD',     type: 'CHAR(2)',           nullPct: 0,    distinct: 4 },
    { name: 'GRADE_CD',      type: 'CHAR(1)',           nullPct: 0,    distinct: 5 },
    { name: 'EMAIL',         type: 'VARCHAR(64)',       nullPct: 31.2, distinct: 5900 },
    { name: 'MOBILE_NUM',    type: 'CHAR(20)',          nullPct: 44.7, distinct: 4800 },
    { name: 'ADDR_CD',       type: 'CHAR(7)',           nullPct: 8.3,  distinct: 1200 },
    { name: 'ENTRY_TS',      type: 'CHAR(14)',          nullPct: 0,    distinct: 8450 },
    { name: 'UPDATE_TS',     type: 'CHAR(14)',          nullPct: 0,    distinct: 8450 },
  ],
  'HR.DEPARTMENT': [
    { name: 'DEPT_CD',    type: 'CHAR(4)',    pk: true, nullPct: 0,   distinct: 48 },
    { name: 'DEPT_NM',    type: 'VARCHAR(80)',          nullPct: 0,   distinct: 48 },
    { name: 'PARENT_CD',  type: 'CHAR(4)',              nullPct: 8.3, distinct: 12 },
    { name: 'LEVEL_NO',   type: 'SMALLINT',             nullPct: 0,   distinct: 4 },
    { name: 'ENTRY_TS',   type: 'CHAR(14)',             nullPct: 0,   distinct: 48 },
    { name: 'UPDATE_TS',  type: 'CHAR(14)',             nullPct: 0,   distinct: 48 },
  ],
  'HR.POSITION_HISTORY': [
    { name: 'SEQ_NO',     type: 'INTEGER',   pk: true, nullPct: 0,   distinct: 12580 },
    { name: 'EMP_ID',     type: 'CHAR(8)',              nullPct: 0,   distinct: 3120 },
    { name: 'CHANGE_YMD', type: 'CHAR(8)',              nullPct: 0,   distinct: 4200 },
    { name: 'OLD_POS_CD', type: 'CHAR(3)',              nullPct: 2.1, distinct: 12 },
    { name: 'NEW_POS_CD', type: 'CHAR(3)',              nullPct: 0,   distinct: 12 },
    { name: 'OLD_DEPT_CD',type: 'CHAR(4)',              nullPct: 3.0, distinct: 47 },
    { name: 'NEW_DEPT_CD',type: 'CHAR(4)',              nullPct: 0,   distinct: 47 },
    { name: 'REASON_CD',  type: 'CHAR(2)',              nullPct: 0,   distinct: 8 },
    { name: 'ENTRY_TS',   type: 'CHAR(14)',             nullPct: 0,   distinct: 12580 },
  ],
};

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
  const [selected, setSelected] = useState<Selection>({ side: 'tobe', name: 'public.employees', internalName: 'TOBE_employees' });
  const [search, setSearch] = useState('');
  const [showUnrouted, setShowUnrouted] = useState(false);
  const [tableBindingEdits, setTableBindingEdits] = useState<Record<string, TableBindingEdit>>({});

  const handleBindingChange = useCallback((internalName: string, edit: TableBindingEdit) =>
    setTableBindingEdits((prev) => ({ ...prev, [internalName]: edit })), []);

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
    }), [tableBindingEdits]);

  return (
    <div style={styles.fullBleed}>
      <DualInventory
        asis={ASIS_TABLES}
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
  const [activeTab, setActiveTab] = useState<Side>('tobe');
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
            <button key={side} onClick={() => setActiveTab(side)} style={{
              ...styles.invTab,
              color: isActive ? accent : 'var(--text-3)',
              fontWeight: isActive ? 700 : 500,
              boxShadow: isActive ? `inset 0 -2px 0 ${accent}` : 'none',
            }}>
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

function Workspace({ selected, onSelect, tableBindingEdits, onBindingChange }: {
  selected: Selection;
  onSelect: (s: Selection) => void;
  tableBindingEdits: Record<string, TableBindingEdit>;
  onBindingChange: (internalName: string, edit: TableBindingEdit) => void;
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
  return <AsisTableDetail table={asis} onJumpTobe={(internalName, name) => onSelect({ side: 'tobe', internalName, name })} />;
}

// ── TO-BE mapping detail ─────────────────────────────────────

function TobeMappingDetail({ table, rows, bindingEdit, onBindingChange }: {
  table: TobeTable;
  rows: MappingRow[];
  bindingEdit?: TableBindingEdit;
  onBindingChange: (edit: TableBindingEdit) => void;
}) {
  const [bindingOpen, setBindingOpen] = useState((bindingEdit?.sources ?? table.sources).length === 0);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [q, setQ] = useState('');
  const [ruleFilter, setRuleFilter] = useState<'all' | MappingRow['rule']>('all');
  const [activeIdx, setActiveIdx] = useState(0);
  const [rowEdits, setRowEdits] = useState<Record<string, RowEdit>>({});
  const handleSaveEdit = useCallback((r: MappingRow, edit: RowEdit) =>
    setRowEdits((prev) => ({ ...prev, [r.tgt]: { ...prev[r.tgt], ...edit } })), []);
  const [bindingSources, setBindingSources] = useState(bindingEdit?.sources ?? table.sources);
  const [bindingMode, setBindingMode] = useState<'join' | 'union'>(
    bindingEdit?.mode ?? (table.compositionKind === 'union' ? 'union' : 'join'),
  );
  const transformCompletions = useMemo(() =>
    bindingSources.flatMap((s) =>
      (ASIS_COLUMNS[s.table] || []).flatMap((c) => [`${s.alias}.${c.name}`, c.name])
    ), [bindingSources]);

  const [extraRows, setExtraRows] = useState<MappingRow[]>([]);
  const [addingField, setAddingField] = useState(false);
  const [newFieldName, setNewFieldName] = useState('');
  const [newFieldType, setNewFieldType] = useState('TEXT');

  const allRows = useMemo(() => [...rows, ...extraRows], [rows, extraRows]);

  const handleAddField = () => {
    if (!newFieldName.trim()) return;
    setExtraRows((prev) => [...prev, {
      src: '—', tgt: newFieldName.trim(), srcType: '—', tgtType: newFieldType,
      rule: 'added' as const, status: 'queued' as const, tgtNullable: true,
    }]);
    setNewFieldName('');
    setAddingField(false);
  };

  const visibleRows = useMemo(() => allRows.filter((r) => r.rule !== 'skip'), [allRows]);

  const filtered = visibleRows.filter((r) =>
    (!q || (r.src + ' ' + r.tgt).toLowerCase().includes(q.toLowerCase())) &&
    (ruleFilter === 'all' || r.rule === ruleFilter),
  );

  const counts = {
    all:      visibleRows.length,
    auto:     visibleRows.filter((r) => r.rule === 'auto').length,
    rule:     visibleRows.filter((r) => r.rule === 'rule').length,
    null:     visibleRows.filter((r) => r.rule === 'null').length,
    default:  visibleRows.filter((r) => r.rule === 'default').length,
    unmapped: visibleRows.filter((r) => r.rule === 'unmapped').length,
  };
  const active = visibleRows[activeIdx] ?? visibleRows[0];

  return (
    <div style={styles.workspace}>
      {/* Context bar */}
      <div style={styles.contextBar}>
        <span style={{ ...styles.sidePill, color: 'var(--navy)', background: 'var(--navy-50)', borderColor: 'var(--navy)' }}>TO-BE</span>
        <div style={styles.tableChip}>{table.name}</div>
        <div style={{ flex: 1 }} />
        <div style={styles.statusCounts}>
          {counts.unmapped > 0 && <StatusBadge tone="queued">{counts.unmapped} unmapped</StatusBadge>}
        </div>
        <button style={styles.btnPrimary} title="Run test migration for this table">
          <Ic.play /> Test
        </button>
      </div>

      {bindingSources.length === 0 && (
        <div style={styles.noSourceBanner}>
          <Ic.warn />
          <span>AS-IS 소스가 연결되지 않았습니다. 아래 <b>Table binding</b> 패널에서 [Add source] 로 소스 테이블을 추가하세요.</span>
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
        <div style={styles.ruleFilter}>
          {(
            [
              ['all', 'All'], ['unmapped', 'Unmapped'], ['auto', 'Passthrough'],
              ['rule', 'Transform'], ['null', 'Null'], ['default', 'Default'],
            ] as const
          ).map(([k, l], i) => (
            <button
              key={k}
              onClick={() => setRuleFilter(k)}
              style={{
                ...styles.ruleFilterBtn,
                borderLeft: i ? '1px solid var(--border)' : 'none',
                background: ruleFilter === k ? 'var(--navy-50)' : 'transparent',
                color: ruleFilter === k ? 'var(--navy)' : 'var(--text-2)',
                fontWeight: ruleFilter === k ? 600 : 500,
              }}
            >
              {l}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <button style={styles.btnGhost}><Ic.download /> Import YAML</button>
        <button style={styles.btnSecondary}>Auto-map unmapped</button>
        <button onClick={() => setAddingField(true)} style={styles.btnGhost} disabled={addingField}>
          <Ic.plus /> Add field
        </button>
      </div>

      {/* Grid + inspector */}
      <div style={styles.gridSplit}>
        <div style={styles.gridScroll}>
          <table style={styles.gridTable}>
            <thead>
              <tr>
                {[
                  { l: '',             w: 24 },
                  { l: 'Source field', w: '22%' },
                  { l: 'Alias',        w: 50 },
                  { l: 'Source type',  w: 170 },
                  { l: '',             w: 28 },
                  { l: 'Target field', w: '22%' },
                  { l: 'Target type',  w: 140 },
                  { l: 'Rule',         w: 70 },
                  { l: 'Status',       w: 80 },
                ].map((h, i) => (
                  <th key={i} style={{ ...styles.gridTh, width: h.w }}>{h.l}</th>
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
                    <td style={{ ...styles.gridTd, fontFamily: 'var(--mono)', fontWeight: 500, color: rowEdits[r.tgt]?.savedSrc?.length ? 'var(--text)' : srcCellColor(r) }}>
                      {(() => {
                        const eff = rowEdits[r.tgt]?.savedSrc;
                        if (eff?.length) return <span>{eff.map((s) => s.slice(s.lastIndexOf('.') + 1)).join(' + ')}</span>;
                        return srcCellContent(r);
                      })()}
                    </td>
                    <td style={{ ...styles.gridTd, padding: '5px 4px' }}>
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
                    <td style={styles.gridTd}><RuleTag rule={r.rule} /></td>
                    <td style={styles.gridTd}><StatusFor row={r} /></td>
                  </tr>
                );
              })}
              {addingField && (
                <tr style={{ background: 'var(--navy-50)', borderBottom: '1px solid var(--border)' }}>
                  <td colSpan={4} />
                  <td style={{ ...styles.gridTd, padding: '5px 0', textAlign: 'center', color: 'var(--green)' }}>+</td>
                  <td style={styles.gridTd}>
                    <input
                      value={newFieldName}
                      onChange={(e) => setNewFieldName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleAddField(); if (e.key === 'Escape') setAddingField(false); }}
                      placeholder="new_column_name"
                      autoFocus
                      style={{ ...styles.metaInput, width: '100%' }}
                    />
                  </td>
                  <td style={styles.gridTd}>
                    <select value={newFieldType} onChange={(e) => setNewFieldType(e.target.value)} style={styles.joinSelect}>
                      {['TEXT', 'VARCHAR(255)', 'INTEGER', 'BIGINT', 'BOOLEAN', 'DATE', 'TIMESTAMP', 'UUID', 'JSONB', 'NUMERIC(11,2)'].map((t) => (
                        <option key={t}>{t}</option>
                      ))}
                    </select>
                  </td>
                  <td colSpan={2} style={styles.gridTd}>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button onClick={handleAddField} style={styles.btnPrimarySm}>Add</button>
                      <button onClick={() => setAddingField(false)} style={{ ...styles.btnSecondary, height: 24, fontSize: 11 }}>Cancel</button>
                    </div>
                  </td>
                </tr>
              )}
              {filtered.length === 0 && !addingField && (
                <tr>
                  <td colSpan={9} style={styles.gridEmpty}>no fields match this filter</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {inspectorOpen
          ? <Inspector
              active={active}
              composition={table.compositionKind}
              sources={bindingSources}
              rowEdit={rowEdits[active?.tgt ?? '']}
              onSave={(edit) => handleSaveEdit(active, edit)}
              completions={transformCompletions}
              onClose={() => setInspectorOpen(false)}
            />
          : <InspectorRail onOpen={() => setInspectorOpen(true)} />}
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
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={styles.aliasChipFilled}>{s.alias}</span>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.table}</span>
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

function Inspector({ active, composition, sources, rowEdit, onSave, completions, onClose }: {
  active: MappingRow | undefined;
  composition: TobeTable['compositionKind'];
  sources: TobeTable['sources'];
  rowEdit?: RowEdit;
  onSave: (edit: RowEdit) => void;
  completions?: string[];
  onClose: () => void;
}) {
  const [editingRule, setEditingRule] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [savedRule, setSavedRule] = useState<string | null>(null);
  const [ruleError, setRuleError] = useState<string | null>(null);
  const [editNotNull, setEditNotNull] = useState(false);
  const [editDefault, setEditDefault] = useState('');
  const [editSrc, setEditSrc] = useState<string[]>([]);
  const [editSrcType, setEditSrcType] = useState<string[]>([]);
  const [savedSrc, setSavedSrc] = useState<string[] | null>(null);
  const [savedSrcType, setSavedSrcType] = useState<string[] | null>(null);
  const [savedDefault, setSavedDefault] = useState<string | null>(null);
  const [savedNotNull, setSavedNotNull] = useState<boolean | null>(null);
  const [editStrategy, setEditStrategy] = useState<'expression' | 'null' | 'default'>('expression');
  const [savedStrategy, setSavedStrategy] = useState<'expression' | 'null' | 'default' | null>(null);
  const [userFnOpen, setUserFnOpen] = useState(false);
  const [javaCode, setJavaCode] = useState('');
  useEffect(() => {
    setEditingRule(false); setRuleError(null);
    const re = rowEdit;
    setSavedRule(re?.savedRule ?? null);
    setSavedDefault(re?.savedDefault ?? null);
    setSavedNotNull(re?.savedNotNull ?? null);
    setSavedStrategy(re?.savedStrategy ?? null);
    const src = re?.savedSrc ?? null;
    setSavedSrc(src);
    setSavedSrcType(src ? src.map((s) => resolveSrcType(s, sources)) : null);
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!active) return null;
  const initSrc: string[] = active.src === '—' ? [] : [active.sourceAlias ? `${active.sourceAlias}.${active.src}` : active.src];
  const resolveType = (s: string) => resolveSrcType(s, sources);
  const validAliases = new Set(sources.map((s) => s.alias));
  const handleEdit = () => {
    const inferredStrategy = savedStrategy ?? (active.rule === 'null' ? 'null' : active.rule === 'default' ? 'default' : 'expression');
    setEditStrategy(inferredStrategy);
    setEditValue((savedRule ?? transformPlain(active)).toUpperCase());
    setEditNotNull(savedNotNull !== null ? savedNotNull : active.tgtNullable === false);
    setEditDefault(savedDefault ?? active.ddlDefault ?? '');
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
    if (editStrategy === 'expression') {
      const err = validateRule(editValue);
      if (err) { setRuleError(err); return; }
    }
    setRuleError(null);
    setSavedStrategy(editStrategy);
    setSavedRule(editStrategy === 'expression' ? editValue : null);
    setSavedDefault(editDefault);
    setSavedNotNull(editNotNull);
    const filled = editSrc.filter(Boolean);
    const newSrc = filled.length > 0 ? filled : null;
    setSavedSrc(newSrc);
    setSavedSrcType(newSrc ? newSrc.map(resolveType) : null);
    onSave({ savedRule: editStrategy === 'expression' ? editValue : undefined, savedSrc: newSrc ?? undefined, savedDefault: editDefault, savedNotNull: editNotNull, savedStrategy: editStrategy });
    setEditingRule(false);
  };
  const updateEditSrcAt = (i: number, val: string) => {
    setEditSrc((prev) => prev.map((x, j) => j === i ? val : x));
    setEditSrcType((prev) => prev.map((x, j) => j === i ? resolveType(val) : x));
  };

  const displaySrcArr = savedSrc ?? initSrc;
  const displaySrcName = displaySrcArr.length === 0
    ? '(unassigned)'
    : displaySrcArr[0].slice(displaySrcArr[0].lastIndexOf('.') + 1) +
      (displaySrcArr.length > 1 ? ` +${displaySrcArr.length - 1}` : '');
  return (
    <aside style={styles.inspector}>
      <div style={styles.inspectorHeader}>
        <button onClick={onClose} title="Hide detail" style={styles.inspectorClose}><Ic.x /></button>
        <div style={styles.inspectorEyebrow}>Mapping detail</div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 600 }}>{displaySrcName}</div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-3)' }}>→ {active.tgt}</div>
      </div>

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
          {editingRule ? (
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 11.5, color: 'var(--text-2)' }}>
              <input type="checkbox" checked={editNotNull} onChange={(e) => setEditNotNull(e.target.checked)} style={{ margin: 0 }} />
              NOT NULL
            </label>
          ) : (
            (savedNotNull !== null ? savedNotNull : active.tgtNullable === false)
              ? <StatusBadge tone="warn">required</StatusBadge>
              : <span style={{ color: 'var(--text-4)' }}>nullable</span>
          )}
        </MetaRow>
        <MetaRow k="Default">
          {editingRule ? (
            <input
              value={editDefault}
              onChange={(e) => setEditDefault(e.target.value)}
              placeholder="DDL DEFAULT value"
              style={styles.metaInput}
            />
          ) : (
            (savedDefault ?? active.ddlDefault)
              ? <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--text-2)' }}>{savedDefault ?? active.ddlDefault}</span>
              : <span style={{ color: 'var(--text-4)' }}>—</span>
          )}
        </MetaRow>
      </div>

      <div style={styles.section}>
        <div style={styles.sectionLabel}>Transform</div>
        {editingRule ? (
          <>
            <div style={styles.strategyBtnGroup}>
              {(['expression', 'null', 'default'] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => { setEditStrategy(s); setRuleError(null); }}
                  style={{ ...styles.strategyBtn, ...(editStrategy === s ? styles.strategyBtnActive : {}) }}
                >
                  {s === 'expression' ? 'Expression' : s === 'null' ? 'NULL' : 'Default'}
                </button>
              ))}
            </div>
            {editStrategy === 'expression' && (
              <>
                <HighlightEditor
                  value={editValue}
                  onChange={(v) => { setEditValue(v.toUpperCase()); if (ruleError) setRuleError(null); }}
                  language="sql"
                  hasError={!!ruleError}
                  completions={completions}
                  minHeight={72}
                />
                {ruleError && <div style={styles.ruleErrorMsg}>{ruleError}</div>}
              </>
            )}
            {editStrategy === 'null' && (
              <div style={styles.codeBlock}>
                <span style={{ color: '#e8b86f' }}>NULL</span>
                <span style={{ color: '#7a8aa6' }}>{' '}-- 이 컬럼은 항상 NULL 로 출력됩니다</span>
              </div>
            )}
            {editStrategy === 'default' && (
              <div style={styles.codeBlock}>
                <span style={{ color: '#e8b86f' }}>DEFAULT</span>
                <span style={{ color: '#7a8aa6' }}>{' '}-- DDL 기본값을 사용합니다</span>
              </div>
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
            return (
              <div style={styles.codeBlock}>
                <span style={{ color: '#e8b86f' }}>DEFAULT</span>
                {(savedDefault ?? active.ddlDefault) && (
                  <span style={{ color: '#9fd9b3' }}>{' '}{savedDefault ?? active.ddlDefault}</span>
                )}
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

      <div style={styles.section}>
        <div style={styles.sectionLabel}>
          Sample preview <StatusBadge tone="warn">ui only</StatusBadge>
        </div>
        <div style={styles.sampleTable}>
          <div style={styles.sampleHeader}>
            <span>Source ({active.src})</span>
            <span>Transformed ({active.tgt})</span>
          </div>
          {samplePreview(active).map((row, i) => (
            <div
              key={i}
              style={{
                ...styles.sampleRow,
                background: i % 2 ? 'var(--panel-2)' : 'var(--panel)',
              }}
            >
              <span style={{ color: 'var(--text-3)' }}>{row.src}</span>
              <span style={{ color: row.out === 'NULL' ? 'var(--text-4)' : 'var(--text)' }}>{row.out}</span>
            </div>
          ))}
        </div>
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
    </aside>
  );
}

function InspectorRail({ onOpen }: { onOpen: () => void }) {
  return (
    <div onClick={onOpen} title="Show mapping detail" style={styles.inspectorRail}>
      <div style={styles.inspectorRailLabel}>‹ Mapping detail</div>
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

function samplePreview(r: MappingRow): { src: string; out: string }[] {
  if (r.rule === 'unmapped' || r.rule === 'skip') return [];
  if (r.rule === 'null')     return Array.from({ length: 4 }, () => ({ src: '—', out: 'NULL' }));
  if (r.rule === 'default')  return Array.from({ length: 4 }, () => ({ src: '—', out: r.ddlDefault ?? 'DEFAULT' }));
  const samples = ['000142', '000143', '000144', '000145', '000146'];
  return samples.map((s) => ({ src: s, out: r.rule === 'auto' ? s : s.replace(/^0+/, '') }));
}

// ── AS-IS table detail ───────────────────────────────────────

function AsisTableDetail({ table, onJumpTobe }: { table: AsisTable; onJumpTobe: (internalName: string, name: string) => void }) {
  const cols = ASIS_COLUMNS[table.name] || [];
  const [subTab, setSubTab] = useState<'columns' | 'samples' | 'profile'>('columns');
  const routedTobe = TOBE_TABLES.filter((t) => table.routing.includes(t.internalName));

  return (
    <div style={styles.workspace}>
      <div style={styles.contextBar}>
        <span style={{ ...styles.sidePill, color: 'var(--amber)', background: 'var(--amber-50)', borderColor: 'var(--amber)' }}>AS-IS</span>
        <div style={styles.tableChip}>{table.name}</div>
        <div style={{ flex: 1 }} />
        <button style={styles.btnSecondary}><Ic.plus /> Route to TO-BE…</button>
      </div>

      <div style={styles.asisHint}>
        <Ic.warn />
        <span>이 화면은 <b>읽기 전용 브라우저</b>입니다. 컬럼 매핑 규칙을 편집하려면 좌측 TO-BE 트리에서 대상 테이블을 선택하세요.</span>
      </div>

      <div style={styles.routingPanel}>
        <div style={styles.routingHeader}>Routing</div>
        {routedTobe.length === 0 ? (
          <div style={styles.routingEmpty}>
            이 AS-IS 테이블은 아직 어느 TO-BE 테이블에도 연결되어 있지 않습니다. [Route to TO-BE…] 로 이행 대상을 지정하세요.
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

      {/* Sub-tabs */}
      <div style={styles.subTabs}>
        {(
          [
            { k: 'columns', l: 'Columns', c: cols.length },
            { k: 'samples', l: 'Samples', c: 10 },
            { k: 'profile', l: 'Profile', c: cols.length },
          ] as const
        ).map((tdef) => {
          const isActive = subTab === tdef.k;
          return (
            <button key={tdef.k} onClick={() => setSubTab(tdef.k)} style={{
              ...styles.subTabBtn,
              color: isActive ? 'var(--navy)' : 'var(--text-2)',
              fontWeight: isActive ? 600 : 500,
              boxShadow: isActive ? 'inset 0 -2px 0 var(--navy)' : 'none',
            }}>
              {tdef.l}
              <span style={{
                ...styles.subTabCount,
                background: isActive ? 'var(--navy-50)' : 'var(--panel-2)',
              }}>{tdef.c}</span>
            </button>
          );
        })}
      </div>

      <div style={{ flex: 1, overflow: 'auto', background: 'var(--panel)' }}>
        {subTab === 'columns' && (
          <table style={styles.gridTable}>
            <thead>
              <tr>
                {['Column', 'Type', 'Null %', 'Distinct'].map((h, i) => (
                  <th key={i} style={{ ...styles.gridTh, textAlign: i >= 2 ? 'right' : 'left' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cols.map((c, i) => (
                <tr key={c.name} style={{ background: i % 2 === 1 ? 'var(--zebra)' : 'var(--panel)', borderBottom: '1px solid var(--border)' }}>
                  <td style={{ ...styles.gridTd, fontFamily: 'var(--mono)', fontWeight: 500 }}>
                    {c.pk && <span style={{ color: 'var(--navy)', marginRight: 5, fontSize: 9, fontWeight: 700 }}>PK</span>}
                    {c.name}
                  </td>
                  <td style={styles.gridTd}><TypeBadge>{c.type}</TypeBadge></td>
                  <td style={{ ...styles.gridTd, textAlign: 'right', fontFamily: 'var(--mono)', color: (c.nullPct ?? 0) > 10 ? 'var(--amber)' : 'var(--text-2)' }}>
                    {(c.nullPct ?? 0).toFixed(1)}%
                  </td>
                  <td style={{ ...styles.gridTd, textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--text-2)' }}>
                    {(c.distinct ?? 0).toLocaleString()}
                  </td>
                </tr>
              ))}
              {cols.length === 0 && (
                <tr><td colSpan={4} style={styles.gridEmpty}>(no column schema available for this table)</td></tr>
              )}
            </tbody>
          </table>
        )}
        {subTab === 'samples' && (
          <div style={styles.subTabPlaceholder}>샘플 미리보기는 실접속 시 SELECT * LIMIT 10 으로 채워집니다.</div>
        )}
        {subTab === 'profile' && (
          <div style={styles.subTabPlaceholder}>고정 프로파일 값입니다. 실접속 시 ANALYZE / information_schema 로 채워집니다.</div>
        )}
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

function StatusBadge({ tone, children }: { tone: 'ok' | 'warn' | 'err' | 'info' | 'skip' | 'queued'; children: React.ReactNode }) {
  const palette = {
    ok:     { color: 'var(--green)', bg: 'var(--green-50)', border: 'var(--green)' },
    warn:   { color: 'var(--amber)', bg: 'var(--amber-50)', border: 'var(--amber)' },
    err:    { color: 'var(--red)',   bg: 'var(--red-50)',   border: 'var(--red)' },
    info:   { color: 'var(--navy)',  bg: 'var(--navy-50)',  border: 'var(--navy)' },
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

function RuleTag({ rule }: { rule: MappingRow['rule'] }) {
  const map: Record<MappingRow['rule'], { l: string; tone: Parameters<typeof StatusBadge>[0]['tone'] }> = {
    auto:     { l: 'pass',  tone: 'ok' },
    rule:     { l: 'rule',  tone: 'info' },
    null:     { l: 'null',  tone: 'queued' },
    default:  { l: 'def',   tone: 'queued' },
    unmapped: { l: '—',     tone: 'queued' },
    added:    { l: 'new',   tone: 'ok' },
    skip:     { l: 'skip',  tone: 'skip' },
  };
  return <StatusBadge tone={map[rule].tone}>{map[rule].l}</StatusBadge>;
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
    overflow: 'auto',
  },
  inspectorHeader: { padding: '12px 14px', borderBottom: '1px solid var(--border)', position: 'relative' },
  inspectorClose: {
    position: 'absolute', top: 8, right: 10,
    border: 'none', background: 'transparent',
    color: 'var(--text-3)', cursor: 'pointer', padding: 4,
    display: 'inline-flex',
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
  subTabs: {
    display: 'flex', alignItems: 'stretch',
    padding: '0 14px',
    borderBottom: '1px solid var(--border)',
    background: 'var(--panel)', height: 30,
  },
  subTabBtn: {
    position: 'relative',
    padding: '0 13px', border: 'none', background: 'transparent',
    display: 'inline-flex', alignItems: 'center', gap: 6,
    cursor: 'pointer', fontSize: 12,
  },
  subTabCount: {
    fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-4)',
    padding: '0 5px',
    border: '1px solid var(--border)', borderRadius: 6,
  },
  subTabPlaceholder: { padding: '24px', fontSize: 11.5, color: 'var(--text-3)', fontFamily: 'var(--mono)' },

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
