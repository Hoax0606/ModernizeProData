import { useState, useMemo } from 'react';
import { useWorkspaceStore } from '../store/workspace';
import { useT, type TranslationKey } from '../i18n';

/**
 * Artifacts tab — 매핑 스냅샷·DDL·검증 리포트 등의 산출물 미리보기·다운로드.
 *
 * 현재는 백엔드에 산출물 데이터가 없으므로 시각 구조(좌측 트리 + Excel-style
 * 워크북 chrome)만 그대로 구현하고 본문은 빈 상태로 둔다. 매핑·런 결과가
 * 들어오기 시작하면 각 카테고리의 items 와 sheet render 만 채우면 된다.
 *
 * Prototype: Prototype/src/artifacts.jsx
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

/* 데이터가 채워질 자리의 placeholder 텍스트 — 어떤 값이 들어올지 한눈에 보이도록.
   포맷은 '~/memory/project_artifacts_formula_bar.md' 참조. */
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
      {/* Sidebar */}
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

      {/* Workbook viewer */}
      <section style={styles.body}>
        <EmptyExcelWorkbook category={activeCategory} />
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
   Empty Excel workbook view
   ─────────────────────────────────────────────────────────────── */

function EmptyExcelWorkbook({ category }: { category: Category }) {
  const t = useT();
  const filename = `${t('artifacts.workbook.placeholderName')}${category.suffix}`;

  return (
    <div style={styles.workbookWrap}>
      <div style={styles.workbook}>
        {/* Title bar */}
        <div style={styles.titleBar}>
          <span>{filename}</span>
          <span style={styles.titleBarSep}>·</span>
          <span style={styles.titleBarMeta}>{t('artifacts.workbook.readOnly')}</span>
          <div style={{ flex: 1 }} />
          <button style={styles.titleBarBtnDisabled} disabled>
            {t('artifacts.workbook.download')}
          </button>
        </div>

        {/* Ribbon — Excel tabs across the top, no tab selected. */}
        <div style={styles.ribbon}>
          {['File', 'Home', 'Insert', 'Page Layout', 'Formulas', 'Data', 'Review', 'View'].map((m) => (
            <span key={m} style={styles.ribbonTab}>{m}</span>
          ))}
        </div>

        {/* Name Box (A1) + gray separator with vertical ellipsis + cancel/confirm/fx + formula content. */}
        <div style={styles.formulaRow}>
          <div style={styles.nameBox}>
            <span>A1</span>
            <span style={styles.nameBoxCaret}>▾</span>
          </div>
          <div style={styles.formulaSpacer}>⋮</div>
          <div style={styles.cancelIcon}>✕</div>
          <div style={styles.confirmIcon}>✓</div>
          <div style={styles.fxButton}>fx</div>
          <div style={styles.formulaPlaceholder}>{SUMMARY_PLACEHOLDER[category.key]}</div>
        </div>

        {/* Empty sheet */}
        <div style={styles.sheetArea}>
          <div style={styles.sheetEmpty}>
            <div style={styles.sheetEmptyTitle}>{t('artifacts.empty.title')}</div>
            <div style={styles.sheetEmptyHint}>{t('artifacts.workbook.noSheet')}</div>
          </div>
        </div>

        {/* Sheet tabs — category-specific names shown as placeholders. */}
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
      </div>
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────
   Styles
   ─────────────────────────────────────────────────────────────── */

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

  /* Sidebar */
  sidebar: {
    width: 260,
    minWidth: 260,
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
  catCaret: {
    display: 'inline-block',
    width: 8,
    color: 'var(--text-4)',
  },
  catIcon: { color: 'var(--text-4)' },
  catLabel: { flex: 1 },
  catCount: { color: 'var(--text-4)' },

  /* Workbook viewer */
  body: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--panel-2)',
    overflow: 'auto',
  },
  workbookWrap: { padding: '14px 14px', flex: '0 0 auto' },
  workbook: {
    maxWidth: 1100,
    margin: '0 auto',
    background: '#fff',
    border: '1px solid var(--border)',
    borderRadius: 4,
    boxShadow: '0 2px 8px rgba(20,30,50,.04)',
    overflow: 'hidden',
  },

  titleBar: {
    padding: '7px 12px',
    background: '#217346',
    color: '#fff',
    fontSize: 11,
    fontFamily: 'var(--mono)',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  titleBarSep: { color: 'rgba(255,255,255,.6)' },
  titleBarMeta: { color: 'rgba(255,255,255,.7)' },
  titleBarBtnDisabled: {
    padding: '2px 10px',
    fontSize: 10.5,
    fontFamily: 'var(--mono)',
    background: 'rgba(255,255,255,.08)',
    color: 'rgba(255,255,255,.45)',
    border: '1px solid rgba(255,255,255,.2)',
    borderRadius: 3,
    cursor: 'not-allowed',
  },

  ribbon: {
    background: '#f3f2f1',
    borderBottom: '1px solid #d0cfce',
    padding: '4px 10px',
    fontSize: 10.5,
    color: '#605e5c',
    display: 'flex',
    gap: 12,
    fontFamily: 'var(--sans)',
  },
  ribbonTab: {
    padding: '3px 8px',
    color: '#605e5c',
    whiteSpace: 'nowrap',
    cursor: 'default',
  },

  formulaRow: {
    display: 'flex',
    alignItems: 'stretch',
    borderBottom: '1px solid #d0cfce',
    background: '#fff',
    fontFamily: 'var(--mono)',
    fontSize: 10.5,
  },
  nameBox: {
    padding: '3px 8px',
    width: 60,
    borderRight: '1px solid #d0cfce',
    color: '#201f1e',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    background: '#fff',
  },
  nameBoxCaret: {
    color: '#605e5c',
    fontSize: 9,
    marginLeft: 'auto',
  },
  formulaSpacer: {
    width: 20,
    background: '#f3f2f1',
    borderRight: '1px solid #d0cfce',
    color: '#a8a8a8',
    fontSize: 13,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'default',
    userSelect: 'none',
  },
  cancelIcon: {
    padding: '3px 5px',
    color: '#9aa3b0',
    fontSize: 11,
    display: 'flex',
    alignItems: 'center',
    background: '#fff',
    cursor: 'default',
  },
  confirmIcon: {
    padding: '3px 5px',
    color: '#9aa3b0',
    fontSize: 11,
    display: 'flex',
    alignItems: 'center',
    background: '#fff',
    cursor: 'default',
  },
  fxButton: {
    padding: '3px 7px',
    borderRight: '1px solid #d0cfce',
    color: '#605e5c',
    fontStyle: 'italic',
    display: 'flex',
    alignItems: 'center',
    background: '#fff',
    letterSpacing: 0.5,
  },
  formulaPlaceholder: {
    padding: '4px 12px',
    color: '#9aa3b0',
    fontStyle: 'italic',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    flex: 1,
    display: 'flex',
    alignItems: 'center',
  },

  sheetArea: {
    background: '#fff',
    minHeight: 340,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderBottom: '1px solid #d0cfce',
  },
  sheetEmpty: { textAlign: 'center', padding: '40px 20px' },
  sheetEmptyTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: '#605e5c',
    marginBottom: 6,
    fontFamily: 'var(--sans)',
  },
  sheetEmptyHint: {
    fontSize: 11,
    color: '#9aa3b0',
    fontFamily: 'var(--mono)',
  },

  sheetTabs: {
    display: 'flex',
    background: '#f3f2f1',
    overflowX: 'auto',
  },
  sheetTabActive: {
    padding: '4px 12px',
    background: '#fff',
    borderRight: '1px solid #d0cfce',
    borderTop: '2px solid #217346',
    marginTop: -1,
    color: '#217346',
    fontFamily: 'var(--sans)',
    fontSize: 11,
    fontWeight: 600,
    whiteSpace: 'nowrap',
  },
  sheetTabInactive: {
    padding: '4px 12px',
    background: 'transparent',
    borderRight: '1px solid #d0cfce',
    color: '#9aa3b0',
    fontFamily: 'var(--sans)',
    fontSize: 11,
    fontWeight: 500,
    whiteSpace: 'nowrap',
  },
};
