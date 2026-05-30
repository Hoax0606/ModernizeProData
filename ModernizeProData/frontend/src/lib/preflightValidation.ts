import type { Project, Site } from '../store/workspace';
import type { DdlSchema, DdlTableWithColumns } from '../api/asisDdl';
import type { SnapshotData, FrozenRule, FrozenBinding } from '../store/snapshots';
import type { TranslationKey } from '../i18n';

export type CheckStatus = 'pass' | 'fail' | 'skip';

export type PreflightCheckId =
  | 'csv-arrived'
  | 'ddl-asis'
  | 'ddl-tobe'
  | 'conn-tobe'
  | 'tobe-bindings'
  | 'unmapped-cols'
  | 'asis-unmapped';

export interface TableCheckResult {
  /** TO-BE physicalName, or '*' for project-wide rows. */
  table: string;
  status: CheckStatus;
  /** i18n キーと vars.  PreflightResultPanel が render 時に t(...) で解決する.
   *  ラベル変更 / 言語切替を再 run なしに反映するため pre-resolved 文字列ではなく key を保持. */
  detailKey: TranslationKey;
  detailVars?: Record<string, string | number>;
}

export interface PreflightCheckResult {
  id: PreflightCheckId;
  title: string;
  /** 'project' rows are not expandable in UI; 'per-table' rows can be expanded. */
  scope: 'project' | 'per-table';
  aggregate: CheckStatus;
  perTable: TableCheckResult[];
  /**
   * true = per-table 失敗時の Fix 先がすべて同じ project-wide 設定画面に飛ぶケース.
   * UI は per-table 行の Fix ボタンを非表示にし、aggregate 行の Fix のみ残す.
   * (例: csv-arrived は AS-IS テーブルごとに失敗しても、修正先は全部 SiteSettings → CSV)
   */
  fixIsProjectWide?: boolean;
}

type T = (key: TranslationKey, vars?: Record<string, string | number>) => string;

export interface PreflightInput {
  project: Project;
  site: Site;
  tobeSchema: DdlSchema | undefined;
  asisSchema: DdlSchema | undefined;
  snapshotData: SnapshotData;
  selectedTables: string[];
  t: T;
  /**
   * TO-BE DB 接続テストの live 결과.
   * 呼び元 (startPreflight) が runPreflight 前に `tobeDbApi.testConnection` を叩いて
   * 結果を渡す. null = テスト未実施 (e.g. 設定不足で skip).
   */
  tobeDbReachable: { success: boolean; message: string } | null;
  /**
   * AS-IS テーブル名 (physicalName) → CSV ファイル存在チェック結果.
   * 呼び元 (startPreflight) が csv-preview API を叩いて事前に構築.
   * キーが無い = 検査対象外 (binding がない / csvPath 未設定でスキップした 等).
   */
  csvFilesByAsisTable: Record<string, { exists: boolean; error?: string }>;
  /**
   * 자식 link binding 의 master project 의 binding lookup.
   * key = `${masterProjectId}|${tobeSchema}|${tobeTable}` (lowercase).
   * value = master binding 의 sources 가 비어있지 않은지 여부.
   * 呼び元 (startPreflight) 가 link 마커 있는 자식 binding 의 masterId 모아 미리 fetch.
   */
  masterBindingHasSources?: Record<string, boolean>;
  /**
   * 자식 link binding 의 master project 의 mapping_rules lookup.
   * key = `${masterProjectId}|${tobeSchema}|${tobeTable}` (lowercase).
   * value = master 의 같은 (schema, table) 의 rules.
   * unmapped-cols / asis-unmapped 체크가 자식 link 시 master 의 rules 로 검증.
   */
  masterRulesByKey?: Record<string, FrozenRule[]>;
}

const ORDER: PreflightCheckId[] = [
  'csv-arrived',
  'ddl-asis',
  'ddl-tobe',
  'conn-tobe',
  'tobe-bindings',
  'unmapped-cols',
  'asis-unmapped',
];

/**
 * Check id → i18n title key.  PreflightResultPanel が cache に固定された `title` 文字列ではなく
 * id から都度 t(...) で解決できるようにするための写像.  (i18n 文言を変えても再 run なしに反映される.)
 */
const TITLE_KEY_BY_ID: Record<PreflightCheckId, TranslationKey> = {
  'csv-arrived':   'execution.preflight.check.csvArrived.title',
  'ddl-asis':      'execution.preflight.check.ddlAsis.title',
  'ddl-tobe':      'execution.preflight.check.ddlTobe.title',
  'conn-tobe':     'execution.preflight.check.connTobe.title',
  'tobe-bindings': 'execution.preflight.check.tobeBindings.title',
  'unmapped-cols': 'execution.preflight.check.unmappedCols.title',
  'asis-unmapped': 'execution.preflight.check.asisUnmapped.title',
};

export function titleKeyForId(id: PreflightCheckId): TranslationKey {
  return TITLE_KEY_BY_ID[id];
}

export function runPreflight(input: PreflightInput): PreflightCheckResult[] {
  const ctx = buildContext(input);
  return ORDER.map((id) => runOne(id, ctx));
}

export function isAllPass(results: PreflightCheckResult[]): boolean {
  if (results.length === 0) return false;
  return results.every((r) => r.aggregate === 'pass');
}

/* ───────────────────────── Internals ──────────────────────────── */

interface Context extends PreflightInput {
  /** Bindings grouped by tobe physicalName. */
  bindingsByTobe: Map<string, FrozenBinding[]>;
  /** Rules grouped by tobe physicalName. */
  rulesByTobe: Map<string, FrozenRule[]>;
  /** TO-BE DDL row lookup by physicalName. */
  tobeTableByName: Map<string, DdlTableWithColumns>;
  /** AS-IS DDL row lookup by physicalName. */
  asisTableByName: Map<string, DdlTableWithColumns>;
}

function buildContext(input: PreflightInput): Context {
  /* 防御적: BE が null mapping 을 돌려준 케이스에 대비. ensureSnapshotData 가 정상화하지만
     호출자가 직접 null 을 넘긴 경우에도 throw 하지 않도록. */
  const safeData: SnapshotData = input.snapshotData ?? { rules: [], bindings: [], codeMaps: [] };
  const bindingsByTobe = new Map<string, FrozenBinding[]>();
  for (const b of safeData.bindings ?? []) {
    const key = b.tobeTable;
    const arr = bindingsByTobe.get(key) ?? [];
    arr.push(b);
    bindingsByTobe.set(key, arr);
  }
  const rulesByTobe = new Map<string, FrozenRule[]>();
  for (const r of safeData.rules ?? []) {
    const key = r.tobeTable;
    const arr = rulesByTobe.get(key) ?? [];
    arr.push(r);
    rulesByTobe.set(key, arr);
  }
  const tobeTableByName = new Map<string, DdlTableWithColumns>();
  for (const t of input.tobeSchema?.tables ?? []) {
    tobeTableByName.set(t.table.physicalName, t);
  }
  const asisTableByName = new Map<string, DdlTableWithColumns>();
  for (const t of input.asisSchema?.tables ?? []) {
    asisTableByName.set(t.table.physicalName, t);
  }
  return { ...input, snapshotData: safeData, bindingsByTobe, rulesByTobe, tobeTableByName, asisTableByName };
}

/** A FrozenRule "covers" its tobe column if the strategy actually produces a value. */
function ruleProducesValue(r: FrozenRule): boolean {
  if (r.strategy === 'skip') return false;
  if (r.strategy === 'null') return true;
  if (r.strategy === 'default') return true;
  // expression: at least one of asisColumn / transformSql / transformRule must be present
  const hasSrc = (r.asisColumn ?? []).some((c) => !!c && c.trim() !== '');
  const hasSql = !!r.transformSql && r.transformSql.trim() !== '';
  const hasRule = !!r.transformRule && r.transformRule.trim() !== '';
  return hasSrc || hasSql || hasRule;
}

function runOne(id: PreflightCheckId, ctx: Context): PreflightCheckResult {
  switch (id) {
    case 'csv-arrived': return checkCsvArrived(ctx);
    case 'ddl-asis':    return checkDdlAsis(ctx);
    case 'ddl-tobe':    return checkDdlTobe(ctx);
    case 'conn-tobe':   return checkConnTobe(ctx);
    case 'tobe-bindings': return checkTobeBindings(ctx);
    case 'unmapped-cols': return checkUnmappedCols(ctx);
    case 'asis-unmapped': return checkAsisUnmapped(ctx);
  }
}

function checkCsvArrived(ctx: Context): PreflightCheckResult {
  const t = ctx.t;
  const path = ctx.site.csvPath?.trim() ?? '';

  /* path 未設定 → project-wide fail (per-table 表示しない). */
  if (path.length === 0) {
    return {
      id: 'csv-arrived',
      title: t('execution.preflight.check.csvArrived.title'),
      scope: 'project',
      aggregate: 'fail',
      perTable: [{
        table: '*', status: 'fail',
        detailKey: 'execution.preflight.check.csvArrived.failNoPath',
      }],
    };
  }

  /* path 設定済 → per-table 検査. 選択 TO-BE が binding 経由で要求する AS-IS
     테이블의 CSV ファイル存在を確認する. */
  const tables = ctx.selectedTables;
  if (tables.length === 0) {
    return {
      id: 'csv-arrived',
      title: t('execution.preflight.check.csvArrived.title'),
      scope: 'per-table',
      aggregate: 'skip',
      perTable: [],
    };
  }
  const perTable: TableCheckResult[] = tables.map((name) => {
    const bindings = ctx.bindingsByTobe.get(name) ?? [];
    const asisTables = collectAsisTables(bindings);
    if (asisTables.length === 0) {
      return {
        table: name, status: 'skip',
        detailKey: 'execution.preflight.check.csvArrived.skipNoBinding',
      };
    }
    const missing: string[] = [];
    for (const asis of asisTables) {
      const r = ctx.csvFilesByAsisTable[asis];
      if (!r || !r.exists) missing.push(asis);
    }
    return missing.length === 0
      ? {
          table: name, status: 'pass',
          detailKey: 'execution.preflight.check.csvArrived.passOne',
          detailVars: { tables: asisTables.join(', ') },
        }
      : {
          table: name, status: 'fail',
          detailKey: 'execution.preflight.check.csvArrived.failOne',
          detailVars: {
            n: missing.length,
            tables: missing.slice(0, 5).join(', '),
          },
        };
  });
  return {
    id: 'csv-arrived',
    title: t('execution.preflight.check.csvArrived.title'),
    scope: 'per-table',
    aggregate: aggregate(perTable),
    perTable,
    fixIsProjectWide: true,
  };
}

function checkDdlAsis(ctx: Context): PreflightCheckResult {
  const t = ctx.t;
  const n = ctx.asisSchema?.tables.length ?? 0;
  const pass = n > 0;
  return {
    id: 'ddl-asis',
    title: t('execution.preflight.check.ddlAsis.title'),
    scope: 'project',
    aggregate: pass ? 'pass' : 'fail',
    perTable: [{
      table: '*',
      status: pass ? 'pass' : 'fail',
      detailKey: pass
        ? 'execution.preflight.check.ddlAsis.pass'
        : 'execution.preflight.check.ddlAsis.fail',
      detailVars: pass ? { n } : undefined,
    }],
  };
}

function checkDdlTobe(ctx: Context): PreflightCheckResult {
  const t = ctx.t;
  const n = ctx.tobeSchema?.tables.length ?? 0;
  const pass = n > 0;
  return {
    id: 'ddl-tobe',
    title: t('execution.preflight.check.ddlTobe.title'),
    scope: 'project',
    aggregate: pass ? 'pass' : 'fail',
    perTable: [{
      table: '*',
      status: pass ? 'pass' : 'fail',
      detailKey: pass
        ? 'execution.preflight.check.ddlTobe.pass'
        : 'execution.preflight.check.ddlTobe.fail',
      detailVars: pass ? { n } : undefined,
    }],
  };
}

function checkConnTobe(ctx: Context): PreflightCheckResult {
  const t = ctx.t;
  const env = ctx.site.environment;
  const conn = ctx.site.tobeDbByEnv?.[env];
  const fieldsFilled = !!conn
    && !!conn.host && conn.host.trim() !== ''
    && !!conn.database && conn.database.trim() !== ''
    && !!conn.username && conn.username.trim() !== '';

  /* 設定不足 → 接続テスト走らせる前に fail. */
  if (!fieldsFilled) {
    return {
      id: 'conn-tobe',
      title: t('execution.preflight.check.connTobe.title'),
      scope: 'project',
      aggregate: 'fail',
      perTable: [{
        table: '*', status: 'fail',
        detailKey: 'execution.preflight.check.connTobe.failMissing',
        detailVars: { env },
      }],
    };
  }

  /* 設定 OK → 呼び元が事前に走らせた接続テストの結果を見る. */
  const r = ctx.tobeDbReachable;
  if (!r) {
    /* 何らかの理由でテスト未実行 (呼び元の事故). 安全側に fail. */
    return {
      id: 'conn-tobe',
      title: t('execution.preflight.check.connTobe.title'),
      scope: 'project',
      aggregate: 'fail',
      perTable: [{
        table: '*', status: 'fail',
        detailKey: 'execution.preflight.check.connTobe.failUntested',
        detailVars: { env },
      }],
    };
  }
  return {
    id: 'conn-tobe',
    title: t('execution.preflight.check.connTobe.title'),
    scope: 'project',
    aggregate: r.success ? 'pass' : 'fail',
    perTable: [{
      table: '*',
      status: r.success ? 'pass' : 'fail',
      detailKey: r.success
        ? 'execution.preflight.check.connTobe.passConfigured'
        : 'execution.preflight.check.connTobe.failUnreachable',
      detailVars: r.success ? { env } : { env, msg: r.message },
    }],
  };
}

function checkTobeBindings(ctx: Context): PreflightCheckResult {
  const t = ctx.t;
  const tables = ctx.selectedTables;
  const ready = ctx.tobeSchema && ctx.tobeSchema.tables.length > 0;
  if (!ready || tables.length === 0) {
    return {
      id: 'tobe-bindings',
      title: t('execution.preflight.check.tobeBindings.title'),
      scope: 'per-table',
      aggregate: 'skip',
      perTable: [],
    };
  }
  const masterMap = ctx.masterBindingHasSources ?? {};
  const perTable: TableCheckResult[] = tables.map((name) => {
    const bs = ctx.bindingsByTobe.get(name) ?? [];
    // 자식 link binding (sharedFromProjectId 있음) → master project 의 같은 (schema, table)
    // binding 의 sources 확인. master 가 sources 있으면 pass.
    // 자체 정의 binding → 자기 sources 확인.
    const hasReal = bs.some((b) => {
      if (b.sharedFromProjectId) {
        const key = `${b.sharedFromProjectId}|${(b.tobeSchema ?? '').toLowerCase()}|${b.tobeTable.toLowerCase()}`;
        return masterMap[key] === true;
      }
      return (b.sources?.length ?? 0) > 0;
    });
    return hasReal
      ? { table: name, status: 'pass', detailKey: 'execution.preflight.check.tobeBindings.passOne' }
      : { table: name, status: 'fail', detailKey: 'execution.preflight.check.tobeBindings.failOne' };
  });
  return {
    id: 'tobe-bindings',
    title: t('execution.preflight.check.tobeBindings.title'),
    scope: 'per-table',
    aggregate: aggregate(perTable),
    perTable,
  };
}

function checkUnmappedCols(ctx: Context): PreflightCheckResult {
  const t = ctx.t;
  const tables = ctx.selectedTables;
  const ready = ctx.tobeSchema && ctx.tobeSchema.tables.length > 0;
  if (!ready || tables.length === 0) {
    return {
      id: 'unmapped-cols',
      title: t('execution.preflight.check.unmappedCols.title'),
      scope: 'per-table',
      aggregate: 'skip',
      perTable: [],
    };
  }
  const masterRulesMap = ctx.masterRulesByKey ?? {};
  const perTable: TableCheckResult[] = tables.map((name) => {
    const tobeTable = ctx.tobeTableByName.get(name);
    if (!tobeTable) {
      return { table: name, status: 'skip', detailKey: 'execution.preflight.check.unmappedCols.skipNoDdl' };
    }
    /* Mapping UI / Dashboard と同じ規約: 全カラムが mapping 要. ただし strategy='skip'
       の rule がついているカラムは「明示的に除외」なので OK 扱い. */
    // 자식 link binding 이면 master 의 rules 사용. 자체 정의 binding 이면 자기 rules.
    const bs = ctx.bindingsByTobe.get(name) ?? [];
    const linkChild = bs.find((b) => b.sharedFromProjectId);
    let rules: FrozenRule[] = ctx.rulesByTobe.get(name) ?? [];
    if (linkChild) {
      const key = `${linkChild.sharedFromProjectId}|${(linkChild.tobeSchema ?? '').toLowerCase()}|${linkChild.tobeTable.toLowerCase()}`;
      rules = masterRulesMap[key] ?? [];
    }
    const skippedCols = new Set<string>();
    const mappedCols = new Set<string>();
    for (const r of rules) {
      if (r.strategy === 'skip') skippedCols.add(r.tobeColumn);
      else if (ruleProducesValue(r)) mappedCols.add(r.tobeColumn);
    }
    const totalCols = tobeTable.columns.length;
    const missing = tobeTable.columns.filter(
      (c) => !mappedCols.has(c.physicalName) && !skippedCols.has(c.physicalName),
    );
    return missing.length === 0
      ? {
          table: name, status: 'pass',
          detailKey: 'execution.preflight.check.unmappedCols.passOne',
          detailVars: { n: totalCols },
        }
      : {
          table: name,
          status: 'fail',
          detailKey: 'execution.preflight.check.unmappedCols.failOne',
          detailVars: {
            n: missing.length,
            cols: missing.slice(0, 5).map((c) => c.physicalName).join(', '),
          },
        };
  });
  return {
    id: 'unmapped-cols',
    title: t('execution.preflight.check.unmappedCols.title'),
    scope: 'per-table',
    aggregate: aggregate(perTable),
    perTable,
  };
}

function checkAsisUnmapped(ctx: Context): PreflightCheckResult {
  const t = ctx.t;
  const ready = ctx.asisSchema && ctx.asisSchema.tables.length > 0;
  if (!ready) {
    return {
      id: 'asis-unmapped',
      title: t('execution.preflight.check.asisUnmapped.title'),
      scope: 'per-table',
      aggregate: 'skip',
      perTable: [],
    };
  }
  /* AS-IS columns referenced by any rule.  Cross-tobe lookup is fine here —
     a column counts as "used" globally. 자식 link 의 master rules 도 합산. */
  const usedAsisCols = new Set<string>();
  const allRules: FrozenRule[] = [...(ctx.snapshotData.rules ?? [])];
  for (const masterRules of Object.values(ctx.masterRulesByKey ?? {})) {
    allRules.push(...masterRules);
  }
  for (const r of allRules) {
    if (!ruleProducesValue(r)) continue;
    if (!r.asisTable) continue;
    for (const col of r.asisColumn ?? []) {
      if (!col) continue;
      usedAsisCols.add(qualifyAsisCol(r.asisTable, col));
    }
  }

  /* 2026-05-30: scope を 'selectedTables の bindings 経由 AS-IS' から
     'AS-IS DDL に登録された全テーブル' へ変更.  unused AS-IS カラム検出は
     project 全体で行うべき(=selection に依存させない)という方針合わせ. */
  const asisInScope = ctx.asisSchema!.tables.map((tc) => tc.table.physicalName);
  const perTable: TableCheckResult[] = asisInScope.map((asis) => {
    const def = ctx.asisTableByName.get(asis);
    if (!def) {
      return { table: asis, status: 'skip', detailKey: 'execution.preflight.check.asisUnmapped.skipNoBinding' };
    }
    const unusedCols: string[] = [];
    for (const col of def.columns) {
      const key = qualifyAsisCol(asis, col.physicalName);
      if (!usedAsisCols.has(key)) unusedCols.push(col.physicalName);
    }
    return unusedCols.length === 0
      ? { table: asis, status: 'pass', detailKey: 'execution.preflight.check.asisUnmapped.passOne' }
      : {
          table: asis,
          status: 'fail',
          detailKey: 'execution.preflight.check.asisUnmapped.failOne',
          detailVars: {
            n: unusedCols.length,
            cols: unusedCols.slice(0, 5).join(', '),
          },
        };
  });
  return {
    id: 'asis-unmapped',
    title: t('execution.preflight.check.asisUnmapped.title'),
    scope: 'per-table',
    aggregate: aggregate(perTable),
    perTable,
  };
}

/* ───────────────────────── Helpers ────────────────────────────── */

function aggregate(rows: TableCheckResult[]): CheckStatus {
  if (rows.length === 0) return 'skip';
  if (rows.some((r) => r.status === 'fail')) return 'fail';
  if (rows.every((r) => r.status === 'skip')) return 'skip';
  return 'pass';
}

function collectAsisTables(bindings: FrozenBinding[]): string[] {
  const set = new Set<string>();
  for (const b of bindings) {
    for (const s of b.sources ?? []) {
      if (s.asisTable) set.add(s.asisTable);
    }
  }
  return [...set];
}

function qualifyAsisCol(table: string, col: string): string {
  return `${table}.${col}`;
}
