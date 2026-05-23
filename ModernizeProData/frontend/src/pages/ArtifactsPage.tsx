import { useState, useMemo } from 'react';
import { useWorkspaceStore } from '../store/workspace';
import { useT, type TranslationKey } from '../i18n';

/**
 * Artifacts tab — 매핑 스냅샷·DDL·검증 리포트 등의 산출물 미리보기·다운로드.
 *
 * 좌측: 카테고리 트리 + Export all 버튼. 우측: Excel 워크북 chrome
 * (titlebar → ribbon → formula bar → sheet grid → sheet tabs → status bar).
 *
 * Excel chrome 은 산출물 데이터가 없을 때도 실제 Excel 윈도우처럼 보이도록
 * placeholder 컬럼/타입을 채워서 렌더한다. 실데이터가 들어오면
 * PLACEHOLDER_COLUMNS 만 교체하면 된다.
 *
 * Prototype: Prototype/src/artifacts.jsx, excel-ui-prototype.html
 */

export type CategoryKey = 'dashboard' | 'diff' | 'ddl' | 'sql' | 'mapping' | 'validation';

export interface Category {
  key: CategoryKey;
  labelKey: TranslationKey;
  suffix: string;
  icon: string;
  /** dashboard 는 프로젝트 단위 단일 산출물, 나머지는 테이블 단위. */
  single?: boolean;
}

export const CATEGORIES: Category[] = [
  { key: 'dashboard',  labelKey: 'artifacts.cat.dashboard',  suffix: '.dashboard.xlsx', icon: '▣', single: true },
  { key: 'diff',       labelKey: 'artifacts.cat.diff',       suffix: '.diff.xlsx',      icon: '◨' },
  { key: 'ddl',        labelKey: 'artifacts.cat.ddl',        suffix: '.ddl.sql',        icon: '▤' },
  { key: 'sql',        labelKey: 'artifacts.cat.sql',        suffix: '.migrate.sql',    icon: '↦' },
  { key: 'mapping',    labelKey: 'artifacts.cat.mapping',    suffix: '.map.xlsx',       icon: '≡' },
  { key: 'validation', labelKey: 'artifacts.cat.validation', suffix: '.report.xlsx',    icon: '✓' },
];

/* 수식 입력줄에 보일 카테고리별 placeholder 텍스트. */
const SUMMARY_PLACEHOLDER: Record<CategoryKey, string> = {
  dashboard:  'Snapshot: {project} · {n} tables · {n.n}% migrated',
  diff:       'Schema diff: {ASIS} → {TOBE} · +n added · -n removed · ~n typed',
  ddl:        'DDL: {table} · {n} columns · {n} primary key',
  sql:        'Migration SQL: {ASIS} → {TOBE} · {n} lines',
  mapping:    'Mapping: {ASIS} → {TOBE} · {n} rules · {n} lookups',
  validation: 'Validation: {table} · {n} checks · PASS/FAIL',
};

const SHEET_NAMES: Record<CategoryKey, string[]> = {
  dashboard:  ['Overview', 'Tables', 'Issues'],
  diff:       ['Diff', 'Summary', 'ASIS', 'TOBE'],
  ddl:        ['DDL'],
  sql:        ['Migration SQL'],
  mapping:    ['Overview', 'Rules', 'Lookups'],
  validation: ['Overview', 'Sum recon', 'NULL parity', 'Range'],
};

/* 카테고리별 placeholder 컬럼/타입 — Excel-style 그리드 채우기 용도.
   실제 산출물 데이터가 들어오면 이 값들을 실데이터로 교체한다. */
const PLACEHOLDER_COLUMNS: Record<CategoryKey, { name: string; type: string }[]> = {
  dashboard: [
    { name: 'project',         type: 'VARCHAR' },
    { name: 'tables_total',    type: 'INT' },
    { name: 'tables_migrated', type: 'INT' },
    { name: 'progress_pct',    type: 'DECIMAL(5,2)' },
    { name: 'last_run_at',     type: 'TIMESTAMP' },
  ],
  diff: [
    { name: 'table',  type: 'VARCHAR' },
    { name: 'column', type: 'VARCHAR' },
    { name: 'asis',   type: 'VARCHAR' },
    { name: 'tobe',   type: 'VARCHAR' },
    { name: 'status', type: 'ENUM' },
  ],
  ddl: [
    { name: 'column_name', type: 'VARCHAR' },
    { name: 'data_type',   type: 'VARCHAR' },
    { name: 'nullable',    type: 'BOOLEAN' },
    { name: 'default',     type: 'VARCHAR' },
    { name: 'pk',          type: 'BOOLEAN' },
    { name: 'comment',     type: 'VARCHAR(255)' },
  ],
  sql: [
    { name: 'line_no',        type: 'INT' },
    { name: 'statement_type', type: 'ENUM' },
    { name: 'target_table',   type: 'VARCHAR' },
    { name: 'statement',      type: 'TEXT' },
    { name: 'applied',        type: 'BOOLEAN' },
    { name: 'applied_at',     type: 'TIMESTAMP' },
  ],
  mapping: [
    { name: 'asis_table',  type: 'VARCHAR' },
    { name: 'asis_column', type: 'VARCHAR' },
    { name: 'tobe_table',  type: 'VARCHAR' },
    { name: 'tobe_column', type: 'VARCHAR' },
    { name: 'transform',   type: 'EXPR' },
    { name: 'lookup_key',  type: 'VARCHAR' },
  ],
  validation: [
    { name: 'check_name', type: 'VARCHAR' },
    { name: 'asis_value', type: 'NUMBER' },
    { name: 'tobe_value', type: 'NUMBER' },
    { name: 'diff',       type: 'NUMBER' },
    { name: 'result',     type: 'ENUM' },
  ],
};

const EMPTY_ROWS = 20;

/** A, B, ..., Z, AA, AB, ... Excel-식 알파벳 컬럼 라벨. */
function colLabel(i: number): string {
  let s = '';
  let n = i;
  while (true) {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
    if (n < 0) break;
  }
  return s;
}

export function ArtifactsPage() {
  const t = useT();
  const projects = useWorkspaceStore((s) => s.projects);
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const project = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId],
  );

  const [openCats, setOpenCats] = useState<Record<CategoryKey, boolean>>({
    dashboard: true,
    diff: true,
    ddl: true,
    sql: false,
    mapping: false,
    validation: false,
  });
  const [selectedCat, setSelectedCat] = useState<CategoryKey>('dashboard');

  if (!project) {
    return (
      <div>
        <div style={styles.empty}>
          <div style={styles.emptyTitle}>{t('artifacts.empty.noProject')}</div>
        </div>
      </div>
    );
  }

  const activeCategory = CATEGORIES.find((c) => c.key === selectedCat) ?? CATEGORIES[0];

  return (
    <div style={styles.page}>
      {/* Sidebar — feature/artifacts 디자인 유지 (export btn in header) */}
      <aside style={styles.sidebar}>
        <div style={styles.sidebarHeader}>
          <span style={styles.sidebarHeaderLabel}>Artifacts</span>
          <span style={styles.sidebarHeaderCount}>0</span>
          <div style={{ flex: 1 }} />
          <button style={styles.exportBtnDisabled} disabled title={t('artifacts.empty.hint')}>
            {t('artifacts.exportAll')}
          </button>
        </div>
        <ArtifactTree
          openCats={openCats}
          setOpenCats={setOpenCats}
          selectedCat={selectedCat}
          onSelect={(cat) => setSelectedCat(cat)}
        />
      </aside>

      {/* Excel workbook chrome — fills the right pane completely */}
      <section style={styles.body}>
        <ExcelWorkbook category={activeCategory} />
      </section>
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────
   Sidebar tree
   ─────────────────────────────────────────────────────────────── */

interface TreeProps {
  openCats: Record<CategoryKey, boolean>;
  setOpenCats: (updater: (prev: Record<CategoryKey, boolean>) => Record<CategoryKey, boolean>) => void;
  selectedCat: CategoryKey;
  onSelect: (cat: CategoryKey) => void;
}

function ArtifactTree({ openCats, setOpenCats, selectedCat, onSelect }: TreeProps) {
  const t = useT();
  return (
    <div style={styles.tree}>
      {CATEGORIES.map((cat) => {
        const open = openCats[cat.key];
        const active = selectedCat === cat.key;
        return (
          <div key={cat.key} style={{ marginBottom: 2 }}>
            <div
              onClick={() => {
                onSelect(cat.key);
                setOpenCats((o) => ({ ...o, [cat.key]: !o[cat.key] }));
              }}
              style={{
                ...styles.catRow,
                ...(active ? styles.catRowActive : null),
              }}
            >
              <span style={styles.catCaret}>{open ? '▾' : '▸'}</span>
              <span style={styles.catIcon}>{cat.icon}</span>
              <span style={styles.catLabel}>{t(cat.labelKey)}</span>
              <span style={styles.catCount}>0</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────
   Excel workbook chrome (prototype port)
   ─────────────────────────────────────────────────────────────── */

function ExcelWorkbook({ category }: { category: Category }) {
  const t = useT();
  const filename = `${t('artifacts.workbook.placeholderName')}${category.suffix}`;
  const cols = PLACEHOLDER_COLUMNS[category.key];

  return (
    <div style={styles.workbook}>
      {/* 1) Title bar — 가운데 정렬 파일명 + 우측 윈도우 버튼 */}
      <div style={styles.titleBar}>
        <div style={styles.titleBarCenter}>
          {filename} ({t('artifacts.workbook.readOnly')}) - Report
        </div>
        <div style={styles.titleBarRight}>
          <span style={styles.titleBarBtn}>─</span>
          <span style={styles.titleBarBtn}>▢</span>
          <span style={styles.titleBarBtn}>✕</span>
        </div>
      </div>

      {/* 2) Ribbon — File 짙은 녹색, Home 활성 (밝은 회색) */}
      <div style={styles.ribbon}>
        <span style={{ ...styles.ribbonTab, ...styles.ribbonTabFile }}>File</span>
        <span style={{ ...styles.ribbonTab, ...styles.ribbonTabActive }}>Home</span>
        {['Insert', 'Page Layout', 'Formulas', 'Data', 'Review', 'View', 'Help'].map((m) => (
          <span key={m} style={styles.ribbonTab}>{m}</span>
        ))}
      </div>
      <div style={styles.ribbonBody} />

      {/* 3) Formula bar — Name Box / ✕ ✓ fx / 입력 영역 */}
      <div style={styles.formulaBar}>
        <div style={styles.nameBox}>
          <span>A1</span>
          <span style={styles.nameBoxCaret}>▾</span>
        </div>
        <div style={styles.formulaButtons}>
          <span style={{ ...styles.formulaBtn, ...styles.formulaBtnCancel }}>✕</span>
          <span style={{ ...styles.formulaBtn, ...styles.formulaBtnConfirm }}>✓</span>
          <span style={{ ...styles.formulaBtn, ...styles.formulaBtnFx }}>
            <i>f</i><sub>x</sub>
          </span>
        </div>
        <div style={styles.formulaInput}>{SUMMARY_PLACEHOLDER[category.key]}</div>
      </div>

      {/* 4) Sheet — 실제 Excel 그리드 */}
      <div style={styles.sheetArea}>
        <table style={styles.sheet}>
          <thead>
            {/* (A) 알파벳 헤더 */}
            <tr>
              <th style={styles.corner} />
              {cols.map((_, i) => (
                <th key={i} style={styles.colHeader}>{colLabel(i)}</th>
              ))}
            </tr>
            {/* (B) 1행 — 컬럼명 */}
            <tr>
              <th style={{ ...styles.rowHeader, ...styles.rowHeaderName }}>1</th>
              {cols.map((c) => (
                <th key={`n-${c.name}`} style={styles.colName}>{c.name}</th>
              ))}
            </tr>
            {/* (C) 2행 — 타입 */}
            <tr>
              <th style={{ ...styles.rowHeader, ...styles.rowHeaderType }}>2</th>
              {cols.map((c) => (
                <th key={`t-${c.name}`} style={styles.colType}>{c.type}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* (D) 빈 데이터 행 */}
            {Array.from({ length: EMPTY_ROWS }, (_, r) => (
              <tr key={r}>
                <td style={styles.rowHeader}>{r + 3}</td>
                {cols.map((_, c) => (
                  <td key={c} style={styles.cell} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 5) Sheet tabs */}
      <div style={styles.sheetTabs}>
        {SHEET_NAMES[category.key].map((name, i) => (
          <span
            key={name}
            style={i === 0 ? styles.sheetTabActive : styles.sheetTabInactive}
          >
            {name}
          </span>
        ))}
        <div style={{ flex: 1 }} />
      </div>

      {/* 6) Status bar */}
      <div style={styles.statusBar}>
        Ready · cols <span style={styles.statusNum}>{cols.length}</span> · rows <span style={styles.statusNum}>{EMPTY_ROWS}</span>
      </div>
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────
   Styles
   ─────────────────────────────────────────────────────────────── */

/* Excel 프로토타입 팔레트 — excel-ui-prototype.html spec 그대로. */
const EXCEL_GREEN         = '#217346';
const EXCEL_GREEN_DARK    = '#185c37';
const EXCEL_RIBBON_BG     = '#f3f2f1';
const EXCEL_BORDER        = '#d0d0d0';
const EXCEL_BORDER_STRONG = '#b8b8b8';
const EXCEL_BORDER_CELL   = '#e1e1e1';
const EXCEL_HEADER_BG     = '#e1e1e1';
const EXCEL_TEXT          = '#201f1e';
const EXCEL_TEXT_DIM      = '#605e5c';
const EXCEL_TEXT_MUTED    = '#555';

const EXCEL_FONT = '"Calibri","Segoe UI","맑은 고딕","Malgun Gothic",system-ui,sans-serif';

const styles: Record<string, React.CSSProperties> = {
  empty: {
    background: 'var(--panel)',
    border: '1px dashed var(--border-strong)',
    borderRadius: 6,
    padding: '50px 24px',
    textAlign: 'center',
  },
  emptyTitle: { fontSize: 13, fontWeight: 600, color: 'var(--text-3)' },

  page: {
    display: 'flex',
    height: 'calc(100vh - 140px)',
    minHeight: 480,
    background: 'var(--panel)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    overflow: 'hidden',
  },

  /* Sidebar — feature/artifacts 디자인 + 폭 200px */
  sidebar: {
    width: 200,
    minWidth: 200,
    borderRight: '1px solid var(--border)',
    background: 'var(--panel)',
    overflow: 'auto',
    display: 'flex',
    flexDirection: 'column',
  },
  sidebarHeader: {
    padding: '8px 12px',
    borderBottom: '1px solid var(--border)',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  sidebarHeaderLabel: {
    fontSize: 10,
    color: 'var(--text-3)',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  sidebarHeaderCount: {
    fontSize: 10,
    fontFamily: 'var(--mono)',
    color: 'var(--text-4)',
  },
  exportBtnDisabled: {
    padding: '3px 10px',
    fontSize: 10.5,
    fontFamily: 'var(--mono)',
    background: 'var(--panel-2)',
    color: 'var(--text-4)',
    border: '1px solid var(--border)',
    borderRadius: 3,
    cursor: 'not-allowed',
  },

  tree: { fontFamily: 'var(--mono)', fontSize: 11, padding: '6px 0' },
  catRow: {
    padding: '3px 10px',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    cursor: 'pointer',
    color: 'var(--text-2)',
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  catRowActive: {
    background: 'var(--navy-50)',
    color: 'var(--navy)',
    borderLeft: '2px solid var(--navy)',
  },
  catCaret: { display: 'inline-block', width: 8, color: 'var(--text-4)' },
  catIcon: { color: 'var(--text-4)' },
  catLabel: { flex: 1 },
  catCount: { color: 'var(--text-4)' },

  /* ===== Excel workbook chrome (fills right pane) ===== */
  body: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    background: '#d4d4d4',
  },
  workbook: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    background: '#fff',
    fontFamily: EXCEL_FONT,
    fontSize: 11,
    color: EXCEL_TEXT,
    minHeight: 0,
    userSelect: 'none',
  },

  /* 1) Title bar */
  titleBar: {
    height: 28,
    background: EXCEL_GREEN,
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    padding: 0,
    fontSize: 11.5,
    flexShrink: 0,
    position: 'relative',
  },
  titleBarCenter: {
    position: 'absolute',
    left: '50%',
    transform: 'translateX(-50%)',
    color: '#fff',
    fontSize: 11.5,
    letterSpacing: 0.2,
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
  },
  titleBarRight: {
    marginLeft: 'auto',
    display: 'flex',
    alignItems: 'stretch',
    height: '100%',
  },
  titleBarBtn: {
    width: 46,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#fff',
    fontSize: 13,
    cursor: 'default',
  },

  /* 2) Ribbon */
  ribbon: {
    height: 28,
    background: EXCEL_GREEN,
    color: '#fff',
    display: 'flex',
    alignItems: 'flex-end',
    padding: '0 8px',
    fontSize: 12,
    flexShrink: 0,
  },
  ribbonTab: {
    padding: '4px 12px',
    height: 24,
    lineHeight: '16px',
    color: 'rgba(255,255,255,0.92)',
    cursor: 'default',
  },
  ribbonTabFile: {
    background: EXCEL_GREEN_DARK,
    fontWeight: 600,
  },
  ribbonTabActive: {
    background: EXCEL_RIBBON_BG,
    color: EXCEL_TEXT,
    borderTopLeftRadius: 2,
    borderTopRightRadius: 2,
    fontWeight: 600,
  },
  ribbonBody: {
    height: 4,
    background: EXCEL_RIBBON_BG,
    borderBottom: `1px solid ${EXCEL_BORDER}`,
    flexShrink: 0,
  },

  /* 3) Formula bar */
  formulaBar: {
    height: 24,
    background: '#F3F3F3',
    display: 'flex',
    alignItems: 'stretch',
    borderBottom: `1px solid ${EXCEL_BORDER}`,
    flexShrink: 0,
    padding: '2px 4px',
    gap: 4,
  },
  nameBox: {
    width: 110,
    background: '#fff',
    border: `1px solid ${EXCEL_BORDER}`,
    display: 'flex',
    alignItems: 'center',
    padding: '0 8px',
    fontSize: 11,
    color: EXCEL_TEXT,
  },
  nameBoxCaret: {
    marginLeft: 'auto',
    fontSize: 9,
    color: EXCEL_TEXT_DIM,
  },
  formulaButtons: {
    display: 'flex',
    alignItems: 'center',
    gap: 2,
    padding: '0 4px',
  },
  formulaBtn: {
    width: 20,
    height: 18,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'transparent',
    color: '#888',
    fontSize: 11,
    cursor: 'default',
  },
  formulaBtnCancel:  { color: '#b40000' },
  formulaBtnConfirm: { color: '#006400' },
  formulaBtnFx: {
    color: EXCEL_TEXT_DIM,
    fontFamily: '"Cambria Math","Times New Roman",serif',
    fontStyle: 'italic',
    fontSize: 12,
  },
  formulaInput: {
    flex: 1,
    background: '#fff',
    border: `1px solid ${EXCEL_BORDER}`,
    padding: '0 8px',
    display: 'flex',
    alignItems: 'center',
    fontSize: 11,
    color: '#9aa3b0',
    fontStyle: 'italic',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },

  /* 4) Sheet */
  sheetArea: {
    flex: 1,
    overflow: 'auto',
    background: '#fff',
    minHeight: 0,
  },
  sheet: {
    borderCollapse: 'collapse',
    fontFamily: '"Calibri","Segoe UI",system-ui,sans-serif',
    fontSize: 11,
    background: '#fff',
    width: 'max-content',
    minWidth: '100%',
  },
  corner: {
    position: 'sticky',
    top: 0,
    left: 0,
    zIndex: 3,
    width: 32,
    height: 20,
    background: EXCEL_HEADER_BG,
    borderRight: `1px solid ${EXCEL_BORDER_STRONG}`,
    borderBottom: `1px solid ${EXCEL_BORDER_STRONG}`,
    padding: 0,
  },
  colHeader: {
    position: 'sticky',
    top: 0,
    zIndex: 1,
    minWidth: 100,
    height: 20,
    background: EXCEL_HEADER_BG,
    color: EXCEL_TEXT_MUTED,
    borderRight: '1px solid #c8c8c8',
    borderBottom: `1px solid ${EXCEL_BORDER_STRONG}`,
    fontSize: 11,
    fontWeight: 400,
    textAlign: 'center',
  },
  rowHeader: {
    position: 'sticky',
    left: 0,
    zIndex: 1,
    width: 32,
    height: 20,
    background: EXCEL_HEADER_BG,
    color: EXCEL_TEXT_MUTED,
    borderRight: `1px solid ${EXCEL_BORDER_STRONG}`,
    borderBottom: '1px solid #d8d8d8',
    fontSize: 11,
    fontWeight: 400,
    textAlign: 'center',
    padding: 0,
  },
  /* 1행 / 2행 — 사이 border 제거해서 셀 병합처럼 보이게 */
  rowHeaderName: {
    top: 20,
    zIndex: 2,
    borderBottom: 'none',
  },
  rowHeaderType: {
    top: 42,
    zIndex: 2,
    borderBottom: `1px solid ${EXCEL_BORDER_STRONG}`,
  },
  colName: {
    position: 'sticky',
    top: 20,
    zIndex: 1,
    minWidth: 100,
    height: 22,
    padding: '3px 6px 0 6px',
    background: EXCEL_RIBBON_BG,
    color: EXCEL_GREEN,
    fontSize: 12,
    fontWeight: 700,
    textAlign: 'left',
    borderRight: '1px solid #c8c8c8',
    borderBottom: 'none',
    verticalAlign: 'bottom',
    whiteSpace: 'nowrap',
  },
  colType: {
    position: 'sticky',
    top: 42,
    zIndex: 1,
    minWidth: 100,
    height: 20,
    padding: '0 6px 3px 6px',
    background: EXCEL_RIBBON_BG,
    color: EXCEL_TEXT_DIM,
    fontSize: 10.5,
    fontWeight: 400,
    textAlign: 'left',
    borderRight: '1px solid #c8c8c8',
    borderBottom: `1px solid ${EXCEL_BORDER_STRONG}`,
    verticalAlign: 'top',
    whiteSpace: 'nowrap',
  },
  cell: {
    minWidth: 100,
    height: 20,
    padding: '0 6px',
    background: '#fff',
    color: EXCEL_TEXT,
    borderRight: `1px solid ${EXCEL_BORDER_CELL}`,
    borderBottom: `1px solid ${EXCEL_BORDER_CELL}`,
    fontSize: 11,
    verticalAlign: 'middle',
  },

  /* 5) Sheet tabs */
  sheetTabs: {
    height: 22,
    background: EXCEL_RIBBON_BG,
    borderTop: `1px solid ${EXCEL_BORDER}`,
    display: 'flex',
    alignItems: 'center',
    padding: '0 8px',
    gap: 4,
    flexShrink: 0,
  },
  sheetTabActive: {
    padding: '2px 14px',
    fontSize: 11,
    color: EXCEL_GREEN,
    fontWeight: 700,
    background: '#fff',
    border: '1px solid #c8c8c8',
    borderBottom: `2px solid ${EXCEL_GREEN}`,
    marginTop: 2,
    cursor: 'default',
  },
  sheetTabInactive: {
    padding: '2px 14px',
    fontSize: 11,
    color: '#444',
    background: '#fff',
    border: '1px solid #c8c8c8',
    borderBottom: 'none',
    marginTop: 2,
    cursor: 'default',
  },

  /* 6) Status bar */
  statusBar: {
    height: 22,
    background: EXCEL_GREEN,
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    padding: '0 12px',
    fontSize: 11,
    flexShrink: 0,
    gap: 4,
  },
  statusNum: { fontFamily: 'var(--mono)' },
};
