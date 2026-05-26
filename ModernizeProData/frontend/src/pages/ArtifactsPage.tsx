import { useState, useMemo } from 'react';
import ExcelJS from 'exceljs';
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
     내부 key 는 'diff' 그대로 유지 (코드 전반의 SHEETS.diff / MOCK_ROWS.diff / 등이 참조). */
  { key: 'diff',       labelKey: 'artifacts.cat.mapping',    suffix: '.map.xlsx',       icon: '◨', downloadType: 'xlsx' },
  { key: 'ddl',        labelKey: 'artifacts.cat.ddl',        suffix: '.ddl.sql',        icon: '▤', single: true, viewType: 'sql' },
  { key: 'sql',        labelKey: 'artifacts.cat.sql',        suffix: '.migrate.xlsx',   icon: '↦', downloadType: 'xlsx' },
  { key: 'validation', labelKey: 'artifacts.cat.validation', suffix: '.report.xlsx',    icon: '✓', downloadType: 'xlsx' },
];

/* 수식 입력줄에 보일 카테고리별 placeholder 텍스트.
   `{key}` 형식의 placeholder 는 ExcelWorkbook 의 ctx 값으로 치환된다. */
const SUMMARY_PLACEHOLDER: Record<CategoryKey, string> = {
  dashboard:  'Dashboard snapshot · {n} tables · {progress}% migrated',
  diff:       'Schema diff: {ASIS} → {TOBE} · {changed} changed',
  ddl:        'DDL: {table} · {n} columns · {pk} primary key',
  sql:        'Migration SQL: {ASIS} → {TOBE} · {n} lines',
  validation: 'Validation report · {table} · {n} checks',
};

/* 카테고리 × 시트 별 placeholder 스키마.
   시트 탭을 클릭하면 ExcelWorkbook 이 해당 시트의 columns 로 그리드를 다시 렌더한다.
   실제 산출물 데이터가 들어오면 columns 옆에 rows 데이터만 추가하면 된다. */
interface SheetSchema {
  name: string;
  columns: { name: string; type: string }[];
  /** true 면 컬럼명/타입 헤더 행 (1행/2행) 을 생략하고 데이터를 row 1 부터 시작.
   *  Validation Overview 처럼 free-form 레이아웃에서 사용 — 헤더는 데이터 안에 inline. */
  freeForm?: boolean;
}

const SHEETS: Record<CategoryKey, SheetSchema[]> = {
  dashboard: [
    { name: 'Overview', columns: [
      { name: 'Item',  type: 'TEXT' },
      { name: 'Value', type: 'TEXT' },
      { name: 'Unit',  type: 'TEXT' },
      { name: 'Note',  type: 'TEXT' },
    ]},
    { name: 'Tables', columns: [
      { name: 'Table',       type: 'VARCHAR' },
      { name: 'Schema',      type: 'VARCHAR' },
      { name: 'Rows',        type: 'BIGINT' },
      { name: 'Migrated',    type: 'BIGINT' },
      { name: 'Progress %',  type: 'DECIMAL' },
      { name: 'Rules',       type: 'INT' },
      { name: 'Issues',      type: 'INT' },
      { name: 'Status',      type: 'ENUM' },
      { name: 'Last update', type: 'TIMESTAMP' },
    ]},
    { name: 'Issues', columns: [
      { name: 'Table',  type: 'VARCHAR' },
      { name: 'Status', type: 'ENUM' },
      { name: 'Issues', type: 'INT' },
      { name: 'Note',   type: 'TEXT' },
    ]},
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
     시트 이름이 곧 AS-IS / TO-BE 스크립트 선택 키 (DDL_SCRIPTS 참조). */
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
  ],
};

/* ───────────────────────────────────────────────────────────────
   Mock data — 실제 산출물 데이터가 없을 때 데모용으로 사용.
   실데이터 wiring 이 완료되면 MOCK_ROWS / MOCK_FORMULA_CTX 와
   ExcelWorkbook 안의 mock 참조를 제거하면 된다.
   ─────────────────────────────────────────────────────────────── */

type Cell = string | number | boolean | null;

const MOCK_ROWS: Record<CategoryKey, Record<string, Cell[][]>> = {
  dashboard: {
    Overview: [
      ['Dashboard snapshot', null, null, null],
      ['Captured', '2026-04-21 09:41 JST', null, null],
      ['Run',      'run-2026-0421-0914',  null, null],
      ['Author',   'KS Info System',       null, null],
      ['Metric',           'Value',         'Unit',    'Note'],
      ['Tables',           18,              'count',   '10 complete / 5 active'],
      ['Rows total',       '1,555,760,862', 'rows',    'all selected tables'],
      ['Rows migrated',    '509,883,778',   'rows',    '32.77% overall'],
      ['Overall progress', '32.77%',        'percent', 'sum of done ÷ sum of rows'],
      ['Mapping rules',    574,             'count',   'applied across tables'],
      ['Open issues',      7,               'count',   'see Issues sheet'],
    ],
    Tables: [
      ['ACCT_MASTER',       'PROD_LEG', 38_400_000,  38_400_000,  '100%',   42, 0, 'done',    '2026-04-20 22:14'],
      ['TXN_JOURNAL_2023',  'PROD_LEG', 220_510_000, 120_400_000, '54.60%', 68, 2, 'running', '2026-04-21 09:30'],
      ['TXN_JOURNAL_2024',  'PROD_LEG', 185_300_000, 120_400_000, '64.97%', 68, 0, 'running', '2026-04-21 09:30'],
      ['CUST_PROFILE',      'PROD_LEG', 4_250_000,   4_250_000,   '100%',   35, 0, 'done',    '2026-04-20 22:14'],
      ['KYC_DOCUMENT',      'PROD_LEG', 890_000,     0,           '0%',     24, 1, 'blocked', '2026-04-19 14:00'],
      ['LOAN_APPLICATION',  'PROD_LEG', 2_300_000,   2_300_000,   '100%',   48, 0, 'done',    '2026-04-20 22:14'],
      ['LOAN_DISBURSEMENT', 'PROD_LEG', 1_800_000,   1_100_000,   '61.11%', 41, 0, 'running', '2026-04-21 09:35'],
      ['LOAN_REPAYMENT',    'PROD_LEG', 15_400_000,  8_900_000,   '57.79%', 56, 0, 'running', '2026-04-21 09:35'],
      ['CARD_MASTER',       'PROD_LEG', 3_200_000,   3_200_000,   '100%',   32, 0, 'done',    '2026-04-20 22:14'],
      ['CARD_AUTH_LOG',     'PROD_LEG', 450_000_000, 280_500_000, '62.33%', 29, 0, 'running', '2026-04-21 09:30'],
      ['FX_RATE_DAILY',     'PROD_LEG', 450_000,     450_000,     '100%',   18, 0, 'done',    '2026-04-20 22:14'],
      ['FX_POSITION',       'PROD_LEG', 120_000,     120_000,     '100%',   25, 0, 'done',    '2026-04-20 22:14'],
      ['GL_ENTRY',          'PROD_LEG', 608_220_862, 140_393_778, '23.08%', 88, 4, 'warn',    '2026-04-21 09:35'],
    ],
    Issues: [
      ['TXN_JOURNAL_2023', 'running', 2, 'see logs for detail'],
      ['KYC_DOCUMENT',     'blocked', 1, 'migration halted — needs triage'],
      ['GL_ENTRY',         'warn',    4, 'encoded with warnings'],
    ],
  },
  /* diff/validation 은 child 테이블 별로 다른 데이터를 가져야 해서 별도 상수 MOCK_ROWS_BY_TABLE 로 분리.
     여기서는 비워둠 — lookup 이 MOCK_ROWS_BY_TABLE 를 먼저 본다. */
  diff: {},
  /* ddl 은 SQL 뷰 — grid 데이터가 아니라 DDL_SCRIPTS 의 SQL 문자열을 사용. */
  ddl: {},
  sql: {
    'Migration SQL': [
      [1, 'CREATE',       'm_user',  'CREATE TABLE m_user (id BIGINT PRIMARY KEY, ...)',  true,  '2026-05-23 14:30:00'],
      [2, 'INSERT',       'm_user',  'INSERT INTO m_user SELECT ... FROM legacy_user',    true,  '2026-05-23 14:30:15'],
      [3, 'ALTER',        'm_order', 'ALTER TABLE m_order ADD COLUMN status VARCHAR(20)', true,  '2026-05-23 14:31:02'],
      [4, 'INSERT',       'm_order', 'INSERT INTO m_order SELECT ... FROM legacy_order',  false, null],
      [5, 'CREATE INDEX', 'm_user',  'CREATE INDEX idx_user_email ON m_user(email)',      false, null],
    ],
  },
  /* validation 은 child 테이블 별로 다른 데이터 — MOCK_ROWS_BY_TABLE 로 분리. */
  validation: {},
};

/* ───────────────────────────────────────────────────────────────
   MOCK_ROWS_BY_TABLE — diff/validation 의 child 테이블별 mock 데이터.
   사이드바에서 테이블을 바꾸면 각 sheet 의 행이 바뀌어서, 어떤 항목이 변하는지
   바로 보인다. 실데이터 wiring 시 이 자리를 백엔드 응답으로 교체.
   ─────────────────────────────────────────────────────────────── */
const MOCK_ROWS_BY_TABLE: Record<'diff' | 'validation', Record<string, Record<string, Cell[][]>>> = {
  diff: {
    acct_master: {
      Diff: [
        ['typed',     'ACCT_MASTER', 'ACCT_ID',     'VARCHAR2(20)',  'NO',  'account_id',     'VARCHAR(20)',   'NO',  'rename + lower'],
        ['typed',     'ACCT_MASTER', 'BAL_AMT',     'NUMBER(15,2)',  'NO',  'balance_amount', 'NUMERIC(15,2)', 'NO',  'cast NUMBER → NUMERIC'],
        ['typed',     'ACCT_MASTER', 'KYC_LV',      'NUMBER(2)',     'NO',  'kyc_level',      'SMALLINT',      'NO',  'cast NUMBER(2) → SMALLINT'],
        ['typed',     'ACCT_MASTER', 'AML_FLG',     'CHAR(1)',       'NO',  'aml_flag',       'BOOLEAN',       'NO',  "case 'Y'/'N' → BOOLEAN"],
        ['unchanged', 'ACCT_MASTER', 'CUST_ID',     'VARCHAR2(20)',  'NO',  'customer_id',    'VARCHAR(20)',   'NO',  'rename'],
        ['unchanged', 'ACCT_MASTER', 'BRANCH_CD',   'CHAR(3)',       'NO',  'branch_code',    'CHAR(3)',       'NO',  'rename'],
        ['unchanged', 'ACCT_MASTER', 'STATUS',      'VARCHAR2(8)',   'NO',  'status',         'VARCHAR(8)',    'NO',  'rename'],
        ['added',     'ACCT_MASTER', null,          null,            null,  'tenant_id',      'VARCHAR(8)',    'NO',  "default 'T01'"],
      ],
      Summary: [
        ['Schema diff summary', null, null, null],
        ['ASIS table',     'CORE_ACCT_MASTER', null, null],
        ['TOBE table',     'public.account',   null, null],
        ['ASIS columns',   17,                 null, null],
        ['TOBE columns',   18,                 null, null],
        ['Kind',           'Count', '% of TOBE', 'Note'],
        ['+ added',        1,       '5.56%',     'tenant_id'],
        ['→ renamed',      4,       '22.22%',    'ACCT_ID, CUST_ID, BRANCH_CD, STATUS'],
        ['~ typed',        2,       '11.11%',    'BAL_AMT, KYC_LV (cast)'],
        ['unchanged',      13,      '72.22%',    null],
      ],
    },
    cust_profile: {
      Diff: [
        ['renamed',   'CUST_PROFILE', 'CUST_NM',    'VARCHAR2(120)', 'NO',  'customer_name', 'VARCHAR(120)', 'NO',  'rename'],
        ['renamed',   'CUST_PROFILE', 'BIRTH_DT',   'DATE',          'YES', 'birth_date',    'DATE',         'YES', 'rename'],
        ['renamed',   'CUST_PROFILE', 'EMAIL',      'VARCHAR2(120)', 'YES', 'email',         'VARCHAR(120)', 'YES', 'rename'],
        ['renamed',   'CUST_PROFILE', 'ADDR_LINE1', 'VARCHAR2(200)', 'YES', 'address_line1', 'VARCHAR(200)', 'YES', 'rename'],
        ['renamed',   'CUST_PROFILE', 'ADDR_LINE2', 'VARCHAR2(200)', 'YES', 'address_line2', 'VARCHAR(200)', 'YES', 'rename'],
        ['renamed',   'CUST_PROFILE', 'CITY_CD',    'VARCHAR2(8)',   'YES', 'city_code',     'VARCHAR(8)',   'YES', 'rename'],
        ['unchanged', 'CUST_PROFILE', 'CUST_ID',    'VARCHAR2(20)',  'NO',  'CUST_ID',       'VARCHAR(20)',  'NO',  ''],
        ['unchanged', 'CUST_PROFILE', 'GENDER',     'CHAR(1)',       'YES', 'GENDER',        'CHAR(1)',      'YES', ''],
        ['unchanged', 'CUST_PROFILE', 'PHONE',      'VARCHAR2(20)',  'YES', 'PHONE',         'VARCHAR(20)',  'YES', ''],
        ['unchanged', 'CUST_PROFILE', 'STATUS',     'VARCHAR2(8)',   'NO',  'STATUS',        'VARCHAR(8)',   'NO',  ''],
        ['unchanged', 'CUST_PROFILE', 'CREATED_AT', 'TIMESTAMP',     'NO',  'CREATED_AT',    'TIMESTAMP',    'NO',  ''],
      ],
      Summary: [
        ['Schema diff summary', null, null, null],
        ['ASIS table',     'CORE_CUST_PROFILE', null, null],
        ['TOBE table',     'public.customer',   null, null],
        ['ASIS columns',   11,                  null, null],
        ['TOBE columns',   11,                  null, null],
        ['Kind',           'Count', '% of TOBE', 'Note'],
        ['→ renamed',      6,       '54.55%',    'CUST_NM, BIRTH_DT, EMAIL, ADDR_LINE1, ADDR_LINE2, CITY_CD'],
        ['unchanged',      5,       '45.45%',    'CUST_ID, GENDER, PHONE, STATUS, CREATED_AT'],
      ],
    },
    txn_journal_2024: {
      Diff: [
        ['unchanged', 'TXN_JOURNAL_2024', 'TXN_ID',       'VARCHAR(32)',    'NO',  'TXN_ID',        'VARCHAR(32)',    'NO',  ''],
        ['typed',     'TXN_JOURNAL_2024', 'ACCT_ID',      'VARCHAR(20)',    'NO',  'account_id',    'VARCHAR(20)',    'NO',  'rename + lower'],
        ['typed',     'TXN_JOURNAL_2024', 'AMT',          'NUMBER(15,2)',   'NO',  'amount',        'NUMERIC(18,2)',  'NO',  'cast NUMBER → NUMERIC'],
        ['removed',   'TXN_JOURNAL_2024', 'BAL_AMT',      'NUMBER(15,2)',   'NO',  null,            null,             null,  'DROP'],
        ['typed',     'TXN_JOURNAL_2024', 'EXEC_TM',      'DATE',           'NO',  'executed_at',   'TIMESTAMP',      'NO',  'cast DATE → TIMESTAMP'],
        ['typed',     'TXN_JOURNAL_2024', 'BR_ID',        'VARCHAR(8)',     'NO',  'branch_id',     'VARCHAR(8)',     'NO',  'rename'],
        ['unchanged', 'TXN_JOURNAL_2024', 'OPR_ID',       'VARCHAR(12)',    'YES', 'OPR_ID',        'VARCHAR(12)',    'YES', ''],
        ['typed',     'TXN_JOURNAL_2024', 'CHANNEL_CD',   'CHAR(3)',        'NO',  'channel_code',  'VARCHAR(8)',     'NO',  'widen + rename'],
        ['unchanged', 'TXN_JOURNAL_2024', 'MEMO',         'VARCHAR(255)',   'YES', 'MEMO',          'VARCHAR(255)',   'YES', ''],
        ['unchanged', 'TXN_JOURNAL_2024', 'REF_NO',       'VARCHAR(40)',    'YES', 'reference_no',  'VARCHAR(40)',    'YES', 'rename'],
        ['unchanged', 'TXN_JOURNAL_2024', 'CURRENCY_CD',  'CHAR(3)',        'NO',  'currency_code', 'CHAR(3)',        'NO',  'rename'],
        ['unchanged', 'TXN_JOURNAL_2024', 'STATUS',       'VARCHAR(8)',     'NO',  'status',        'VARCHAR(8)',     'NO',  'rename'],
        ['added',     'TXN_JOURNAL_2024', null,           null,             null,  'tenant_id',     'VARCHAR(8)',     'NO',  "default 'T01'"],
      ],
      Summary: [
        ['Schema diff summary', null, null, null],
        ['ASIS table',     'CORE_TXN_JOURNAL_2024',   null, null],
        ['TOBE table',     'public.transaction_2024', null, null],
        ['ASIS columns',   11,                        null, null],
        ['TOBE columns',   12,                        null, null],
        ['Kind',           'Count', '% of TOBE', 'Note'],
        ['+ added',        1,       '8.33%',     'tenant_id'],
        ['- removed',      1,       '',          'BAL_AMT'],
        ['~ typed',        5,       '41.67%',    'ACCT_ID, AMT, EXEC_TM, BR_ID, CHANNEL_CD'],
        ['unchanged',      6,       '50%',       null],
      ],
    },
    transaction_unified: {
      Diff: [
        ['typed',     'TRANSACTION_UNIFIED', 'TXN_ID',    'VARCHAR(32)',   'NO',  'transaction_id', 'VARCHAR(32)',   'NO',  'union 2023∪2024 + rename'],
        ['typed',     'TRANSACTION_UNIFIED', 'ACCT_ID',   'VARCHAR(20)',   'NO',  'account_id',     'VARCHAR(20)',   'NO',  'rename'],
        ['typed',     'TRANSACTION_UNIFIED', 'AMT',       'NUMBER(18,2)',  'NO',  'amount',         'NUMERIC(18,2)', 'NO',  'cast NUMBER → NUMERIC'],
        ['removed',   'TRANSACTION_UNIFIED', 'BAL_AMT',   'NUMBER(15,2)',  'NO',  null,             null,            null,  'DROP (not in 2024 schema)'],
        ['typed',     'TRANSACTION_UNIFIED', 'EXEC_TM',   'DATE',          'NO',  'transaction_at', 'TIMESTAMP',     'NO',  'cast DATE → TIMESTAMP'],
        ['typed',     'TRANSACTION_UNIFIED', 'BR_ID',     'VARCHAR(8)',    'NO',  'branch_id',      'VARCHAR(8)',    'NO',  'rename'],
        ['unchanged', 'TRANSACTION_UNIFIED', 'REF_NO',    'VARCHAR(40)',   'YES', 'reference_no',   'VARCHAR(40)',   'YES', 'rename'],
        ['unchanged', 'TRANSACTION_UNIFIED', 'STATUS',    'VARCHAR(8)',    'NO',  'status',         'VARCHAR(8)',    'NO',  'rename'],
        ['added',     'TRANSACTION_UNIFIED', null,        null,            null,  'source_year',    'SMALLINT',      'NO',  'from source table name (2023|2024)'],
      ],
      Summary: [
        ['Schema diff summary', null, null, null],
        ['ASIS table',     'CORE_TXN_JOURNAL_2023 ∪ CORE_TXN_JOURNAL_2024', null, null],
        ['TOBE table',     'public.transaction',                            null, null],
        ['ASIS columns',   9,    null, null],
        ['TOBE columns',   10,   null, null],
        ['Kind',           'Count', '% of TOBE', 'Note'],
        ['+ added',        1,       '10.00%',    'source_year'],
        ['- removed',      1,       '',          'BAL_AMT (2023 only)'],
        ['~ typed',        5,       '50.00%',    'TXN_ID, ACCT_ID, AMT, EXEC_TM, BR_ID'],
        ['unchanged',      4,       '40.00%',    null],
      ],
    },
    loan: {
      Diff: [
        ['unchanged', 'LOAN', 'LOAN_ID',   'VARCHAR2(20)', 'NO',  'LOAN_ID',       'VARCHAR(20)',   'NO', ''],
        ['renamed',   'LOAN', 'CUST_ID',   'VARCHAR2(20)', 'NO',  'customer_id',   'VARCHAR(20)',   'NO', 'rename'],
        ['unchanged', 'LOAN', 'PRINCIPAL', 'NUMBER(15,2)', 'NO',  'principal',     'NUMERIC(15,2)', 'NO', 'rename'],
        ['typed',     'LOAN', 'INT_RATE',  'NUMBER(5,3)',  'NO',  'interest_rate', 'NUMERIC(5,3)',  'NO', 'rename + cast'],
        ['renamed',   'LOAN', 'TERM_M',    'NUMBER(3)',    'NO',  'term_months',   'SMALLINT',      'NO', 'rename + cast'],
        ['renamed',   'LOAN', 'ISSUE_DT',  'DATE',         'NO',  'issued_at',     'DATE',          'NO', 'rename'],
        ['unchanged', 'LOAN', 'STATUS',    'VARCHAR2(8)',  'NO',  'status',        'VARCHAR(8)',    'NO', 'rename'],
      ],
      Summary: [
        ['Schema diff summary', null, null, null],
        ['ASIS table',     'CORE_LOAN',   null, null],
        ['TOBE table',     'public.loan', null, null],
        ['ASIS columns',   7,             null, null],
        ['TOBE columns',   7,             null, null],
        ['Kind',           'Count', '% of TOBE', 'Note'],
        ['→ renamed',      3,       '42.86%',    'CUST_ID, TERM_M, ISSUE_DT'],
        ['~ typed',        1,       '14.29%',    'INT_RATE'],
        ['unchanged',      3,       '42.86%',    'LOAN_ID, PRINCIPAL, STATUS'],
      ],
    },
    card: {
      Diff: [
        ['renamed',   'CARD', 'CARD_NO',   'VARCHAR2(16)', 'NO', 'card_number', 'VARCHAR(16)', 'NO', 'rename'],
        ['renamed',   'CARD', 'CUST_ID',   'VARCHAR2(20)', 'NO', 'customer_id', 'VARCHAR(20)', 'NO', 'rename'],
        ['renamed',   'CARD', 'CARD_TYPE', 'VARCHAR2(8)',  'NO', 'card_type',   'VARCHAR(8)',  'NO', 'rename'],
        ['unchanged', 'CARD', 'ISSUE_DT',  'DATE',         'NO', 'issued_at',   'DATE',        'NO', 'rename'],
        ['unchanged', 'CARD', 'EXPIRE_DT', 'DATE',         'NO', 'expires_at',  'DATE',        'NO', 'rename'],
        ['unchanged', 'CARD', 'STATUS',    'VARCHAR2(8)',  'NO', 'status',      'VARCHAR(8)',  'NO', 'rename'],
      ],
      Summary: [
        ['Schema diff summary', null, null, null],
        ['ASIS table',     'CORE_CARD',   null, null],
        ['TOBE table',     'public.card', null, null],
        ['ASIS columns',   6,             null, null],
        ['TOBE columns',   6,             null, null],
        ['Kind',           'Count', '% of TOBE', 'Note'],
        ['→ renamed',      3,       '50.00%',    'CARD_NO, CUST_ID, CARD_TYPE'],
        ['unchanged',      3,       '50.00%',    'ISSUE_DT, EXPIRE_DT, STATUS'],
      ],
    },
    fx_position: {
      Diff: [
        ['renamed', 'FX_POSITION', 'POS_DT',       'DATE',         'NO', 'position_date',   'DATE',          'NO', 'rename'],
        ['renamed', 'FX_POSITION', 'CCY_CD',       'CHAR(3)',      'NO', 'currency_code',   'CHAR(3)',       'NO', 'rename'],
        ['renamed', 'FX_POSITION', 'POSITION_AMT', 'NUMBER(18,4)', 'NO', 'position_amount', 'NUMERIC(18,4)', 'NO', 'rename + cast'],
      ],
      Summary: [
        ['Schema diff summary', null, null, null],
        ['ASIS table',     'CORE_FX_POSITION',   null, null],
        ['TOBE table',     'public.fx_position', null, null],
        ['ASIS columns',   3,                    null, null],
        ['TOBE columns',   3,                    null, null],
        ['Kind',           'Count', '% of TOBE', 'Note'],
        ['→ renamed',      3,       '100.00%',   'POS_DT, CCY_CD, POSITION_AMT'],
      ],
    },
  },
  validation: {
    acct_master: {
      Overview: [
        ['Validation report · ACCT_MASTER', null, null, null],
        ['ASIS table', 'legacy.acct_master',   null, null],
        ['TOBE table', 'public.account',       null, null],
        ['Generated',  '2026-04-21 09:41 JST', null, null],
        ['Check',                       'ASIS',             'TOBE',             'Verdict'],
        ['Row count',                   '38,400,000',       '38,400,000',       '✓ PASS'],
        ['SHA-256 checksum',            'sha256:9b1d…2c01', 'sha256:9b1d…2c01', '✓ PASS'],
        ['Sum reconciliation (2 cols)', '—',                '—',                '✓ PASS'],
        ['NULL count parity (5 cols)',  '—',                '—',                '✓ PASS'],
        ['Range/overflow (1 cols)',     '—',                '—',                '✓ PASS'],
        ['Total',                       '7',                '7 pass',           '0 fail'],
      ],
      'Sum recon': [
        ['balance_amount', 'NUMERIC(15,2)', '4,580,219,402,150', '4,580,219,402,150', '0.000000%', '✓ PASS'],
        ['risk_score',     'SMALLINT',      '47,329,008',        '47,329,008',        '0.000000%', '✓ PASS'],
      ],
      'NULL parity': [
        ['account_id',        'VARCHAR(20)',  0,      0,      0, '✓ PASS'],
        ['account_name',      'VARCHAR(80)',  12_400, 12_400, 0, '✓ PASS'],
        ['account_name_kana', 'VARCHAR(120)', 18_200, 18_200, 0, '✓ PASS'],
        ['risk_score',        'SMALLINT',     5_002,  5_002,  0, '✓ PASS'],
        ['updated_by',        'VARCHAR(20)',  812,    812,    0, '✓ PASS'],
      ],
      Range: [
        ['kyc_level', 'SMALLINT', '±32767', '12', 0, '✓ PASS'],
      ],
    },
    cust_profile: {
      Overview: [
        ['Validation report · CUST_PROFILE', null, null, null],
        ['ASIS table', 'CORE.CUST_PROFILE ⋈ CORE.CUST_CONTACT', null, null],
        ['TOBE table', 'public.customer',                       null, null],
        ['Generated',  '2026-04-21 09:41 JST',                  null, null],
        ['Check',                        'ASIS',             'TOBE',             'Verdict'],
        ['Row count',                    '22,488,541',       '22,488,541',       '✓ PASS'],
        ['SHA-256 checksum',             'sha256:8a2c…e109', 'sha256:8a2c…e109', '✓ PASS'],
        ['Sum reconciliation (1 cols)',  '—',                '—',                '✓ PASS'],
        ['NULL count parity (14 cols)',  '—',                '—',                '✓ PASS'],
        ['Range/overflow (1 cols)',      '—',                '—',                '✓ PASS'],
        ['Total',                        '18',               '18 pass',          '0 fail'],
      ],
      'Sum recon': [
        ['risk_tier', 'SMALLINT', '741,312,166,603', '741,312,166,603', '0.000000%', '✓ PASS'],
      ],
      'NULL parity': [
        ['customer_id',       'VARCHAR(20)',  0,       0,       0, '✓ PASS'],
        ['customer_name',     'VARCHAR(120)', 0,       0,       0, '✓ PASS'],
        ['birth_date',        'DATE',         1_502,   1_502,   0, '✓ PASS'],
        ['gender',            'CHAR(1)',      5_124,   5_124,   0, '✓ PASS'],
        ['email',             'VARCHAR(120)', 1_290,   1_290,   0, '✓ PASS'],
        ['phone',             'VARCHAR(20)',  830,     830,     0, '✓ PASS'],
        ['nationality',       'CHAR(3)',      500,     500,     0, '✓ PASS'],
        ['city_code',         'VARCHAR(8)',   215,     215,     0, '✓ PASS'],
        ['open_branch',       'VARCHAR(8)',   0,       0,       0, '✓ PASS'],
        ['risk_tier',         'SMALLINT',     1_018,   1_018,   0, '✓ PASS'],
        ['preferred_channel', 'VARCHAR(8)',   2_560,   2_560,   0, '✓ PASS'],
        ['marketing_opt_in',  'BOOLEAN',      0,       0,       0, '✓ PASS'],
        ['created_at',        'TIMESTAMP',    0,       0,       0, '✓ PASS'],
        ['updated_at',        'TIMESTAMP',    0,       0,       0, '✓ PASS'],
        ['status',            'VARCHAR(8)',   0,       0,       0, '✓ PASS'],
      ],
      Range: [
        ['risk_tier', 'SMALLINT', '±32767', '4', 0, '✓ PASS'],
      ],
    },
    txn_journal_2024: {
      Overview: [
        ['Validation report · TXN_JOURNAL_2024', null, null, null],
        ['ASIS table', 'legacy.txn_journal_2024',  null, null],
        ['TOBE table', 'public.transaction_2024',  null, null],
        ['Generated',  '2026-04-21 09:41 JST',     null, null],
        ['Check',                        'ASIS',             'TOBE',             'Verdict'],
        ['Row count',                    '185,300,000',      '185,300,000',      '✓ PASS'],
        ['SHA-256 checksum',             'sha256:1f8e…ca04', 'sha256:1f8e…ca04', '✓ PASS'],
        ['Sum reconciliation (1 cols)',  '—',                '—',                '✓ PASS'],
        ['NULL count parity (4 cols)',   '—',                '—',                '✓ PASS'],
        ['Range/overflow (1 cols)',      '—',                '—',                '✓ PASS'],
        ['Total',                        '6',                '6 pass',           '0 fail'],
      ],
      'Sum recon': [
        ['amount', 'NUMERIC(18,2)', '6,809,238,400,158.32', '6,809,238,400,158.32', '0.000000%', '✓ PASS'],
      ],
      'NULL parity': [
        ['transaction_id', 'VARCHAR(32)', 0,         0,         0, '✓ PASS'],
        ['account_id',     'VARCHAR(20)', 0,         0,         0, '✓ PASS'],
        ['OPR_ID',         'VARCHAR(12)', 2_840_182, 2_840_182, 0, '✓ PASS'],
        ['reference_no',   'VARCHAR(40)', 510_038,   510_038,   0, '✓ PASS'],
      ],
      Range: [
        ['amount', 'NUMERIC(18,2)', '±9999999999999999.99', '9.99e+9', 0, '✓ PASS'],
      ],
    },
    transaction_unified: {
      Overview: [
        ['Validation report · TRANSACTION_UNIFIED', null, null, null],
        ['ASIS table', 'legacy.txn_journal_2023 ∪ legacy.txn_journal_2024', null, null],
        ['TOBE table', 'public.transaction',                                null, null],
        ['Generated',  '2026-04-21 09:41 JST',                              null, null],
        ['Check',                        'ASIS',             'TOBE',             'Verdict'],
        ['Row count',                    '405,810,000',      '405,810,000',      '✓ PASS'],
        ['SHA-256 checksum',             'sha256:c702…b14d', 'sha256:c702…b14d', '✓ PASS'],
        ['Sum reconciliation (1 cols)',  '—',                '—',                '✓ PASS'],
        ['NULL count parity (3 cols)',   '—',                '—',                '✓ PASS'],
        ['Range/overflow (1 cols)',      '—',                '—',                '✓ PASS'],
        ['Total',                        '6',                '6 pass',           '0 fail'],
      ],
      'Sum recon': [
        ['amount', 'NUMERIC(18,2)', '14,802,310,558,200', '14,802,310,558,200', '0.000000%', '✓ PASS'],
      ],
      'NULL parity': [
        ['reference_no', 'VARCHAR(40)', 920_412, 920_412, 0, '✓ PASS'],
        ['status',       'VARCHAR(8)',  0,       0,       0, '✓ PASS'],
        ['source_year',  'SMALLINT',    0,       0,       0, '✓ PASS'],
      ],
      Range: [
        ['source_year', 'SMALLINT', '±32767', '2024', 0, '✓ PASS'],
      ],
    },
    loan: {
      Overview: [
        ['Validation report · LOAN', null, null, null],
        ['ASIS table', 'legacy.loan',          null, null],
        ['TOBE table', 'public.loan',          null, null],
        ['Generated',  '2026-04-21 09:41 JST', null, null],
        ['Check',                        'ASIS',             'TOBE',             'Verdict'],
        ['Row count',                    '2,300,000',        '2,300,000',        '✓ PASS'],
        ['SHA-256 checksum',             'sha256:5f1e…a832', 'sha256:5f1e…a832', '✓ PASS'],
        ['Sum reconciliation (2 cols)',  '—',                '—',                '✓ PASS'],
        ['NULL count parity (1 cols)',   '—',                '—',                '✓ PASS'],
        ['Range/overflow (1 cols)',      '—',                '—',                '✓ PASS'],
        ['Total',                        '6',                '6 pass',           '0 fail'],
      ],
      'Sum recon': [
        ['principal',     'NUMERIC(15,2)', '385,420,180,003', '385,420,180,003', '0.000000%', '✓ PASS'],
        ['interest_rate', 'NUMERIC(5,3)',  '8,752.245',       '8,752.245',       '0.000000%', '✓ PASS'],
      ],
      'NULL parity': [
        ['status', 'VARCHAR(8)', 0, 0, 0, '✓ PASS'],
      ],
      Range: [
        ['term_months', 'SMALLINT', '±32767', '360', 0, '✓ PASS'],
      ],
    },
    card: {
      Overview: [
        ['Validation report · CARD', null, null, null],
        ['ASIS table', 'legacy.card',          null, null],
        ['TOBE table', 'public.card',          null, null],
        ['Generated',  '2026-04-21 09:41 JST', null, null],
        ['Check',                        'ASIS',             'TOBE',             'Verdict'],
        ['Row count',                    '3,200,000',        '3,200,000',        '✓ PASS'],
        ['SHA-256 checksum',             'sha256:7d4a…f018', 'sha256:7d4a…f018', '✓ PASS'],
        ['Sum reconciliation (0 cols)',  '—',                '—',                'n/a'],
        ['NULL count parity (1 cols)',   '—',                '—',                '✓ PASS'],
        ['Range/overflow (1 cols)',      '—',                '—',                '✓ PASS'],
        ['Total',                        '4',                '4 pass',           '0 fail'],
      ],
      'Sum recon': [
        ['(no numeric columns)', 'n/a', 'n/a', 'n/a', 'n/a', 'n/a'],
      ],
      'NULL parity': [
        ['status', 'VARCHAR(8)', 0, 0, 0, '✓ PASS'],
      ],
      Range: [
        ['expires_at', 'DATE', 'within issue+10y', '2049-12-31', 0, '✓ PASS'],
      ],
    },
    fx_position: {
      Overview: [
        ['Validation report · FX_POSITION', null, null, null],
        ['ASIS table', 'legacy.fx_position',   null, null],
        ['TOBE table', 'public.fx_position',   null, null],
        ['Generated',  '2026-04-21 09:41 JST', null, null],
        ['Check',                        'ASIS',             'TOBE',             'Verdict'],
        ['Row count',                    '120,000',          '120,000',          '✓ PASS'],
        ['SHA-256 checksum',             'sha256:e201…7ab9', 'sha256:e201…7ab9', '✓ PASS'],
        ['Sum reconciliation (1 cols)',  '—',                '—',                '✓ PASS'],
        ['NULL count parity (1 cols)',   '—',                '—',                '✓ PASS'],
        ['Range/overflow (1 cols)',      '—',                '—',                '✓ PASS'],
        ['Total',                        '5',                '5 pass',           '0 fail'],
      ],
      'Sum recon': [
        ['position_amount', 'NUMERIC(18,4)', '1,420,800,250.5400', '1,420,800,250.5400', '0.000000%', '✓ PASS'],
      ],
      'NULL parity': [
        ['position_amount', 'NUMERIC(18,4)', 0, 0, 0, '✓ PASS'],
      ],
      Range: [
        ['position_amount', 'NUMERIC(18,4)', '±9,999,999,999.9999', '4.8e+8', 0, '✓ PASS'],
      ],
    },
  },
};

/* 사이드바 트리에서 카테고리 펼쳤을 때 보일 mock 테이블 목록.
   실제로는 프로젝트의 ASIS/TOBE 테이블 목록을 백엔드에서 가져온다. */
const MOCK_TABLES = [
  'acct_master',
  'cust_profile',
  'txn_journal_2024',
  'transaction_unified',
  'loan',
  'card',
  'fx_position',
];

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
  return {
    dashboard:  ['dashboard-snapshot'],
    diff:       MOCK_TABLES,
    ddl:        [projectSlug(projectName)],
    sql:        MOCK_TABLES,
    validation: MOCK_TABLES,
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

/** Status 컬럼 값별 배지 색상 — 프로토타입의 running/blocked/warn/done 매칭. */
const STATUS_BADGE: Record<string, React.CSSProperties> = {
  running: { background: '#fff4d4', color: '#7a5a00' },
  blocked: { background: '#ffd9d9', color: '#a00000' },
  warn:    { background: '#ffe6c2', color: '#8a4c00' },
  done:    { background: '#dff5e1', color: '#0a5a1f' },
};

/** Rule 컬럼 값별 배지 색상 — Mapping(구 Schema diff) Rules 시트에서 사용.
 *  Diff palette 와 동일 색을 재사용 (rename = added 초록, add = typed 노랑, drop = removed 빨강). */
const RULE_BADGE: Record<string, React.CSSProperties> = {
  rename: { background: '#d4eedb', color: '#0a5a1f' },
  add:    { background: '#fff0c2', color: '#7a5a00' },
  drop:   { background: '#f3d3d3', color: '#a00000' },
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
  if (first.startsWith('Validation report')) {
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

/* ───────────────────────────────────────────────────────────────
   DDL SQL mock — 테이블 × (AS-IS / TO-BE) 별 CREATE TABLE 스크립트.
   실데이터 wiring 시 DDL_SCRIPTS 자리에 백엔드 응답을 넣으면 된다.
   ─────────────────────────────────────────────────────────────── */

const DDL_SCRIPTS: Record<string, Record<'AS-IS' | 'TO-BE', string>> = {
  acct_master: {
    'AS-IS': `-- DDL for legacy.acct_master (ASIS)
-- source: ORACLE 11g — CORE banking
CREATE TABLE legacy.acct_master (
  ACCT_ID         VARCHAR2(20) NOT NULL,
  CUST_ID         VARCHAR2(20) NOT NULL,
  BRANCH_CD       CHAR(3) NOT NULL,
  ACCT_TYPE       VARCHAR2(8) NOT NULL,
  CCY_CD          CHAR(3) NOT NULL,
  BAL_AMT         NUMBER(15,2) NOT NULL,
  OPENED_DT       DATE NOT NULL,
  STATUS          VARCHAR2(8) NOT NULL,
  ACCT_NM         VARCHAR2(80),
  ACCT_NM_KANA    VARCHAR2(120),
  RISK_SCORE      NUMBER(3) DEFAULT 0,
  KYC_LV          NUMBER(2) DEFAULT 0 NOT NULL,
  AML_FLG         CHAR(1) DEFAULT 'N' NOT NULL,
  SEGMENT_CD      VARCHAR2(8) NOT NULL,
  TENANT_ID       VARCHAR2(8) NOT NULL,
  UPDATED_BY      VARCHAR2(20),
  CREATED_AT      TIMESTAMP DEFAULT SYSDATE NOT NULL,
  UPDATED_AT      TIMESTAMP DEFAULT SYSDATE NOT NULL,
  CONSTRAINT PK_ACCT_MASTER PRIMARY KEY (ACCT_ID)
);`,
    'TO-BE': `-- DDL for public.account (TOBE)
-- generated from CORE_ACCT_MASTER
CREATE TABLE IF NOT EXISTS public.account (
  account_id        VARCHAR(20) NOT NULL,
  customer_id       VARCHAR(20) NOT NULL,
  branch_code       CHAR(3) NOT NULL,
  account_type      VARCHAR(8) NOT NULL,
  currency_code     CHAR(3) NOT NULL,
  balance_amount    NUMERIC(15,2) NOT NULL,
  opened_at         DATE NOT NULL,
  status            VARCHAR(8) NOT NULL,
  account_name      VARCHAR(80),
  account_name_kana VARCHAR(120),
  risk_score        SMALLINT DEFAULT 0,
  kyc_level         SMALLINT NOT NULL DEFAULT 0,
  aml_flag          BOOLEAN NOT NULL DEFAULT false,
  segment_code      VARCHAR(8) NOT NULL,
  tenant_id         VARCHAR(8) NOT NULL,
  updated_by        VARCHAR(20),
  created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id)
);`,
  },
  cust_profile: {
    'AS-IS': `-- DDL for legacy.cust_profile (ASIS)
CREATE TABLE legacy.cust_profile (
  CUST_ID       VARCHAR2(20) NOT NULL,
  CUST_NM       VARCHAR2(120) NOT NULL,
  BIRTH_DT      DATE,
  GENDER        CHAR(1),
  EMAIL         VARCHAR2(120),
  PHONE         VARCHAR2(20),
  ADDR_LINE1    VARCHAR2(200),
  ADDR_LINE2    VARCHAR2(200),
  CITY_CD       VARCHAR2(8),
  STATUS        VARCHAR2(8) NOT NULL,
  CREATED_AT    TIMESTAMP DEFAULT SYSDATE NOT NULL,
  CONSTRAINT PK_CUST_PROFILE PRIMARY KEY (CUST_ID)
);`,
    'TO-BE': `-- DDL for public.customer (TOBE)
CREATE TABLE IF NOT EXISTS public.customer (
  customer_id    VARCHAR(20) NOT NULL,
  customer_name  VARCHAR(120) NOT NULL,
  birth_date     DATE,
  gender         CHAR(1),
  email          VARCHAR(120),
  phone          VARCHAR(20),
  address_line1  VARCHAR(200),
  address_line2  VARCHAR(200),
  city_code      VARCHAR(8),
  status         VARCHAR(8) NOT NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (customer_id)
);`,
  },
  txn_journal_2024: {
    'AS-IS': `-- DDL for legacy.txn_journal_2024 (ASIS)
CREATE TABLE legacy.txn_journal_2024 (
  TXN_ID       VARCHAR2(32) NOT NULL,
  ACCT_ID      VARCHAR2(20) NOT NULL,
  TXN_DT       DATE NOT NULL,
  TXN_TYPE     VARCHAR2(8) NOT NULL,
  AMT          NUMBER(18,2) NOT NULL,
  CCY_CD       CHAR(3) NOT NULL,
  REF_NO       VARCHAR2(40),
  STATUS       VARCHAR2(8) NOT NULL,
  CONSTRAINT PK_TXN_JOURNAL_2024 PRIMARY KEY (TXN_ID)
);`,
    'TO-BE': `-- DDL for public.transaction (TOBE) — unified 2023/2024 sources
CREATE TABLE IF NOT EXISTS public.transaction (
  transaction_id  VARCHAR(32) NOT NULL,
  account_id      VARCHAR(20) NOT NULL,
  transaction_at  TIMESTAMP NOT NULL,
  transaction_type VARCHAR(8) NOT NULL,
  amount          NUMERIC(18,2) NOT NULL,
  currency_code   CHAR(3) NOT NULL,
  reference_no    VARCHAR(40),
  status          VARCHAR(8) NOT NULL,
  source_year     SMALLINT NOT NULL,
  PRIMARY KEY (transaction_id)
);`,
  },
  transaction_unified: {
    'AS-IS': `-- (view) legacy.txn_journal_2023 ∪ legacy.txn_journal_2024
-- See txn_journal_2024.ddl.sql for ASIS schema.`,
    'TO-BE': `-- DDL for public.transaction (unified)
-- Same as txn_journal_2024 TO-BE. See txn_journal_2024.ddl.sql.`,
  },
  loan: {
    'AS-IS': `-- DDL for legacy.loan (ASIS)
CREATE TABLE legacy.loan (
  LOAN_ID      VARCHAR2(20) NOT NULL,
  CUST_ID      VARCHAR2(20) NOT NULL,
  PRINCIPAL    NUMBER(15,2) NOT NULL,
  INT_RATE     NUMBER(5,3) NOT NULL,
  TERM_M       NUMBER(3) NOT NULL,
  ISSUE_DT     DATE NOT NULL,
  STATUS       VARCHAR2(8) NOT NULL,
  CONSTRAINT PK_LOAN PRIMARY KEY (LOAN_ID)
);`,
    'TO-BE': `-- DDL for public.loan (TOBE)
CREATE TABLE IF NOT EXISTS public.loan (
  loan_id        VARCHAR(20) NOT NULL,
  customer_id    VARCHAR(20) NOT NULL,
  principal      NUMERIC(15,2) NOT NULL,
  interest_rate  NUMERIC(5,3) NOT NULL,
  term_months    SMALLINT NOT NULL,
  issued_at      DATE NOT NULL,
  status         VARCHAR(8) NOT NULL,
  PRIMARY KEY (loan_id)
);`,
  },
  card: {
    'AS-IS': `-- DDL for legacy.card (ASIS)
CREATE TABLE legacy.card (
  CARD_NO      VARCHAR2(16) NOT NULL,
  CUST_ID      VARCHAR2(20) NOT NULL,
  CARD_TYPE    VARCHAR2(8) NOT NULL,
  ISSUE_DT     DATE NOT NULL,
  EXPIRE_DT    DATE NOT NULL,
  STATUS       VARCHAR2(8) NOT NULL,
  CONSTRAINT PK_CARD PRIMARY KEY (CARD_NO)
);`,
    'TO-BE': `-- DDL for public.card (TOBE)
CREATE TABLE IF NOT EXISTS public.card (
  card_number   VARCHAR(16) NOT NULL,
  customer_id   VARCHAR(20) NOT NULL,
  card_type     VARCHAR(8) NOT NULL,
  issued_at     DATE NOT NULL,
  expires_at    DATE NOT NULL,
  status        VARCHAR(8) NOT NULL,
  PRIMARY KEY (card_number)
);`,
  },
  fx_position: {
    'AS-IS': `-- DDL for legacy.fx_position (ASIS)
CREATE TABLE legacy.fx_position (
  POS_DT       DATE NOT NULL,
  CCY_CD       CHAR(3) NOT NULL,
  POSITION_AMT NUMBER(18,4) NOT NULL,
  CONSTRAINT PK_FX_POSITION PRIMARY KEY (POS_DT, CCY_CD)
);`,
    'TO-BE': `-- DDL for public.fx_position (TOBE)
CREATE TABLE IF NOT EXISTS public.fx_position (
  position_date   DATE NOT NULL,
  currency_code   CHAR(3) NOT NULL,
  position_amount NUMERIC(18,4) NOT NULL,
  PRIMARY KEY (position_date, currency_code)
);`,
  },
};

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

/* ───────────────────────────────────────────────────────────────
   Schema diff 메타 — 트리에서 선택한 테이블마다 ASIS/TOBE 이름 + 카운트.
   상단 배너와 fx ctx 의 ASIS/TOBE 자리에 사용. 실데이터 wiring 시 백엔드 응답으로 교체.
   ─────────────────────────────────────────────────────────────── */

interface DiffMeta {
  asisName: string;
  tobeName: string;
  added: number;
  removed: number;
  renamed: number;
  typed: number;
  reordered: number;
  unchanged: number;
}

const SCHEMA_DIFF_META: Record<string, DiffMeta> = {
  acct_master:         { asisName: 'CORE_ACCT_MASTER',      tobeName: 'public.account',           added: 1, removed: 0, renamed: 4, typed: 2, reordered: 0, unchanged: 13 },
  cust_profile:        { asisName: 'CORE_CUST_PROFILE',     tobeName: 'public.customer',          added: 0, removed: 0, renamed: 6, typed: 0, reordered: 0, unchanged: 5 },
  txn_journal_2024:    { asisName: 'CORE_TXN_JOURNAL_2024', tobeName: 'public.transaction_2024',  added: 1, removed: 1, renamed: 0, typed: 5, reordered: 0, unchanged: 6 },
  transaction_unified: { asisName: 'CORE_TXN_JOURNAL_*',    tobeName: 'public.transaction',       added: 1, removed: 1, renamed: 0, typed: 5, reordered: 0, unchanged: 6 },
  loan:                { asisName: 'CORE_LOAN',             tobeName: 'public.loan',              added: 0, removed: 0, renamed: 3, typed: 1, reordered: 0, unchanged: 3 },
  card:                { asisName: 'CORE_CARD',             tobeName: 'public.card',              added: 0, removed: 0, renamed: 3, typed: 0, reordered: 0, unchanged: 3 },
  fx_position:         { asisName: 'CORE_FX_POSITION',      tobeName: 'public.fx_position',       added: 0, removed: 0, renamed: 3, typed: 0, reordered: 0, unchanged: 0 },
};

/* validation 카테고리의 fx 수식바 `{n}` 자리 — 테이블별 총 check 수 (Overview 시트의 Total 값과 동일).
   사이드바에서 테이블 바꾸면 수식바의 'X checks' 가 따라서 바뀐다. */
const VALIDATION_CHECK_COUNT: Record<string, number> = {
  acct_master:         7,
  cust_profile:        18,
  txn_journal_2024:    6,
  transaction_unified: 6,
  loan:                6,
  card:                4,
  fx_position:         5,
};

/* Status 키워드별 색상 — Diff 시트의 배지 색깔 + 행 전체 tint. */
type DiffStatusKey = 'added' | 'removed' | 'renamed' | 'typed' | 'reordered' | 'unchanged';

/* prefix 는 chip 의 `+ 5 added` / `→ 7 renamed` 식 prefix.
   name 은 chip 의 카운트 뒤 키워드.
   label 은 Diff/Summary 시트의 Status/Kind 셀에 표시되는 라벨. */
const DIFF_STATUS_STYLE: Record<DiffStatusKey, {
  prefix: string;
  name: string;
  label: string;
  badge: React.CSSProperties;
  rowTint: string;
}> = {
  /* 각 status 별로 badge bg 와 row tint 를 같은 shade 로 통일 (chip/Status 셀/행 모두 동일 색).
     텍스트는 짙은 톤으로 contrast 유지. */
  added: {
    prefix: '+', name: 'added', label: '+ added',
    badge: { background: '#d4eedb', color: '#0a5a1f' },
    rowTint: '#d4eedb',
  },
  removed: {
    prefix: '-', name: 'removed', label: '- removed',
    badge: { background: '#f3d3d3', color: '#a00000' },
    rowTint: '#f3d3d3',
  },
  renamed: {
    prefix: '→', name: 'renamed', label: '→ renamed',
    badge: { background: '#d6e3f3', color: '#0a448a' },
    rowTint: '#d6e3f3',
  },
  typed: {
    prefix: '~', name: 'typed', label: '~ typed',
    badge: { background: '#fff0c2', color: '#7a5a00' },
    rowTint: '#fff0c2',
  },
  reordered: {
    prefix: '↕', name: 'reordered', label: '↕ reordered',
    badge: { background: '#ffd8b8', color: '#7a3a00' },
    rowTint: '#ffd8b8',
  },
  unchanged: {
    prefix: '', name: 'unchanged', label: 'unchanged',
    /* unchanged 는 prototype 처럼 배경 없이 dim text 만. row 도 흰색 유지.
       borderColor 는 badge 에 넣지 않는다 — 이 badge style 이 table 셀에도 spread 되는데,
       셀의 borderRight/borderBottom(개별 property)와 borderColor(shorthand-ish)가 섞이면
       React 가 rerender 시 border 상태를 stale 하게 남겨서 가끔 가로줄이 다시 보이는
       증상이 있었음. chip 의 unchanged 외곽선은 styles.diffChip 의 6% black 기본값
       그대로 (거의 안 보임). */
    badge: { background: 'transparent', color: '#888' },
    rowTint: '#ffffff',
  },
};

/* Summary 시트의 첫 컬럼 라벨 (예: '+ added') → DiffStatusKey 로 변환.
   Diff 시트는 enum key 를 그대로 쓰지만, Summary 시트는 display label 을 사용해서 별도 매핑이 필요. */
const SUMMARY_KIND_TO_KEY: Record<string, DiffStatusKey> = {
  '+ added':     'added',
  '- removed':   'removed',
  '→ renamed':   'renamed',
  '~ typed':     'typed',
  '↕ reordered': 'reordered',
  'unchanged':   'unchanged',
};

function detectSummaryKind(label: Cell): DiffStatusKey | undefined {
  return typeof label === 'string' ? SUMMARY_KIND_TO_KEY[label] : undefined;
}

/* xlsx 셀 색상 팔레트 — 화면(in-app) 배지 색과 동일한 ARGB 형태.
   화면 CSS hex (#rrggbb) → ARGB (FFRRGGBB) 로 0xFF alpha prefix 만 붙임. */
const ARGB_BY_DIFF_STATUS: Record<DiffStatusKey, { bg: string; fg: string }> = {
  added:     { bg: 'FFD4EEDB', fg: 'FF0A5A1F' },
  removed:   { bg: 'FFF3D3D3', fg: 'FFA00000' },
  renamed:   { bg: 'FFD6E3F3', fg: 'FF0A448A' },
  typed:     { bg: 'FFFFF0C2', fg: 'FF7A5A00' },
  reordered: { bg: 'FFFFD8B8', fg: 'FF7A3A00' },
  unchanged: { bg: 'FFFFFFFF', fg: 'FF888888' },
};
const ARGB_BY_STATUS: Record<string, { bg: string; fg: string }> = {
  running: { bg: 'FFFFF4D4', fg: 'FF7A5A00' },
  blocked: { bg: 'FFFFD9D9', fg: 'FFA00000' },
  warn:    { bg: 'FFFFE6C2', fg: 'FF8A4C00' },
  done:    { bg: 'FFDFF5E1', fg: 'FF0A5A1F' },
};
const ARGB_BY_VERDICT: Record<string, { bg: string; fg: string }> = {
  '✓ PASS': { bg: 'FFD4EEDB', fg: 'FF0A5A1F' },
  '✓':      { bg: 'FFD4EEDB', fg: 'FF0A5A1F' },
  PASS:     { bg: 'FFD4EEDB', fg: 'FF0A5A1F' },
  '✗ FAIL': { bg: 'FFF3D3D3', fg: 'FFA00000' },
  '✗':      { bg: 'FFF3D3D3', fg: 'FFA00000' },
  FAIL:     { bg: 'FFF3D3D3', fg: 'FFA00000' },
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

  for (const sheet of sheets) {
    /* Excel 시트명은 31 자 이하, \\ / ? : * [ ] 금지. 안전하게 잘라낸다. */
    const safeName = sheet.name.replace(/[\\/?:*[\]]/g, '_').slice(0, 31) || 'Sheet';
    const ws = wb.addWorksheet(safeName);
    const rows = getRows(sheet.name);

    if (!sheet.freeForm && sheet.columns.length > 0) {
      /* in-app 워크북 chrome 과 동일한 두 줄 헤더:
           row 1 → 컬럼명 (굵은 짙은 녹색 텍스트, 옅은 회색 fill)
           row 2 → 데이터 타입 (옅은 회색 텍스트, 같은 fill)
         data 행은 row 3 부터 시작. */
      ws.addRow(sheet.columns.map((c) => c.name));
      ws.addRow(sheet.columns.map((c) => c.type));
      const nameRow = ws.getRow(1);
      const typeRow = ws.getRow(2);
      nameRow.eachCell((cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F2F1' } };
        cell.font = { bold: true, color: { argb: 'FF217346' }, size: 12 };
      });
      typeRow.eachCell((cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F2F1' } };
        cell.font = { color: { argb: 'FF605E5C' }, size: 10 };
      });
      sheet.columns.forEach((c, i) => {
        ws.getColumn(i + 1).width = Math.max(12, Math.min(40, c.name.length + 6));
      });
      /* in-app preview 처럼 헤더 2 줄을 항상 보이게 고정 (frozen pane). */
      ws.views = [{ state: 'frozen', ySplit: 2 }];
    }

    rows.forEach((row) => {
      /* Diff 시트의 Status 컬럼 (col 0) 은 in-app 라벨 ('→ renamed', '+ added' 등) 로 변환.
         그래야 다운받은 xlsx 의 셀 텍스트가 in-app preview 와 동일하게 보인다. */
      const transformed = row.map((v, i) => {
        if (v === null || v === undefined) return null;
        if (typeof v === 'boolean') return v ? 'true' : 'false';
        if (
          categoryKey === 'diff' && sheet.name === 'Diff' && i === 0 &&
          typeof v === 'string' && v in DIFF_STATUS_STYLE
        ) {
          return DIFF_STATUS_STYLE[v as DiffStatusKey].label;
        }
        return v;
      });
      const excelRow = ws.addRow(transformed);

      /* ── Mapping (diff) Diff 시트 ── Status 컬럼 값으로 행 전체 tint, Status 셀은 짙은 텍스트. */
      if (categoryKey === 'diff' && sheet.name === 'Diff') {
        const statusKey = row[0] as DiffStatusKey | undefined;
        const palette = statusKey ? ARGB_BY_DIFF_STATUS[statusKey] : undefined;
        if (palette && statusKey !== 'unchanged') {
          sheet.columns.forEach((col, colIdx) => {
            const cell = excelRow.getCell(colIdx + 1);
            const isBadgeCol = col.name === 'Status';
            paintCell(cell, palette.bg, isBadgeCol ? palette.fg : undefined);
          });
        }
      }

      /* ── Mapping Summary 시트 ── Kind 컬럼 (1열) 라벨 + 카운트 행에 status 색. */
      if (categoryKey === 'diff' && sheet.name === 'Summary') {
        const kind = detectSummaryKind(row[0]);
        const palette = kind ? ARGB_BY_DIFF_STATUS[kind] : undefined;
        if (palette && kind !== 'unchanged') {
          excelRow.eachCell((cell) => paintCell(cell, palette.bg));
          paintCell(excelRow.getCell(1), palette.bg, palette.fg);
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

  const buf = await wb.xlsx.writeBuffer();
  /* ExcelJS 3.x 의 browser 번들은 writeBuffer() 가 Node 스타일 Buffer(폴리필) 를
     돌려준다. 이걸 그대로 new Blob([buf]) 에 넘기면 일부 번들 환경에서 Buffer.toString()
     이 호출돼 텍스트로 직렬화 → ZIP 헤더가 깨져 Excel 에서 "파일 형식이 올바르지 않음"
     오류가 난다.

     해결책: 우리가 신뢰할 수 있는 raw ArrayBuffer 를 직접 잘라내서 Blob 에 넘긴다.
       - ArrayBufferView (Buffer/Uint8Array) → underlying buffer 를 byteOffset/Length 만큼 slice
       - 그 외 (ArrayBuffer) → 그대로 사용
     이렇게 하면 Blob 은 Buffer wrapper 없이 순수 바이트만 본다. */
  const arrayBuffer: ArrayBuffer = ArrayBuffer.isView(buf)
    ? (buf.buffer as ArrayBuffer).slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    : (buf as ArrayBuffer);
  const blob = new Blob([arrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
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
  const childTables = useMemo(
    () => childTablesFor(project?.name ?? ''),
    [project?.name],
  );

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
     Dashboard / DDL 은 단일 산출물이라 항상 그 single child, 다른 카테고리면 MOCK_TABLES[0]. */
  const selectedTable =
    selectedTableByCat[activeCategory.key] ?? childTables[activeCategory.key][0];
  const handleSelectTable = (catKey: CategoryKey, tbl: string) => {
    setSelectedCat(catKey);
    setSelectedTableByCat((prev) => ({ ...prev, [catKey]: tbl }));
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
          />
        </div>
        <div style={styles.cta}>
          <button
            disabled
            title={t('artifacts.empty.hint')}
            style={{ ...styles.btnPrimary, ...styles.btnPrimaryDisabled }}
          >
            <span style={styles.btnIcon}>↓</span>
            {t('siteExport.btn.download')}
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
}

function ArtifactTree({
  openCats,
  setOpenCats,
  selectedCat,
  onSelect,
  selectedTableByCat,
  onSelectTable,
  childTables,
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
                {tables.map((tbl) => {
                  const tblActive = active && selectedTable === tbl;
                  return (
                    <div
                      key={tbl}
                      onClick={() => onSelectTable(cat.key, tbl)}
                      style={{
                        ...styles.tableRow,
                        ...(tblActive ? styles.tableRowActive : null),
                      }}
                      title={`${tbl}${cat.suffix}`}
                    >
                      {tbl}{cat.suffix}
                    </div>
                  );
                })}
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
}

function ExcelWorkbook({
  category,
  projectName,
  selectedTable,
  activeSheet,
  onSelectSheet,
}: ExcelWorkbookProps) {
  const t = useT();
  /* Copy 버튼 직후 짧은 "Copied" 토스트를 띄우기 위한 상태.
     true 로 세팅 후 ~1.6 초 뒤 자동으로 false. */
  const [copied, setCopied] = useState(false);
  /* 트리에서 선택한 자식(예: dashboard-snapshot, m_user) 이 있으면 그 이름으로,
     없으면 placeholder 로 fallback. */
  const baseName = selectedTable ?? t('artifacts.workbook.placeholderName');
  const filename = `${baseName}${category.suffix}`;
  const sheets = SHEETS[category.key];
  /* 활성 시트의 컬럼 스키마. activeSheet 가 SHEETS 에 없으면 (방어적) 첫 시트로 fallback. */
  const currentSheet = sheets.find((s) => s.name === activeSheet) ?? sheets[0];
  const cols = currentSheet.columns;

  /* 실제 산출물 데이터가 들어오면 이 자리에 행 배열을 채운다 (현재 시트 기준).
     상태바 rows 카운트는 이 배열 길이를 그대로 사용.
     → 데모용으로 MOCK_ROWS 에서 가져오는 중. 실데이터 wiring 시 교체. */
  /* diff/validation 은 사이드바에서 고른 테이블별 데이터를 본다 — MOCK_ROWS_BY_TABLE 우선.
     dashboard/sql/ddl 은 테이블 무관이라 MOCK_ROWS 그대로. */
  const dataRows: Cell[][] =
    (category.key === 'diff' || category.key === 'validation') && selectedTable
      ? MOCK_ROWS_BY_TABLE[category.key][selectedTable]?.[activeSheet] ?? []
      : MOCK_ROWS[category.key]?.[activeSheet] ?? [];

  /* SQL 뷰일 때만 사용 — DDL Scripts 는 프로젝트 단위 단일 산출물이라 모든 테이블의
     AS-IS / TO-BE DDL 을 하나로 연결해서 보여준다. */
  const isSqlView = category.viewType === 'sql';
  const sqlText: string = isSqlView
    ? MOCK_TABLES
        .map((tbl) => DDL_SCRIPTS[tbl]?.[activeSheet as 'AS-IS' | 'TO-BE'] ?? '')
        .filter((s) => s.trim().length > 0)
        .join('\n\n-- ───────────────────────────────────────────────\n\n')
    : '';
  const sqlLines = sqlText ? sqlText.split('\n') : [];

  /* Diff 카테고리 — 선택된 테이블의 ASIS/TOBE 이름 & diff 카운트. */
  const diffMeta =
    category.key === 'diff' && selectedTable ? SCHEMA_DIFF_META[selectedTable] : undefined;

  const handleCopy = () => {
    void copyToClipboard(sqlText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };
  const handleDownload = () => {
    /* 다운로드 파일명: <table>.<sheet>.sql — 예: acct_master.AS-IS.ddl.sql */
    const dlName = `${baseName}.${activeSheet}${category.suffix}`;
    downloadText(dlName, sqlText, 'application/sql');
  };
  const handleDownloadXlsx = () => {
    /* 워크북 전체(현재 카테고리의 모든 시트)를 실제 xlsx 로 저장. */
    const dlName = `${baseName}${category.suffix}`;
    /* 각 시트별 데이터 lookup — diff/validation 은 테이블별, 나머지는 카테고리 직접. */
    const getRows = (sheetName: string): Cell[][] => {
      if ((category.key === 'diff' || category.key === 'validation') && selectedTable) {
        return MOCK_ROWS_BY_TABLE[category.key][selectedTable]?.[sheetName] ?? [];
      }
      return MOCK_ROWS[category.key]?.[sheetName] ?? [];
    };
    void downloadWorkbookAsXlsx(dlName, category.key, sheets, getRows);
  };

  /* fx 수식바 placeholder 치환 — projectName + 카테고리별 mock context.
     사이드바에서 테이블을 선택했으면 {table} 을 그 값으로 override.
     diff 카테고리면 선택 테이블의 SCHEMA_DIFF_META 로 ASIS/TOBE/카운트 override.
     validation 카테고리면 선택 테이블의 VALIDATION_CHECK_COUNT 로 {n} override.
     실데이터 wiring 시 MOCK_FORMULA_CTX 자리에 실값 ctx 를 넣으면 됨. */
  const validationN: number | undefined =
    category.key === 'validation' && selectedTable
      ? VALIDATION_CHECK_COUNT[selectedTable]
      : undefined;
  const formulaText = substitute(SUMMARY_PLACEHOLDER[category.key], {
    project: projectName,
    ...MOCK_FORMULA_CTX[category.key],
    ...(selectedTable ? { table: selectedTable } : {}),
    ...(validationN != null ? { n: validationN } : {}),
    ...(diffMeta
      ? {
          ASIS: diffMeta.asisName,
          TOBE: diffMeta.tobeName,
          added: diffMeta.added,
          removed: diffMeta.removed,
          changed: diffMeta.typed + diffMeta.renamed + diffMeta.reordered,
        }
      : {}),
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
            const tabFilename = `${baseName}.${s.name === 'AS-IS' ? 'asis' : 'tobe'}${category.suffix}`;
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
            {/* (B), (C) 컬럼명/타입 헤더 — freeForm 시트는 생략 (Overview 처럼 데이터 안에 inline 헤더 두는 경우). */}
            {!currentSheet.freeForm && (
              <>
                <tr>
                  <th style={{ ...styles.rowHeader, ...styles.rowHeaderName }}>1</th>
                  {cols.map((c) => (
                    <th key={`n-${c.name}`} style={styles.colName}>{c.name}</th>
                  ))}
                </tr>
                <tr>
                  <th style={{ ...styles.rowHeader, ...styles.rowHeaderType }}>2</th>
                  {cols.map((c) => (
                    <th key={`t-${c.name}`} style={styles.colType}>{c.type}</th>
                  ))}
                </tr>
              </>
            )}
          </thead>
          <tbody>
            {/* (D) 데이터 행만 렌더 — 아래쪽 padding 빈 행은 두지 않는다 (가로줄 누적 방지).
                 - Dashboard/Validation Status 컬럼 → running/blocked/warn/done 배지
                 - Diff 시트 Status 컬럼 → added/removed/typed/... 배지 + 행 전체 색 tint
                 - Validation Overview (freeForm) → title/meta/header/PASS/total 행 종류별 스타일 */}
            {dataRows.map((row, r) => {
              /* Diff 시트면 Status 값(enum key)으로, Summary 시트면 첫 컬럼 라벨로 행 색을 결정. */
              const diffStatusKey: DiffStatusKey | undefined =
                category.key === 'diff' && activeSheet === 'Diff'
                  ? (row[0] as DiffStatusKey | undefined)
                  : category.key === 'diff' && activeSheet === 'Summary'
                    ? detectSummaryKind(row[0])
                    : undefined;
              const diffRowTint = diffStatusKey ? DIFF_STATUS_STYLE[diffStatusKey]?.rowTint : undefined;
              /* freeForm Overview 행 분류 (validation Overview 만). */
              const isOverviewFreeForm =
                currentSheet.freeForm === true && category.key === 'validation' && activeSheet === 'Overview';
              const ovStyle: OverviewRowStyle | null = isOverviewFreeForm ? classifyOverviewRow(row) : null;
              const rowTint = ovStyle?.rowTint ?? diffRowTint;
              /* freeForm 시트는 thead 의 컬럼명/타입 헤더 2 행이 생략되므로, 데이터 row 번호도 1 부터. */
              const displayRowNum = currentSheet.freeForm ? r + 1 : r + 3;
              return (
                <tr key={r}>
                  <td style={styles.rowHeader}>{displayRowNum}</td>
                  {cols.map((col, c) => {
                    const value = row[c];
                    /* Status 배지 결정: Diff 시트면 DIFF_STATUS_STYLE, 아니면 STATUS_BADGE (Dashboard/Validation). */
                    const isDiffStatus =
                      diffStatusKey != null && col.name === 'Status';
                    const isPlainStatus =
                      !isDiffStatus && col.name === 'Status' && typeof value === 'string';
                    /* Rule 컬럼 (Mapping Rules 시트) → rename/add/drop 배지. */
                    const isRuleCol = col.name === 'Rule' && typeof value === 'string';
                    /* Verdict 컬럼 (Validation 시트) → ✓ PASS / ✗ FAIL 배지. */
                    const isVerdictCol = col.name === 'Verdict' && typeof value === 'string';
                    const diffBadgeStyle = isDiffStatus
                      ? DIFF_STATUS_STYLE[diffStatusKey!]?.badge
                      : undefined;
                    const plainBadgeStyle = isPlainStatus
                      ? STATUS_BADGE[value as string]
                      : undefined;
                    const ruleBadgeStyle = isRuleCol
                      ? RULE_BADGE[value as string]
                      : undefined;
                    const verdictBadgeStyle = isVerdictCol
                      ? VERDICT_BADGE[value as string]
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
                          ...(diffBadgeStyle ?? plainBadgeStyle ?? ruleBadgeStyle ?? verdictBadgeStyle ?? {}),
                          ...(isEmDash ? { textAlign: 'center', color: '#888' } : {}),
                          ...(isEmptyCellInOverview
                            ? { borderRight: '1px solid transparent', borderBottom: '1px solid transparent' }
                            : {}),
                        }}
                      >
                        {isDiffStatus
                          ? DIFF_STATUS_STYLE[diffStatusKey!]?.label
                          : formatCell(value)}
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

  /* 트리 자식 — 카테고리 펼침 시 보이는 테이블 목록 */
  tableList: { paddingTop: 2, paddingBottom: 4 },
  tableRow: {
    padding: '2px 10px 2px 32px',
    fontSize: 11,
    color: 'var(--text-3)',
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
