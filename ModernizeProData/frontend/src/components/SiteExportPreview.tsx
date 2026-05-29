import { useState, useMemo, useEffect, type CSSProperties } from 'react';
import { useT } from '../i18n';
import type { Site, Project } from '../store/workspace';
import type { SnapshotData } from '../store/snapshots';
import type { DdlSchema } from '../api/asisDdl';
import type { TableResultView } from '../api/runs';
import type { ManifestEntry, SchemaCount, SelectedFormats } from '../lib/siteExportManifest';
import {
  slugify, pathSafeName, groupManifest,
  generateValidationPlan, VALIDATION_SHEET_COLUMNS,
} from '../lib/siteExportManifest';

/** Migration SQL 워크북에 쓰이는 run 결과 — SiteExportPage 에서 fetch 한 최근 terminal run 의
 *  transform stage 박제 SQL + rowCount. run 이 없으면 null. runStatus 는 banner 표시용. */
export interface PreviewRunData {
  runId: string;
  runStartedAt: string | null;
  runStatus: string;
  tables: TableResultView[];
}

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
  /** View dropdown 상태 — null = Site Summary aggregate, string = project id. */
  viewProjectId: string | null;
  onViewProjectChange: (id: string | null) => void;
  /** 현재 picker 에서 미리보기 중인 포맷. */
  previewedFormat: keyof SelectedFormats | null;
  /** Reset 버튼 — Site Summary 미리보기로 복귀 (previewedFormat='summary'). */
  onReset: () => void;
  /** previewedFormat 이 mapping/migration/validation 일 때 사용할 프로젝트 (viewProjectId 의 객체). */
  previewProject: Project | null;
  /** previewProject 의 frozen snapshot data — Mapping/Migration 생성에 사용. */
  previewSnapshotData: SnapshotData | null;
  /** previewProject 의 TOBE DDL — Validation plan 컬럼 derive 에 사용. */
  previewTobeSchema: DdlSchema | null;
  /** previewProject 의 가장 최근 success run 결과 — Migration SQL 워크북에 사용. null = run 없음. */
  previewRunData: PreviewRunData | null;
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
        {/* summary 탭에서 previewedFormat 으로 분기:
              'summary' (또는 null) → 기존 Site Summary 워크북 (Cover/Phase mix/All tables/per-project 시트)
              'mapping' / 'migration' / 'validation' → 그 프로젝트의 format-specific 미리보기 */}
        {props.view === 'summary' && (props.previewedFormat === 'summary' || props.previewedFormat == null) && (
          <SiteSummaryPreview {...props} />
        )}
        {props.view === 'summary' && props.previewedFormat === 'mapping' && (
          <FormatPreview kind="mapping" {...props} />
        )}
        {props.view === 'summary' && props.previewedFormat === 'migration' && (
          <FormatPreview kind="migration" {...props} />
        )}
        {props.view === 'summary' && props.previewedFormat === 'validation' && (
          <FormatPreview kind="validation" {...props} />
        )}
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

function SiteSummaryPreview({
  site, projects, schemaCounts, generatedAt, viewProjectId, onViewProjectChange, onReset,
}: Props) {
  const t = useT();
  // 시트: site-wide aggregate (Cover / Phase mix / All tables) + View 로 선택된 프로젝트 1개.
  // viewProjectId 가 바뀌면 마지막 시트가 그 프로젝트로 교체된다. 다른 프로젝트 시트는 노출 안 함
  // (모든 프로젝트의 상세는 View 드롭다운으로 전환해서 보는 워크플로우).
  const viewProject = useMemo(
    () => viewProjectId ? projects.find((p) => p.id === viewProjectId) ?? null : null,
    [viewProjectId, projects],
  );
  const sheetList = useMemo(
    () => ['Cover', 'Phase mix', 'All tables', ...(viewProject ? [viewProject.name] : [])],
    [viewProject],
  );
  const [sheet, setSheet] = useState<string>('Cover');
  useEffect(() => {
    if (!sheetList.includes(sheet)) setSheet(sheetList[0] ?? 'Cover');
  }, [sheetList, sheet]);

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
    <WorkbookFrame
      filename={filename}
      formulaText={formulaText}
      sheetList={[...sheetList]}
      activeSheet={sheet}
      onSheetChange={setSheet}
      projects={projects}
      viewProjectId={viewProjectId}
      onViewProjectChange={onViewProjectChange}
      onReset={onReset}
      resetDisabled={true /* 이미 Site Summary 미리보기 중이므로 reset 의미 없음 */}
    >
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
      {sheet === 'Phase mix' && <PhaseMixSheet projects={projects} />}
      {sheet === 'All tables' && <AllTablesSheet projects={projects} schemaCounts={schemaCounts} />}
      {projects.find(p => p.name === sheet) && (
        <ProjectSheet
          project={projects.find(p => p.name === sheet)!}
          count={schemaCounts[projects.find(p => p.name === sheet)!.id]}
        />
      )}
    </WorkbookFrame>
  );
}

/* ──── WorkbookFrame ──── Excel chrome 공통 추출 — Site Summary + 각 FormatPreview 가 같이 사용.
 *  titlebar / ribbon / formula row / sheetArea (children) / sheet tabs 한 묶음.
 *  View dropdown + Reset 버튼이 ribbon 우측에 항상 표시 (4 미리보기 모두에서). */
interface WorkbookFrameProps {
  filename: string;
  formulaText: string;
  sheetList: string[];
  activeSheet: string;
  onSheetChange: (s: string) => void;
  /** View dropdown 옵션 — 프로젝트만 (Site Summary 옵션은 없음). */
  projects: Project[];
  viewProjectId: string | null;
  onViewProjectChange: (id: string | null) => void;
  /** Reset 버튼 — 클릭 시 Site Summary 미리보기로 복귀. */
  onReset?: () => void;
  /** 현재 Site Summary 미리보기 중이면 Reset 버튼 비활성. */
  resetDisabled?: boolean;
  children: React.ReactNode;
}

function WorkbookFrame({
  filename, formulaText, sheetList, activeSheet, onSheetChange,
  projects, viewProjectId, onViewProjectChange, onReset, resetDisabled,
  children,
}: WorkbookFrameProps) {
  const t = useT();
  return (
    <div style={styles.workbookWrap}>
      <div style={styles.workbook}>
        <div style={styles.titleBar}>
          <span>{filename}</span>
          <span style={styles.titleBarSep}>·</span>
          <span style={styles.titleBarMeta}>{t('artifacts.workbook.readOnly')}</span>
        </div>
        <div style={styles.ribbon}>
          {['File', 'Home', 'Insert', 'Page Layout', 'Formulas', 'Data', 'Review', 'View'].map(m => (
            <span key={m} style={styles.ribbonTab}>{m}</span>
          ))}
          <div style={{ flex: 1 }} />
          {/* View dropdown — 프로젝트 선택. 모든 미리보기에서 동일하게 노출. */}
          <div style={styles.ribbonPickerWrap}>
            <span style={styles.ribbonPickerLabel}>View:</span>
            <select
              value={viewProjectId ?? (projects[0]?.id ?? '')}
              onChange={(e) => onViewProjectChange(e.target.value || null)}
              style={styles.ribbonPickerSelect}
            >
              {projects.length === 0 && <option value="">(no projects)</option>}
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            {/* Reset 버튼 — 클릭 시 Site Summary 로 복귀. */}
            {onReset && (
              <button
                type="button"
                onClick={onReset}
                disabled={resetDisabled}
                title="Reset to Site Summary"
                aria-label="Reset to Site Summary"
                style={{
                  ...styles.ribbonResetBtn,
                  ...(resetDisabled ? styles.ribbonResetBtnDisabled : {}),
                }}
              >
                ↺
              </button>
            )}
          </div>
        </div>
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
        <div style={styles.sheetArea}>{children}</div>
        <div style={styles.sheetTabs}>
          {sheetList.map((s) => (
            <button
              key={s}
              onClick={() => onSheetChange(s)}
              style={activeSheet === s ? styles.sheetTabActive : styles.sheetTabInactive}
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
/* Format-specific preview — Mapping / Migration / Validation       */
/* (picker 라벨 클릭 시 previewedFormat 에 따라 분기 렌더)            */
/* ============================================================= */

interface FormatPreviewProps {
  kind: 'mapping' | 'migration' | 'validation';
  previewProject: Project | null;
  previewSnapshotData: SnapshotData | null;
  previewTobeSchema: DdlSchema | null;
  previewRunData: PreviewRunData | null;
  /** WorkbookFrame 의 View dropdown / Reset 버튼에 필요한 props. */
  projects: Project[];
  viewProjectId: string | null;
  onViewProjectChange: (id: string | null) => void;
  onReset: () => void;
}

function FormatPreview(p: FormatPreviewProps) {
  const common = {
    projects: p.projects,
    viewProjectId: p.viewProjectId,
    onViewProjectChange: p.onViewProjectChange,
    onReset: p.onReset,
  };
  if (p.kind === 'mapping') {
    return <MappingFormatPreview previewProject={p.previewProject} previewSnapshotData={p.previewSnapshotData} {...common} />;
  }
  if (p.kind === 'migration') {
    return <MigrationFormatPreview previewProject={p.previewProject} previewRunData={p.previewRunData} {...common} />;
  }
  return <ValidationFormatPreview previewProject={p.previewProject} previewTobeSchema={p.previewTobeSchema} {...common} />;
}

interface FormatPreviewCommon {
  projects: Project[];
  viewProjectId: string | null;
  onViewProjectChange: (id: string | null) => void;
  onReset: () => void;
}

function MappingFormatPreview({
  previewProject, previewSnapshotData, projects, viewProjectId, onViewProjectChange, onReset,
}: { previewProject: Project | null; previewSnapshotData: SnapshotData | null } & FormatPreviewCommon) {
  const rules = previewSnapshotData?.rules ?? [];
  const bindings = previewSnapshotData?.bindings ?? [];
  const codeMaps = previewSnapshotData?.codeMaps ?? [];
  const [sheet, setSheet] = useState<string>('Rules');
  const sheetList = ['Rules', 'Bindings', 'Code maps'];
  const filename = previewProject ? `mapping-${pathSafeName(previewProject.name)}.preview.xlsx` : 'mapping.preview.xlsx';
  const formulaText = previewProject
    ? `Mapping · ${previewProject.name} · ${rules.length} rules · ${bindings.length} bindings · ${codeMaps.length} code maps`
    : 'Mapping · (no project)';
  return (
    <WorkbookFrame
      filename={filename}
      formulaText={formulaText}
      sheetList={sheetList}
      activeSheet={sheet}
      onSheetChange={setSheet}
      projects={projects}
      viewProjectId={viewProjectId}
      onViewProjectChange={onViewProjectChange}
      onReset={onReset}
    >
      {sheet === 'Rules' && (
        <MappingTable
          columns={['TOBE table.column', 'Strategy', 'AS-IS source', 'Transform']}
          rows={rules.slice(0, 20).map((r) => [
            `${r.tobeTable}.${r.tobeColumn}`,
            r.strategy,
            r.asisColumn && r.asisColumn.length > 0
              ? `${r.asisTable ?? ''}${r.asisTable ? '.' : ''}${r.asisColumn.join(', ')}`
              : '—',
            r.transformRule ?? r.transformSql ?? (r.defaultValue ? `default: ${r.defaultValue}` : '—'),
          ])}
          emptyMsg={rules.length === 0 ? 'No mapping rules in this snapshot' : `Showing ${Math.min(20, rules.length)} of ${rules.length}`}
        />
      )}
      {sheet === 'Bindings' && (
        <MappingTable
          columns={['TOBE table', 'Composition', 'Sources']}
          rows={bindings.slice(0, 20).map((b) => [
            `${b.tobeSchema ? b.tobeSchema + '.' : ''}${b.tobeTable}`,
            b.compositionKind,
            b.sources.map((s) => `${s.asisSchema ? s.asisSchema + '.' : ''}${s.asisTable}`)
              .join(b.compositionKind === 'join' ? ' ⋈ ' : b.compositionKind === 'union' ? ' ∪ ' : ', ') || '—',
          ])}
          emptyMsg={bindings.length === 0 ? 'No bindings in this snapshot' : `Showing ${Math.min(20, bindings.length)} of ${bindings.length}`}
        />
      )}
      {sheet === 'Code maps' && (
        <MappingTable
          columns={['Domain', 'Source value', 'Target value', 'Description']}
          rows={codeMaps.slice(0, 20).map((c) => [
            c.domain, c.sourceValue, c.targetValue, c.description ?? '—',
          ])}
          emptyMsg={codeMaps.length === 0 ? 'No code maps in this snapshot' : `Showing ${Math.min(20, codeMaps.length)} of ${codeMaps.length}`}
        />
      )}
    </WorkbookFrame>
  );
}

function MigrationFormatPreview({
  previewProject, previewRunData,
  projects, viewProjectId, onViewProjectChange, onReset,
}: { previewProject: Project | null; previewRunData: PreviewRunData | null } & FormatPreviewCommon) {
  const [sheet, setSheet] = useState<string>('Tables');
  // 표시 데이터는 가장 최근 terminal run 의 transform stage 결과 — 실제로 돌았던 SQL 과 행수.
  // partial (failed) run 이라도 박제된 테이블들은 의미 있는 실데이터.
  const tables = previewRunData?.tables ?? [];
  const xlsxFilename = previewProject ? `migration-${pathSafeName(previewProject.name)}.preview.xlsx` : 'migration.preview.xlsx';
  const formulaText = previewProject
    ? previewRunData
      ? `Migration SQL · ${previewProject.name} · ${tables.length} table${tables.length === 1 ? '' : 's'} · run ${previewRunData.runId.slice(0, 12)}… · ${previewRunData.runStatus}`
      : `Migration SQL · ${previewProject.name} · no finished run yet`
    : 'Migration SQL · (no project)';
  const sheetList = ['Tables', 'Sample SQL'];

  // Sample SQL 시트는 Excel chrome 없이 VS Code 셸 통째로 — ArtifactsPage MIGRATION SQL 과 동일 룩.
  // 시트 전환 / View dropdown / Reset 은 VS Code 탭 바 안에서 처리.
  if (sheet === 'Sample SQL') {
    return (
      <VsCodeShell
        sheetList={sheetList}
        activeSheet={sheet}
        onSheetChange={setSheet}
        projects={projects}
        viewProjectId={viewProjectId}
        onViewProjectChange={onViewProjectChange}
        onReset={onReset}
        tables={tables}
        isEmpty={!previewRunData || tables.length === 0}
        emptyMsg={
          !previewRunData
            ? 'No finished run yet — run this project in the Execution page to capture compiled SQL.'
            : 'Most recent run had no transform stage SQL.'
        }
      />
    );
  }

  return (
    <WorkbookFrame
      filename={xlsxFilename}
      formulaText={formulaText}
      sheetList={sheetList}
      activeSheet={sheet}
      onSheetChange={setSheet}
      projects={projects}
      viewProjectId={viewProjectId}
      onViewProjectChange={onViewProjectChange}
      onReset={onReset}
    >
      <MappingTable
        columns={['TOBE table', 'Rows migrated', 'Duration (ms)', 'Status']}
        rows={tables.map((t) => [
          `${t.tobeSchema ? t.tobeSchema + '.' : ''}${t.tobeTable}`,
          t.rowCount != null ? t.rowCount.toLocaleString() : '—',
          t.durationMs != null ? t.durationMs.toLocaleString() : '—',
          t.status,
        ])}
        emptyMsg={
          !previewRunData
            ? 'No finished run yet — run this project in the Execution page to populate values.'
            : tables.length === 0
              ? 'Most recent run had no compiled SQL (failed before transform stage).'
              : undefined
        }
      />
    </WorkbookFrame>
  );
}

function ValidationFormatPreview({
  previewProject, previewTobeSchema,
  projects, viewProjectId, onViewProjectChange, onReset,
}: { previewProject: Project | null; previewTobeSchema: DdlSchema | null } & FormatPreviewCommon) {
  const plan = useMemo(() => generateValidationPlan(previewTobeSchema), [previewTobeSchema]);
  const [sheet, setSheet] = useState<string>('Overview');
  const sheetNames = VALIDATION_SHEET_COLUMNS.map((s) => s.name);
  const currentSpec = VALIDATION_SHEET_COLUMNS.find((s) => s.name === sheet);
  const rows = currentSpec ? plan[currentSpec.name as keyof typeof plan] ?? [] : [];
  const totalChecks = plan.Overview.length + plan['Sum recon'].length + plan['NULL parity'].length + plan.Range.length;
  const filename = previewProject ? `validation-${pathSafeName(previewProject.name)}.preview.xlsx` : 'validation.preview.xlsx';
  const formulaText = previewProject
    ? `Validation plan · ${previewProject.name} · ${totalChecks} check${totalChecks === 1 ? '' : 's'} · values pending run`
    : 'Validation plan · (no project)';
  return (
    <WorkbookFrame
      filename={filename}
      formulaText={formulaText}
      sheetList={sheetNames}
      activeSheet={sheet}
      onSheetChange={setSheet}
      projects={projects}
      viewProjectId={viewProjectId}
      onViewProjectChange={onViewProjectChange}
      onReset={onReset}
    >
      {currentSpec && (
        <MappingTable
          columns={currentSpec.columns.map((c) => c.name)}
          rows={rows}
          emptyMsg={rows.length === 0 ? 'Awaiting validation run' : `${rows.length} check${rows.length === 1 ? '' : 's'} planned — values populated after migration run`}
        />
      )}
    </WorkbookFrame>
  );
}

/* ============================================================= */
/* VS Code-style SQL view — Migration 의 Sample SQL 시트 전용.
 *  ArtifactsPage 의 MIGRATION SQL 카테고리와 동일한 dark editor 룩 (라인 번호 +
 *  syntax highlight + Copy 버튼 + status bar).                       */
/* ============================================================= */

const SQL_KEYWORDS = new Set([
  'CREATE', 'TABLE', 'IF', 'EXISTS', 'NOT', 'NULL', 'DEFAULT',
  'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES', 'CONSTRAINT', 'CHECK',
  'INDEX', 'UNIQUE', 'DROP', 'ALTER', 'ADD', 'COLUMN',
  'AND', 'OR', 'CASCADE', 'ON', 'DELETE', 'UPDATE',
  'SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'VALUES',
  'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'UNION', 'ALL', 'AS',
  'OR', 'REPLACE',
]);
const SQL_TYPES = new Set([
  'VARCHAR', 'VARCHAR2', 'CHAR', 'TEXT', 'NUMERIC', 'NUMBER',
  'INT', 'INTEGER', 'BIGINT', 'SMALLINT', 'DECIMAL', 'BOOLEAN',
  'DATE', 'TIMESTAMP', 'JSON', 'JSONB', 'UUID', 'BLOB', 'CLOB',
]);

function highlightSqlLine(line: string, lineKey: number): React.ReactNode {
  const commentIdx = line.indexOf('--');
  const codePart = commentIdx >= 0 ? line.substring(0, commentIdx) : line;
  const commentPart = commentIdx >= 0 ? line.substring(commentIdx) : '';
  const parts: React.ReactNode[] = [];
  const tokens = codePart.split(/(\s+|[(),;])/);
  tokens.forEach((tok, i) => {
    if (tok === '' || tok == null) return;
    if (/^\s+$/.test(tok) || /^[(),;]$/.test(tok)) { parts.push(tok); return; }
    const upper = tok.toUpperCase();
    const baseword = upper.replace(/\(.*\)$/, '');
    if (SQL_KEYWORDS.has(upper)) {
      parts.push(<span key={`k-${lineKey}-${i}`} style={{ color: '#569cd6' }}>{tok}</span>);
    } else if (SQL_TYPES.has(baseword)) {
      parts.push(<span key={`t-${lineKey}-${i}`} style={{ color: '#4ec9b0' }}>{tok}</span>);
    } else if (/^'[^']*'$/.test(tok)) {
      parts.push(<span key={`s-${lineKey}-${i}`} style={{ color: '#ce9178' }}>{tok}</span>);
    } else if (/^\d+(\.\d+)?$/.test(tok)) {
      parts.push(<span key={`n-${lineKey}-${i}`} style={{ color: '#b5cea8' }}>{tok}</span>);
    } else {
      parts.push(tok);
    }
  });
  if (commentPart) {
    parts.push(<span key={`c-${lineKey}`} style={{ color: '#6a9955' }}>{commentPart}</span>);
  }
  return parts;
}

/** Sample SQL 시트 전용 VS Code 셸 — Excel chrome 대체.
 *  ArtifactsPage 의 MIGRATION SQL 카테고리와 동일한 dark 룩:
 *    title bar (dark gray, File/Edit/... 메뉴 + 윈도우 버튼)
 *    tab bar (시트 탭 + View dropdown + Reset + Copy)
 *    editor area (dark theme + 라인 번호 + syntax highlight)
 *    status bar (VS Code 블루)
 *  여러 테이블 SQL 은 하나의 에디터에 합쳐 표시 — 각 테이블 사이는 분리선 코멘트로 구분. */
interface VsCodeShellProps {
  sheetList: string[];
  activeSheet: string;
  onSheetChange: (s: string) => void;
  projects: Project[];
  viewProjectId: string | null;
  onViewProjectChange: (id: string | null) => void;
  onReset?: () => void;
  tables: TableResultView[];
  isEmpty: boolean;
  emptyMsg: string;
}

function VsCodeShell({
  sheetList, activeSheet, onSheetChange,
  projects, viewProjectId, onViewProjectChange, onReset,
  tables, isEmpty, emptyMsg,
}: VsCodeShellProps) {
  const [copied, setCopied] = useState(false);
  // 표시할 SQL — 최대 3 테이블 합쳐 분리선 코멘트로 구분.
  const shown = tables.slice(0, 3);
  const combined = shown.map((t) => {
    const fqn = `${t.tobeSchema ? t.tobeSchema + '.' : ''}${t.tobeTable}`;
    const header = `-- ${fqn}${t.rowCount != null ? `   (${t.rowCount.toLocaleString()} rows)` : ''}`;
    return `${header}\n${t.compiledSql ?? '/* no compiled SQL */'}`;
  }).join('\n\n-- ────────────────────────────────────────\n\n');
  const lines = combined.split('\n');
  const handleCopy = () => {
    navigator.clipboard.writeText(combined).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  return (
    <div style={styles.vsRoot}>
      {/* Title bar — dark + 메뉴 + 우측 윈도우 버튼. */}
      <div style={styles.vsTitleBar}>
        <div style={styles.vsTitleLeft}>
          {['File', 'Edit', 'Selection', 'View', 'Go', 'Run', 'Terminal', 'Help'].map((m) => (
            <span key={m} style={styles.vsTitleMenu}>{m}</span>
          ))}
        </div>
        <div style={styles.vsTitleRight}>
          <span style={styles.vsTitleWinBtn}>─</span>
          <span style={styles.vsTitleWinBtn}>▢</span>
          <span style={styles.vsTitleWinBtn}>✕</span>
        </div>
      </div>

      {/* Tab bar — 시트 탭 (Tables / Sample SQL) + 우측 View 드롭다운 / Reset / Copy. */}
      <div style={styles.vsTabBar}>
        {sheetList.map((s) => (
          <div
            key={s}
            onClick={() => onSheetChange(s)}
            style={s === activeSheet ? styles.vsTabActive : styles.vsTabInactive}
          >
            <span style={styles.vsTabIcon}>{'⟨⟩'}</span>
            <span style={styles.vsTabName}>{s}</span>
          </div>
        ))}
        <div style={{ flex: 1 }} />
        {/* View dropdown — dark 버전. */}
        <div style={styles.vsRibbonPickerWrap}>
          <span style={styles.vsRibbonPickerLabel}>View:</span>
          <select
            value={viewProjectId ?? (projects[0]?.id ?? '')}
            onChange={(e) => onViewProjectChange(e.target.value || null)}
            style={styles.vsRibbonPickerSelect}
          >
            {projects.length === 0 && <option value="">(no projects)</option>}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          {onReset && (
            <button
              type="button"
              onClick={onReset}
              title="Reset to Site Summary"
              style={styles.vsRibbonResetBtn}
            >↺</button>
          )}
        </div>
        <button onClick={handleCopy} style={styles.vsActionBtn}>Copy</button>
      </div>

      {/* Editor — dark theme + 라인 번호 + syntax highlight. */}
      {isEmpty ? (
        <div style={styles.vsEmpty}>{emptyMsg}</div>
      ) : (
        <div style={styles.vsArea}>
          <pre style={styles.vsPre}>
            {lines.map((line, i) => (
              <div key={i} style={styles.vsLineRow}>
                <span style={styles.vsLineNo}>{i + 1}</span>
                <span style={styles.vsLineCode}>{highlightSqlLine(line, i)}</span>
              </div>
            ))}
          </pre>
          <div
            style={{
              ...styles.vsCopiedToast,
              opacity: copied ? 1 : 0,
              pointerEvents: copied ? 'auto' : 'none',
            }}
          >
            ✓ 복사되었습니다
          </div>
        </div>
      )}

      {/* Status bar — VS Code 블루. */}
      <div style={styles.vsStatusBar}>
        <span style={styles.vsStatusItem}>⎇ main</span>
        <span style={styles.vsStatusItem}>⊘ 0</span>
        <div style={{ flex: 1 }} />
        <span style={styles.vsStatusItem}>{shown.length} table{shown.length === 1 ? '' : 's'}</span>
        <span style={styles.vsStatusItem}>{isEmpty ? 0 : lines.length} lines</span>
        <span style={styles.vsStatusItem}>UTF-8</span>
        <span style={styles.vsStatusItem}>SQL</span>
      </div>
    </div>
  );
}

/** 단순 그리드 테이블 — Mapping/Migration/Validation 콘텐츠 공용. */
function MappingTable({
  columns, rows, emptyMsg,
}: { columns: string[]; rows: (string | number | null)[][]; emptyMsg?: string }) {
  return (
    <div style={styles.fmtTableWrap}>
      <table style={styles.fmtTable}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c} style={styles.fmtTableHead}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} style={styles.fmtTableEmpty}>
                {emptyMsg ?? '—'}
              </td>
            </tr>
          ) : (
            rows.map((r, i) => (
              <tr key={i}>
                {r.map((v, j) => (
                  <td key={j} style={styles.fmtTableCell}>{v == null ? '—' : String(v)}</td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
      {emptyMsg && rows.length > 0 && (
        <div style={styles.fmtNote}>{emptyMsg}</div>
      )}
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
  /* Format-specific preview (Mapping/Migration/Validation) — Excel chrome 없는 단순 카드. */
  fmtWorkbookWrap: { padding: 14, display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 },
  fmtTitle: { fontSize: 14, fontWeight: 700, color: '#1d4d2e' },
  fmtSheetTabs: { display: 'flex', gap: 6, borderBottom: '1px solid var(--border)', marginBottom: 4 },
  fmtSheetTabActive: {
    padding: '6px 12px', border: 'none', background: 'transparent',
    color: 'var(--navy)', fontSize: 11.5, fontWeight: 600,
    borderBottom: '2px solid var(--navy)', marginBottom: -1, cursor: 'pointer',
  },
  fmtSheetTabInactive: {
    padding: '6px 12px', border: 'none', background: 'transparent',
    color: 'var(--text-3)', fontSize: 11.5, fontWeight: 500,
    cursor: 'pointer',
  },
  fmtTableWrap: { background: '#fff', border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden' },
  fmtTable: { width: '100%', borderCollapse: 'collapse', fontSize: 11.5 },
  fmtTableHead: {
    padding: '6px 10px', textAlign: 'left',
    background: '#edf4ee', color: '#1d4d2e', fontWeight: 700,
    borderBottom: '1px solid var(--border)',
    fontSize: 11,
  },
  fmtTableCell: {
    padding: '4px 10px', borderBottom: '1px solid #f0f0f0',
    fontFamily: 'var(--mono)', fontSize: 11,
    color: 'var(--text-2)',
  },
  fmtTableEmpty: {
    padding: 16, textAlign: 'center',
    color: 'var(--text-3)', fontStyle: 'italic', fontSize: 11.5,
  },
  fmtSqlBlock: { display: 'flex', flexDirection: 'column', gap: 10 },
  fmtSqlPre: {
    margin: 0, padding: 12,
    background: '#1e1e1e', color: '#dcdcdc',
    fontFamily: 'var(--mono)', fontSize: 10.5,
    border: '1px solid #d0cfce', borderRadius: 4,
    overflow: 'auto', whiteSpace: 'pre',
    maxHeight: 300,
  },
  fmtSqlHeader: { color: '#80cfa0', fontWeight: 700, fontSize: 11 },
  fmtNote: { fontSize: 11, color: '#8a5a06', fontStyle: 'italic', padding: '4px 2px' },
  /* VS Code style — Migration 의 Sample SQL 시트 전용. dark editor + 라인 번호. */
  vsRoot: {
    display: 'flex', flexDirection: 'column',
    background: '#1e1e1e', minHeight: 360,
    margin: 14,
    border: '1px solid #1a1a1a',
    borderRadius: 4,
    overflow: 'hidden',
    boxShadow: '0 2px 8px rgba(0,0,0,.12)',
  },
  vsTitleBar: {
    display: 'flex', alignItems: 'center',
    background: '#3c3c3c', color: '#cccccc',
    height: 28, fontFamily: 'var(--sans)', fontSize: 11.5,
  },
  vsTitleLeft: { display: 'flex', gap: 0, paddingLeft: 8 },
  vsTitleMenu: {
    padding: '0 8px', color: '#cccccc', cursor: 'default',
    lineHeight: '28px',
  },
  vsTitleRight: { display: 'flex', marginLeft: 'auto' },
  vsTitleWinBtn: {
    width: 40, height: 28, display: 'inline-flex',
    alignItems: 'center', justifyContent: 'center',
    color: '#cccccc', cursor: 'default',
  },
  vsTabBar: {
    display: 'flex', alignItems: 'stretch',
    background: '#2d2d2d', borderBottom: '1px solid #1a1a1a',
    height: 30, fontFamily: 'var(--sans)',
  },
  vsTabActive: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '0 12px', background: '#1e1e1e',
    color: '#fff', fontSize: 11.5,
    borderRight: '1px solid #1a1a1a', borderTop: '1px solid #007acc',
    marginTop: -1,
  },
  vsTabInactive: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '0 12px', background: '#2d2d2d',
    color: '#8e8e8e', fontSize: 11.5,
    borderRight: '1px solid #1a1a1a',
  },
  vsTabIcon: { color: '#c5c5c5', fontSize: 10, fontFamily: 'var(--mono)' },
  vsTabName: { fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer' },
  vsActionBtn: {
    background: '#3a3a3a', border: '1px solid #4a4a4a',
    color: '#cccccc', padding: '0 12px',
    fontSize: 11, fontWeight: 600, cursor: 'pointer',
    margin: '4px 8px 4px 0', borderRadius: 3,
  },
  /* View dropdown — dark 버전 (VS Code 셸의 탭 바 우측). */
  vsRibbonPickerWrap: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '0 10px', borderLeft: '1px solid #1a1a1a',
    color: '#cccccc',
  },
  vsRibbonPickerLabel: { fontSize: 10.5, color: '#a0a0a0', fontWeight: 600 },
  vsRibbonPickerSelect: {
    fontSize: 11, padding: '2px 6px', fontFamily: 'var(--mono)',
    border: '1px solid #4a4a4a', borderRadius: 2,
    background: '#2d2d2d', color: '#cccccc',
    minWidth: 160, cursor: 'pointer',
  },
  vsRibbonResetBtn: {
    fontSize: 12, lineHeight: 1, padding: '2px 7px', height: 22,
    fontFamily: 'var(--sans)', border: '1px solid #4a4a4a',
    borderRadius: 2, background: '#2d2d2d', color: '#cccccc',
    cursor: 'pointer', display: 'inline-flex',
    alignItems: 'center', justifyContent: 'center', marginLeft: 2,
  },
  vsArea: {
    position: 'relative',
    background: '#1e1e1e',
    color: '#d4d4d4',
    fontFamily: 'var(--mono)',
    fontSize: 12, lineHeight: 1.55,
    overflow: 'auto',
    maxHeight: 460,
  },
  vsPre: { margin: 0, padding: '8px 0', whiteSpace: 'pre' },
  vsLineRow: { display: 'flex', alignItems: 'flex-start' },
  vsLineNo: {
    display: 'inline-block',
    minWidth: 44, padding: '0 10px 0 0',
    textAlign: 'right',
    color: '#858585', userSelect: 'none',
    fontFamily: 'var(--mono)', fontSize: 11.5,
  },
  vsLineCode: { flex: 1, paddingLeft: 6 },
  vsCopiedToast: {
    position: 'absolute', top: 8, right: 12,
    padding: '4px 10px', background: '#3a3a3a',
    color: '#dcdcdc', fontSize: 11, fontFamily: 'var(--mono)',
    border: '1px solid #4a4a4a', borderRadius: 3,
    transition: 'opacity 0.15s ease-out',
  },
  vsStatusBar: {
    display: 'flex', alignItems: 'center',
    background: '#007acc', color: '#fff',
    fontSize: 10.5, fontFamily: 'var(--mono)',
    padding: '0 10px', height: 22,
    gap: 12,
  },
  vsStatusItem: { whiteSpace: 'nowrap' },
  vsEmpty: {
    padding: '60px 24px', textAlign: 'center',
    color: '#858585', fontSize: 12, fontStyle: 'italic',
    background: '#1e1e1e', minHeight: 360,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },

  /* Failed/partial run 안내 banner — 워크북 시트 위에 한 줄 표시. */
  fmtRunBanner: {
    padding: '6px 12px',
    background: '#fff1e0',
    borderBottom: '1px solid #f0c886',
    color: '#7a4a00',
    fontSize: 11.5,
    lineHeight: 1.4,
  },
  fmtRunBannerCode: {
    fontFamily: 'var(--mono)',
    fontSize: 10.5,
    color: '#5a3a00',
  },
  fmtEmpty: { padding: '60px 24px', textAlign: 'center' },
  fmtEmptyTitle: { fontSize: 13, fontWeight: 600, color: 'var(--text-2)', marginBottom: 6 },
  fmtEmptyBody: { fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.5 },

  /* View dropdown — ribbon 우측. Excel 도구 버튼처럼 작은 라벨 + select. */
  ribbonPickerWrap: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '0 4px 0 12px',
    borderLeft: '1px solid #d0cfce',
    fontFamily: 'var(--sans)',
  },
  ribbonPickerLabel: {
    fontSize: 10.5,
    color: '#605e5c',
    fontWeight: 600,
  },
  ribbonPickerSelect: {
    fontSize: 11,
    padding: '2px 6px',
    fontFamily: 'var(--mono)',
    border: '1px solid #b8b8b8',
    borderRadius: 2,
    background: '#fff',
    color: '#201f1e',
    minWidth: 180,
    cursor: 'pointer',
  },
  /* Reset 버튼 — View dropdown 우측. ↺ 아이콘으로 Site Summary 로 복귀. */
  ribbonResetBtn: {
    fontSize: 12,
    lineHeight: 1,
    padding: '2px 7px',
    height: 22,
    fontFamily: 'var(--sans)',
    border: '1px solid #b8b8b8',
    borderRadius: 2,
    background: '#fff',
    color: '#605e5c',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 2,
  },
  ribbonResetBtnDisabled: {
    cursor: 'not-allowed',
    opacity: 0.4,
    color: '#a8a8a8',
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
