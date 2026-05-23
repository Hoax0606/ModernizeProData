import { useState, useMemo, type CSSProperties } from 'react';
import { useT } from '../i18n';
import type { Site, Project } from '../store/workspace';
import type { ManifestEntry, SchemaCount } from '../lib/siteExportManifest';
import {
  slugify, pathSafeName, groupManifest,
} from '../lib/siteExportManifest';

/* Site export 우측 preview — 2 탭 (summary / manifest). */

export type PreviewView = 'summary' | 'manifest';

interface Props {
  site: Site;
  projects: Project[];
  schemaCounts: Record<string, SchemaCount>;
  manifest: ManifestEntry[];
  view: PreviewView;
  onViewChange: (v: PreviewView) => void;
  generatedAt: string;
}

export function SiteExportPreview(props: Props) {
  const t = useT();
  const tabs: { k: PreviewView; l: string }[] = [
    { k: 'summary',  l: t('siteExport.preview.summary') },
    { k: 'manifest', l: t('siteExport.preview.manifest', { n: props.manifest.length }) },
  ];

  return (
    <div style={styles.root}>
      <div style={styles.tabBar}>
        {tabs.map(t => (
          <button
            key={t.k}
            onClick={() => props.onViewChange(t.k)}
            style={{
              ...styles.tabBtn,
              ...(props.view === t.k ? styles.tabBtnActive : {}),
            }}
          >
            {t.l}
          </button>
        ))}
        <div style={{ flex: 1 }} />
      </div>

      <div
        style={{
          ...styles.body,
          background: props.view === 'manifest' ? 'var(--panel)' : 'var(--panel-2, var(--panel))',
        }}
      >
        {props.view === 'summary' && <SiteSummaryPreview {...props} />}
        {props.view === 'manifest' && <ManifestPreview manifest={props.manifest} />}
      </div>
    </div>
  );
}

/* ============================================================= */
/* Site summary — Excel-style                                      */
/* ============================================================= */

const PHASES_PREVIEW: ReadonlyArray<string> = [
  'planning', 'analysis', 'test', 'sign-off',
  'rehearsal', 'ready', 'cutover', 'hypercare', 'done',
];

function SiteSummaryPreview({ site, projects, schemaCounts, generatedAt }: Props) {
  const t = useT();
  const sheetList = useMemo(
    () => ['Cover', 'Phase mix', 'All tables', ...projects.map(p => p.name)],
    [projects],
  );
  const [sheet, setSheet] = useState<string>('Cover');

  const totalTables = projects.reduce(
    (a, p) => a + (schemaCounts[p.id]?.tables ?? p.tableCount ?? 0),
    0,
  );
  const totalColumns = projects.reduce(
    (a, p) => a + (schemaCounts[p.id]?.columns ?? 0),
    0,
  );
  const doneCount = projects.filter(p => p.phase === 'done').length;

  const filename = `site-summary-${pathSafeName(site.name)}.xlsx`;
  const formulaText = (() => {
    if (sheet === 'Cover') {
      return `Site: ${site.name} · ${projects.length} projects · ${totalTables.toLocaleString()} tables · ${doneCount} done`;
    }
    if (sheet === 'Phase mix') {
      return `Phase mix: ${projects.length} projects across ${PHASES_PREVIEW.length} phases`;
    }
    if (sheet === 'All tables') {
      return `All tables: ${totalTables.toLocaleString()} across ${projects.length} projects · ${totalColumns.toLocaleString()} columns`;
    }
    const p = projects.find(p => p.name === sheet);
    if (p) {
      const tc = schemaCounts[p.id]?.tables ?? p.tableCount ?? 0;
      const cc = schemaCounts[p.id]?.columns ?? 0;
      return `Project: ${p.name} · ${p.phase} · ${tc.toLocaleString()} tables · ${cc.toLocaleString()} columns`;
    }
    return '';
  })();

  return (
    <div style={styles.workbookWrap}>
      <div style={styles.workbook}>
        {/* Title bar — 다운로드는 좌측 picker 의 'Download bundle' 만 사용 */}
        <div style={styles.titleBar}>
          <span>{filename}</span>
          <span style={styles.titleBarSep}>·</span>
          <span style={styles.titleBarMeta}>{t('artifacts.workbook.readOnly')}</span>
        </div>

        {/* Ribbon — 모든 탭 같은 회색, active 없음 */}
        <div style={styles.ribbon}>
          {['File', 'Home', 'Insert', 'Page Layout', 'Formulas', 'Data', 'Review', 'View'].map(m => (
            <span key={m} style={styles.ribbonTab}>{m}</span>
          ))}
        </div>

        {/* Formula row — nameBox + ⋮ + ✕ + ✓ + fx + text */}
        <div style={styles.formulaRow}>
          <div style={styles.nameBox}>
            <span>A1</span>
            <span style={styles.nameBoxCaret}>▾</span>
          </div>
          <div style={styles.formulaSpacer}>⋮</div>
          <div style={styles.cancelIcon}>✕</div>
          <div style={styles.confirmIcon}>✓</div>
          <div style={styles.fxButton}>fx</div>
          <div style={styles.formulaPlaceholder}>{formulaText}</div>
        </div>

        {/* Sheet area */}
        <div style={styles.sheetArea}>
          {sheet === 'Cover' && (
            <CoverSheet
              siteName={site.name}
              projectCount={projects.length}
              tableCount={totalTables}
              columnCount={totalColumns}
              doneCount={doneCount}
              generatedAt={generatedAt}
            />
          )}
          {sheet === 'Phase mix' && (
            <PhaseMixSheet projects={projects} />
          )}
          {sheet === 'All tables' && (
            <AllTablesSheet projects={projects} schemaCounts={schemaCounts} />
          )}
          {projects.find(p => p.name === sheet) && (
            <ProjectSheet
              project={projects.find(p => p.name === sheet)!}
              count={schemaCounts[projects.find(p => p.name === sheet)!.id]}
            />
          )}
        </div>

        {/* Sheet tabs — Artifacts 와 동일 색·폰트 */}
        <div style={styles.sheetTabs}>
          {sheetList.map(s => (
            <button
              key={s}
              onClick={() => setSheet(s)}
              style={sheet === s ? styles.sheetTabActive : styles.sheetTabInactive}
            >
              {s}
            </button>
          ))}
          <div style={{ flex: 1 }} />
        </div>
      </div>
    </div>
  );
}

interface CoverSheetProps {
  siteName: string;
  projectCount: number;
  tableCount: number;
  columnCount: number;
  doneCount: number;
  generatedAt: string;
}

function CoverSheet({
  siteName, projectCount, tableCount, columnCount, doneCount, generatedAt,
}: CoverSheetProps) {
  return (
    <table style={styles.xlsxTable}>
      <thead>{xlsxHead(['A', 'B', 'C', 'D'])}</thead>
      <tbody>
        <tr>
          <td style={styles.rowNum}>1</td>
          <td style={{ ...styles.cell, fontSize: 18, fontWeight: 700, color: '#1d4d2e' }} colSpan={4}>
            {siteName} — Site Summary
          </td>
        </tr>
        <tr>
          <td style={styles.rowNum}>2</td>
          <td style={styles.cell} colSpan={4} />
        </tr>
        {[
          ['Document ID', `SS-${slugify(siteName).toUpperCase()}-${generatedAt.slice(0, 10)}`],
          ['Issued', generatedAt],
          ['Author', 'KS Info System'],
        ].map(([k, v], i) => (
          <tr key={k}>
            <td style={styles.rowNum}>{3 + i}</td>
            <td style={{ ...styles.cell, fontWeight: 600 }}>{k}</td>
            <td style={styles.cell} colSpan={3}>{v}</td>
          </tr>
        ))}
        <tr>
          <td style={styles.rowNum}>6</td>
          <td style={styles.cell} colSpan={4} />
        </tr>
        <tr>
          <td style={styles.rowNum}>7</td>
          <td style={{ ...styles.cell, fontWeight: 600 }} colSpan={4}>Scope</td>
        </tr>
        <tr>
          <td style={styles.rowNum}>8</td>
          <td style={styles.cell} colSpan={4}>
            Site-wide summary covering all {projectCount} migration project(s) at {siteName},
            totalling {tableCount.toLocaleString()} table(s).
          </td>
        </tr>
        <tr>
          <td style={styles.rowNum}>9</td>
          <td style={styles.cell} colSpan={4} />
        </tr>
        <tr>
          <td style={styles.rowNum}>10</td>
          <td style={{ ...styles.cell, fontWeight: 600, color: '#1d4d2e' }} colSpan={4}>
            {projectCount} projects · {tableCount.toLocaleString()} tables · {columnCount.toLocaleString()} columns · {doneCount} done
          </td>
        </tr>
      </tbody>
    </table>
  );
}

function PhaseMixSheet({ projects }: { projects: Project[] }) {
  const counts: Record<string, number> = {};
  for (const p of projects) counts[p.phase] = (counts[p.phase] ?? 0) + 1;
  return (
    <table style={styles.xlsxTable}>
      <thead>{xlsxHead([0, 1])}</thead>
      <tbody>
        {xlsxHeader(['Phase', 'Projects'])}
        {PHASES_PREVIEW.map((ph, i) => (
          <tr key={ph} style={{ background: i % 2 ? '#fafafa' : '#fff' }}>
            <td style={styles.rowNum}>{3 + i}</td>
            <td style={styles.cell}>{ph}</td>
            <td style={{ ...styles.cell, textAlign: 'right', fontFamily: 'var(--mono)' }}>{counts[ph] ?? 0}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AllTablesSheet({ projects, schemaCounts }: { projects: Project[]; schemaCounts: Record<string, SchemaCount> }) {
  return (
    <table style={styles.xlsxTable}>
      <thead>{xlsxHead([0, 1, 2, 3, 4])}</thead>
      <tbody>
        {xlsxHeader(['Project', 'Phase', 'Tables', 'Columns', 'Assignee'])}
        {projects.map((p, i) => {
          const tc = schemaCounts[p.id]?.tables ?? p.tableCount ?? 0;
          const cc = schemaCounts[p.id]?.columns ?? 0;
          return (
            <tr key={p.id} style={{ background: i % 2 ? '#fafafa' : '#fff' }}>
              <td style={styles.rowNum}>{3 + i}</td>
              <td style={styles.cell}>{p.name}</td>
              <td style={styles.cell}>{p.phase}</td>
              <td style={{ ...styles.cell, textAlign: 'right', fontFamily: 'var(--mono)' }}>{tc.toLocaleString()}</td>
              <td style={{ ...styles.cell, textAlign: 'right', fontFamily: 'var(--mono)' }}>{cc.toLocaleString()}</td>
              <td style={styles.cell}>{p.assignee ?? '—'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ProjectSheet({ project, count }: { project: Project; count?: SchemaCount }) {
  const tc = count?.tables ?? project.tableCount ?? 0;
  const cc = count?.columns ?? 0;
  return (
    <table style={styles.xlsxTable}>
      <thead>{xlsxHead([0, 1])}</thead>
      <tbody>
        {xlsxHeader(['Field', 'Value'])}
        {[
          ['Project', project.name],
          ['Phase', project.phase],
          ['Tables', String(tc)],
          ['Columns', String(cc)],
          ['Owner', project.owner ?? '—'],
          ['Assignee', project.assignee ?? '—'],
          ['Run status', project.runStatus],
        ].map(([k, v], i) => (
          <tr key={k} style={{ background: i % 2 ? '#fafafa' : '#fff' }}>
            <td style={styles.rowNum}>{3 + i}</td>
            <td style={{ ...styles.cell, fontWeight: 600 }}>{k}</td>
            <td style={styles.cell}>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ============================================================= */
/* Manifest preview                                                */
/* ============================================================= */

function ManifestPreview({ manifest }: { manifest: ManifestEntry[] }) {
  const grouped = groupManifest(manifest);
  const entries = Object.entries(grouped);
  if (entries.length === 0) {
    return <div style={styles.manifestEmpty}>No files to export — pick a format on the left.</div>;
  }
  return (
    <div>
      {entries.map(([cat, files]) => (
        <details key={cat} open style={styles.manifestGroup}>
          <summary style={styles.manifestSummary}>
            <span style={styles.manifestCaret}>▾</span>
            <span style={styles.manifestCat}>{cat}</span>
            <span style={styles.manifestMeta}>
              {files.length} files
            </span>
          </summary>
          <table style={styles.manifestTable}>
            <tbody>
              {files.slice(0, 200).map((f, i) => (
                <tr key={i} style={styles.manifestRow}>
                  <td style={{ ...styles.manifestCell, width: '85%' }}>{f.path}</td>
                  <td style={{ ...styles.manifestCell, width: 70 }}>{f.kind}</td>
                </tr>
              ))}
              {files.length > 200 && (
                <tr>
                  <td colSpan={2} style={{ ...styles.manifestCell, fontStyle: 'italic', color: 'var(--text-3)' }}>
                    …{files.length - 200} more files
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </details>
      ))}
    </div>
  );
}

/* ============================================================= */
/* xlsx table helpers                                              */
/* ============================================================= */

function xlsxHead(cols: (string | number)[]) {
  return (
    <tr>
      <th style={styles.corner} />
      {cols.map((_, i) => (
        <th key={i} style={styles.colHead}>{String.fromCharCode(65 + i)}</th>
      ))}
    </tr>
  );
}

function xlsxHeader(labels: string[]) {
  return (
    <tr style={{ background: '#f8f8f8' }}>
      <td style={styles.rowNum}>2</td>
      {labels.map((l, i) => (
        <td
          key={i}
          style={{
            ...styles.cell,
            fontWeight: 600,
            background: '#edf4ee',
            color: '#1d4d2e',
          }}
        >
          {l}
        </td>
      ))}
    </tr>
  );
}

const styles: Record<string, CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', minHeight: 0 },
  tabBar: {
    display: 'flex',
    padding: '0 14px',
    borderBottom: '1px solid var(--border)',
    background: 'var(--panel)',
    height: 32,
    alignItems: 'stretch',
  },
  tabBtn: {
    padding: '0 13px',
    border: 'none',
    background: 'transparent',
    fontSize: 11.5,
    fontWeight: 500,
    color: 'var(--text-2)',
    cursor: 'pointer',
    borderBottom: '2px solid transparent',
    marginBottom: -1,
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  tabBtnActive: {
    fontWeight: 600,
    color: 'var(--navy)',
    borderBottom: '2px solid var(--navy)',
  },
  body: { flex: 1, minHeight: 0, overflow: 'auto' },

  /* Excel workbook chrome — ArtifactsPage.tsx 와 1:1 */
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
    borderBottom: '1px solid #d0cfce',
  },

  xlsxTable: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: 11,
    fontFamily: 'var(--sans, system-ui)',
  },
  corner: {
    width: 32,
    background: '#f3f2f1',
    borderBottom: '1px solid #d0cfce',
    borderRight: '1px solid #d0cfce',
  },
  colHead: {
    padding: '2px 6px',
    background: '#f3f2f1',
    color: '#605e5c',
    borderBottom: '1px solid #d0cfce',
    borderRight: '1px solid #d0cfce',
    fontSize: 10.5,
    fontWeight: 500,
    fontFamily: 'var(--mono)',
    minWidth: 80,
    textAlign: 'center',
  },
  rowNum: {
    background: '#f3f2f1',
    color: '#605e5c',
    fontFamily: 'var(--mono)',
    borderRight: '1px solid #d0cfce',
    borderBottom: '1px solid #e1dfdd',
    fontSize: 10.5,
    padding: '2px 6px',
    textAlign: 'right',
    width: 32,
  },
  cell: {
    padding: '3px 8px',
    borderRight: '1px solid #e1dfdd',
    borderBottom: '1px solid #e1dfdd',
    fontSize: 11,
    color: '#1a2330',
    whiteSpace: 'nowrap',
  },
  sheetTabs: {
    display: 'flex',
    background: '#f3f2f1',
    overflowX: 'auto',
  },
  sheetTabActive: {
    padding: '4px 12px',
    border: 'none',
    background: '#fff',
    borderRight: '1px solid #d0cfce',
    borderTop: '2px solid #217346',
    marginTop: -1,
    color: '#217346',
    fontFamily: 'var(--sans)',
    fontSize: 11,
    fontWeight: 600,
    whiteSpace: 'nowrap',
    cursor: 'pointer',
  },
  sheetTabInactive: {
    padding: '4px 12px',
    border: 'none',
    background: 'transparent',
    borderRight: '1px solid #d0cfce',
    color: '#9aa3b0',
    fontFamily: 'var(--sans)',
    fontSize: 11,
    fontWeight: 500,
    whiteSpace: 'nowrap',
    cursor: 'pointer',
  },

  /* Manifest */
  manifestEmpty: {
    padding: 20,
    fontSize: 12,
    color: 'var(--text-3)',
    textAlign: 'center',
    fontFamily: 'var(--mono)',
  },
  manifestGroup: { borderBottom: '1px solid var(--border)' },
  manifestSummary: {
    padding: '7px 14px',
    background: 'var(--panel-2, var(--panel))',
    fontSize: 11,
    fontWeight: 600,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    cursor: 'pointer',
    listStyle: 'none',
    userSelect: 'none',
  },
  manifestCaret: { color: 'var(--text-3)', fontSize: 10 },
  manifestCat: { color: 'var(--navy)' },
  manifestMeta: {
    color: 'var(--text-3)',
    fontFamily: 'var(--mono)',
    fontSize: 10.5,
    fontWeight: 400,
  },
  manifestTable: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: 11,
    fontFamily: 'var(--mono)',
  },
  manifestRow: { borderTop: '1px solid var(--border)' },
  manifestCell: { padding: '3px 14px', color: 'var(--text-2)' },
};
