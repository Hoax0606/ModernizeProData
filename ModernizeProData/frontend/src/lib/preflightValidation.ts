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
  detail: string;
}

export interface PreflightCheckResult {
  id: PreflightCheckId;
  title: string;
  /** 'project' rows are not expandable in UI; 'per-table' rows can be expanded. */
  scope: 'project' | 'per-table';
  aggregate: CheckStatus;
  perTable: TableCheckResult[];
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
  const pass = path.length > 0;
  return {
    id: 'csv-arrived',
    title: t('execution.preflight.check.csvArrived.title'),
    scope: 'project',
    aggregate: pass ? 'pass' : 'fail',
    perTable: [{
      table: '*',
      status: pass ? 'pass' : 'fail',
      detail: pass
        ? t('execution.preflight.check.csvArrived.pass')
        : t('execution.preflight.check.csvArrived.failNoPath'),
    }],
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
      detail: pass
        ? t('execution.preflight.check.ddlAsis.pass', { n })
        : t('execution.preflight.check.ddlAsis.fail'),
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
      detail: pass
        ? t('execution.preflight.check.ddlTobe.pass', { n })
        : t('execution.preflight.check.ddlTobe.fail'),
    }],
  };
}

function checkConnTobe(ctx: Context): PreflightCheckResult {
  const t = ctx.t;
  const env = ctx.site.environment;
  const conn = ctx.site.tobeDbByEnv?.[env];
  const ok = !!conn
    && !!conn.host && conn.host.trim() !== ''
    && !!conn.database && conn.database.trim() !== ''
    && !!conn.username && conn.username.trim() !== '';
  return {
    id: 'conn-tobe',
    title: t('execution.preflight.check.connTobe.title'),
    scope: 'project',
    aggregate: ok ? 'pass' : 'fail',
    perTable: [{
      table: '*',
      status: ok ? 'pass' : 'fail',
      detail: ok
        ? t('execution.preflight.check.connTobe.passConfigured', { env })
        : t('execution.preflight.check.connTobe.failMissing', { env }),
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
  const perTable: TableCheckResult[] = tables.map((name) => {
    const bs = ctx.bindingsByTobe.get(name) ?? [];
    const hasReal = bs.some((b) => (b.sources?.length ?? 0) > 0);
    return hasReal
      ? { table: name, status: 'pass', detail: t('execution.preflight.check.tobeBindings.passOne') }
      : { table: name, status: 'fail', detail: t('execution.preflight.check.tobeBindings.failOne') };
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
  const perTable: TableCheckResult[] = tables.map((name) => {
    const tobeTable = ctx.tobeTableByName.get(name);
    if (!tobeTable) {
      return { table: name, status: 'skip', detail: t('execution.preflight.check.unmappedCols.skipNoDdl') };
    }
    /* Mapping UI / Dashboard と同じ規約: 全カラムが mapping 要. ただし strategy='skip'
       の rule がついているカラムは「明示的に除外」なので OK 扱い. */
    const rules = ctx.rulesByTobe.get(name) ?? [];
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
      ? { table: name, status: 'pass', detail: t('execution.preflight.check.unmappedCols.passOne', { n: totalCols }) }
      : {
          table: name,
          status: 'fail',
          detail: t('execution.preflight.check.unmappedCols.failOne', {
            n: missing.length,
            cols: missing.slice(0, 5).map((c) => c.physicalName).join(', '),
          }),
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
  const tables = ctx.selectedTables;
  const ready = ctx.tobeSchema && ctx.tobeSchema.tables.length > 0
    && ctx.asisSchema && ctx.asisSchema.tables.length > 0;
  if (!ready || tables.length === 0) {
    return {
      id: 'asis-unmapped',
      title: t('execution.preflight.check.asisUnmapped.title'),
      scope: 'per-table',
      aggregate: 'skip',
      perTable: [],
    };
  }
  /* AS-IS columns referenced by any rule.  Cross-tobe lookup is fine here —
     a column counts as "used" globally. */
  const usedAsisCols = new Set<string>();
  for (const r of ctx.snapshotData.rules ?? []) {
    if (!ruleProducesValue(r)) continue;
    if (!r.asisTable) continue;
    for (const col of r.asisColumn ?? []) {
      if (!col) continue;
      usedAsisCols.add(qualifyAsisCol(r.asisTable, col));
    }
  }

  const perTable: TableCheckResult[] = tables.map((name) => {
    const bindings = ctx.bindingsByTobe.get(name) ?? [];
    const asisTables = collectAsisTables(bindings);
    if (asisTables.length === 0) {
      return { table: name, status: 'skip', detail: t('execution.preflight.check.asisUnmapped.skipNoBinding') };
    }
    const unused: string[] = [];
    for (const asis of asisTables) {
      const def = ctx.asisTableByName.get(asis);
      if (!def) continue;
      for (const col of def.columns) {
        const key = qualifyAsisCol(asis, col.physicalName);
        if (!usedAsisCols.has(key)) unused.push(`${asis}.${col.physicalName}`);
      }
    }
    return unused.length === 0
      ? { table: name, status: 'pass', detail: t('execution.preflight.check.asisUnmapped.passOne') }
      : {
          table: name,
          status: 'fail',
          detail: t('execution.preflight.check.asisUnmapped.failOne', {
            n: unused.length,
            cols: unused.slice(0, 5).join(', '),
          }),
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
