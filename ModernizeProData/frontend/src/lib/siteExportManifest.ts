import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import type { Site, Project } from '../store/workspace';
import type { DdlSchema } from '../api/asisDdl';

/* Site export — manifest 생성 + client-side zip bundle 생성.
 * 백엔드 export job 이 아직 없으므로 .sql 은 stub 텍스트,
 * Mapping / Validation 의 .xlsx 자리는 placeholder.txt 로 zip.
 * Site summary 만은 TO-BE DDL 데이터로 실제 .xlsx 를 ExcelJS 로 만든다. */

export type ArtifactCat =
  | 'Migration SQL'
  | 'Mapping'
  | 'Validation'
  | 'Site summary';

export interface ManifestEntry {
  cat: ArtifactCat;
  path: string;
  kind: 'sql' | 'xlsx';
}

export interface SchemaCount {
  tables: number;
  columns: number;
}

export interface SelectedFormats {
  migration: boolean;
  mapping: boolean;
  validation: boolean;
  /** Site summary — site 단위 단일 워크북. (구 'DB design spec' 통합). */
  summary: boolean;
}

export const DEFAULT_FORMATS: SelectedFormats = {
  migration: true,
  mapping: true,
  validation: true,
  summary: true,
};

/** ASCII slug — Document ID 등 URL/ID 용도. 비-ASCII 는 제거됨. */
export function slugify(s: string): string {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** 파일/폴더 이름용. 한글·일본어 등 Unicode 문자는 보존, FS 금지 문자만 '_' 로.
 *  zip 내부 폴더명·zip 자체의 파일명·워크북 표시명 등 사람이 읽는 자리에 사용. */
export function pathSafeName(s: string): string {
  const out = String(s || '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .trim();
  return out || 'unnamed';
}

export function paddedTableName(i: number): string {
  return `tbl_${String(i + 1).padStart(3, '0')}`;
}

export function fmtBytes(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + ' GB';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MB';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + ' KB';
  return n + ' B';
}

interface BuildManifestArgs {
  projects: Project[];
  schemaCounts: Record<string, SchemaCount>;
  selectedFormats: SelectedFormats;
  /** zip 내부 최상위 폴더명 (`/` 없이). 보통 zip 파일명 stem 과 동일하게 전달. */
  bundleStem: string;
}

export function buildManifest({ projects, schemaCounts, selectedFormats, bundleStem }: BuildManifestArgs): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  const prefix = `${bundleStem}/`;

  // 각 프로젝트의 table 수 — tobe DDL 미임포트면 project.tableCount 로 fallback, 그것도 없으면 1.
  const tableCountOf = (p: Project): number => {
    const fromSchema = schemaCounts[p.id]?.tables;
    if (fromSchema && fromSchema > 0) return fromSchema;
    if (p.tableCount && p.tableCount > 0) return p.tableCount;
    return 0;
  };

  for (const p of projects) {
    const tc = tableCountOf(p);
    // 폴더명은 한글/일본어 보존을 위해 pathSafeName 사용 (slugify 는 비-ASCII 를 다 깎는다).
    const pslug = pathSafeName(p.name);

    if (selectedFormats.migration) {
      for (let i = 0; i < tc; i++) {
        entries.push({
          cat: 'Migration SQL',
          path: `${prefix}${pslug}/migration/${paddedTableName(i)}.up.sql`,
          kind: 'sql',
        });
      }
    }
    if (selectedFormats.mapping) {
      for (let i = 0; i < tc; i++) {
        entries.push({
          cat: 'Mapping',
          path: `${prefix}${pslug}/mapping/${paddedTableName(i)}.map.xlsx`,
          kind: 'xlsx',
        });
      }
    }
    if (selectedFormats.validation) {
      for (let i = 0; i < tc; i++) {
        entries.push({
          cat: 'Validation',
          path: `${prefix}${pslug}/validation/${paddedTableName(i)}.report.xlsx`,
          kind: 'xlsx',
        });
      }
    }
  }

  if (selectedFormats.summary) {
    // Site summary — site 단위 단일 워크북. (구 'DB design spec' 통합)
    // 시트: Cover / Phase mix / All tables / 각 프로젝트.
    entries.push({
      cat: 'Site summary',
      path: `${prefix}site-summary.xlsx`,
      kind: 'xlsx',
    });
  }

  return entries;
}

export function groupManifest(manifest: ManifestEntry[]): Record<string, ManifestEntry[]> {
  const grouped: Record<string, ManifestEntry[]> = {};
  for (const m of manifest) {
    (grouped[m.cat] = grouped[m.cat] || []).push(m);
  }
  return grouped;
}

interface BuildZipArgs {
  site: Site;
  /** site 의 모든 프로젝트 — Site summary 워크북 빌드에 사용 */
  projects: Project[];
  /** projectId → TO-BE DdlSchema. 없는 프로젝트는 Cover 만 있는 빈 워크북. */
  schemas: Record<string, DdlSchema>;
  manifest: ManifestEntry[];
  /** 'YYYY-MM-DD HH:MM JST' 같은 표기 — stub / placeholder 본문에 박는다 */
  generatedAt: string;
}

export async function generateZipBundle({
  site, projects, schemas, manifest, generatedAt,
}: BuildZipArgs): Promise<Blob> {
  const zip = new JSZip();

  // path 안의 project slug → Project 매칭 (Mapping/Validation 워크북 메타에 사용).
  const projectBySlug = new Map(projects.map(p => [pathSafeName(p.name), p]));

  for (const entry of manifest) {
    if (entry.kind === 'sql') {
      // 짧은 stub DDL/Migration 본문. 실제 SQL 은 백엔드 wiring 후.
      const tableName = entry.path.split('/').pop()?.replace(/\.(up\.)?sql$/, '') ?? 'table';
      const body =
        `-- ${entry.cat}\n` +
        `-- ${entry.path}\n` +
        `-- generated ${generatedAt}\n` +
        `-- NOTE: placeholder. real content arrives when the backend export job is wired.\n` +
        `\n` +
        `-- TODO: ${tableName}\n`;
      zip.file(entry.path, body);
    } else if (entry.cat === 'Site summary') {
      // 사이트 단위 단일 워크북. 화면의 Site summary preview 와 1:1.
      const buf = await buildSiteSummaryWorkbook({ site, projects, schemas, generatedAt });
      zip.file(entry.path, buf);
    } else {
      // Mapping / Validation 등: 빈 .xlsx 워크북 (1 시트 Cover, 가짜 데이터 없음).
      // 라벨이 .xlsx 라 약속한 대로 진짜 .xlsx 가 떨어지되, 본문은 "Not yet populated" 안내.
      const fileName = entry.path.split('/').pop() ?? 'artifact';
      const tableName = fileName.replace(/\.(map|report|pipeline)?\.xlsx$/, '');
      const project = projectBySlug.get(entry.path.split('/')[1]) ?? null;
      const buf = await buildEmptyArtifactWorkbook({
        category: entry.cat,
        projectName: project?.name ?? 'project',
        tableName,
        generatedAt,
      });
      zip.file(entry.path, buf);
    }
  }

  return zip.generateAsync({ type: 'blob' });
}

/* ── Empty artifact workbook builder ─────────────────────────────────
 * Mapping / Validation 등 backend 미연결 카테고리용. 1 시트 (Cover) 의
 * 진짜 .xlsx — 라벨 약속을 지키되 가짜 데이터는 안 넣음.
 * 백엔드 export job 연결 후 본 함수는 교체되거나 삭제됨. */

interface BuildEmptyArtifactArgs {
  category: ArtifactCat;
  projectName: string;
  tableName: string;
  generatedAt: string;
}

async function buildEmptyArtifactWorkbook({
  category, projectName, tableName, generatedAt,
}: BuildEmptyArtifactArgs): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'KS Info System';
  wb.created = new Date();

  const cover = wb.addWorksheet('Cover');
  cover.getColumn(1).width = 18;
  cover.getColumn(2).width = 60;

  // row 1: 제목 (merged A1:B1)
  cover.mergeCells('A1:B1');
  const titleCell = cover.getCell('A1');
  titleCell.value = `${category} — ${tableName}`;
  titleCell.font = { bold: true, size: 14, color: { argb: 'FF1D4D2E' } };

  // row 2: 빈 행. row 3-6: KV.
  const kv: [string, string][] = [
    ['Project',    projectName],
    ['Table',      tableName],
    ['Category',   category],
    ['Generated',  generatedAt],
  ];
  kv.forEach(([k, v], i) => {
    const r = 3 + i;
    cover.getCell(`A${r}`).value = k;
    cover.getCell(`A${r}`).font = { bold: true };
    cover.getCell(`B${r}`).value = v;
  });

  // row 7: 빈 행. row 8: 안내문 (merged A8:B8).
  cover.mergeCells('A8:B8');
  cover.getCell('A8').value =
    'Not yet populated. This artifact will be filled by the backend ' +
    'export job once /api/v1/sites/{id}/export is implemented.';
  cover.getCell('A8').alignment = { wrapText: true, vertical: 'top' };
  cover.getCell('A8').font = { italic: true, color: { argb: 'FF8A5A06' } };
  cover.getRow(8).height = 36;

  applyGridBorders(cover, { from: 1, to: 8 }, { from: 1, to: 2 });

  return wb.xlsx.writeBuffer();
}

/* ── Site summary workbook builder ─────────────────────────────────
 * 화면의 'Site summary' preview (SiteExportPreview.tsx) 와 1:1 매칭.
 * 사이트 단위 단일 워크북.
 *
 * 시트 구성:
 *   - Cover      : 사이트 메타 + Scope 문장 + KPI 한 줄
 *   - Phase mix  : phase 9 단계별 프로젝트 수
 *   - All tables : 프로젝트별 요약 (Project / Phase / Tables / Columns / Assignee)
 *   - per-project: KV (Project / Phase / Tables / Columns / Owner / Assignee / Run status) */
interface BuildSiteSummaryArgs {
  site: Site;
  projects: Project[];
  schemas: Record<string, DdlSchema>;
  generatedAt: string;
}

const PHASES: ReadonlyArray<string> = [
  'planning', 'analysis', 'test', 'sign-off',
  'rehearsal', 'ready', 'cutover', 'hypercare', 'done',
];

const THIN_BORDER: ExcelJS.Borders = {
  top:    { style: 'thin', color: { argb: 'FFBFBFBF' } },
  left:   { style: 'thin', color: { argb: 'FFBFBFBF' } },
  bottom: { style: 'thin', color: { argb: 'FFBFBFBF' } },
  right:  { style: 'thin', color: { argb: 'FFBFBFBF' } },
  diagonal: { style: 'none' },
} as ExcelJS.Borders;

/** 지정 사각형 영역의 모든 셀에 thin grid border 적용. 빈 셀에도 그어짐. */
function applyGridBorders(
  ws: ExcelJS.Worksheet,
  rows: { from: number; to: number },
  cols: { from: number; to: number },
): void {
  for (let r = rows.from; r <= rows.to; r++) {
    for (let c = cols.from; c <= cols.to; c++) {
      ws.getCell(r, c).border = THIN_BORDER;
    }
  }
}

async function buildSiteSummaryWorkbook({
  site, projects, schemas, generatedAt,
}: BuildSiteSummaryArgs): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'KS Info System';
  wb.created = new Date();

  const tableCountOf = (p: Project): number =>
    schemas[p.id]?.tables.length ?? p.tableCount ?? 0;
  const columnCountOf = (p: Project): number =>
    schemas[p.id]?.tables.reduce((s, tw) => s + tw.columns.length, 0) ?? 0;
  const totalTables = projects.reduce((a, p) => a + tableCountOf(p), 0);
  const totalColumns = projects.reduce((a, p) => a + columnCountOf(p), 0);
  const doneCount = projects.filter(p => p.phase === 'done').length;

  /* ── Cover sheet ──
   *   1: 제목 (merged A1:D1)
   *   2: 빈 행
   *   3-7: KV (Document ID / Version / Issued / Author / Classification)
   *   8: 빈 행
   *   9: 'Scope' 헤더
   *   10: scope 문장
   *   11: 빈 행
   *   12: KPI 한 줄 */
  const cover = wb.addWorksheet('Cover');
  cover.getColumn(1).width = 20;
  cover.getColumn(2).width = 24;
  cover.getColumn(3).width = 24;
  cover.getColumn(4).width = 28;

  cover.mergeCells('A1:D1');
  const titleCell = cover.getCell('A1');
  titleCell.value = `${site.name} — Site Summary`;
  titleCell.font = { bold: true, size: 18, color: { argb: 'FF1D4D2E' } };

  const docId = `SS-${slugify(site.name).toUpperCase()}-${generatedAt.slice(0, 10)}`;
  const kvRows: [string, string][] = [
    ['Document ID', docId],
    ['Issued', generatedAt],
    ['Author', 'KS Info System'],
  ];
  kvRows.forEach(([k, v], i) => {
    const r = 3 + i;
    cover.getCell(`A${r}`).value = k;
    cover.getCell(`A${r}`).font = { bold: true };
    cover.mergeCells(`B${r}:D${r}`);
    cover.getCell(`B${r}`).value = v;
  });

  // 행 6: 빈 행, 행 7: Scope 헤더, 행 8: scope 문장, 행 9: 빈 행, 행 10: KPI.
  cover.mergeCells('A7:D7');
  const scopeHeader = cover.getCell('A7');
  scopeHeader.value = 'Scope';
  scopeHeader.font = { bold: true };

  cover.mergeCells('A8:D8');
  cover.getCell('A8').value =
    `Site-wide summary covering all ${projects.length} migration project(s) at ${site.name}, ` +
    `totalling ${totalTables.toLocaleString()} table(s).`;
  cover.getCell('A8').alignment = { wrapText: true, vertical: 'top' };
  cover.getRow(8).height = 28;

  cover.mergeCells('A10:D10');
  cover.getCell('A10').value =
    `${projects.length} projects · ${totalTables.toLocaleString()} tables · ` +
    `${totalColumns.toLocaleString()} columns · ${doneCount} done`;
  cover.getCell('A10').font = { bold: true, color: { argb: 'FF1D4D2E' } };

  applyGridBorders(cover, { from: 1, to: 10 }, { from: 1, to: 4 });

  /* ── Phase mix sheet ──
   * 9 단계 phase 별 프로젝트 수. SiteOverview 와 동일 분류. */
  const phaseMix = wb.addWorksheet('Phase mix');
  phaseMix.columns = [
    { header: 'Phase',    key: 'phase',    width: 18 },
    { header: 'Projects', key: 'projects', width: 12 },
  ];
  phaseMix.getRow(1).font = { bold: true };
  phaseMix.getRow(1).fill = {
    type: 'pattern', pattern: 'solid',
    fgColor: { argb: 'FFEDF4EE' },
  };
  const phaseCounts: Record<string, number> = {};
  for (const p of projects) {
    phaseCounts[p.phase] = (phaseCounts[p.phase] ?? 0) + 1;
  }
  for (const ph of PHASES) {
    phaseMix.addRow({ phase: ph, projects: phaseCounts[ph] ?? 0 });
  }
  applyGridBorders(
    phaseMix,
    { from: 1, to: PHASES.length + 1 },
    { from: 1, to: 2 },
  );

  /* ── All tables sheet ──
   * 화면의 AllTablesSheet 와 동일 컬럼 순서. */
  const allTables = wb.addWorksheet('All tables');
  allTables.columns = [
    { header: 'Project', key: 'project', width: 32 },
    { header: 'Phase', key: 'phase', width: 14 },
    { header: 'Tables', key: 'tables', width: 10 },
    { header: 'Columns', key: 'columns', width: 10 },
    { header: 'Assignee', key: 'assignee', width: 24 },
  ];
  allTables.getRow(1).font = { bold: true };
  allTables.getRow(1).fill = {
    type: 'pattern', pattern: 'solid',
    fgColor: { argb: 'FFEDF4EE' },
  };
  for (const p of projects) {
    allTables.addRow({
      project: p.name,
      phase: p.phase,
      tables: tableCountOf(p),
      columns: columnCountOf(p),
      assignee: p.assignee ?? '—',
    });
  }
  applyGridBorders(
    allTables,
    { from: 1, to: projects.length + 1 },
    { from: 1, to: 5 },
  );

  /* ── Per-project sheets ──
   * 화면의 ProjectSheet 와 동일한 7-row KV. 시트 이름 = 프로젝트 이름.
   * Excel 시트명 제약 (31 chars, no \\/?:*[]) + 중복 회피. */
  const usedNames = new Set<string>(['Cover', 'All tables']);
  for (const p of projects) {
    const sheetName = uniqueSheetName(p.name, usedNames);
    const ws = wb.addWorksheet(sheetName);
    ws.columns = [
      { header: 'Field', key: 'k', width: 18 },
      { header: 'Value', key: 'v', width: 48 },
    ];
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = {
      type: 'pattern', pattern: 'solid',
      fgColor: { argb: 'FFEDF4EE' },
    };
    const rows: [string, string | number][] = [
      ['Project', p.name],
      ['Phase', p.phase],
      ['Tables', tableCountOf(p)],
      ['Columns', columnCountOf(p)],
      ['Owner', p.owner ?? '—'],
      ['Assignee', p.assignee ?? '—'],
      ['Run status', p.runStatus],
    ];
    rows.forEach(([k, v]) => ws.addRow({ k, v }));
    ws.getColumn(1).font = { bold: true };
    applyGridBorders(ws, { from: 1, to: rows.length + 1 }, { from: 1, to: 2 });
  }

  return wb.xlsx.writeBuffer();
}

/* Excel 시트명: 31 자 이하, \\ / ? : * [ ] 금지, 빈 문자열 / 중복 금지. */
function uniqueSheetName(name: string, used: Set<string>): string {
  const sanitized = name.replace(/[\\/?:*[\]]/g, '_').slice(0, 31) || 'Sheet';
  if (!used.has(sanitized)) {
    used.add(sanitized);
    return sanitized;
  }
  for (let i = 2; i < 1000; i++) {
    const suffix = ` (${i})`;
    const trimmed = sanitized.slice(0, 31 - suffix.length) + suffix;
    if (!used.has(trimmed)) {
      used.add(trimmed);
      return trimmed;
    }
  }
  // fallback — 거의 도달 불가.
  const fallback = `Sheet ${used.size + 1}`;
  used.add(fallback);
  return fallback;
}

export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // 다음 frame 에서 revoke — 일부 브라우저가 즉시 revoke 시 download 가 끊기는 경우 회피.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function manifestToClipboardText(site: Site, manifest: ManifestEntry[], generatedAt: string): string {
  return [
    `# site-export — ${site.name}`,
    `# generated ${generatedAt}`,
    `# files: ${manifest.length} · total ${fmtBytes(manifestTotalSize(manifest))}`,
    '',
    ...manifest.map(m => `${m.path}\t${fmtBytes(m.size)}`),
  ].join('\n');
}

/* ────────────────────────────────────────────────────────────────
 * 미리보기용 데이터 생성기 — Migration SQL / Validation plan / Mapping preview.
 * snapshot rules + bindings + DDL 으로 실 동작 가능한 SQL / 검증 계획을 생성.
 * (백엔드 export job 이 결국 같은 것을 만듦. FE 미리보기는 작업 검수용.)
 * ──────────────────────────────────────────────────────────────── */

/** Validation 시트 컬럼 정의 — ArtifactsPage.tsx SHEETS.validation 과 동일. */
export interface ValidationSheetSpec {
  name: string;
  columns: { name: string; type: string }[];
  freeForm?: boolean;
}
export const VALIDATION_SHEET_COLUMNS: ValidationSheetSpec[] = [
  { name: 'Overview', freeForm: true, columns: [
    { name: 'Item',    type: 'TEXT' },
    { name: 'ASIS',    type: 'TEXT' },
    { name: 'TOBE',    type: 'TEXT' },
    { name: 'Verdict', type: 'TEXT' },
  ]},
  { name: 'Sum recon', columns: [
    { name: 'Column',    type: 'VARCHAR' },
    { name: 'Type',      type: 'VARCHAR' },
    { name: 'SUM(ASIS)', type: 'NUMBER' },
    { name: 'SUM(TOBE)', type: 'NUMBER' },
    { name: 'Δ %',       type: 'TEXT' },
    { name: 'Verdict',   type: 'TEXT' },
  ]},
  { name: 'NULL parity', columns: [
    { name: 'Column',     type: 'VARCHAR' },
    { name: 'Type',       type: 'VARCHAR' },
    { name: 'NULLS ASIS', type: 'BIGINT' },
    { name: 'NULLS TOBE', type: 'BIGINT' },
    { name: 'Δ',          type: 'BIGINT' },
    { name: 'Verdict',    type: 'TEXT' },
  ]},
  { name: 'Range', columns: [
    { name: 'Column',        type: 'VARCHAR' },
    { name: 'Type',          type: 'VARCHAR' },
    { name: 'Bound',         type: 'TEXT' },
    { name: 'Observed max',  type: 'NUMBER' },
    { name: 'Overflow rows', type: 'INT' },
    { name: 'Verdict',       type: 'TEXT' },
  ]},
];

/** Migration SQL 한 테이블당 entry — Tables 시트 + Sample SQL 시트 용도. */
export interface MigrationSqlEntry {
  table: string;          // fully qualified TOBE table
  ruleCount: number;
  composition: string;    // 'single' | 'join (N)' | 'union (N)' | 'none'
  source: string;         // AS-IS source(s) joined by composition symbol
  sql: string;            // CREATE + INSERT statements
}

/** snapshot rules + bindings + TOBE DDL → 실 INSERT/CREATE SQL.
 *  공통 transformation logic — 백엔드 export job 의 출력과 큰 틀 동일. */
export function generateMigrationSql(
  rules: Array<{
    strategy: 'expression' | 'null' | 'default' | 'skip';
    tobeSchema: string; tobeTable: string; tobeColumn: string;
    asisTable: string | null; asisColumn: string[] | null;
    transformSql: string | null; transformRule: string | null;
    defaultValue: string | null;
  }>,
  bindings: Array<{
    tobeSchema: string; tobeTable: string;
    compositionKind: 'single' | 'join' | 'union' | 'none';
    sources: Array<{ asisSchema: string | null; asisTable: string; alias: string; role: 'primary' | 'join' | 'union'; joinType: string | null; joinOn: string | null }>;
  }>,
  tobeSchema: DdlSchema | null,
): MigrationSqlEntry[] {
  if (!tobeSchema) return [];
  const rulesByTable = new Map<string, typeof rules>();
  for (const r of rules) {
    const key = `${r.tobeSchema || ''}.${r.tobeTable}`.toLowerCase();
    if (!rulesByTable.has(key)) rulesByTable.set(key, []);
    rulesByTable.get(key)!.push(r);
  }
  const bindingByTable = new Map<string, typeof bindings[number]>();
  for (const b of bindings) bindingByTable.set(`${b.tobeSchema || ''}.${b.tobeTable}`.toLowerCase(), b);

  const out: MigrationSqlEntry[] = [];
  for (const tw of [...tobeSchema.tables].sort((a, b) => a.table.ordinal - b.table.ordinal)) {
    const key = `${tw.table.schemaName || ''}.${tw.table.physicalName}`.toLowerCase();
    const tableRules = rulesByTable.get(key) ?? [];
    if (tableRules.length === 0) continue;
    const tobeFqn = `${tw.table.schemaName ? tw.table.schemaName + '.' : ''}${tw.table.physicalName}`;
    const binding = bindingByTable.get(key);

    const composition: string = binding
      ? binding.compositionKind === 'single' ? 'single'
        : binding.compositionKind === 'none' ? 'none'
        : `${binding.compositionKind} (${binding.sources.length})`
      : 'none';
    const sourceJoin = binding?.compositionKind === 'join' ? ' ⋈ '
                    : binding?.compositionKind === 'union' ? ' ∪ ' : ', ';
    const source = binding && binding.sources.length > 0
      ? binding.sources.map((s) => `${s.asisSchema ? s.asisSchema + '.' : ''}${s.asisTable}`).join(sourceJoin)
      : '—';

    const nonSkip = tableRules.filter((r) => r.strategy !== 'skip');
    const insertCols = nonSkip.map((r) => r.tobeColumn);
    const primary = binding?.sources.find((s) => s.role === 'primary') ?? binding?.sources[0];
    const primaryAlias = primary?.alias || 'a';

    const selectExprs = nonSkip.map((r) => {
      if (r.strategy === 'null') return `NULL AS ${r.tobeColumn}`;
      if (r.strategy === 'default') {
        const dv = r.defaultValue ?? '';
        const isNum = /^-?\d+(\.\d+)?$/.test(dv);
        return `${isNum ? dv : `'${dv.replace(/'/g, "''")}'`} AS ${r.tobeColumn}`;
      }
      if (r.transformSql && r.transformSql.trim()) return `${r.transformSql.trim()} AS ${r.tobeColumn}`;
      const cols = (r.asisColumn ?? []).filter((c) => c && c.trim());
      if (cols.length === 0) return `NULL /* no source */ AS ${r.tobeColumn}`;
      if (cols.length === 1) return `${primaryAlias}.${cols[0]} AS ${r.tobeColumn}`;
      return `/* combine: ${cols.join(', ')} */ ${primaryAlias}.${cols[0]} AS ${r.tobeColumn}`;
    });

    let fromClause = '';
    if (!binding || binding.sources.length === 0) {
      fromClause = `FROM (/* no binding */)`;
    } else if (binding.compositionKind === 'single' || binding.sources.length === 1) {
      const p = primary!;
      fromClause = `FROM ${p.asisSchema ? p.asisSchema + '.' : ''}${p.asisTable} AS ${p.alias || 'a'}`;
    } else if (binding.compositionKind === 'join') {
      const lines = [`FROM ${primary!.asisSchema ? primary!.asisSchema + '.' : ''}${primary!.asisTable} AS ${primary!.alias}`];
      for (const s of binding.sources) {
        if (s === primary) continue;
        const jt = s.joinType || 'LEFT JOIN';
        const tn = `${s.asisSchema ? s.asisSchema + '.' : ''}${s.asisTable}`;
        const on = s.joinOn?.trim() || '/* missing join clause */';
        lines.push(`${jt} ${tn} AS ${s.alias} ON ${on}`);
      }
      fromClause = lines.join('\n');
    } else {
      // union
      fromClause = `FROM ${primary!.asisSchema ? primary!.asisSchema + '.' : ''}${primary!.asisTable} AS ${primary!.alias}  -- (UNION ALL with ${binding.sources.length - 1} more)`;
    }

    const createCols = tw.columns
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((c) => {
        const nn = c.nullable ? '' : ' NOT NULL';
        const dv = c.defaultValue ? ` DEFAULT ${c.defaultValue}` : '';
        return `  ${c.physicalName} ${c.dataTypeRaw}${nn}${dv}`;
      });
    const pkCols = tw.columns
      .filter((c) => c.pkOrder != null)
      .sort((a, b) => (a.pkOrder ?? 0) - (b.pkOrder ?? 0))
      .map((c) => c.physicalName);
    const pkLine = pkCols.length > 0 ? `,\n  PRIMARY KEY (${pkCols.join(', ')})` : '';

    const sql = [
      `-- ${tobeFqn}`,
      `CREATE TABLE IF NOT EXISTS ${tobeFqn} (`,
      createCols.join(',\n') + pkLine,
      `);`,
      ``,
      `INSERT INTO ${tobeFqn} (`,
      insertCols.map((c) => `  ${c}`).join(',\n'),
      `)`,
      `SELECT`,
      selectExprs.map((e) => `  ${e}`).join(',\n'),
      fromClause,
      `;`,
    ].join('\n');

    out.push({ table: tobeFqn, ruleCount: nonSkip.length, composition, source, sql });
  }
  return out;
}

/** TOBE DDL → 어떤 컬럼에 어떤 검증이 걸리는지 (Sum/NULL/Range) 플랜. 비교 값은 'pending'. */
export interface ValidationPlanRows {
  Overview:      (string | number | null)[][];
  'Sum recon':   (string | number | null)[][];
  'NULL parity': (string | number | null)[][];
  Range:         (string | number | null)[][];
}

const NUMERIC_TYPE_RE = /^(NUMBER|NUMERIC|DECIMAL|INT|INTEGER|BIGINT|SMALLINT|FLOAT|REAL|DOUBLE)/i;
const STRING_BOUND_TYPE_RE = /^(VARCHAR|CHAR|VARCHAR2)/i;

export function generateValidationPlan(tobeSchema: DdlSchema | null): ValidationPlanRows {
  const empty: ValidationPlanRows = { Overview: [], 'Sum recon': [], 'NULL parity': [], Range: [] };
  if (!tobeSchema) return empty;

  for (const tw of [...tobeSchema.tables].sort((a, b) => a.table.ordinal - b.table.ordinal)) {
    const tobeFqn = `${tw.table.schemaName ? tw.table.schemaName + '.' : ''}${tw.table.physicalName}`;
    empty.Overview.push([tobeFqn, 'pending', 'pending', 'pending']);
    for (const c of tw.columns) {
      const type = (c.dataType || c.dataTypeRaw || '').toUpperCase();
      const rawType = c.dataTypeRaw || type;
      if (NUMERIC_TYPE_RE.test(type)) {
        empty['Sum recon'].push([c.physicalName, rawType, null, null, null, 'pending']);
      }
      if (c.nullable) {
        empty['NULL parity'].push([c.physicalName, rawType, null, null, null, 'pending']);
      }
      if (c.length != null && STRING_BOUND_TYPE_RE.test(type)) {
        empty.Range.push([c.physicalName, rawType, `len ≤ ${c.length}`, null, null, 'pending']);
      } else if (/SMALLINT/i.test(type)) {
        empty.Range.push([c.physicalName, rawType, '±32767', null, null, 'pending']);
      }
    }
  }
  return empty;
}
