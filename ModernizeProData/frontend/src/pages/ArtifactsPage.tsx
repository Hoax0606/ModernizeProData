import { useState, useMemo, useEffect } from 'react';
import ExcelJS from 'exceljs';
import { useWorkspaceStore } from '../store/workspace';
import { snapshotApi } from '../api/workspace';
import { useSnapshotsStore, usePinnedSnapshotsStore, type FrozenRule, type SnapshotData, type MappingSnapshot } from '../store/snapshots';
import { asisDdlApi, type DdlSchema, type DdlColumn } from '../api/asisDdl';
import { tobeDdlApi } from '../api/tobeDdl';
import { mappingImportApi } from '../api/mappingImport';
import { validationApi, type ValidationReportDto } from '../api/validation';
import { ValidationDiffModal } from '../components/ValidationDiffModal';
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

export type CategoryKey = 'dashboard' | 'diff' | 'ddl' | 'sql' | 'validation';

export interface Category {
  key: CategoryKey;
  labelKey: TranslationKey;
  suffix: string;
  icon: string;
  /** dashboard 는 프로젝트 단위 단일 산출물, 나머지는 테이블 단위. */
  single?: boolean;
  /** 본문 렌더 모드 — 'grid' (Excel 셀 표) | 'sql' (다크 테마 코드 뷰). 기본 grid. */
  viewType?: 'grid' | 'sql';
  /** 타이틀바 우측 액션 — 'xlsx' 면 녹색 Download .xlsx 버튼, 없으면 윈도우 버튼 데코.
   *  viewType='sql' 인 경우는 Copy/Download 버튼이 자동으로 표시되므로 무관. */
  downloadType?: 'xlsx';
}

export const CATEGORIES: Category[] = [
  { key: 'dashboard',  labelKey: 'artifacts.cat.dashboard',  suffix: '.dashboard.xlsx', icon: '▣', single: true, downloadType: 'xlsx' },
  /* 구 'Schema diff' — 사용자 노출 라벨은 'Mapping', 파일 확장자도 .map.xlsx 로 통일.
     내부 key 는 'diff' 그대로 유지 (코드 전반의 SHEETS.diff / buildDiff 등이 참조). */
  { key: 'diff',       labelKey: 'artifacts.cat.mapping',    suffix: '.map.xlsx',       icon: '◨', downloadType: 'xlsx' },
  { key: 'ddl',        labelKey: 'artifacts.cat.ddl',        suffix: '.ddl.sql',        icon: '▤', single: true, viewType: 'sql' },
  { key: 'sql',        labelKey: 'artifacts.cat.sql',        suffix: '.migrate.sql',    icon: '↦', viewType: 'sql' },
  { key: 'validation', labelKey: 'artifacts.cat.validation', suffix: '.report.xlsx',    icon: '✓', downloadType: 'xlsx' },
];

/* 수식 입력줄에 보일 카테고리별 placeholder 텍스트.
   `{key}` 형식의 placeholder 는 ExcelWorkbook 의 ctx 값으로 치환된다. */
const SUMMARY_PLACEHOLDER: Record<CategoryKey, string> = {
  dashboard:  'Dashboard · {n} tables · {progress}% columns mapped',
  diff:       'Schema diff: {ASIS} → {TOBE} · {changed} changed',
  ddl:        'DDL: {table} · {n} columns · {pk} primary key',
  sql:        'Migration SQL: {ASIS} → {TOBE} · {n} lines',
  validation: 'Validation report · {table} · {n} checks',
};

/* 카테고리 × 시트 별 placeholder 스키마.
   시트 탭을 클릭하면 ExcelWorkbook 이 해당 시트의 columns 로 그리드를 다시 렌더한다.
   실제 산출물 데이터가 들어오면 columns 옆에 rows 데이터만 추가하면 된다. */
export interface SheetSchema {
  name: string;
  columns: { name: string; type: string }[];
  /** true 면 컬럼명/타입 헤더 행 (1행/2행) 을 생략하고 데이터를 row 1 부터 시작.
   *  Validation Overview 처럼 free-form 레이아웃에서 사용 — 헤더는 데이터 안에 inline. */
  freeForm?: boolean;
}

export const SHEETS: Record<CategoryKey, SheetSchema[]> = {
  dashboard: [
    /* Overview 는 free-form — 컬럼명/타입 헤더 생략. row 1 부터 'Dashboard snapshot' 제목,
       Captured/Run/Author 메타 행, blank, 그 다음 inline 'Metric/Value/Unit/Note' 헤더 + 값 행. */
    { name: 'Overview', freeForm: true, columns: [
      { name: 'Item',  type: 'TEXT' },
      { name: 'Value', type: 'TEXT' },
      { name: 'Unit',  type: 'TEXT' },
      { name: 'Note',  type: 'TEXT' },
    ]},
    { name: 'Tables', columns: [
      { name: 'Table',       type: 'VARCHAR' },
      { name: 'Schema',      type: 'VARCHAR' },
      { name: 'Rules',       type: 'INT' },
      { name: 'Issues',      type: 'INT' },
      { name: 'Status',      type: 'ENUM' },
      { name: 'Last update', type: 'TIMESTAMP' },
    ]},
    /* Issues 시트는 의도적으로 없음 — Overview Issues/Errors 카운트 + Tables Issues column 으로
       수만 노출하고, 상세 진단/수정은 Mapping 페이지에서 진행. */
  ],
  diff: [
    { name: 'Diff', columns: [
      { name: 'Status',            type: 'ENUM' },
      { name: 'Table',             type: 'VARCHAR' },
      { name: 'ASIS column',       type: 'VARCHAR' },
      { name: 'ASIS type',         type: 'VARCHAR' },
      { name: 'ASIS null',         type: 'BOOLEAN' },
      { name: 'TOBE column',       type: 'VARCHAR' },
      { name: 'TOBE type',         type: 'VARCHAR' },
      { name: 'TOBE null',         type: 'BOOLEAN' },
      { name: 'Mapping / default', type: 'TEXT' },
    ]},
    { name: 'Summary', columns: [
      { name: 'Kind',      type: 'TEXT' },
      { name: 'Count',     type: 'INT' },
      { name: '% of TOBE', type: 'TEXT' },
      { name: 'Note',      type: 'TEXT' },
    ]},
  ],
  /* DDL 은 viewType='sql' 이라 columns 는 사용되지 않음.
     시트 이름이 곧 AS-IS / TO-BE 스크립트 선택 키 (reconstructDdl 결과 참조). */
  ddl: [
    { name: 'AS-IS', columns: [] },
    { name: 'TO-BE', columns: [] },
  ],
  sql: [
    { name: 'Migration SQL', columns: [
      { name: 'line_no',        type: 'INT' },
      { name: 'statement_type', type: 'ENUM' },
      { name: 'target_table',   type: 'VARCHAR' },
      { name: 'statement',      type: 'TEXT' },
      { name: 'applied',        type: 'BOOLEAN' },
      { name: 'applied_at',     type: 'TIMESTAMP' },
    ]},
  ],
  validation: [
    /* Overview 는 free-form 레이아웃 — 컬럼명/타입 헤더 생략, 데이터 안에 inline 헤더.
       Title / Meta(ASIS table 등) / Check 헤더 / PASS rows / Total 등 행 종류별로 다른 스타일. */
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
      { name: 'Note',      type: 'TEXT' },
    ]},
    { name: 'NULL parity', columns: [
      { name: 'Column',     type: 'VARCHAR' },
      { name: 'Type',       type: 'VARCHAR' },
      { name: 'NULLS ASIS', type: 'BIGINT' },
      { name: 'NULLS TOBE', type: 'BIGINT' },
      { name: 'Δ',          type: 'BIGINT' },
      { name: 'Verdict',    type: 'TEXT' },
      { name: 'Note',       type: 'TEXT' },
    ]},
    { name: 'Min Max', columns: [
      { name: 'Column',   type: 'VARCHAR' },
      { name: 'Type',     type: 'VARCHAR' },
      { name: 'MIN ASIS', type: 'TEXT' },
      { name: 'MAX ASIS', type: 'TEXT' },
      { name: 'MIN TOBE', type: 'TEXT' },
      { name: 'MAX TOBE', type: 'TEXT' },
      { name: 'Verdict',  type: 'TEXT' },
      { name: 'Note',     type: 'TEXT' },
    ]},
    { name: 'Range', columns: [
      { name: 'Column',        type: 'VARCHAR' },
      { name: 'Type',          type: 'VARCHAR' },
      { name: 'Bound',         type: 'TEXT' },
      { name: 'Observed max',  type: 'NUMBER' },
      { name: 'Overflow rows', type: 'INT' },
      { name: 'Verdict',       type: 'TEXT' },
      { name: 'Note',          type: 'TEXT' },
    ]},
    /* Quarantine 통계 시트 — binding 의 stageLabel × (entries, rows) 집계 (2026-05-31). */
    { name: 'Quarantine', columns: [
      { name: 'Check',             type: 'VARCHAR' },
      { name: 'Entries',           type: 'INT' },
      { name: 'Rows Quarantined',  type: 'BIGINT' },
      { name: 'Severity',          type: 'TEXT' },
    ]},
  ],
};


export type Cell = string | number | boolean | null;


/* 프로젝트 이름을 파일명에 안전하게 쓸 수 있는 slug 로. 비-ASCII 는 보존하지 않고
   소문자/숫자/언더스코어 만 남긴다 (file-name 호환성 우선). */
function projectSlug(name: string): string {
  const out = (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return out || 'project';
}

/* 카테고리별 자식 산출물 목록 — 트리에 자식 항목으로 표시되고,
   클릭하면 워크북 타이틀바 파일명이 `<child><category.suffix>` 로 갱신된다.
   Dashboard / DDL Scripts 는 프로젝트 단위 단일 산출물 (child 1개).
   DDL Scripts 의 child 이름은 프로젝트명에서 파생 (projectname.ddl.sql 형태). */
function childTablesFor(projectName: string): Record<CategoryKey, string[]> {
  /* diff / sql / validation 의 child 테이블 목록은 호출부 (childTables useMemo)에서
     실 데이터 (diff.tables / validationByTable) 로 override. 여기서는 빈 array 가 기본 — run
     안 됐을 때 사이드바 비어있는 게 정확 (mock fake table 안 보임). */
  return {
    dashboard:  ['dashboard-snapshot'],
    diff:       [],
    ddl:        [projectSlug(projectName)],
    sql:        [],
    validation: [],
  };
}

/* 카테고리별 fx 수식바 mock context — 시트 개수/카운트 등 상위 요약 값. */
const MOCK_FORMULA_CTX: Record<CategoryKey, FormulaContext> = {
  dashboard:  { n: 18, progress: 32.8 },
  diff:       { ASIS: 'legacy_db', TOBE: 'new_db', added: 1, removed: 1, changed: 2 },
  ddl:        { table: 'm_user', n: 6, pk: 1 },
  sql:        { ASIS: 'legacy_db', TOBE: 'new_db', n: 5 },
  validation: { table: 'CUST_PROFILE', n: 5 },
};

/** 데이터가 들어간 행만 렌더 — 데이터 아래쪽에 빈 padding 행을 두지 않는다.
 *  예전엔 EMPTY_ROWS=20 으로 padding 을 깔았는데, 빈 셀들의 1px borderBottom 이
 *  쌓여서 가로줄(barcode) 처럼 보인다는 피드백이 있어 제거. */

/** 셀 값을 표시용 문자열로 변환 — null/undefined 는 빈 칸. */
function formatCell(v: Cell | undefined): string {
  if (v == null) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

/** MAPPING(diff) Status 분류 = 매핑 strategy. skip 은 null(행 제외). */
type StrategyKind = 'rule' | 'default' | 'null' | 'passed';

/** buildDiff 가 받는 rule 의 최소 형태 — FrozenRule(snapshot) 과 MappingRuleDto(live) 양쪽이 만족.
 *  데이터 소스가 snapshot 이든 live mapping_rules 든 같은 코드로 처리하기 위한 구조적 타입.
 *  codeDomain / notNullOverride / timestamps 는 Dashboard issue 검출 + Last update 산출에 사용 —
 *  MappingRuleDto 가 안 가질 수도 있어서 optional. */
export type DiffRule = Pick<
  FrozenRule,
  | 'strategy'
  | 'transformSql'
  | 'transformRule'
  | 'asisTable'
  | 'asisColumn'
  | 'asisType'
  | 'tobeSchema'
  | 'tobeTable'
  | 'tobeColumn'
  | 'defaultValue'
> & {
  codeDomain?: string | null;
  notNullOverride?: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
};

function diffStatusKind(r: DiffRule): StrategyKind | null {
  if (r.strategy === 'skip') return null;
  if (r.strategy === 'null') return 'null';
  if (r.strategy === 'default') return 'default';
  // expression strategy 분류:
  //  - 다중 소스(combine/join) → 실제 변환이므로 rule
  //  - 단일 소스이면서 변환식이 없거나(단순 복사/리네임) 단순 컬럼 참조(col / alias.col) → passed
  //  - 그 외(함수·CASE·캐스트 등 식이 있음) → rule
  const expr = (r.transformSql ?? r.transformRule ?? '').trim();
  const multiSource = (r.asisColumn?.length ?? 0) > 1;
  if (multiSource) return 'rule';
  if (expr === '' || /^[A-Za-z_][\w$]*(\.[A-Za-z_][\w$]*)?$/.test(expr)) return 'passed';
  return 'rule';
}

/** type 문자열을 거친 카테고리로 분류 — Summary 의 type-mismatch 카운트용.
 *  VARCHAR2(50) 과 VARCHAR(100) 처럼 길이만 다른 건 같은 string 카테고리로 본다. */
function typeCategory(t: string | null | undefined): string {
  if (!t) return 'unknown';
  const s = t.toLowerCase().trim();
  if (/^(var)?char|^nchar|^nvarchar|^text|^clob/.test(s))                       return 'string';
  if (/^(big|small|tiny)?int|^integer|^number|^numeric|^decimal|^float|^double|^real/.test(s)) return 'number';
  if (/^date|^timestamp|^time/.test(s))                                         return 'date';
  if (/^bool|^bit/.test(s))                                                     return 'boolean';
  if (/^blob|^bytea|^binary|^raw/.test(s))                                      return 'binary';
  return 'other';
}

/** DdlSchema 를 `${table}.${column}` (lowercase) → DdlColumn 맵으로. */
function ddlColumnMap(schema: DdlSchema | null): Map<string, DdlColumn> {
  const m = new Map<string, DdlColumn>();
  if (!schema) return m;
  for (const t of schema.tables) {
    for (const c of t.columns) {
      m.set(`${t.table.physicalName}.${c.physicalName}`.toLowerCase(), c);
    }
  }
  return m;
}

/** buildDiff 결과 — Diff 시트 rows + 사이드바 테이블 목록 + 테이블별 Summary/fx 컨텍스트. */
interface DiffBuild {
  /** Diff 시트 9컬 rows (모든 테이블 flat, TOBE DDL ordinal 순). */
  rows: Cell[][];
  /** 사이드바에 보일 TOBE 테이블 목록 — 현재 TOBE DDL 에 있고 rule 이 매칭된 것만. */
  tables: string[];
  /** 테이블별 Summary 시트 rows (Kind / Count / % of TOBE / Note). */
  summaryByTable: Record<string, Cell[][]>;
  /** 전체(테이블 미선택) Summary — Total tables/columns + strategy 분포 + type mismatch. */
  summaryAll: Cell[][];
  /** 테이블별 fx 수식바 컨텍스트. */
  fxByTable: Record<string, { asis: string; tobe: string; changed: number }>;
  /** 전체 모드 fx 수식바 컨텍스트 — 사이드바 미선택 시 사용. */
  fxAll: { asis: string; tobe: string; changed: number };
  /** 사이드바에서 회색 disabled 로 표시할 테이블 (= latest run 에서 성공하지 못한 테이블).
   *  Set 요소는 비교 일관성을 위해 lowercase. */
  disabledTables: Set<string>;
  /** latest run 자체가 없을 때 (= 아직 실행 안 됨). 사이드바 안내 메시지용. */
  noRun: boolean;
}

/** mapping rules + ASIS/TOBE DDL → MAPPING(diff) 산출물.
 *
 *  핵심: rule 은 **현재 프로젝트의 TOBE DDL 에 존재하는 테이블** 로 한정한다. mapping_rules /
 *  snapshot 은 종종 DDL 보다 많은 테이블을 담는다 (generic fixture seed, 옛 import 잔재 등) —
 *  그대로 펼치면 3-테이블 프로젝트에 12 테이블이 뜬다. DashboardPage 와 동일하게 qualified-first,
 *  short-fallback 으로 TOBE DDL 테이블에 매칭하고, 못 찾은 rule 은 버린다.
 *
 *  Diff 9컬 순서: Status, Table, ASIS column, ASIS type, ASIS null, TOBE column, TOBE type, TOBE null, Mapping/default. */
export function buildDiff(
  rules: DiffRule[],
  asisSchema: DdlSchema | null,
  tobeSchema: DdlSchema | null,
  /** snapshot.executionContext 의 성공 테이블 (lowercase). null = 그 snapshot 으로
   *  한 번도 run 한 적 없음 → 모든 Artifacts 카테고리(MAPPING diff 포함) 빈 상태.
   *  ("mapping 은 그대로 보여줘야" 는 사이드바 메뉴의 Mapping 탭 / `/mapping` 페이지 얘기로,
   *  Artifacts 의 MAPPING(diff) 카테고리는 별개로 박제 기준 표시.) */
  successTables: Set<string> | null,
): DiffBuild {
  // run 박제가 없으면 Artifacts 의 어느 카테고리도 (diff 포함) 빈 상태 — sidebar 안내.
  if (successTables === null) {
    return {
      rows: [],
      tables: [],
      summaryByTable: {},
      summaryAll: [],
      fxByTable: {},
      fxAll: { asis: '—', tobe: '—', changed: 0 },
      disabledTables: new Set(),
      noRun: true,
    };
  }
  const asisMap = ddlColumnMap(asisSchema);
  const tobeMap = ddlColumnMap(tobeSchema);

  // TOBE DDL 테이블 인덱스 (qualified "schema.table" + short "table", lowercase) → {표시명, 순서, 컬럼수}.
  type TobeInfo = { name: string; ordinal: number; cols: number };
  const tobeByQualified = new Map<string, TobeInfo>();
  const tobeByShort = new Map<string, TobeInfo>();
  const tableOrder: string[] = [];
  if (tobeSchema) {
    for (const tw of [...tobeSchema.tables].sort((a, b) => a.table.ordinal - b.table.ordinal)) {
      const info: TobeInfo = { name: tw.table.physicalName, ordinal: tw.table.ordinal, cols: tw.columns.length };
      const qualified = `${tw.table.schemaName ? tw.table.schemaName + '.' : ''}${tw.table.physicalName}`.toLowerCase();
      tobeByQualified.set(qualified, info);
      const short = tw.table.physicalName.toLowerCase();
      if (!tobeByShort.has(short)) tobeByShort.set(short, info);
      tableOrder.push(info.name);
    }
  }

  const rowsByTable = new Map<string, Cell[][]>();
  const asisByTable = new Map<string, Set<string>>();
  const colsByTable = new Map<string, number>();
  const typeMismatchByTable = new Map<string, number>();
  const asisAll = new Set<string>();
  let typeMismatchAll = 0;
  for (const r of rules) {
    const kind = diffStatusKind(r);
    if (!kind) continue;
    const qualified = `${r.tobeSchema ? r.tobeSchema + '.' : ''}${r.tobeTable}`.toLowerCase();
    const info = tobeByQualified.get(qualified) ?? tobeByShort.get(r.tobeTable.toLowerCase());
    if (!info) continue; // 현재 TOBE DDL 에 없는 rule 은 제외 (fixture/옛 import 잔재).
    const table = info.name;
    colsByTable.set(table, info.cols);

    const firstAsisCol = r.asisColumn?.[0] ?? null;
    const aCol =
      r.asisTable && firstAsisCol
        ? asisMap.get(`${r.asisTable}.${firstAsisCol}`.toLowerCase())
        : undefined;
    const tCol = tobeMap.get(`${r.tobeTable}.${r.tobeColumn}`.toLowerCase());
    const asisColDisplay = (r.asisColumn ?? []).join(' + ') || '—';
    const asisType = aCol?.dataTypeRaw ?? (r.asisType?.join(' + ') || '—');
    const asisNull = aCol ? (aCol.nullable ? 'YES' : 'NO') : '—';
    const tobeType = tCol?.dataTypeRaw ?? '—';
    const tobeNull = tCol ? (tCol.nullable ? 'YES' : 'NO') : '—';
    const mapping =
      r.transformSql ??
      r.transformRule ??
      (r.strategy === 'default' ? (r.defaultValue ?? 'NULL') : r.strategy === 'null' ? 'NULL' : '');

    if (!rowsByTable.has(table)) rowsByTable.set(table, []);
    rowsByTable.get(table)!.push([kind, table, asisColDisplay, asisType, asisNull, r.tobeColumn, tobeType, tobeNull, mapping]);
    if (r.asisTable) {
      if (!asisByTable.has(table)) asisByTable.set(table, new Set());
      asisByTable.get(table)!.add(r.asisTable);
      asisAll.add(r.asisTable);
    }

    // type mismatch — ASIS / TOBE 둘 다 column 정보가 있고, 카테고리가 다른 경우만.
    // (passed/rule 모두 포함 — 매핑된 컬럼 중 type kind 가 어긋난 것 카운트.)
    if (aCol && tCol) {
      if (typeCategory(aCol.dataTypeRaw) !== typeCategory(tCol.dataTypeRaw)) {
        typeMismatchByTable.set(table, (typeMismatchByTable.get(table) ?? 0) + 1);
        typeMismatchAll++;
      }
    }
  }

  const tables = tableOrder.filter((t) => rowsByTable.has(t));
  // 사이드바 회색 disabled 대상 — snapshot 에 있지만 latest run 에서 성공하지 못한 테이블.
  const disabledTables = new Set(
    tables.filter((t) => !successTables.has(t.toLowerCase())).map((t) => t.toLowerCase()),
  );
  // Diff 시트(전체 모드) rows / Summary all 은 latest run 성공 테이블만 집계.
  const successOnly = tables.filter((t) => successTables.has(t.toLowerCase()));
  const rows: Cell[][] = successOnly.flatMap((t) => rowsByTable.get(t)!);

  const summaryByTable: Record<string, Cell[][]> = {};
  const fxByTable: Record<string, { asis: string; tobe: string; changed: number }> = {};
  for (const t of tables) {
    const trows = rowsByTable.get(t)!;
    const counts: Record<StrategyKind, number> = { rule: 0, default: 0, null: 0, passed: 0 };
    for (const rr of trows) counts[rr[0] as StrategyKind]++;
    const tobeCols = colsByTable.get(t) ?? trows.length;
    const asisList = [...(asisByTable.get(t) ?? [])].join(', ') || '—';
    const changed = trows.length - counts.passed;
    const pct = (n: number) => (tobeCols > 0 ? `${((n / tobeCols) * 100).toFixed(1)}%` : '—');
    const tmCount = typeMismatchByTable.get(t) ?? 0;
    summaryByTable[t] = [
      ['TOBE table',     t,             '',                '' ],
      ['ASIS source',    asisList,      '',                '' ],
      ['TOBE columns',   tobeCols,      '',                '' ],
      ['Mapped columns', trows.length,  '',                '' ],
      ['rule',           counts.rule,   pct(counts.rule),    'transform expression'],
      ['default',        counts.default, pct(counts.default), 'constant default'],
      ['null',           counts.null,   pct(counts.null),    'set NULL'],
      ['passed',         counts.passed, pct(counts.passed),  'pass-through (no transform)'],
      ['type mismatch',  tmCount,       pct(tmCount),        'ASIS / TOBE type kind differs'],
    ];
    fxByTable[t] = { asis: asisList, tobe: t, changed };
  }

  // 전체(테이블 미선택) Summary — latest run 에서 성공한 테이블만 집계.
  // snapshot 의 전체 rules 가 아니라 successOnly 의 rows 만 카운트한다 (사용자 요청).
  const totalCountsAll: Record<StrategyKind, number> = { rule: 0, default: 0, null: 0, passed: 0 };
  const asisSucc = new Set<string>();
  let typeMismatchSucc = 0;
  for (const t of successOnly) {
    const trows = rowsByTable.get(t)!;
    for (const rr of trows) totalCountsAll[rr[0] as StrategyKind]++;
    for (const a of asisByTable.get(t) ?? []) asisSucc.add(a);
    typeMismatchSucc += typeMismatchByTable.get(t) ?? 0;
  }
  const totalMapped = totalCountsAll.rule + totalCountsAll.default + totalCountsAll.null + totalCountsAll.passed;
  // 전체 TOBE 컬럼 — 성공 테이블의 컬럼 합 (이게 매핑 진척률의 자연스러운 기준).
  let totalTobeCols = 0;
  for (const t of successOnly) totalTobeCols += colsByTable.get(t) ?? 0;
  if (totalTobeCols === 0) totalTobeCols = totalMapped;
  const pctAll = (n: number) => (totalTobeCols > 0 ? `${((n / totalTobeCols) * 100).toFixed(1)}%` : '—');
  const asisListAll = [...asisSucc].sort().join(', ') || '—';
  // asisAll 은 type mismatch 계산이 끝났으니 더 이상 안 쓴다 — 의도적으로 unused.
  void asisAll;
  void typeMismatchAll;
  const summaryAll: Cell[][] = successOnly.length === 0 ? [] : [
    ['TOBE tables',    successOnly.length,                  '',                              ''],
    ['ASIS sources',   asisListAll,                          '',                              ''],
    ['TOBE columns',   totalTobeCols,                        '',                              ''],
    ['Mapped columns', totalMapped,                          pctAll(totalMapped),             ''],
    ['rule',           totalCountsAll.rule,                  pctAll(totalCountsAll.rule),     'transform expression'],
    ['default',        totalCountsAll.default,               pctAll(totalCountsAll.default),  'constant default'],
    ['null',           totalCountsAll.null,                  pctAll(totalCountsAll.null),     'set NULL'],
    ['passed',         totalCountsAll.passed,                pctAll(totalCountsAll.passed),   'pass-through (no transform)'],
    ['type mismatch',  typeMismatchSucc,                     pctAll(typeMismatchSucc),        'ASIS / TOBE type kind differs'],
  ];
  const fxAll = { asis: asisListAll, tobe: `${successOnly.length} tables`, changed: totalMapped - totalCountsAll.passed };

  return { rows, tables, summaryByTable, summaryAll, fxByTable, fxAll, disabledTables, noRun: false };
}

/** 파싱된 DdlSchema 를 CREATE TABLE 스크립트로 재구성.
 *  DDL 임포트는 원본 SQL 텍스트를 저장하지 않으므로(ddl_tables/ddl_columns 로 파싱됨),
 *  컬럼·타입(dataTypeRaw)·NULL·PK·default 로 CREATE TABLE 을 다시 만든다. */
export function reconstructDdl(schema: DdlSchema | null): string {
  if (!schema || schema.tables.length === 0) return '';
  const blocks: string[] = [];
  for (const tw of [...schema.tables].sort((a, b) => a.table.ordinal - b.table.ordinal)) {
    const t = tw.table;
    const qualified = `${t.schemaName ? t.schemaName + '.' : ''}${t.physicalName}`;
    const cols = [...tw.columns].sort((a, b) => a.ordinal - b.ordinal);
    const pad = Math.min(40, Math.max(4, ...cols.map((c) => c.physicalName.length)));
    const lines = cols.map((c) => {
      const name = c.physicalName.padEnd(pad);
      const nn = c.nullable ? '' : ' NOT NULL';
      const def = c.defaultValue ? ` DEFAULT ${c.defaultValue}` : '';
      return `  ${name} ${c.dataTypeRaw}${nn}${def}`;
    });
    const pkCols = cols
      .filter((c) => c.pkOrder != null)
      .sort((a, b) => (a.pkOrder ?? 0) - (b.pkOrder ?? 0))
      .map((c) => c.physicalName);
    if (pkCols.length > 0) lines.push(`  PRIMARY KEY (${pkCols.join(', ')})`);
    const header = t.logicalName ? `-- ${t.logicalName} (${qualified})` : `-- ${qualified}`;
    blocks.push(`${header}\nCREATE TABLE ${qualified} (\n${lines.join(',\n')}\n);`);
  }
  return blocks.join('\n\n-- ───────────────────────────────────────────────\n\n');
}

/** Dashboard 산출물 — DDL + mapping (+ snapshot 의 bindings/codeMaps 있으면 더 풍부한 issue 검출).
 *  시트: Overview / Tables (Issues 별도 시트 없음 — 카운트만 노출, 상세는 Mapping 페이지). */
interface DashboardBuild {
  /** 시트명(Overview/Tables) → rows. */
  sheets: Record<string, Cell[][]>;
  /** fx 수식바용 — TO-BE 테이블 수 + 전체 매핑 커버리지 %. */
  tableCount: number;
  mappingPct: number;
}

/** rule 이 "mapped" 인지 — DashboardPage.isMappingRuleMapped 와 동일 판정. */
function dashRuleMapped(r: DiffRule): boolean {
  if (r.strategy === 'skip') return false;
  if (r.strategy === 'null' || r.strategy === 'default') return true;
  const hasSrc = (r.asisColumn ?? []).some((c) => c && c.trim() !== '');
  const hasRule = !!(r.transformRule && r.transformRule.trim());
  return hasSrc || hasRule;
}

/** Issue 검출 신호 — Overview 의 Errors/Issues 카운트, Tables 의 Issues 컬럼에 반영.
 *  blocker = 실행 막힘 (Errors), warning = 검토 권장 (Issues). */
type DashIssueSignal =
  | 'unmapped-table'              // blocker — 테이블 전체 rule 0
  | 'unmapped-column'             // warning — 일부 컬럼 rule 없음
  | 'not-null-conflict'           // blocker — notNullOverride + (null strategy or empty default)
  | 'not-null-vs-nullable-ddl'    // warning — notNullOverride 인데 TOBE DDL 은 nullable
  | 'unresolved-codeDomain'       // blocker — codeDomain 참조하는 데 snapshot 에 없음
  | 'multi-source-missing-joinOn' // blocker — join binding 인데 joinOn 없음
  | 'missing-pk-mapping'          // blocker — PK 컬럼 rule 없거나 skip
  | 'type-shrinkage'              // warning — VARCHAR/NUMERIC 축소 → truncate 위험
  | 'empty-mapping';              // warning — expression 인데 source/transform/default 모두 빈 룰

interface DashIssue {
  severity: 'blocker' | 'warning';
  signal: DashIssueSignal;
  table: string;     // TOBE table physical name
  column: string;    // TOBE column physical name (없으면 '')
}

/* ddlColumnMap 은 buildDiff 영역에 이미 정의돼 있음 (line ~697) — 재사용. */

function buildDashboard(
  tobeSchema: DdlSchema | null,
  asisSchema: DdlSchema | null,
  rules: DiffRule[],
  snapshotData: SnapshotData | null,
  snapshot: MappingSnapshot | null,
): DashboardBuild {
  const tables = tobeSchema
    ? [...tobeSchema.tables].sort((a, b) => a.table.ordinal - b.table.ordinal)
    : [];
  // rule → TOBE DDL table 매칭 (qualified-first, short-fallback) — MAPPING/Dashboard 동일 규약.
  const byQualified = new Map<string, string>();
  const byShort = new Map<string, string>();
  const ddlColByQ = new Map<string, DdlColumn>();
  for (const tw of tables) {
    const q = `${tw.table.schemaName ? tw.table.schemaName + '.' : ''}${tw.table.physicalName}`.toLowerCase();
    byQualified.set(q, tw.table.id);
    const s = tw.table.physicalName.toLowerCase();
    if (!byShort.has(s)) byShort.set(s, tw.table.id);
    for (const col of tw.columns) {
      ddlColByQ.set(`${tw.table.physicalName}.${col.physicalName}`.toLowerCase(), col);
    }
  }

  // matched rules / per-table 집계.
  const mappedByTable = new Map<string, number>();
  const rulesByTable = new Map<string, number>();
  const tableRulesById = new Map<string, DiffRule[]>();
  const matchedRules: DiffRule[] = [];
  for (const r of rules) {
    const q = `${r.tobeSchema ? r.tobeSchema + '.' : ''}${r.tobeTable}`.toLowerCase();
    const tid = byQualified.get(q) ?? byShort.get(r.tobeTable.toLowerCase());
    if (!tid) continue;
    matchedRules.push(r);
    if (r.strategy !== 'skip') rulesByTable.set(tid, (rulesByTable.get(tid) ?? 0) + 1);
    if (dashRuleMapped(r)) mappedByTable.set(tid, (mappedByTable.get(tid) ?? 0) + 1);
    if (!tableRulesById.has(tid)) tableRulesById.set(tid, []);
    tableRulesById.get(tid)!.push(r);
  }

  // bindings / codeMaps — snapshotData 있으면 사용. 없으면 빈 배열 (해당 issue 검출 skip).
  const bindings = snapshotData?.bindings ?? [];
  const codeMaps = snapshotData?.codeMaps ?? [];
  const matchedBindings = bindings.filter((b) => {
    const q = `${b.tobeSchema ? b.tobeSchema + '.' : ''}${b.tobeTable}`.toLowerCase();
    return byQualified.has(q) || byShort.has(b.tobeTable.toLowerCase());
  });
  const domains = new Set(codeMaps.map((m) => m.domain));

  // rule by tobe column — 'table.column' → rule.
  const ruleByCol = new Map<string, DiffRule>();
  for (const r of matchedRules) ruleByCol.set(`${r.tobeTable}.${r.tobeColumn}`.toLowerCase(), r);

  // === Issue 검출 ===
  const issues: DashIssue[] = [];

  // unmapped-table / unmapped-column
  for (const tw of tables) {
    const unmappedCols = tw.columns.filter((c) =>
      !ruleByCol.has(`${tw.table.physicalName}.${c.physicalName}`.toLowerCase()),
    );
    if (tw.columns.length > 0 && unmappedCols.length === tw.columns.length) {
      issues.push({ severity: 'blocker', signal: 'unmapped-table', table: tw.table.physicalName, column: '' });
    } else {
      for (const c of unmappedCols) {
        issues.push({ severity: 'warning', signal: 'unmapped-column', table: tw.table.physicalName, column: c.physicalName });
      }
    }
  }

  // not-null-conflict / not-null-vs-nullable-ddl
  const isNotNullConflict = (r: DiffRule): boolean =>
    !!r.notNullOverride && (r.strategy === 'null' || (r.strategy === 'default' && !r.defaultValue?.trim()));
  for (const r of matchedRules) {
    if (!r.notNullOverride) continue;
    if (isNotNullConflict(r)) {
      issues.push({ severity: 'blocker', signal: 'not-null-conflict', table: r.tobeTable, column: r.tobeColumn });
      continue;
    }
    const ddlCol = ddlColByQ.get(`${r.tobeTable}.${r.tobeColumn}`.toLowerCase());
    if (ddlCol?.nullable === true) {
      issues.push({ severity: 'warning', signal: 'not-null-vs-nullable-ddl', table: r.tobeTable, column: r.tobeColumn });
    }
  }

  // unresolved-codeDomain
  for (const r of matchedRules) {
    if (r.codeDomain && !domains.has(r.codeDomain)) {
      issues.push({ severity: 'blocker', signal: 'unresolved-codeDomain', table: r.tobeTable, column: r.tobeColumn });
    }
  }

  // multi-source-missing-joinOn
  for (const b of matchedBindings) {
    if (b.compositionKind !== 'join') continue;
    for (const s of b.sources) {
      if (s.role === 'join' && !s.joinOn?.trim()) {
        issues.push({ severity: 'blocker', signal: 'multi-source-missing-joinOn', table: b.tobeTable, column: '' });
      }
    }
  }

  // missing-pk-mapping — TOBE PK 컬럼이 rule 없거나 skip
  for (const tw of tables) {
    const pkCols = tw.columns.filter((c) => c.pkOrder != null);
    for (const c of pkCols) {
      const key = `${tw.table.physicalName}.${c.physicalName}`.toLowerCase();
      const rule = ruleByCol.get(key);
      if (!rule || rule.strategy === 'skip') {
        issues.push({ severity: 'blocker', signal: 'missing-pk-mapping', table: tw.table.physicalName, column: c.physicalName });
      }
    }
  }

  // type-shrinkage — AS-IS → TOBE 타입 축소 (length / precision)
  const asisColMap = ddlColumnMap(asisSchema);
  for (const r of matchedRules) {
    if (r.strategy !== 'expression') continue;
    const asisCols = (r.asisColumn ?? []).filter((c) => c && c.trim());
    if (asisCols.length === 0) continue;
    const asisTbl = r.asisTable ?? '';
    const tobeCol = ddlColByQ.get(`${r.tobeTable}.${r.tobeColumn}`.toLowerCase());
    if (!tobeCol) continue;
    for (const ac of asisCols) {
      const asisCol = asisColMap.get(`${asisTbl}.${ac}`.toLowerCase());
      if (!asisCol) continue;
      const aLen = asisCol.length ?? null;
      const tLen = tobeCol.length ?? null;
      if (aLen != null && tLen != null && tLen < aLen) {
        issues.push({ severity: 'warning', signal: 'type-shrinkage', table: r.tobeTable, column: r.tobeColumn });
        continue;
      }
      const aPrec = asisCol.precision ?? null;
      const tPrec = tobeCol.precision ?? null;
      if (aPrec != null && tPrec != null && tPrec < aPrec) {
        issues.push({ severity: 'warning', signal: 'type-shrinkage', table: r.tobeTable, column: r.tobeColumn });
      }
    }
  }

  // empty-mapping — expression strategy 인데 source/transform/default 모두 빈 룰
  for (const r of matchedRules) {
    if (r.strategy !== 'expression') continue;
    const hasSrc = (r.asisColumn ?? []).some((c) => c && c.trim() !== '');
    const hasRule = !!(r.transformRule && r.transformRule.trim());
    const hasSql = !!(r.transformSql && r.transformSql.trim());
    if (!hasSrc && !hasRule && !hasSql) {
      issues.push({ severity: 'warning', signal: 'empty-mapping', table: r.tobeTable, column: r.tobeColumn });
    }
  }

  // === issue 카운트 per-table + total ===
  const issueCountByTable = new Map<string, number>();
  for (const it of issues) {
    issueCountByTable.set(it.table, (issueCountByTable.get(it.table) ?? 0) + 1);
  }
  const blockerCount = issues.filter((it) => it.severity === 'blocker').length;
  const warningCount = issues.filter((it) => it.severity === 'warning').length;

  // === per-table rows ===
  let totalCols = 0, mappedCols = 0;
  const tableRows: Cell[][] = [];
  for (const tw of tables) {
    const id = tw.table.id;
    const total = tw.columns.length;
    const mapped = Math.min(mappedByTable.get(id) ?? 0, total);
    const rcount = rulesByTable.get(id) ?? 0;
    const issueN = issueCountByTable.get(tw.table.physicalName) ?? 0;
    let status: string;
    if (total === 0 || mapped === 0) status = 'unmapped';
    else if (mapped < total) status = 'partial';
    else if (issueN > 0) status = 'review';
    else status = 'ready';
    totalCols += total; mappedCols += mapped;

    // Last update — 이 테이블의 rule 들 중 max(updatedAt ?? createdAt). 0개면 '—'.
    const tableRules = tableRulesById.get(id) ?? [];
    let lastTs: string | null = null;
    for (const r of tableRules) {
      const ts = r.updatedAt ?? r.createdAt ?? null;
      if (ts && (!lastTs || ts > lastTs)) lastTs = ts;
    }
    const lastUpdate = lastTs ? fmtJst(lastTs) : '—';

    tableRows.push([
      tw.table.physicalName,
      tw.table.schemaName || '—',
      rcount,
      issueN,
      status,
      lastUpdate,
    ]);
  }
  const overallPct = totalCols > 0 ? Math.round((mappedCols / totalCols) * 1000) / 10 : 0;

  // === Overview header (title + Captured/Run/Author) + Metric 5 rows ===
  // 사진 레이아웃: 'Dashboard snapshot' 제목 + Captured / Run / Author KV + blank + Metric 표.
  // 값은 snapshot 실데이터 (snapshot 없으면 live view 안내).
  const capturedLine = snapshot?.createdAt
    ? fmtJst(snapshot.createdAt)
    : `${fmtJst(new Date())} (live view — no snapshot)`;
  const runLine = snapshot
    ? `${snapshot.name} · ${snapshot.version}${snapshot.baseline ? ' · baseline' : ''}`
    : '— (live view — mapping not yet frozen)';
  const overview: Cell[][] = [
    ['Dashboard snapshot', null, null, null],
    ['', '', '', ''],
    ['Captured', capturedLine, '', ''],
    ['Run',      runLine,      '', ''],
    ['Author',   'KS Info System', '', ''],
    ['', '', '', ''],
    ['Metric',  'Value', 'Unit', 'Note'],
    ['Tables',  tables.length, 'count', 'in TO-BE schema'],
    ['Columns', totalCols,     'count', 'across all tables'],
    ['Mapped',  mappedCols,    'columns', totalCols > 0 ? `${overallPct}% of total` : '—'],
    ['Errors',  blockerCount,  'count', blockerCount === 0 ? 'no errors — execution unblocked' : 'must fix before execution'],
    ['Issues',  warningCount,  'count', warningCount === 0 ? 'no issues — mapping is clean' : 'should review (advisory)'],
  ];

  return {
    sheets: { Overview: overview, Tables: tableRows },
    tableCount: tables.length,
    mappingPct: overallPct,
  };
}

/** ISO 문자열 또는 Date → 'YYYY-MM-DD HH:mm JST' 포맷. Asia/Tokyo 변환. */
function fmtJst(input: string | Date | null | undefined): string {
  if (!input) return '—';
  const d = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return '—';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')} JST`;
}

/** Status 컬럼 값별 배지 색상.
 *  실행 컨텍스트 (Validation 등 다른 페이지) : running / blocked / warn / done
 *  매핑 컨텍스트 (Dashboard snapshot Tables) : ready / review / partial / unmapped
 *  같은 색 팔레트 재사용 — 실행 / 매핑 둘 다 비슷한 의미 매핑. */
const STATUS_BADGE: Record<string, React.CSSProperties> = {
  // 실행 컨텍스트
  running: { background: '#fff4d4', color: '#7a5a00' },
  blocked: { background: '#ffd9d9', color: '#a00000' },
  warn:    { background: '#ffe6c2', color: '#8a4c00' },
  done:    { background: '#dff5e1', color: '#0a5a1f' },
  // 매핑 컨텍스트 (Dashboard snapshot 전용)
  ready:    { background: '#dff5e1', color: '#0a5a1f' },     // = done
  review:   { background: '#ffe6c2', color: '#8a4c00' },     // = warn
  partial:  { background: '#fff4d4', color: '#7a5a00' },     // = running
  unmapped: { background: '#ffd9d9', color: '#a00000' },     // = blocked
};

/** Rule 컬럼 값별 배지 색상 — Mapping(구 Schema diff) Rules 시트에서 사용.
 *  Diff palette 와 동일 색을 재사용 (rename = added 초록, add = typed 노랑, drop = removed 빨강). */
const RULE_BADGE: Record<string, React.CSSProperties> = {
  rename: { background: '#d4eedb', color: '#0a5a1f' },
  add:    { background: '#fff0c2', color: '#7a5a00' },
  drop:   { background: '#f3d3d3', color: '#a00000' },
};

/** MAPPING(diff) Status 컬럼 배지 — 매핑 strategy 분류. */
const STRATEGY_BADGE: Record<string, React.CSSProperties> = {
  rule:            { background: '#d4eedb', color: '#0a5a1f' },     // green
  default:         { background: '#d6e3f3', color: '#0a448a' },     // blue
  null:            { background: '#fbe8c6', color: '#8a5500' },     // amber (의도적 NULL — 주의 환기)
  passed:          { background: 'transparent', color: '#605e5c' }, // plain
  // Summary 시트 전용 — strategy 가 아니라 ASIS/TOBE type kind 가 어긋난 매핑 카운트 행.
  // 주의 환기 의미로 warning red 계열 (null 의 amber 와 의미 구분).
  'type mismatch': { background: '#f3d3d3', color: '#a00000' },     // red
};

/** strategy 별 행 전체 tint (배지보다 연하게). */
const STRATEGY_ROW_TINT: Record<string, string> = {
  rule:            '#eef7f1',
  default:         '#eef2fa',
  null:            '#fbf4e6',
  passed:          '#ffffff',
  'type mismatch': '#fbeaea',
};

/** Verdict 컬럼 — Validation 시트의 검증 결과 배지. */
const VERDICT_BADGE: Record<string, React.CSSProperties> = {
  '✓ PASS': { background: '#d4eedb', color: '#0a5a1f' },
  '✓':      { background: '#d4eedb', color: '#0a5a1f' },
  PASS:     { background: '#d4eedb', color: '#0a5a1f' },
  '✗ FAIL': { background: '#f3d3d3', color: '#a00000' },
  '✗':      { background: '#f3d3d3', color: '#a00000' },
  FAIL:     { background: '#f3d3d3', color: '#a00000' },
  'n/a':    { background: '#f0f0f0', color: '#605e5c' },
};


/* Validation Overview (freeForm) 의 행 종류별 스타일 분류.
   행의 첫 칸 내용 + Verdict 컬럼 값으로 title / header / PASS / total / meta 행을 구별한다.
   - title: 'Validation report …' 헤더 (큰 글씨 짙은 녹색)
   - check 헤더: 'Check' / 'Item' / 'Metric' 행 — 행 전체 light green tint + 굵게
   - PASS 행: Verdict 컬럼 값에 '✓ PASS' 가 포함 → 행 전체 light green tint
   - total: 'Total' 행 → 1열 굵게
   - meta: 1열이 라벨이고 2열에 값이 있는 행 → 1열 굵게 */
interface OverviewRowStyle {
  rowTint?: string;
  titleStyle?: React.CSSProperties;
  metaLabelStyle?: React.CSSProperties;
  cellExtra?: React.CSSProperties;
}

function classifyOverviewRow(row: Cell[]): OverviewRowStyle {
  const first = typeof row[0] === 'string' ? row[0] : '';
  if (first.startsWith('Validation report') || first === 'Dashboard snapshot') {
    return { titleStyle: { fontWeight: 700, fontSize: 14, color: '#1d4d2e' } };
  }
  if (first === 'Check' || first === 'Item' || first === 'Metric') {
    return { rowTint: '#e8f5ec', cellExtra: { fontWeight: 600 } };
  }
  if (row.some((c) => typeof c === 'string' && c.includes('PASS'))) {
    return { rowTint: '#e8f5ec' };
  }
  if (first === 'Total') {
    return { metaLabelStyle: { fontWeight: 700 } };
  }
  if (first && row[1] != null) {
    return { metaLabelStyle: { fontWeight: 600 } };
  }
  return {};
}

/* SQL 신택스 하이라이트 — 경량 토크나이저. 라이브러리 없이 keyword/type/comment/number 만 색칠. */
const SQL_KEYWORDS = new Set([
  'CREATE', 'TABLE', 'IF', 'EXISTS', 'NOT', 'NULL', 'DEFAULT',
  'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES', 'CONSTRAINT', 'CHECK',
  'INDEX', 'UNIQUE', 'DROP', 'ALTER', 'ADD', 'COLUMN',
  'AND', 'OR', 'CASCADE', 'ON', 'DELETE', 'UPDATE',
]);
const SQL_TYPES = new Set([
  'VARCHAR', 'VARCHAR2', 'CHAR', 'TEXT', 'NUMERIC', 'NUMBER',
  'INT', 'INTEGER', 'BIGINT', 'SMALLINT', 'DECIMAL', 'BOOLEAN',
  'DATE', 'TIMESTAMP', 'JSON', 'JSONB', 'UUID', 'BLOB', 'CLOB',
]);

function highlightSqlLine(line: string, lineKey: number): React.ReactNode {
  /* 주석 우선 처리 — `--` 부터 줄 끝까지 통째로 comment 색. */
  const commentIdx = line.indexOf('--');
  const codePart = commentIdx >= 0 ? line.substring(0, commentIdx) : line;
  const commentPart = commentIdx >= 0 ? line.substring(commentIdx) : '';

  const parts: React.ReactNode[] = [];
  /* 단어/공백/구분자 단위로 토큰화. */
  const tokens = codePart.split(/(\s+|[(),;])/);
  tokens.forEach((tok, i) => {
    if (tok === '' || tok == null) return;
    if (/^\s+$/.test(tok) || /^[(),;]$/.test(tok)) {
      parts.push(tok);
      return;
    }
    /* VARCHAR(20) 같이 paren 포함된 토큰의 baseword 만 비교. */
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

/* Validation report DTO → 시트별 Cell[][] 변환. BE 의 ValidationReportService 가 만든 raw
   shape 를 mock 과 동일한 헤더 + 행 구조의 ExcelJS-호환 Cell 표 로 펼친다.

   Cell verdict 텍스트는 mock 과 동일하게 '✓ PASS' / '✗ FAIL' / '⚠ WARN' — ARGB_BY_VERDICT 가
   이 텍스트를 보고 색상 배지를 매긴다. */
function verdictText(v: 'PASS' | 'FAIL' | 'WARN' | string): string {
  if (v === 'PASS') return '✓ PASS';
  if (v === 'FAIL') return '✗ FAIL';
  if (v === 'WARN') return '⚠ WARN';
  return String(v ?? '');
}

/** BE 의 overview item 라벨 → 화면 표시. SHA-256 만 친숙화하고 나머지는 BE 원본 그대로.
 *  (2026-05-31 사용자 결정: SHA-256 hex 용어가 고객사 친숙도 낮아 'Data Integrity Check' 로
 *  변경하되, 다른 항목은 운영팀에 익숙한 기존 어휘 유지). */
function friendlyOverviewItem(item: string): string {
  if (item === 'Checksum SHA-256') return 'Data Integrity Check';
  return item;
}

function fmtCell(v: unknown): Cell {
  if (v == null) return null;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v;
  return String(v);
}

function validationOverviewRows(dto: ValidationReportDto): Cell[][] {
  const meta: Cell[][] = [
    [`Validation report · ${dto.tobeTable}`, null, null, null],
    ['TOBE table', dto.tobeSchema ? `${dto.tobeSchema}.${dto.tobeTable}` : dto.tobeTable, null, null],
    ['Generated', dto.generatedAt ?? '', null, null],
    ['Check', 'ASIS', 'TOBE', 'Verdict'],
  ];
  const items: Cell[][] = (dto.overview ?? []).map((r) => {
    const itemRaw = String(r.item ?? '');
    /* SHA-256 checksum row 의 ASIS/TOBE 는 BE 가 hash prefix (8자+…) 전송. 고객사 입장에서
       hex string 은 의미 전달 X — verdict 기반으로 'Match' / 'Mismatch' 로 변환해 가독성 ↑.
       단 '(no PK)' 같은 sentinel 값은 보존. (2026-05-31 친숙화) */
    if (itemRaw === 'Checksum SHA-256') {
      const asisRaw = String(r.asis ?? '');
      const tobeRaw = String(r.tobe ?? '');
      const isSentinel = asisRaw.startsWith('(') || tobeRaw.startsWith('(');
      const matchLabel = isSentinel
        ? fmtCell(r.asis)
        : (r.verdict === 'PASS' ? '✓ Match'
         : r.verdict === 'WARN' ? '⚠ Match (display differs)'
         : '✗ Mismatch');
      const matchLabel2 = isSentinel ? fmtCell(r.tobe) : matchLabel;
      return [friendlyOverviewItem(itemRaw), matchLabel, matchLabel2, verdictText(r.verdict)];
    }
    return [
      friendlyOverviewItem(itemRaw),
      fmtCell(r.asis), fmtCell(r.tobe), verdictText(r.verdict),
    ];
  });
  const total: Cell[][] = [
    ['Total', String(dto.totalChecks),
     `${dto.passedChecks} pass`,
     `${dto.totalChecks - dto.passedChecks} fail`],
  ];
  return [...meta, ...items, ...total];
}

function validationSumReconRows(dto: ValidationReportDto): Cell[][] {
  return (dto.sumRecon ?? []).map((r) => [
    fmtCell(r.column), fmtCell(r.type),
    fmtCell(r.asisSum), fmtCell(r.tobeSum),
    r.deltaPercent == null ? '' : `${fmtCell(r.deltaPercent)}%`,
    verdictText(r.verdict),
    fmtCell(r.note ?? ''),
  ]);
}

function validationNullParityRows(dto: ValidationReportDto): Cell[][] {
  return (dto.nullParity ?? []).map((r) => [
    fmtCell(r.column), fmtCell(r.type),
    r.asisNulls, r.tobeNulls, r.delta,
    verdictText(r.verdict),
    fmtCell(r.note ?? ''),
  ]);
}

function validationMinMaxRows(dto: ValidationReportDto): Cell[][] {
  return (dto.minMax ?? []).map((r) => [
    fmtCell(r.column), fmtCell(r.type),
    fmtCell(r.asisMin), fmtCell(r.asisMax),
    fmtCell(r.tobeMin), fmtCell(r.tobeMax),
    verdictText(r.verdict),
    fmtCell(r.note ?? ''),
  ]);
}

function validationRangeRows(dto: ValidationReportDto): Cell[][] {
  return (dto.typeValid ?? []).map((r) => [
    fmtCell(r.column), fmtCell(r.type),
    fmtCell(r.bound), fmtCell(r.observedMax),
    r.overflowRows ?? 0,
    verdictText(r.verdict),
    fmtCell(r.note ?? ''),
  ]);
}

/** Quarantine 통계 시트 — stageLabel × (entries, rows, severity). 친숙화 라벨 적용. */
function validationQuarantineRows(dto: ValidationReportDto): Cell[][] {
  return (dto.quarantineStats ?? []).map((r) => [
    friendlyStageLabel(r.stageLabel),
    r.entries ?? 0,
    r.rowsQuarantined ?? 0,
    friendlySeverity(r.severity ?? ''),
  ]);
}

/** quarantine severity → 화면 표시. error → "✗ Error", warning → "⚠ Warning", '' → ''. */
function friendlySeverity(sev: string): string {
  if (sev === 'error') return '✗ Error';
  if (sev === 'warning') return '⚠ Warning';
  return '';
}

/** BE 의 stageLabel (예: 'validate.range') → 고객사 친숙 라벨. */
function friendlyStageLabel(label: string): string {
  switch (label) {
    case 'validate.range':       return 'Numeric Range Overflow';
    case 'validate.type':        return 'Type Cast Failure';
    case 'validate.length':      return 'String Length Overflow';
    case 'validate.notnull':     return 'NOT NULL Violation';
    case 'validate.pk_unique':   return 'Primary Key Duplicate';
    case 'validate.fk':          return 'Foreign Key Violation';
    case 'validate.sum_recon':   return 'Total Reconciliation Mismatch';
    case 'validate.min_max':     return 'Min/Max Mismatch';
    case 'validate.null_parity': return 'NULL Count Mismatch';
    case 'validate.row_count':   return 'Record Count Mismatch';
    case 'validate.checksum':    return 'Data Integrity Mismatch';
    default: return label || '(unknown)';
  }
}

/** Sheet 이름 → 해당 시트의 Cell[][] 행. dto null 또는 sheet 매칭 없으면 빈 배열. */
export function validationRowsFor(dto: ValidationReportDto | null | undefined, sheetName: string): Cell[][] {
  if (!dto) return [];
  switch (sheetName) {
    case 'Overview':    return validationOverviewRows(dto);
    case 'Sum recon':   return validationSumReconRows(dto);
    case 'NULL parity': return validationNullParityRows(dto);
    case 'Min Max':     return validationMinMaxRows(dto);
    case 'Range':       return validationRangeRows(dto);
    case 'Quarantine':  return validationQuarantineRows(dto);
    default: return [];
  }
}

/* xlsx 셀 색상 팔레트 — 화면(in-app) 배지 색과 동일한 ARGB 형태.
   화면 CSS hex (#rrggbb) → ARGB (FFRRGGBB) 로 0xFF alpha prefix 만 붙임. */

/* MAPPING(diff) Diff/Summary 시트의 strategy 색 — in-app STRATEGY_BADGE / STRATEGY_ROW_TINT 와 1:1.
   배지(col 0)는 진한 bg+fg, 나머지 행은 연한 tint. passed 는 흰색이라 칠하지 않는다. */
const ARGB_STRATEGY_BADGE: Record<string, { bg: string; fg: string }> = {
  rule:            { bg: 'FFD4EEDB', fg: 'FF0A5A1F' },
  default:         { bg: 'FFD6E3F3', fg: 'FF0A448A' },
  null:            { bg: 'FFFBE8C6', fg: 'FF8A5500' },
  passed:          { bg: 'FFFFFFFF', fg: 'FF605E5C' },
  'type mismatch': { bg: 'FFF3D3D3', fg: 'FFA00000' },
};
const ARGB_STRATEGY_ROW_TINT: Record<string, string> = {
  rule: 'FFEEF7F1', default: 'FFEEF2FA', null: 'FFFBF4E6', passed: 'FFFFFFFF',
  'type mismatch': 'FFFBEAEA',
};
const ARGB_BY_STATUS: Record<string, { bg: string; fg: string }> = {
  // 실행 컨텍스트
  running: { bg: 'FFFFF4D4', fg: 'FF7A5A00' },
  blocked: { bg: 'FFFFD9D9', fg: 'FFA00000' },
  warn:    { bg: 'FFFFE6C2', fg: 'FF8A4C00' },
  done:    { bg: 'FFDFF5E1', fg: 'FF0A5A1F' },
  // 매핑 컨텍스트 (Dashboard snapshot Tables)
  ready:    { bg: 'FFDFF5E1', fg: 'FF0A5A1F' },
  review:   { bg: 'FFFFE6C2', fg: 'FF8A4C00' },
  partial:  { bg: 'FFFFF4D4', fg: 'FF7A5A00' },
  unmapped: { bg: 'FFFFD9D9', fg: 'FFA00000' },
};
const ARGB_BY_VERDICT: Record<string, { bg: string; fg: string }> = {
  /* 2026-05-31 친숙화 — 화면 표시 = 'Pass'/'Fail'/'Warning' (BE 의 'PASS'/'FAIL'/'WARN' 은
     verdictText 에서 변환). 양쪽 키 모두 등록해 in-app preview / ExcelJS 둘 다 색칠. */
  '✓ Pass': { bg: 'FFD4EEDB', fg: 'FF0A5A1F' },
  '✓ PASS': { bg: 'FFD4EEDB', fg: 'FF0A5A1F' },
  '✓':      { bg: 'FFD4EEDB', fg: 'FF0A5A1F' },
  Pass:     { bg: 'FFD4EEDB', fg: 'FF0A5A1F' },
  PASS:     { bg: 'FFD4EEDB', fg: 'FF0A5A1F' },
  '✗ Fail': { bg: 'FFF3D3D3', fg: 'FFA00000' },
  '✗ FAIL': { bg: 'FFF3D3D3', fg: 'FFA00000' },
  '✗':      { bg: 'FFF3D3D3', fg: 'FFA00000' },
  Fail:     { bg: 'FFF3D3D3', fg: 'FFA00000' },
  FAIL:     { bg: 'FFF3D3D3', fg: 'FFA00000' },
  /* WARN (Talend Data Stewardship 패턴) — 표현 차이로 인한 false-positive 또는 canonical
     비교 일치인 row. 노란 amber tint. */
  '⚠ Warning': { bg: 'FFFFF4D4', fg: 'FF7A5A00' },
  '⚠ WARN':    { bg: 'FFFFF4D4', fg: 'FF7A5A00' },
  '⚠':         { bg: 'FFFFF4D4', fg: 'FF7A5A00' },
  Warning:     { bg: 'FFFFF4D4', fg: 'FF7A5A00' },
  WARN:        { bg: 'FFFFF4D4', fg: 'FF7A5A00' },
  /* Checksum SHA-256 친숙화 — '✓ Match' / '⚠ Match (display differs)' / '✗ Mismatch'
     (2026-05-31). hex string 노출 대신 사용자 친화 표현. */
  '✓ Match':                     { bg: 'FFD4EEDB', fg: 'FF0A5A1F' },
  '⚠ Match (display differs)':   { bg: 'FFFFF4D4', fg: 'FF7A5A00' },
  '✗ Mismatch':                  { bg: 'FFF3D3D3', fg: 'FFA00000' },
};

/* ExcelJS 셀에 fill + font color 한번에 적용하는 헬퍼. */
function paintCell(cell: ExcelJS.Cell, bg: string, fg?: string): void {
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
  if (fg) cell.font = { ...(cell.font ?? {}), color: { argb: fg } };
}

/* 워크북 전체(현재 카테고리의 모든 시트)를 실제 xlsx 바이너리로 생성해 다운로드.
   화면에서 보이는 in-app 배지 색/굵기를 ExcelJS 셀 fill+font 로 그대로 옮긴다. */
async function downloadWorkbookAsXlsx(
  filename: string,
  categoryKey: CategoryKey,
  sheets: SheetSchema[],
  getRows: (sheetName: string) => Cell[][],
): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'KS Info System';
  wb.created = new Date();
  await fillWorkbook(wb, categoryKey, sheets, getRows);
  const blob = await xlsxBlobFromWorkbook(wb);
  triggerBlobDownload(blob, filename);
}

/** 빈 workbook 에 한 카테고리의 모든 시트 + 행 + ARGB 배지 색을 채워 넣는다.
 *  downloadWorkbookAsXlsx (단일 카테고리 다운로드) 와 buildXlsxBlob (bundle zip 용)
 *  둘 다 이 함수를 통해 동일한 결과를 얻는다. */
async function fillWorkbook(
  wb: ExcelJS.Workbook,
  categoryKey: CategoryKey,
  sheets: SheetSchema[],
  getRows: (sheetName: string) => Cell[][],
): Promise<void> {
  for (const sheet of sheets) {
    /* Excel 시트명은 31 자 이하, \\ / ? : * [ ] 금지. 안전하게 잘라낸다. */
    const safeName = sheet.name.replace(/[\\/?:*[\]]/g, '_').slice(0, 31) || 'Sheet';
    const ws = wb.addWorksheet(safeName);
    const rows = getRows(sheet.name);

    if (!sheet.freeForm && sheet.columns.length > 0) {
      /* in-app preview 와 동일: 컬럼명 1줄 (+ hideTypeRow 가 아니면 타입 2번째 줄).
         dashboard / diff(MAPPING) / sql(MIGRATION SQL) 은 타입 행이 의미 없어 생략. */
      const hideTypeRow = categoryKey === 'dashboard' || categoryKey === 'diff' || categoryKey === 'sql';
      ws.addRow(sheet.columns.map((c) => c.name));
      const nameRow = ws.getRow(1);
      nameRow.eachCell((cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F2F1' } };
        cell.font = { bold: true, color: { argb: 'FF217346' }, size: 12 };
      });
      if (!hideTypeRow) {
        ws.addRow(sheet.columns.map((c) => c.type));
        const typeRow = ws.getRow(2);
        typeRow.eachCell((cell) => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F2F1' } };
          cell.font = { color: { argb: 'FF605E5C' }, size: 10 };
        });
      }
      sheet.columns.forEach((c, i) => {
        ws.getColumn(i + 1).width = Math.max(12, Math.min(40, c.name.length + 6));
      });
      /* in-app preview 처럼 헤더 줄을 고정 (frozen pane) — hideTypeRow 면 1줄, 아니면 2줄. */
      ws.views = [{ state: 'frozen', ySplit: hideTypeRow ? 1 : 2 }];
    }

    rows.forEach((row) => {
      const transformed = row.map((v) => {
        if (v === null || v === undefined) return null;
        if (typeof v === 'boolean') return v ? 'true' : 'false';
        return v;
      });
      const excelRow = ws.addRow(transformed);

      /* ── Mapping (diff) Diff & Summary 시트 ── col 0 의 strategy(rule/default/null/passed) 로
         행 전체를 연한 tint, col 0(Status/Kind) 은 진한 배지색. in-app preview 와 동일. */
      if (categoryKey === 'diff' && (sheet.name === 'Diff' || sheet.name === 'Summary')) {
        const kind = typeof row[0] === 'string' ? (row[0] as string) : '';
        const badge = ARGB_STRATEGY_BADGE[kind];
        if (badge) {
          const tint = ARGB_STRATEGY_ROW_TINT[kind];
          if (tint && tint !== 'FFFFFFFF') excelRow.eachCell((cell) => paintCell(cell, tint));
          paintCell(excelRow.getCell(1), badge.bg, badge.fg);
        }
      }

      /* ── Dashboard/Validation Status 컬럼 ── done/running/blocked/warn 배지. */
      if (!sheet.freeForm) {
        sheet.columns.forEach((col, colIdx) => {
          const cell = excelRow.getCell(colIdx + 1);
          const v = row[colIdx];
          if (typeof v !== 'string') return;
          if (col.name === 'Status' && categoryKey !== 'diff') {
            const p = ARGB_BY_STATUS[v];
            if (p) paintCell(cell, p.bg, p.fg);
          }
          if (col.name === 'Verdict') {
            const p = ARGB_BY_VERDICT[v];
            if (p) paintCell(cell, p.bg, p.fg);
          }
        });
      }

      /* ── Validation Overview (freeForm) ── inline 헤더 / PASS 행 / title 행. */
      if (categoryKey === 'validation' && sheet.freeForm && sheet.name === 'Overview') {
        const first = typeof row[0] === 'string' ? row[0] : '';
        if (first.startsWith('Validation report')) {
          /* title 행 — 굵은 짙은 녹색 텍스트. */
          paintCell(excelRow.getCell(1), 'FFFFFFFF', 'FF1D4D2E');
          excelRow.getCell(1).font = { bold: true, color: { argb: 'FF1D4D2E' }, size: 13 };
        } else if (first === 'Check' || first === 'Item' || first === 'Metric') {
          /* check 헤더 — 연녹색 tint + 굵게. */
          excelRow.eachCell((cell) => {
            paintCell(cell, 'FFE8F5EC');
            cell.font = { ...(cell.font ?? {}), bold: true };
          });
        } else if (row.some((c) => typeof c === 'string' && c.includes('PASS'))) {
          /* PASS 행 — 연녹색 tint 행. */
          excelRow.eachCell((cell) => paintCell(cell, 'FFE8F5EC'));
        } else if (first === 'Total') {
          excelRow.getCell(1).font = { ...(excelRow.getCell(1).font ?? {}), bold: true };
        } else if (first && row[1] != null) {
          excelRow.getCell(1).font = { ...(excelRow.getCell(1).font ?? {}), bold: true };
        }
        /* Verdict 컬럼 (4번째) — PASS/FAIL 배지. */
        const verdict = row[3];
        if (typeof verdict === 'string') {
          const p = ARGB_BY_VERDICT[verdict];
          if (p) paintCell(excelRow.getCell(4), p.bg, p.fg);
        }
      }

    });

    /* 최종 폰트 통일 — 모든 셀에 Calibri 강제 적용 (기존 bold/color/size 속성은 유지).
       기본값으로 두면 Excel 의 로케일에 따라 MS P ゴシック / 맑은 고딕 등으로 렌더돼서
       in-app 화면 (Calibri) 과 글씨체가 달라 보인다. spread 뒤에 name 을 다시 덮어써서
       Calibri 가 최종 값이 되게 한다. */
    ws.eachRow((excelRow) => {
      excelRow.eachCell({ includeEmpty: false }, (cell) => {
        const prev = cell.font ?? {};
        cell.font = { ...prev, name: 'Calibri' };
      });
    });
  }
}

/** ExcelJS Workbook → Blob. writeBuffer 가 Node Buffer(폴리필) 를 줄 수 있어
 *  순수 ArrayBuffer 로 slice 한 뒤 Blob 으로 감싼다 (ZIP 헤더 깨짐 방지). */
async function xlsxBlobFromWorkbook(wb: ExcelJS.Workbook): Promise<Blob> {
  const buf = await wb.xlsx.writeBuffer();
  const arrayBuffer: ArrayBuffer = ArrayBuffer.isView(buf)
    ? (buf.buffer as ArrayBuffer).slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    : (buf as ArrayBuffer);
  return new Blob([arrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

/** Blob 다운로드 — <a download> 트릭. */
function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** 한 카테고리 분의 ExcelJS workbook 을 만들어 Blob 으로 돌려준다.
 *  downloadWorkbookAsXlsx 의 내부 로직과 동일 — bundle 다운로드에서 같은 결과를
 *  blob 형태로 zip 에 넣기 위해 분리한 entry point. */
export async function buildXlsxBlob(
  categoryKey: CategoryKey,
  sheets: SheetSchema[],
  getRows: (sheetName: string) => Cell[][],
): Promise<Blob> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'KS Info System';
  wb.created = new Date();
  // downloadWorkbookAsXlsx 와 동일 sheet/row/스타일 처리를 거치도록 그 함수의 in-place
  // 효과를 그대로 활용 — 임시로 호출하고 마지막 download 부분만 우회.
  // (DRY 를 위해 downloadWorkbookAsXlsx 를 한 번 더 부르고 Blob 만 가로채는 대신,
  // helper 가 받은 wb 를 호출자가 채우게 두면 단순하지만 시그니처가 커진다 — 그래서
  // 동일 로직을 호출하는 시점에 writeBuffer 만 별도로 한다.)
  await fillWorkbook(wb, categoryKey, sheets, getRows);
  return xlsxBlobFromWorkbook(wb);
}

/* Clipboard 복사 — 최신 API 우선, 실패 시 fallback. */
async function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
}

/* 텍스트를 파일로 다운로드. */
function downloadText(filename: string, text: string, mime = 'text/plain'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

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

/** fx 수식바의 `{key}` placeholder 를 ctx 값으로 치환.
 *  - 값이 있으면: `{key}` → `{value}` (중괄호는 유지하고 안의 내용만 교체)
 *  - 값이 없으면: `{key}` 원본 그대로 유지 (실데이터 wiring 전 placeholder 가 보이도록) */
type FormulaContext = Record<string, string | number | undefined | null>;

function substitute(template: string, ctx: FormulaContext): string {
  return template.replace(/\{([^}]+)\}/g, (match, key: string) => {
    const v = ctx[key];
    return v != null && v !== '' ? `{${v}}` : match;
  });
}

export function ArtifactsPage() {
  const t = useT();
  const projects = useWorkspaceStore((s) => s.projects);
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const project = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId],
  );

  // MAPPING(diff) 산출물 — 활성 snapshot 의 frozen rules + ASIS/TOBE DDL 조합.
  // 활성 snapshot 우선순위: (1) 프로젝트의 pinned (baseline) snapshot, (2) 가장 최근 mapping snapshot.
  // 사용자가 pin 을 옛 snapshot 으로 옮기면 그 시점의 executionContext/mapping 으로 자동 전환.
  const snapshots = useSnapshotsStore((s) => s.snapshots);
  const fetchSnapshots = useSnapshotsStore((s) => s.fetchByProject);
  const pinnedIds = usePinnedSnapshotsStore((s) => s.pinnedIds);
  useEffect(() => {
    if (activeProjectId) fetchSnapshots(activeProjectId);
  }, [activeProjectId, fetchSnapshots]);
  const latestMappingSnapshot = useMemo(() => {
    const projectMapping = snapshots.filter(
      (s) => s.projectId === activeProjectId && s.type === 'mapping',
    );
    const pinned = projectMapping.find((s) => pinnedIds.includes(s.id));
    if (pinned) return pinned;
    return [...projectMapping].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  }, [snapshots, activeProjectId, pinnedIds]);
  const [mappingRules, setMappingRules] = useState<DiffRule[]>([]);
  const [snapshotData, setSnapshotData] = useState<SnapshotData | null>(null);
  const [asisSchema, setAsisSchema] = useState<DdlSchema | null>(null);
  const [tobeSchema, setTobeSchema] = useState<DdlSchema | null>(null);
  /* 데이터 소스: 최신 mapping snapshot 의 frozen rules 우선 (= 승인/동결된 산출물).
     스냅샷이 없는 프로젝트는 현재 live mapping_rules 로 폴백 — 그래야 스냅샷 전 단계에서도
     매핑 산출물 미리보기가 가능. 어느 쪽이든 buildDiff 가 TOBE DDL 기준으로 필터한다.
     snapshotData (rules+bindings+codeMaps) 도 별도 보관 — Dashboard issue 검출에 사용. */
  useEffect(() => {
    if (!activeProjectId) {
      setMappingRules([]);
      setSnapshotData(null);
      return;
    }
    let cancelled = false;
    if (latestMappingSnapshot) {
      snapshotApi
        .getMapping(latestMappingSnapshot.id)
        .then((d) => {
          if (cancelled) return;
          setMappingRules(d.rules);
          setSnapshotData(d);
        })
        .catch(() => {
          if (!cancelled) { setMappingRules([]); setSnapshotData(null); }
        });
    } else {
      mappingImportApi
        .listRules(activeProjectId)
        .then((rs) => { if (!cancelled) { setMappingRules(rs); setSnapshotData(null); } })
        .catch(() => { if (!cancelled) { setMappingRules([]); setSnapshotData(null); } });
    }
    return () => { cancelled = true; };
  }, [activeProjectId, latestMappingSnapshot]);
  useEffect(() => {
    if (!activeProjectId) {
      setAsisSchema(null);
      setTobeSchema(null);
      return;
    }
    let cancelled = false;
    asisDdlApi.get(activeProjectId).then((d) => { if (!cancelled) setAsisSchema(d); }).catch(() => { if (!cancelled) setAsisSchema(null); });
    tobeDdlApi.get(activeProjectId).then((d) => { if (!cancelled) setTobeSchema(d); }).catch(() => { if (!cancelled) setTobeSchema(null); });
    return () => { cancelled = true; };
  }, [activeProjectId]);
  // latest mapping snapshot 의 박제된 execution_context 가 source — runs API 폴링이 아니라
  // "snapshot 시점" 의 상태를 보여준다 (사용자 결정 — phase 2). snapshot 의 executionContext
  // 가 null (아직 한 번도 run 안 됨) 이면 diff 가 noRun=true 빈 상태.
  const successTables = useMemo<Set<string> | null>(() => {
    const ctx = latestMappingSnapshot?.executionContext;
    if (!ctx) return null;
    const s = new Set<string>();
    for (const st of ctx.stages) {
      for (const tr of st.tables) {
        if (tr.status === 'success') s.add(tr.tobeTable.toLowerCase());
      }
    }
    return s;
  }, [latestMappingSnapshot]);
  // MIGRATION SQL 은 load stage 의 합성 SQL 만 (Transform 의 박제는 backend 에 디버깅용으로
  // 두지만 사용자에겐 노출 X — 사용자 의도: 실행되는 적재 SQL 만).
  const compiledSqlByTable = useMemo<Record<string, string>>(() => {
    const ctx = latestMappingSnapshot?.executionContext;
    if (!ctx) return {};
    const map: Record<string, string> = {};
    const loadStage = ctx.stages.find((s) => s.stageKey === 'load');
    if (loadStage) {
      for (const tr of loadStage.tables) {
        if (tr.compiledSql) map[tr.tobeTable.toLowerCase()] = tr.compiledSql;
      }
    }
    return map;
  }, [latestMappingSnapshot]);

  const diff = useMemo(
    () => buildDiff(mappingRules, asisSchema, tobeSchema, successTables),
    [mappingRules, asisSchema, tobeSchema, successTables],
  );

  /* VALIDATION — pinned snapshot 의 박제된 run 의 validation_reports 를 일괄 prefetch.
     snapshot 의 executionContext.runId 가 source (= "그 시점의" 검증 결과). pin 변경 시 자동 swap.
     키는 tobe_table. 값이 undefined = 그 테이블에 대한 report 없음 (run 안 됐거나 binding 미포함). */
  const validationRunId = latestMappingSnapshot?.executionContext?.runId ?? null;
  const [validationByTable, setValidationByTable] =
    useState<Record<string, ValidationReportDto>>({});
  useEffect(() => {
    if (!validationRunId) { setValidationByTable({}); return; }
    let cancelled = false;
    validationApi.listByRun(validationRunId)
      .then((list) => {
        if (cancelled) return;
        const m: Record<string, ValidationReportDto> = {};
        for (const r of list) m[r.tobeTable] = r;
        setValidationByTable(m);
      })
      .catch(() => { if (!cancelled) setValidationByTable({}); });
    return () => { cancelled = true; };
  }, [validationRunId]);
  // DDL SCRIPTS — 임포트한 ASIS/TOBE DDL 을 CREATE TABLE 로 재구성 (AS-IS / TO-BE 탭).
  const ddlText = useMemo<Record<string, string>>(
    () => ({ 'AS-IS': reconstructDdl(asisSchema), 'TO-BE': reconstructDdl(tobeSchema) }),
    [asisSchema, tobeSchema],
  );
  // DASHBOARD — TOBE/AS-IS DDL + mapping rules + snapshotData(bindings/codeMaps) 로 9 종 issue 검출.
  //   snapshot 도 전달 → Overview header 의 Captured/Run 표시에 사용.
  const dashboard = useMemo(
    () => buildDashboard(tobeSchema, asisSchema, mappingRules, snapshotData, latestMappingSnapshot),
    [tobeSchema, asisSchema, mappingRules, snapshotData, latestMappingSnapshot],
  );

  const [openCats, setOpenCats] = useState<Record<CategoryKey, boolean>>({
    dashboard: true,
    diff: true,
    ddl: true,
    sql: false,
    validation: false,
  });
  const [selectedCat, setSelectedCat] = useState<CategoryKey>('dashboard');
  /* 카테고리별로 마지막으로 본 시트를 기억해서, 카테고리 전환 시 사용자가
     선택했던 시트를 그대로 복원한다. */
  const [activeSheetByCat, setActiveSheetByCat] =
    useState<Partial<Record<CategoryKey, string>>>({});
  /* 카테고리별로 사이드바 트리에서 선택한 테이블 기억. fx 수식바의 {table}
     placeholder 가 이 값으로 치환된다. */
  const [selectedTableByCat, setSelectedTableByCat] =
    useState<Partial<Record<CategoryKey, string>>>({});

  /* 자식 산출물 목록은 프로젝트명에 의존 (DDL Scripts 의 child 이름이 projectSlug).
     project null 일 때도 hook 자체는 호출되어야 — early return 위로 끌어올려야
     "Rendered more hooks than during the previous render" 가 안 남. */
  const childTables = useMemo(() => {
    const base = childTablesFor(project?.name ?? '');
    // MAPPING(diff) / MIGRATION SQL 둘 다 — 현재 TOBE DDL 에 있고 rule 이 매칭된 테이블.
    // SQL 도 사이드바에 같은 list 가 뜨고 성공 외 테이블은 disabled.
    // VALIDATION — pinned snapshot 의 박제 run 으로부터 prefetch 한 report 가 있는 테이블만.
    //   report 없는 테이블은 트리에서도 안 보임 (run 안 됐거나 binding 미포함).
    const validationTables = Object.keys(validationByTable).sort();
    return {
      ...base,
      diff: diff.tables,
      sql: diff.tables,
      validation: validationTables.length > 0 ? validationTables : base.validation,
    };
  }, [project?.name, diff.tables, validationByTable]);

  /* Bundle (zip) 다운로드 진행 중 상태 — 사이드바 버튼 disabled 처리용. */
  const [bundleBusy, setBundleBusy] = useState(false);

  /* diff / sql 의 default selected — early return 위에서 계산 (hooks 순서 보장).
     latest run 미성공 테이블이 첫 번째일 수 있으니 첫 success 로 default.
     두 카테고리 모두 같은 successTables/disabledTables 를 공유하므로 default 도 같다. */
  const defaultSuccessTable = useMemo(() => {
    if (!diff || diff.noRun) return undefined;
    return diff.tables.find((t) => !diff.disabledTables.has(t.toLowerCase())) ?? undefined;
  }, [diff]);

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
  const activeSheet =
    activeSheetByCat[activeCategory.key] ?? SHEETS[activeCategory.key][0].name;
  const handleSelectSheet = (name: string) =>
    setActiveSheetByCat((prev) => ({ ...prev, [activeCategory.key]: name }));

  /* 사용자가 명시적으로 자식을 안 골라도 첫 번째 자식이 default 로 활성.
     Dashboard / DDL 은 단일 산출물이라 항상 그 single child.
     defaultDiffTable 은 early return 위에서 이미 계산함. */
  const selectedTable =
    selectedTableByCat[activeCategory.key]
      ?? ((activeCategory.key === 'diff' || activeCategory.key === 'sql')
          ? defaultSuccessTable
          : childTables[activeCategory.key][0]);
  const handleSelectTable = (catKey: CategoryKey, tbl: string) => {
    // diff / sql 의 disabled (latest run 미성공) 테이블은 선택 차단 — silently 무시.
    if ((catKey === 'diff' || catKey === 'sql') && diff.disabledTables.has(tbl.toLowerCase())) return;
    setSelectedCat(catKey);
    setSelectedTableByCat((prev) => ({ ...prev, [catKey]: tbl }));
  };

  /* Artifacts 의 모든 다운로드 가능 산출물을 zip 한 묶음으로.
     - Dashboard / MAPPING(diff) → .xlsx (in-app preview 와 동일 색상/스타일).
     - DDL Scripts → asis/tobe 각 .sql.
     - MIGRATION SQL → 성공 테이블 별 .migrate.sql.
     - VALIDATION → prefetch 한 validation_reports 의 테이블 별 .report.xlsx. */
  const handleDownloadBundle = async () => {
    if (bundleBusy) return;
    setBundleBusy(true);
    try {
      const JSZipMod = await import('jszip');
      const JSZip = JSZipMod.default;
      const zip = new JSZip();
      const stem = projectSlug(project.name);

      // 카테고리별 폴더 안에 배치 — 사용자가 압축 해제했을 때 카테고리별로 묶여 보이게.
      // 1) Dashboard
      if (dashboard) {
        try {
          const blob = await buildXlsxBlob('dashboard', SHEETS.dashboard,
            (sheet) => dashboard.sheets[sheet] ?? []);
          zip.file(`dashboard/${stem}.dashboard.xlsx`, await blob.arrayBuffer());
        } catch (e) { console.warn('bundle: dashboard skipped', e); }
      }
      // 2) MAPPING (diff) — 박제 있을 때만.
      if (!diff.noRun && diff.tables.length > 0) {
        try {
          const blob = await buildXlsxBlob('diff', SHEETS.diff, (sheet) => {
            if (sheet === 'Diff') return diff.rows;
            if (sheet === 'Summary') return diff.summaryAll;
            return [];
          });
          zip.file(`mapping/${stem}.map.xlsx`, await blob.arrayBuffer());
        } catch (e) { console.warn('bundle: mapping skipped', e); }
      }
      // 3) DDL Scripts
      if (ddlText['AS-IS']) zip.file(`ddl/${stem}.asis.ddl.sql`, ddlText['AS-IS']);
      if (ddlText['TO-BE']) zip.file(`ddl/${stem}.tobe.ddl.sql`, ddlText['TO-BE']);
      // 4) MIGRATION SQL — table 별 합성 SQL.
      for (const [tableLc, sql] of Object.entries(compiledSqlByTable)) {
        if (sql) zip.file(`migration-sql/${tableLc}.migrate.sql`, sql);
      }
      // 5) VALIDATION — prefetch 한 report 별 .report.xlsx.
      for (const [tableName, dto] of Object.entries(validationByTable)) {
        try {
          const blob = await buildXlsxBlob('validation', SHEETS.validation,
            (sheet) => validationRowsFor(dto, sheet));
          zip.file(`validation/${tableName}.report.xlsx`, await blob.arrayBuffer());
        } catch (e) { console.warn('bundle: validation skipped', tableName, e); }
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      triggerBlobDownload(zipBlob, `${stem}.artifacts.zip`);
    } catch (e) {
      console.warn('bundle download failed', e);
    } finally {
      setBundleBusy(false);
    }
  };

  return (
    <div style={styles.page}>
      {/* Sidebar — feature/artifacts 디자인 유지 (export btn in header) */}
      <aside style={styles.sidebar}>
        <div style={styles.sidebarHeader}>
          <span style={styles.sidebarHeaderLabel}>Artifacts</span>
          <span style={styles.sidebarHeaderCount}>0</span>
        </div>
        <div style={styles.sidebarBody}>
          <ArtifactTree
            openCats={openCats}
            setOpenCats={setOpenCats}
            selectedCat={selectedCat}
            onSelect={(cat) => setSelectedCat(cat)}
            selectedTableByCat={selectedTableByCat}
            onSelectTable={handleSelectTable}
            childTables={childTables}
            disabledDiffTables={diff.disabledTables}
            diffNoRun={diff.noRun}
          />
        </div>
        <div style={styles.cta}>
          <button
            onClick={() => void handleDownloadBundle()}
            disabled={bundleBusy}
            title={bundleBusy ? '' : t('siteExport.btn.download')}
            style={bundleBusy
              ? { ...styles.btnPrimary, ...styles.btnPrimaryDisabled }
              : styles.btnPrimary}
          >
            <span style={styles.btnIcon}>↓</span>
            {bundleBusy ? '' : t('siteExport.btn.download')}
          </button>
        </div>
      </aside>

      {/* Excel workbook chrome — fills the right pane completely */}
      <section style={styles.body}>
        <ExcelWorkbook
          category={activeCategory}
          projectName={project.name}
          selectedTable={selectedTable}
          activeSheet={activeSheet}
          onSelectSheet={handleSelectSheet}
          diff={diff}
          ddlText={ddlText}
          dashboard={dashboard}
          compiledSqlByTable={compiledSqlByTable}
          validationByTable={validationByTable}
        />
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
  selectedTableByCat: Partial<Record<CategoryKey, string>>;
  onSelectTable: (cat: CategoryKey, tbl: string) => void;
  childTables: Record<CategoryKey, string[]>;
  /** diff 카테고리에서 회색·비활성으로 보일 테이블 (lowercase). */
  disabledDiffTables?: Set<string>;
  /** diff 카테고리에 표시할 run 자체가 없을 때 = 안내 메시지로 대체. */
  diffNoRun?: boolean;
}

function ArtifactTree({
  openCats,
  setOpenCats,
  selectedCat,
  onSelect,
  selectedTableByCat,
  onSelectTable,
  childTables,
  disabledDiffTables,
  diffNoRun,
}: TreeProps) {
  const t = useT();
  return (
    <div style={styles.tree}>
      {CATEGORIES.map((cat) => {
        const open = openCats[cat.key];
        const active = selectedCat === cat.key;
        const tables = childTables[cat.key];
        /* default selection = 첫 번째 자식 (사용자가 클릭 안 했어도 활성 표시) */
        const selectedTable = selectedTableByCat[cat.key] ?? tables[0];
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
              <span style={styles.catCount}>{tables.length}</span>
            </div>
            {open && (
              <div style={styles.tableList}>
                {(cat.key === 'diff' || cat.key === 'sql') && diffNoRun ? (
                  <div style={styles.noRunHint}>{t('artifacts.diff.noRun')}</div>
                ) : (
                  tables.map((tbl) => {
                    const disabled = (cat.key === 'diff' || cat.key === 'sql') && !!disabledDiffTables?.has(tbl.toLowerCase());
                    const tblActive = active && selectedTable === tbl && !disabled;
                    return (
                      <div
                        key={tbl}
                        onClick={disabled ? undefined : () => onSelectTable(cat.key, tbl)}
                        style={{
                          ...styles.tableRow,
                          ...(tblActive ? styles.tableRowActive : null),
                          ...(disabled ? styles.tableRowDisabled : null),
                        }}
                        title={disabled
                          ? `${tbl}${cat.suffix} — ${t('artifacts.diff.notInLatestRun')}`
                          : `${tbl}${cat.suffix}`}
                      >
                        {tbl}{cat.suffix}
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────
   Excel workbook chrome (prototype port)
   ─────────────────────────────────────────────────────────────── */

interface ExcelWorkbookProps {
  category: Category;
  projectName: string;
  selectedTable?: string;
  activeSheet: string;
  onSelectSheet: (sheet: string) => void;
  /** MAPPING(diff) 산출물 — rules + DDL 로 빌드한 Diff rows / Summary / fx. */
  diff?: DiffBuild;
  /** DDL SCRIPTS — 재구성한 AS-IS / TO-BE CREATE TABLE 텍스트 (시트명 → SQL). */
  ddlText?: Record<string, string>;
  /** DASHBOARD — DDL + mapping 커버리지 시트(Overview/Tables/Issues) + fx 메타. */
  dashboard?: DashboardBuild;
  /** MIGRATION SQL — latest run 의 transform stage 가 박제한 (테이블 → SQL 텍스트).
   *  키는 lowercase tobeTable. selectedTable 의 lowercase 로 lookup. */
  compiledSqlByTable?: Record<string, string>;
  /** VALIDATION — pinned snapshot 의 박제 run 으로부터 prefetch 한 per-table report.
   *  키는 tobe_table (case-sensitive — BE 의 binding.tobeTable 그대로). 값 미존재 = 그 테이블
   *  에 대해 run 안 됐거나 binding 미포함. */
  validationByTable?: Record<string, ValidationReportDto>;
}

function ExcelWorkbook({
  category,
  projectName,
  selectedTable,
  activeSheet,
  onSelectSheet,
  diff,
  ddlText,
  dashboard,
  compiledSqlByTable,
  validationByTable,
}: ExcelWorkbookProps) {
  const t = useT();
  /* Copy 버튼 직후 짧은 "Copied" 토스트를 띄우기 위한 상태.
     true 로 세팅 후 ~1.6 초 뒤 자동으로 false. */
  const [copied, setCopied] = useState(false);
  /* Validation drill-down 모달 — Data Integrity Check (SHA-256) FAIL 시 row-by-row 비교.
     Validation 카테고리 + validationDto.checksum.verdict 가 'FAIL' 일 때만 트리거 버튼 표시. */
  const [diffOpen, setDiffOpen] = useState(false);
  /* 트리에서 선택한 자식(예: dashboard-snapshot, m_user) 이 있으면 그 이름으로,
     없으면 placeholder 로 fallback. */
  const baseName = selectedTable ?? t('artifacts.workbook.placeholderName');
  const filename = `${baseName}${category.suffix}`;
  const sheets = SHEETS[category.key];
  /* 활성 시트의 컬럼 스키마. activeSheet 가 SHEETS 에 없으면 (방어적) 첫 시트로 fallback. */
  const currentSheet = sheets.find((s) => s.name === activeSheet) ?? sheets[0];
  const cols = currentSheet.columns;
  /* 2행(타입 헤더 INT/ENUM/VARCHAR…) 표시 여부 — dashboard / MAPPING(diff) / MIGRATION SQL 은 의미 없어 생략.
     VALIDATION 은 유지 (수치 검증 시트라 타입 정보가 도움됨). DDL SCRIPTS 는 SQL 뷰라 무관. */
  const hideTypeRow =
    category.key === 'dashboard' || category.key === 'diff' || category.key === 'sql';

  /* 현재 시트에 그릴 행. 상태바 rows 카운트도 이 배열 길이를 사용.
     - DASHBOARD: DDL+mapping 커버리지(Overview/Tables/Issues) — 실데이터
     - MAPPING(diff): Diff = buildDiff rows(선택 테이블 필터), Summary = 테이블별 집계 — 실데이터
     - VALIDATION: pinned snapshot 의 박제 run 의 validation_reports — 실데이터
     - DDL / SQL: viewType='sql' 이라 grid 미사용 — dataRows 빈 array (sqlText path) */
  const validationDto = (category.key === 'validation' && selectedTable)
    ? validationByTable?.[selectedTable] ?? null
    : null;
  const dataRows: Cell[][] =
    category.key === 'dashboard'
      ? (dashboard?.sheets[activeSheet] ?? [])
      : category.key === 'diff' && activeSheet === 'Diff'
        ? (diff?.rows ?? []).filter((r) => !selectedTable || String(r[1]) === selectedTable)
        : category.key === 'diff' && activeSheet === 'Summary'
          ? ((selectedTable ? (diff?.summaryByTable[selectedTable] ?? []) : (diff?.summaryAll ?? [])))
          : category.key === 'validation' && selectedTable
            ? validationRowsFor(validationDto, activeSheet)
            : [];

  /* viewType='sql' 인 두 카테고리:
       - DDL SCRIPTS: ddlText[activeSheet] ('AS-IS' / 'TO-BE')
       - MIGRATION SQL: compiledSqlByTable[selectedTable.toLowerCase()] — latest run 의 박제 SQL. */
  const isSqlView = category.viewType === 'sql';
  const sqlText: string = !isSqlView
    ? ''
    : category.key === 'sql'
      ? (selectedTable ? (compiledSqlByTable?.[selectedTable.toLowerCase()] ?? '') : '')
      : (ddlText?.[activeSheet] ?? '');
  const sqlLines = sqlText ? sqlText.split('\n') : [];

  /* Diff 카테고리 — fx 수식바 컨텍스트.
     사이드바 테이블 선택 시: 그 테이블의 fxByTable, 미선택(전체) 시: fxAll (전체 카운트).
     둘 다 실데이터. */
  const diffFx =
    category.key === 'diff'
      ? (selectedTable ? diff?.fxByTable[selectedTable] : diff?.fxAll)
      : undefined;
  /* Dashboard — fx 수식바의 {n} 테이블 수 / {progress} 매핑 커버리지 % (실데이터). */
  const dashFx = category.key === 'dashboard' ? dashboard : undefined;

  const handleCopy = () => {
    void copyToClipboard(sqlText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };
  const handleDownload = () => {
    /* 다운로드 파일명:
         DDL          : <table>.<sheet>.sql — 예: acct_master.AS-IS.ddl.sql
         MIGRATION SQL: <table>.migrate.sql — 시트 한 장이라 sheet 이름 생략. */
    const dlName = category.key === 'sql'
      ? `${baseName}${category.suffix}`
      : `${baseName}.${activeSheet}${category.suffix}`;
    downloadText(dlName, sqlText, 'application/sql');
  };
  const handleDownloadXlsx = () => {
    /* 워크북 전체(현재 카테고리의 모든 시트)를 실제 xlsx 로 저장. */
    const dlName = `${baseName}${category.suffix}`;
    /* 각 시트별 데이터 lookup — 다 실데이터. validation 은 prefetch 한 DTO 를 시트별 Cell[][]
       로 변환. in-app preview 와 동일 행을 그대로 xlsx 로 굽는다. */
    const getRows = (sheetName: string): Cell[][] => {
      if (category.key === 'dashboard') return dashboard?.sheets[sheetName] ?? [];
      if (category.key === 'diff') {
        if (sheetName === 'Diff') return (diff?.rows ?? []).filter((r) => !selectedTable || String(r[1]) === selectedTable);
        if (sheetName === 'Summary') return (selectedTable ? (diff?.summaryByTable[selectedTable] ?? []) : (diff?.summaryAll ?? []));
        return [];
      }
      if (category.key === 'validation' && selectedTable) {
        return validationRowsFor(validationByTable?.[selectedTable] ?? null, sheetName);
      }
      return [];  // ddl / sql 은 viewType='sql' — xlsx grid 미사용
    };
    void downloadWorkbookAsXlsx(dlName, category.key, sheets, getRows);
  };

  /* fx 수식바 placeholder 치환 — projectName + 카테고리별 context.
     사이드바에서 테이블을 선택했으면 {table} 을 그 값으로 override.
     diff 카테고리면 선택 테이블의 fxByTable 로 ASIS/TOBE/changed override (실데이터).
     validation 카테고리면 prefetch 한 DTO 의 totalChecks 로 {n} override (실데이터). */
  const validationN: number | undefined =
    category.key === 'validation' && validationDto
      ? validationDto.totalChecks
      : undefined;
  const formulaText = substitute(SUMMARY_PLACEHOLDER[category.key], {
    project: projectName,
    ...MOCK_FORMULA_CTX[category.key],
    ...(selectedTable ? { table: selectedTable } : {}),
    ...(validationN != null ? { n: validationN } : {}),
    ...(diffFx
      ? { ASIS: diffFx.asis, TOBE: diffFx.tobe, changed: diffFx.changed }
      : {}),
    ...(dashFx ? { n: dashFx.tableCount, progress: dashFx.mappingPct } : {}),
  });

  /* DDL Scripts (viewType='sql') 은 Excel 크롬 대신 VS Code-style 크롬으로 렌더. */
  if (isSqlView) {
    return (
      <div style={styles.vscodeRoot}>
        {/* Title bar — 다크 그레이 + 좌측 메뉴, 우측 윈도우 버튼.
            파일명은 탭에서 이미 보이므로 가운데 중복 표시는 생략 (메뉴와 겹침 방지). */}
        <div style={styles.vscodeTitleBar}>
          <div style={styles.vscodeTitleLeft}>
            {['File', 'Edit', 'Selection', 'View', 'Go', 'Run', 'Terminal', 'Help'].map((m) => (
              <span key={m} style={styles.vscodeTitleMenu}>{m}</span>
            ))}
          </div>
          <div style={styles.vscodeTitleRight}>
            <span style={styles.vscodeTitleWinBtn}>─</span>
            <span style={styles.vscodeTitleWinBtn}>▢</span>
            <span style={styles.vscodeTitleWinBtn}>✕</span>
          </div>
        </div>

        {/* Tab bar — 좌측 AS-IS / TO-BE 파일 탭, 우측 Copy / Download 버튼 (같은 라인). */}
        <div style={styles.vscodeTabBar}>
          {sheets.map((s) => {
            const isActive = s.name === activeSheet;
            /* DDL 은 시트가 AS-IS/TO-BE 라 sheet 이름이 파일명에 들어가지만,
               MIGRATION SQL 은 시트 한 장이라 selectedTable 만 들어간다. */
            const tabFilename = category.key === 'sql'
              ? `${baseName}${category.suffix}`
              : `${baseName}.${s.name === 'AS-IS' ? 'asis' : 'tobe'}${category.suffix}`;
            return (
              <div
                key={s.name}
                onClick={() => onSelectSheet(s.name)}
                style={isActive ? styles.vscodeTabActive : styles.vscodeTabInactive}
              >
                <span style={styles.vscodeTabIcon}>{'⟨⟩'}</span>
                <span style={styles.vscodeTabName}>{tabFilename}</span>
                <span style={styles.vscodeTabClose}>✕</span>
              </div>
            );
          })}
          <div style={{ flex: 1 }} />
          <div style={styles.vscodeTabActions}>
            <button onClick={handleCopy} style={styles.vscodeActionBtn}>Copy</button>
            <button onClick={handleDownload} style={styles.vscodeActionBtn}>Download</button>
          </div>
        </div>

        {/* Editor — 다크 테마 코드 뷰 (기존 sqlArea 재사용).
            position: relative — 우상단 "Copied" 토스트의 anchor. */}
        <div style={{ ...styles.sqlArea, position: 'relative' }}>
          <pre style={styles.sqlPre}>
            {sqlLines.map((line, i) => (
              <div key={i} style={styles.sqlLineRow}>
                <span style={styles.sqlLineNo}>{i + 1}</span>
                <span style={styles.sqlLineCode}>{highlightSqlLine(line, i)}</span>
              </div>
            ))}
          </pre>
          {/* Copy 후 잠깐 보이는 토스트. opacity 트랜지션으로 부드럽게 사라짐. */}
          <div
            style={{
              ...styles.vscodeCopiedToast,
              opacity: copied ? 1 : 0,
              pointerEvents: copied ? 'auto' : 'none',
            }}
          >
            ✓ 복사되었습니다
          </div>
        </div>

        {/* Status bar — VS Code 블루 */}
        <div style={styles.vscodeStatusBar}>
          <span style={styles.vscodeStatusItem}>⎇ main</span>
          <span style={styles.vscodeStatusItem}>⊘ 0</span>
          <div style={{ flex: 1 }} />
          <span style={styles.vscodeStatusItem}>{activeSheet}</span>
          <span style={styles.vscodeStatusItem}>Ln 1, Col 1</span>
          <span style={styles.vscodeStatusItem}>{sqlLines.length} lines</span>
          <span style={styles.vscodeStatusItem}>UTF-8</span>
          <span style={styles.vscodeStatusItem}>SQL</span>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.workbook}>
      {/* 1) Title bar — 가운데 정렬 파일명 + 우측 윈도우 버튼 */}
      <div style={styles.titleBar}>
        <div style={styles.titleBarCenter}>
          {filename} ({t('artifacts.workbook.readOnly')}) - Report
        </div>
        <div style={styles.titleBarRight}>
          {category.key === 'validation'
            && validationDto
            && String(validationDto.checksum?.verdict ?? '') === 'FAIL' && (
            <button
              onClick={() => setDiffOpen(true)}
              style={styles.titleBarActionBtn}
              title="Open row-by-row Data Integrity diff"
            >
              View Row Diff
            </button>
          )}
          {category.downloadType === 'xlsx' ? (
            <button onClick={handleDownloadXlsx} style={styles.titleBarActionBtn}>
              Download .xlsx
            </button>
          ) : (
            <>
              <span style={styles.titleBarBtn}>─</span>
              <span style={styles.titleBarBtn}>▢</span>
              <span style={styles.titleBarBtn}>✕</span>
            </>
          )}
        </div>
      </div>

      <ValidationDiffModal
        open={diffOpen}
        runId={validationDto?.runId ?? null}
        bindingId={validationDto?.bindingId ?? null}
        tobeTable={validationDto?.tobeTable ?? selectedTable ?? ''}
        onClose={() => setDiffOpen(false)}
      />

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
        <div style={styles.formulaInput}>{formulaText}</div>
      </div>

      {/* 4) Sheet 본문 — Excel 그리드 (SQL 뷰는 vscode chrome 으로 early return 됨). */}
      <div style={styles.sheetArea}>
        <table style={styles.sheet}>
          <thead>
            {/* (A) 알파벳 헤더 — 항상 렌더 */}
            <tr>
              <th style={styles.corner} />
              {cols.map((_, i) => (
                <th key={i} style={styles.colHeader}>{colLabel(i)}</th>
              ))}
            </tr>
            {/* (B) 컬럼명 헤더 — freeForm 시트는 생략 (Overview 처럼 데이터 안에 inline 헤더 두는 경우). */}
            {!currentSheet.freeForm && (
              <tr>
                <th style={{ ...styles.rowHeader, ...styles.rowHeaderName }}>1</th>
                {cols.map((c) => (
                  <th key={`n-${c.name}`} style={styles.colName}>{c.name}</th>
                ))}
              </tr>
            )}
            {/* (C) 타입 헤더 — hideTypeRow 카테고리(dashboard/diff/sql)는 생략 (의미 없는 메타). */}
            {!currentSheet.freeForm && !hideTypeRow && (
              <tr>
                <th style={{ ...styles.rowHeader, ...styles.rowHeaderType }}>2</th>
                {cols.map((c) => (
                  <th key={`t-${c.name}`} style={styles.colType}>{c.type}</th>
                ))}
              </tr>
            )}
          </thead>
          <tbody>
            {/* (D) 데이터 행만 렌더 — 아래쪽 padding 빈 행은 두지 않는다 (가로줄 누적 방지).
                 - Dashboard/Validation Status 컬럼 → running/blocked/warn/done 배지
                 - MAPPING(diff) Diff/Summary 의 col 0 → rule/default/null/passed strategy 배지 + 행 tint
                 - Validation Overview (freeForm) → title/meta/header/PASS/total 행 종류별 스타일 */}
            {dataRows.map((row, r) => {
              /* MAPPING(diff) 의 Diff/Summary 는 col 0 이 mapping strategy. STRATEGY_BADGE/ROW_TINT 로 색칠.
                 (Summary 의 meta 행 — 'TOBE table' 등 — 은 strategy key 가 아니라 plain 으로 렌더된다.) */
              const isMappingDiff = category.key === 'diff' && (activeSheet === 'Diff' || activeSheet === 'Summary');
              const mappingStatusKind =
                isMappingDiff && typeof row[0] === 'string' && (row[0] as string) in STRATEGY_BADGE
                  ? (row[0] as string)
                  : undefined;
              const mappingRowTint = mappingStatusKind ? STRATEGY_ROW_TINT[mappingStatusKind] : undefined;
              /* freeForm Overview 행 분류 — validation / dashboard Overview 공용. */
              const isOverviewFreeForm =
                currentSheet.freeForm === true
                && (category.key === 'validation' || category.key === 'dashboard')
                && activeSheet === 'Overview';
              const ovStyle: OverviewRowStyle | null = isOverviewFreeForm ? classifyOverviewRow(row) : null;
              const rowTint = ovStyle?.rowTint ?? mappingRowTint;
              /* row 번호 오프셋: freeForm = 헤더 0행 (데이터 row 1부터),
                 hideTypeRow = 헤더 1행 (데이터 row 2부터), 기본 = 헤더 2행 (데이터 row 3부터). */
              const displayRowNum = currentSheet.freeForm ? r + 1 : hideTypeRow ? r + 2 : r + 3;
              return (
                <tr key={r}>
                  <td style={styles.rowHeader}>{displayRowNum}</td>
                  {cols.map((col, c) => {
                    const value = row[c];
                    /* Status 배지 (Dashboard/Validation) — diff 는 strategy 배지로 따로 처리. */
                    const isPlainStatus =
                      !isMappingDiff && col.name === 'Status' && typeof value === 'string';
                    /* Rule 컬럼 (Mapping Rules 시트) → rename/add/drop 배지. */
                    const isRuleCol = col.name === 'Rule' && typeof value === 'string';
                    /* Verdict 컬럼 (Validation 시트) → ✓ PASS / ✗ FAIL 배지. */
                    const isVerdictCol = col.name === 'Verdict' && typeof value === 'string';
                    const plainBadgeStyle = isPlainStatus
                      ? STATUS_BADGE[value as string]
                      : undefined;
                    const ruleBadgeStyle = isRuleCol
                      ? RULE_BADGE[value as string]
                      : undefined;
                    const verdictBadgeStyle = isVerdictCol
                      ? VERDICT_BADGE[value as string]
                      : undefined;
                    /* MAPPING(diff) col 0 (Diff=Status, Summary=Kind) → strategy 배지. */
                    const isMappingStatusCol =
                      isMappingDiff && c === 0 && typeof value === 'string' && (value as string) in STRATEGY_BADGE;
                    const strategyBadgeStyle = isMappingStatusCol
                      ? STRATEGY_BADGE[value as string]
                      : undefined;
                    const cellBg = rowTint ? { background: rowTint } : undefined;
                    /* freeForm Overview 전용 셀 스타일 — 1열 라벨 굵게, em-dash 가운데 정렬, 빈 셀은 보더 투명. */
                    const isFirstCol = c === 0;
                    const isEmDash = value === '—';
                    const isEmptyCellInOverview = isOverviewFreeForm && (value == null || value === '');
                    return (
                      <td
                        key={c}
                        style={{
                          ...styles.cell,
                          ...(cellBg ?? {}),
                          ...(isOverviewFreeForm && isFirstCol && ovStyle?.titleStyle ? ovStyle.titleStyle : {}),
                          ...(isOverviewFreeForm && isFirstCol && ovStyle?.metaLabelStyle ? ovStyle.metaLabelStyle : {}),
                          ...(isOverviewFreeForm && ovStyle?.cellExtra ? ovStyle.cellExtra : {}),
                          ...(plainBadgeStyle ?? ruleBadgeStyle ?? verdictBadgeStyle ?? strategyBadgeStyle ?? {}),
                          ...(isEmDash ? { textAlign: 'center', color: '#888' } : {}),
                          ...(isEmptyCellInOverview
                            ? { borderRight: '1px solid transparent', borderBottom: '1px solid transparent' }
                            : {}),
                        }}
                      >
                        {formatCell(value)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 5) Sheet tabs — 클릭 시 시트별 스키마로 그리드 전환 */}
      <div style={styles.sheetTabs}>
        {sheets.map((s) => {
          const isActive = s.name === activeSheet;
          return (
            <span
              key={s.name}
              onClick={() => onSelectSheet(s.name)}
              style={{
                ...(isActive ? styles.sheetTabActive : styles.sheetTabInactive),
                cursor: 'pointer',
              }}
            >
              {s.name}
            </span>
          );
        })}
        <div style={{ flex: 1 }} />
      </div>

      {/* 6) Status bar — cols/rows 카운트 (SQL 뷰는 vscode chrome 으로 별도 처리). */}
      <div style={styles.statusBar}>
        Ready · cols <span style={styles.statusNum}>{cols.length}</span> · rows{' '}
        <span style={styles.statusNum}>{dataRows.length}</span>
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
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
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
  sidebarBody: {
    flex: 1,
    overflow: 'auto',
    minHeight: 0,
  },

  /* CTA — site export 의 picker 와 동일 패턴 */
  cta: {
    padding: '10px 14px',
    borderTop: '1px solid var(--border)',
    background: 'var(--panel-2, var(--panel))',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  btnPrimary: {
    width: '100%',
    height: 32,
    background: 'var(--navy)',
    color: '#fff',
    border: '1px solid var(--navy)',
    borderRadius: 3,
    fontSize: 12.5,
    fontWeight: 600,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  btnPrimaryDisabled: {
    background: 'var(--border-strong)',
    color: 'var(--text-3)',
    borderColor: 'var(--border-strong)',
    cursor: 'not-allowed',
  },
  btnIcon: { fontSize: 13, lineHeight: 1 },

  tree: { fontFamily: 'var(--mono)', fontSize: 12, padding: '6px 0' },
  catRow: {
    padding: '5px 10px',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    cursor: 'pointer',
    color: 'var(--text)',
    fontSize: 12,
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
  catLabel: { flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  catCount: { color: 'var(--text-4)' },

  /* 트리 자식 — 카테고리 펼침 시 보이는 테이블 목록 */
  tableList: { paddingTop: 2, paddingBottom: 4 },
  tableRow: {
    padding: '4px 10px 4px 32px',
    fontSize: 12.5,
    color: 'var(--text-2)',
    fontFamily: 'var(--mono)',
    cursor: 'pointer',
    userSelect: 'none',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  tableRowActive: {
    background: 'var(--navy-50)',
    color: 'var(--navy)',
    fontWeight: 600,
    borderLeft: '2px solid var(--navy)',
  },
  /* diff: latest run 에서 성공하지 못한 테이블 — 회색·dim, click 차단(컴포넌트에서 onClick 미부착). */
  tableRowDisabled: {
    color: 'var(--text-4)',
    opacity: 0.55,
    cursor: 'not-allowed',
    fontStyle: 'italic',
  },
  /* diff: run 자체가 없을 때 사이드바 자리에 뜨는 안내 한 줄. */
  noRunHint: {
    padding: '6px 10px 6px 32px',
    fontSize: 11.5,
    color: 'var(--text-4)',
    fontStyle: 'italic',
    lineHeight: 1.4,
  },

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
    fontSize: 12,
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
    fontSize: 12,
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
    fontSize: 13,
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
    fontSize: 11.5,
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
    color: '#3b3a39',
    borderRight: `1px solid ${EXCEL_BORDER_CELL}`,
    borderBottom: `1px solid ${EXCEL_BORDER_CELL}`,
    fontSize: 12.5,
    verticalAlign: 'middle',
    /* 긴 텍스트는 한 줄에서 잘라서 ellipsis — 행 높이를 20px 로 유지 (Excel 와 동일). */
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
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

  /* ===== Title bar 액션 버튼 (Copy / Download / Download .xlsx) ===== */
  titleBarActionBtn: {
    height: 22,
    margin: '3px 4px',
    padding: '0 12px',
    background: '#fff',
    color: EXCEL_TEXT,
    border: '1px solid rgba(255,255,255,0.4)',
    borderRadius: 3,
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'var(--sans)',
  } as React.CSSProperties,

  /* ===== Schema diff 배너 (formula bar 와 grid 사이) ===== */
  diffBanner: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 12px',
    background: '#f9fafb',
    borderBottom: `1px solid ${EXCEL_BORDER}`,
    fontSize: 11,
    flexShrink: 0,
    overflow: 'hidden',
    whiteSpace: 'nowrap',
  },
  diffBannerNames: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontFamily: 'var(--mono)',
    color: EXCEL_TEXT,
  },
  diffBannerAsis: {
    color: '#a00000',
  },
  diffBannerArrow: {
    color: EXCEL_TEXT_DIM,
  },
  diffBannerTobe: {
    color: '#0a5a1f',
  },
  diffChip: {
    padding: '1px 8px',
    borderRadius: 10,
    fontSize: 10.5,
    fontFamily: 'var(--mono)',
    fontWeight: 600,
    border: '1px solid rgba(0,0,0,0.06)',
  },
  sqlArea: {
    flex: 1,
    overflow: 'auto',
    background: '#1e1e1e',
    minHeight: 0,
  },
  sqlPre: {
    margin: 0,
    padding: '12px 0',
    fontFamily: 'var(--mono), "Cascadia Code", "Consolas", monospace',
    fontSize: 12.5,
    lineHeight: '18px',
    color: '#d4d4d4',
  },
  sqlLineRow: {
    display: 'flex',
    alignItems: 'flex-start',
    paddingLeft: 4,
    paddingRight: 16,
  },
  sqlLineNo: {
    flex: '0 0 44px',
    textAlign: 'right',
    paddingRight: 14,
    color: '#858585',
    userSelect: 'none',
  },
  sqlLineCode: {
    flex: 1,
    whiteSpace: 'pre',
  },

  /* ===== VS Code chrome (DDL Scripts) ===== */
  vscodeRoot: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    background: '#1e1e1e',
    fontFamily: '"Segoe UI",system-ui,sans-serif',
    fontSize: 12,
    color: '#cccccc',
    minHeight: 0,
    userSelect: 'none',
  },
  vscodeTitleBar: {
    height: 30,
    background: '#3c3c3c',
    color: '#cccccc',
    display: 'flex',
    alignItems: 'center',
    padding: 0,
    fontSize: 12,
    flexShrink: 0,
    position: 'relative',
    borderBottom: '1px solid #1e1e1e',
  },
  vscodeTitleLeft: {
    display: 'flex',
    alignItems: 'center',
    height: '100%',
    paddingLeft: 10,
    gap: 2,
  },
  vscodeTitleMenu: {
    padding: '4px 8px',
    color: '#cccccc',
    fontSize: 12,
    cursor: 'default',
  },
  vscodeTitleCenter: {
    position: 'absolute',
    left: '50%',
    transform: 'translateX(-50%)',
    color: '#cccccc',
    fontSize: 12,
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
  },
  vscodeTitleRight: {
    marginLeft: 'auto',
    display: 'flex',
    alignItems: 'center',
    height: '100%',
    gap: 2,
  },
  vscodeActionBtn: {
    height: 22,
    margin: '3px 4px',
    padding: '0 12px',
    background: '#0e639c',
    color: '#fff',
    border: 'none',
    borderRadius: 2,
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'var(--sans)',
  } as React.CSSProperties,
  vscodeTitleWinBtn: {
    width: 46,
    height: 30,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#cccccc',
    fontSize: 11,
    cursor: 'default',
  },
  vscodeTabBar: {
    height: 34,
    background: '#252526',
    display: 'flex',
    alignItems: 'stretch',
    flexShrink: 0,
    borderBottom: '1px solid #1e1e1e',
  },
  vscodeTabActions: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    paddingRight: 6,
  },
  vscodeTabActive: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '0 12px',
    background: '#1e1e1e',
    color: '#ffffff',
    fontSize: 12,
    borderRight: '1px solid #252526',
    borderTop: '1px solid #007acc',
    cursor: 'pointer',
    minWidth: 0,
  },
  vscodeTabInactive: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '0 12px',
    background: '#2d2d2d',
    color: '#969696',
    fontSize: 12,
    borderRight: '1px solid #252526',
    cursor: 'pointer',
    minWidth: 0,
  },
  vscodeTabIcon: {
    color: '#519aba',
    fontFamily: 'var(--mono)',
    fontSize: 10,
  },
  vscodeTabName: {
    whiteSpace: 'nowrap',
  },
  vscodeTabClose: {
    marginLeft: 4,
    fontSize: 11,
    color: '#969696',
    opacity: 0.6,
  },
  vscodeStatusBar: {
    height: 22,
    background: '#007acc',
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    padding: '0 0',
    fontSize: 11,
    flexShrink: 0,
  },
  vscodeStatusItem: {
    padding: '0 8px',
    height: '100%',
    display: 'inline-flex',
    alignItems: 'center',
    color: '#fff',
    fontSize: 11,
    whiteSpace: 'nowrap',
  },
  /* Copy 직후 우상단에 잠시 보이는 작은 토스트. */
  vscodeCopiedToast: {
    position: 'absolute',
    top: 12,
    right: 16,
    padding: '4px 10px',
    background: 'rgba(14, 99, 156, 0.95)',
    color: '#ffffff',
    fontSize: 11,
    fontWeight: 600,
    borderRadius: 3,
    boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
    transition: 'opacity 0.25s ease-out',
    fontFamily: '"Segoe UI",system-ui,sans-serif',
    zIndex: 10,
  },
};
