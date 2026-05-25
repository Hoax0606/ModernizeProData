import type { Project, Site } from '../store/workspace';
import type { DdlColumn, DdlImport, DdlSchema, DdlTable } from '../api/asisDdl';

/**
 * `?demo=preflight` URL 진입 시 store 에 inject 되는 가짜 사이트/프로젝트/스키마.
 *
 * 목적: ExecutionPage 의 Pre-flight 패널(P1) + Fix → MappingPage 컬럼 pulse(P3) +
 * /settings DDL 섹션 강조 + /site/approvals 진입까지 전체 흐름을 사용자가 직접
 * 실 데이터를 등록하지 않아도 검증할 수 있게 한다.
 *
 * 주입 / 제거는 `AppShell` 의 useEffect 한 곳에서 담당.
 * 가짜 id 는 모두 `demo-` prefix — 사용자 실 데이터와 충돌 가능성 0.
 */

const NOW = '2026-05-23T00:00:00Z';

export const DEMO_SITE_ID = 'demo-site-preflight';
export const DEMO_PROJECT_ID = 'demo-project-preflight';

export const DEMO_SITE: Site = {
  id: DEMO_SITE_ID,
  name: 'Demo bank · pre-flight tour',
  asisEnv: 'mainframe',
  tobeEnv: 'on-prem',
  asisEncoding: 'shift_jis',
  tobeEncoding: 'utf-8',
  csvPath: 'C:\\demo\\incoming',
  asisDbType: 'Oracle',
  asisDbVersion: '11g R2',
  notes: 'Demo site — populated automatically when the URL has ?demo=preflight.',
  environment: 'test',
  tobeDbByEnv: {
    test: {
      type: 'PostgreSQL',
      version: '16',
      host: 'demo-db.internal',
      port: '5432',
      database: 'demo_target',
      username: 'demo_app',
      password: '••••••••',
    },
  },
  tobeDbLocks: { test: true },
  createdBy: 'demo',
  createdAt: NOW,
};

export const DEMO_PROJECT: Project = {
  id: DEMO_PROJECT_ID,
  siteId: DEMO_SITE_ID,
  name: 'Customer ledger migration (demo)',
  phase: 'test',
  tableCount: 3,
  tobeTableCount: 3,
  ddlFiles: [],
  owner: 'demo',
  assignee: 'demo',
  executionAssignee: 'demo',
  createdAt: NOW,
};

/* ── DDL fixture helpers ───────────────────────────────────── */

function mkColumn(
  tableId: string,
  ordinal: number,
  physicalName: string,
  dataTypeRaw: string,
  opts: { pk?: number; nullable?: boolean; logical?: string } = {},
): DdlColumn {
  return {
    id: `${tableId}-col-${ordinal}`,
    tableId,
    ordinal,
    physicalName,
    logicalName: opts.logical ?? null,
    dataTypeRaw,
    dataType: dataTypeRaw.replace(/\(.*\)/, '').trim(),
    length: null,
    precision: null,
    scale: null,
    nullable: opts.nullable ?? true,
    pkOrder: opts.pk ?? null,
    defaultValue: null,
    columnComment: null,
  };
}

function mkTable(
  projectId: string,
  side: 'asis' | 'tobe',
  importId: string,
  ordinal: number,
  schemaName: string,
  physicalName: string,
  logicalName: string,
): DdlTable {
  return {
    id: `${projectId}-${side}-tbl-${ordinal}`,
    projectId,
    side,
    importId,
    schemaName,
    physicalName,
    logicalName,
    tableComment: null,
    ordinal,
  };
}

function mkImport(side: 'asis' | 'tobe', tableCount: number, columnCount: number): DdlImport {
  return {
    id: `${DEMO_PROJECT_ID}-${side}-import`,
    projectId: DEMO_PROJECT_ID,
    side,
    filename: `demo-${side}.sql`,
    fileSize: 4096,
    fileHash: 'demo-hash',
    dialect: side === 'asis' ? 'oracle' : 'postgresql',
    status: 'COMPLETED',
    tableCount,
    columnCount,
    importedBy: 'demo',
    importedAt: NOW,
  };
}

/* ── AS-IS schema (Oracle-style) — 3 tables ───────────────── */

const ASIS_CUSTOMER = mkTable(DEMO_PROJECT_ID, 'asis', `${DEMO_PROJECT_ID}-asis-import`, 1, 'LEGACY', 'CUSTOMER_M', '고객 마스터');
const ASIS_ACCOUNT  = mkTable(DEMO_PROJECT_ID, 'asis', `${DEMO_PROJECT_ID}-asis-import`, 2, 'LEGACY', 'ACCOUNT_M',  '계좌 마스터');
const ASIS_TXN      = mkTable(DEMO_PROJECT_ID, 'asis', `${DEMO_PROJECT_ID}-asis-import`, 3, 'LEGACY', 'TXN_HIST',   '거래 이력');

export const DEMO_ASIS_SCHEMA: DdlSchema = {
  latestImport: mkImport('asis', 3, 18),
  tables: [
    {
      table: ASIS_CUSTOMER,
      columns: [
        mkColumn(ASIS_CUSTOMER.id, 1, 'CUST_ID',     'NUMBER(10)',     { pk: 1, nullable: false }),
        mkColumn(ASIS_CUSTOMER.id, 2, 'CUST_NAME',   'VARCHAR2(60)'),
        mkColumn(ASIS_CUSTOMER.id, 3, 'BIRTH_YMD',   'CHAR(8)'),
        mkColumn(ASIS_CUSTOMER.id, 4, 'JOIN_DT',     'DATE'),
        mkColumn(ASIS_CUSTOMER.id, 5, 'STATUS_CD',   'CHAR(1)'),
      ],
    },
    {
      table: ASIS_ACCOUNT,
      columns: [
        mkColumn(ASIS_ACCOUNT.id, 1, 'ACCT_ID',  'NUMBER(12)',     { pk: 1, nullable: false }),
        mkColumn(ASIS_ACCOUNT.id, 2, 'CUST_ID',  'NUMBER(10)',     { nullable: false }),
        mkColumn(ASIS_ACCOUNT.id, 3, 'BALANCE',  'NUMBER(15,2)'),
        mkColumn(ASIS_ACCOUNT.id, 4, 'OPEN_DT',  'DATE'),
        mkColumn(ASIS_ACCOUNT.id, 5, 'CLOSE_DT', 'DATE'),
      ],
    },
    {
      table: ASIS_TXN,
      columns: [
        mkColumn(ASIS_TXN.id, 1, 'TXN_ID',     'NUMBER(18)',  { pk: 1, nullable: false }),
        mkColumn(ASIS_TXN.id, 2, 'ACCT_ID',    'NUMBER(12)',  { nullable: false }),
        mkColumn(ASIS_TXN.id, 3, 'TXN_AMT',    'NUMBER(15,2)'),
        mkColumn(ASIS_TXN.id, 4, 'TXN_TYPE',   'CHAR(2)'),
        mkColumn(ASIS_TXN.id, 5, 'TXN_TS',     'TIMESTAMP'),
        mkColumn(ASIS_TXN.id, 6, 'MEMO',       'VARCHAR2(120)'),
        mkColumn(ASIS_TXN.id, 7, 'RAW_SALARY', 'VARCHAR2(20)'),
        mkColumn(ASIS_TXN.id, 8, 'ERA_DATE',   'VARCHAR2(20)'),
      ],
    },
  ],
};

/* ── TO-BE schema (PostgreSQL-style) — 3 tables ───────────── */

const TOBE_CUSTOMER = mkTable(DEMO_PROJECT_ID, 'tobe', `${DEMO_PROJECT_ID}-tobe-import`, 1, 'public', 'customer', 'customer');
const TOBE_ACCOUNT  = mkTable(DEMO_PROJECT_ID, 'tobe', `${DEMO_PROJECT_ID}-tobe-import`, 2, 'public', 'account',  'account');
const TOBE_LEDGER   = mkTable(DEMO_PROJECT_ID, 'tobe', `${DEMO_PROJECT_ID}-tobe-import`, 3, 'public', 'ledger',   'ledger');

export const DEMO_TOBE_SCHEMA: DdlSchema = {
  latestImport: mkImport('tobe', 3, 17),
  tables: [
    {
      table: TOBE_CUSTOMER,
      columns: [
        mkColumn(TOBE_CUSTOMER.id, 1, 'customer_id',  'BIGINT',       { pk: 1, nullable: false }),
        mkColumn(TOBE_CUSTOMER.id, 2, 'full_name',    'VARCHAR(80)',  { nullable: false }),
        mkColumn(TOBE_CUSTOMER.id, 3, 'birth_date',   'DATE'),
        mkColumn(TOBE_CUSTOMER.id, 4, 'joined_at',    'TIMESTAMP'),
        mkColumn(TOBE_CUSTOMER.id, 5, 'status',       'VARCHAR(1)'),
      ],
    },
    {
      table: TOBE_ACCOUNT,
      columns: [
        mkColumn(TOBE_ACCOUNT.id, 1, 'account_id',  'BIGINT',         { pk: 1, nullable: false }),
        mkColumn(TOBE_ACCOUNT.id, 2, 'customer_id', 'BIGINT',         { nullable: false }),
        mkColumn(TOBE_ACCOUNT.id, 3, 'balance',     'NUMERIC(15,2)'),
        mkColumn(TOBE_ACCOUNT.id, 4, 'opened_at',   'TIMESTAMP'),
        mkColumn(TOBE_ACCOUNT.id, 5, 'closed_at',   'TIMESTAMP'),
      ],
    },
    {
      table: TOBE_LEDGER,
      columns: [
        mkColumn(TOBE_LEDGER.id, 1, 'ledger_id',    'BIGINT',         { pk: 1, nullable: false }),
        mkColumn(TOBE_LEDGER.id, 2, 'account_id',   'BIGINT',         { nullable: false }),
        mkColumn(TOBE_LEDGER.id, 3, 'amount',       'NUMERIC(15,2)'),
        mkColumn(TOBE_LEDGER.id, 4, 'kind',         'VARCHAR(2)'),
        mkColumn(TOBE_LEDGER.id, 5, 'posted_at',    'TIMESTAMP'),
        mkColumn(TOBE_LEDGER.id, 6, 'memo',         'VARCHAR(120)'),
        mkColumn(TOBE_LEDGER.id, 7, 'salary_value', 'NUMERIC(12,2)'),
      ],
    },
  ],
};

/** demo projectId 식별 — fetch effects 에서 자동 fetch 를 건너뛸 때 사용. */
export function isDemoProjectId(projectId: string | null | undefined): boolean {
  return projectId === DEMO_PROJECT_ID;
}
