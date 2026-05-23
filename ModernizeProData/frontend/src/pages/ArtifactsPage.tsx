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
  { key: 'dashboard',  labelKey: 'artifacts.cat.dashboard',  suffix: '.dashboard.xlsx', icon: '▣', single: true },
  /* 구 'Schema diff' — 사용자 노출 라벨은 'Mapping', 파일 확장자도 .map.xlsx 로 통일.
     내부 key 는 'diff' 그대로 유지 (코드 전반의 SHEETS.diff / MOCK_ROWS.diff / 등이 참조). */
  { key: 'diff',       labelKey: 'artifacts.cat.mapping',    suffix: '.map.xlsx',       icon: '◨', downloadType: 'xlsx' },
  { key: 'ddl',        labelKey: 'artifacts.cat.ddl',        suffix: '.ddl.sql',        icon: '▤', viewType: 'sql' },
  { key: 'sql',        labelKey: 'artifacts.cat.sql',        suffix: '.migrate.sql',    icon: '↦' },
  { key: 'validation', labelKey: 'artifacts.cat.validation', suffix: '.report.xlsx',    icon: '✓' },
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
      { name: 'Status',           type: 'ENUM' },
      { name: 'ASIS column',      type: 'VARCHAR' },
      { name: 'ASIS type',        type: 'VARCHAR' },
      { name: 'ASIS null',        type: 'BOOLEAN' },
      { name: 'TOBE column',      type: 'VARCHAR' },
      { name: 'TOBE type',        type: 'VARCHAR' },
      { name: 'TOBE null',        type: 'BOOLEAN' },
      { name: 'Mapping / default', type: 'TEXT' },
    ]},
    { name: 'Summary', columns: [
      { name: 'Kind',      type: 'TEXT' },
      { name: 'Count',     type: 'INT' },
      { name: '% of TOBE', type: 'TEXT' },
      { name: 'Note',      type: 'TEXT' },
    ]},
    { name: 'Rules', columns: [
      { name: 'Source',      type: 'VARCHAR' },
      { name: 'Source type', type: 'VARCHAR' },
      { name: 'Target',      type: 'VARCHAR' },
      { name: 'Target type', type: 'VARCHAR' },
      { name: 'PK',          type: 'BOOLEAN' },
      { name: 'Null',        type: 'BOOLEAN' },
      { name: 'Rule',        type: 'ENUM' },
      { name: 'Transform',   type: 'TEXT' },
    ]},
    { name: 'ASIS', columns: [
      { name: 'Field',    type: 'VARCHAR' },
      { name: 'Type',     type: 'VARCHAR' },
      { name: 'Nullable', type: 'BOOLEAN' },
      { name: 'PK',       type: 'BOOLEAN' },
    ]},
    { name: 'TOBE', columns: [
      { name: 'Field',    type: 'VARCHAR' },
      { name: 'Type',     type: 'VARCHAR' },
      { name: 'Nullable', type: 'BOOLEAN' },
      { name: 'PK',       type: 'BOOLEAN' },
      { name: 'Origin',   type: 'VARCHAR' },
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
    /* Overview 는 free-form 레이아웃 — Dashboard Overview 와 동일 패턴.
       4 컬럼 generic placeholder 로 두고 데이터 행에서 라벨/값을 자유 배치. */
    { name: 'Overview', columns: [
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
      [null, null, null, null],
      ['Captured', '2026-04-21 09:41 JST', null, null],
      ['Run',      'run-2026-0421-0914',  null, null],
      ['Author',   'KS Info System',       null, null],
      [null, null, null, null],
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
  /* diff 의 4개 시트 mock — 프로토타입 (CORE_TXN_JOURNAL_2024 → public.transaction_2024) 기준. */
  diff: {
    /* Diff: 컬럼별 변경 한 줄씩 (added/removed/typed/unchanged). Status 컬럼의 값 키워드로 행 색깔 결정. */
    Diff: [
      ['unchanged', 'TXN_ID',       'VARCHAR(32)',    'NO',  'TXN_ID',         'VARCHAR(32)',    'NO',  '—'],
      ['typed',     'ACCT_ID',      'VARCHAR(20)',    'NO',  'account_id',     'VARCHAR(20)',    'NO',  'rename + lower'],
      ['typed',     'AMT',          'NUMBER(15,2)',   'NO',  'amount',         'NUMERIC(18,2)',  'NO',  'cast NUMBER → NUMERIC'],
      ['removed',   'BAL_AMT',      'NUMBER(15,2)',   'NO',  null,             null,             null,  'DROP'],
      ['typed',     'EXEC_TM',      'DATE',           'NO',  'executed_at',    'TIMESTAMP',      'NO',  'cast DATE → TIMESTAMP'],
      ['typed',     'BR_ID',        'VARCHAR(8)',     'NO',  'branch_id',      'VARCHAR(8)',     'NO',  'rename'],
      ['unchanged', 'OPR_ID',       'VARCHAR(12)',    'YES', 'OPR_ID',         'VARCHAR(12)',    'YES', '—'],
      ['typed',     'CHANNEL_CD',   'CHAR(3)',        'NO',  'channel_code',   'VARCHAR(8)',     'NO',  'widen + rename'],
      ['unchanged', 'MEMO',         'VARCHAR(255)',   'YES', 'MEMO',           'VARCHAR(255)',   'YES', '—'],
      ['unchanged', 'REF_NO',       'VARCHAR(40)',    'YES', 'reference_no',   'VARCHAR(40)',    'YES', 'rename'],
      ['unchanged', 'CURRENCY_CD',  'CHAR(3)',        'NO',  'currency_code',  'CHAR(3)',        'NO',  'rename'],
      ['unchanged', 'STATUS',       'VARCHAR(8)',     'NO',  'status',         'VARCHAR(8)',     'NO',  'rename'],
      ['added',     null,           null,             null,  'tenant_id',      'VARCHAR(8)',     'NO',  "default 'T01'"],
    ],
    /* Summary: 메타 블록 + Kind/Count 표를 한 시트에 자유 형식으로. */
    Summary: [
      ['Schema diff summary', null, null, null],
      [null, null, null, null],
      ['ASIS table',     'CORE_TXN_JOURNAL_2024',   null, null],
      ['TOBE table',     'public.transaction_2024', null, null],
      ['ASIS columns',   11,                        null, null],
      ['TOBE columns',   12,                        null, null],
      [null, null, null, null],
      ['Kind',           'Count', '% of TOBE',     'Note'],
      ['+ added',        1,       '8.33%',         'tenant_id'],
      ['- removed',      1,       '—',             'BAL_AMT'],
      ['→ renamed',      0,       '—',             null],
      ['~ typed',        5,       '41.67%',        'ACCT_ID, AMT, EXEC_TM, BR_ID, CHANNEL_CD'],
      ['↕ reordered',    0,       '—',             null],
      ['unchanged',      6,       '50%',           null],
    ],
    /* Rules: 컬럼별 매핑 규칙 (rename / add 등) + 변환식. 12행. */
    Rules: [
      ['TXN_ID',     'CHAR(24)',             'PK transaction_id', 'VARCHAR(24)',   '✓', 'NO',  'rename', 'rename: TXN_ID → transaction_id'],
      ['ACCT_NO',    'CHAR(16)',             'account_no',        'VARCHAR(16)',   '—', 'NO',  'rename', 'rename: ACCT_NO → account_no'],
      ['—',          '—',                    'occurred_at',       'TIMESTAMP',     '—', 'NO',  'add',    '<add> default := NOW()'],
      ['AMT',        'COMP-3 S9(13)V99',     'amount',            'NUMERIC(15,2)', '—', 'NO',  'rename', 'unpack_comp3(AMT)'],
      ['DR_CR',      'CHAR(1)',              'direction',         'CHAR(1)',       '—', 'NO',  'rename', 'rename: DR_CR → direction'],
      ['BR_CODE',    'CHAR(4)',              'branch_code',       'CHAR(4)',       '—', 'NO',  'rename', 'rename: BR_CODE → branch_code'],
      ['CHANNEL_CD', 'CHAR(2)',              'channel',           'CHAR(16)',      '—', 'NO',  'rename', 'rename: CHANNEL_CD → channel'],
      ['MEMO',       'CHAR(40) EBCDIC-KANA', 'memo',              'VARCHAR(80)',   '—', 'YES', 'rename', "iconv(MEMO, 'EBCDIC-KANA' → 'UTF-8')"],
      ['—',          '—',                    'reference_id',      'VARCHAR(40)',   '—', 'NO',  'add',    '<add> default := NULL'],
      ['—',          '—',                    'currency_code',     'CHAR(3)',       '—', 'NO',  'add',    "<add> default := 'JPY'"],
      ['—',          '—',                    'reversal_of',       'VARCHAR(24)',   '—', 'YES', 'add',    '<add> default := NULL'],
      ['—',          '—',                    'created_at',        'TIMESTAMP',     '—', 'NO',  'add',    '<add> default := NOW()'],
    ],
    /* ASIS: legacy.CORE_TXN_JOURNAL_2024 컬럼 11개. */
    ASIS: [
      ['TXN_ID',      'VARCHAR(32)',  'NO',  true],
      ['ACCT_ID',     'VARCHAR(20)',  'NO',  false],
      ['AMT',         'NUMBER(15,2)', 'NO',  false],
      ['BAL_AMT',     'NUMBER(15,2)', 'NO',  false],
      ['EXEC_TM',     'DATE',         'NO',  false],
      ['BR_ID',       'VARCHAR(8)',   'NO',  false],
      ['OPR_ID',      'VARCHAR(12)',  'YES', false],
      ['CHANNEL_CD',  'CHAR(3)',      'NO',  false],
      ['MEMO',        'VARCHAR(255)', 'YES', false],
      ['REF_NO',      'VARCHAR(40)',  'YES', false],
      ['CURRENCY_CD', 'CHAR(3)',      'NO',  false],
    ],
    /* TOBE: public.transaction_2024 컬럼 12개 + 각 컬럼의 ASIS 출처. */
    TOBE: [
      ['transaction_id', 'VARCHAR(32)',   'NO',  true,  'TXN_ID'],
      ['account_id',     'VARCHAR(20)',   'NO',  false, 'ACCT_ID'],
      ['amount',         'NUMERIC(18,2)', 'NO',  false, 'AMT'],
      ['executed_at',    'TIMESTAMP',     'NO',  false, 'EXEC_TM'],
      ['branch_id',      'VARCHAR(8)',    'NO',  false, 'BR_ID'],
      ['OPR_ID',         'VARCHAR(12)',   'YES', false, 'OPR_ID'],
      ['channel_code',   'VARCHAR(8)',    'NO',  false, 'CHANNEL_CD'],
      ['MEMO',           'VARCHAR(255)',  'YES', false, 'MEMO'],
      ['reference_no',   'VARCHAR(40)',   'YES', false, 'REF_NO'],
      ['currency_code',  'CHAR(3)',       'NO',  false, 'CURRENCY_CD'],
      ['status',         'VARCHAR(8)',    'NO',  false, 'STATUS'],
      ['tenant_id',      'VARCHAR(8)',    'NO',  false, "default 'T01'"],
    ],
  },
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
  /* Validation 의 4 시트 mock — 프로토타입 (cust_profile.report.xlsx) 기준. */
  validation: {
    /* Overview: free-form 레이아웃 — 메타 + Check 표 + Total 행. */
    Overview: [
      ['Validation report · CUST_PROFILE', null, null, null],
      [null, null, null, null],
      ['ASIS table',  'CORE.CUST_PROFILE ⋈ CORE.CUST_CONTACT', null, null],
      ['TOBE table',  'public.customer',                       null, null],
      ['Generated',   '2026-04-21 09:41 JST',                  null, null],
      [null, null, null, null],
      ['Check',                          'ASIS',                 'TOBE',                 'Verdict'],
      ['Row count',                      '22,488,541',           '22,488,541',           '✓ PASS'],
      ['SHA-256 checksum',               'sha256:8a2c…e109',     'sha256:8a2c…e109',     '✓ PASS'],
      ['Sum reconciliation (1 cols)',    '—',                    '—',                    '✓ PASS'],
      ['NULL count parity (14 cols)',    '—',                    '—',                    '✓ PASS'],
      ['Range/overflow (1 cols)',        '—',                    '—',                    '✓ PASS'],
      [null, null, null, null],
      ['Total',                          '18',                   '18 pass',              '0 fail'],
    ],
    /* Sum recon: 합계 검증 — risk_tier 한 컬럼만 검사. */
    'Sum recon': [
      ['risk_tier', 'SMALLINT', '741,312,166,603', '741,312,166,603', '0.000000%', '✓ PASS'],
    ],
    /* NULL parity: 컬럼별 NULL 개수 비교 — 15행. */
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
    /* Range: SMALLINT/INT 등의 컬럼 범위/오버플로 검사. */
    Range: [
      ['risk_tier', 'SMALLINT', '±9999999999999999', '8.21e+9', 0, '✓'],
    ],
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

/* 카테고리별 자식 산출물 목록 — 트리에 자식 항목으로 표시되고,
   클릭하면 워크북 타이틀바 파일명이 `<child><category.suffix>` 로 갱신된다.
   Dashboard 처럼 프로젝트 단위 단일 산출물은 child 1개,
   나머지(테이블 단위 산출물)는 MOCK_TABLES 그대로 사용. */
const CHILD_TABLES: Record<CategoryKey, string[]> = {
  dashboard:  ['dashboard-snapshot'],
  diff:       MOCK_TABLES,
  ddl:        MOCK_TABLES,
  sql:        MOCK_TABLES,
  validation: MOCK_TABLES,
};

/* 카테고리별 fx 수식바 mock context — 시트 개수/카운트 등 상위 요약 값. */
const MOCK_FORMULA_CTX: Record<CategoryKey, FormulaContext> = {
  dashboard:  { n: 18, progress: 32.8 },
  diff:       { ASIS: 'legacy_db', TOBE: 'new_db', added: 1, removed: 1, changed: 2 },
  ddl:        { table: 'm_user', n: 6, pk: 1 },
  sql:        { ASIS: 'legacy_db', TOBE: 'new_db', n: 5 },
  validation: { table: 'CUST_PROFILE', n: 5 },
};

/** 시각적으로 렌더할 빈 데이터 행 수 — 실데이터 개수(dataRows.length)와는 별개 */
const EMPTY_ROWS = 20;

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
};

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
    /* unchanged 는 prototype 처럼 배경 없이 dim text 만. row 도 흰색 유지. */
    badge: { background: 'transparent', color: '#888', borderColor: 'transparent' },
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

/* xlsx 다운로드 (mock) — 실제 xlsx 바이너리 대신 CSV 로 저장.
   실데이터 wiring 시 sheetjs/xlsx-js 같은 라이브러리로 교체. */
function downloadSheetAsXlsx(filename: string, cols: { name: string }[], rows: Cell[][]): void {
  const escape = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const header = cols.map((c) => escape(c.name)).join(',');
  const body = rows.map((row) => row.map((v) => escape(formatCell(v))).join(',')).join('\n');
  /* CSV 본문이지만 파일명은 .xlsx 유지 (mock — 실제 xlsx 출력은 라이브러리 필요). */
  downloadText(filename, header + '\n' + body, 'text/csv');
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
     Dashboard 면 항상 'dashboard-snapshot', 다른 카테고리면 MOCK_TABLES[0]. */
  const selectedTable =
    selectedTableByCat[activeCategory.key] ?? CHILD_TABLES[activeCategory.key][0];
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
}

function ArtifactTree({
  openCats,
  setOpenCats,
  selectedCat,
  onSelect,
  selectedTableByCat,
  onSelectTable,
}: TreeProps) {
  const t = useT();
  return (
    <div style={styles.tree}>
      {CATEGORIES.map((cat) => {
        const open = openCats[cat.key];
        const active = selectedCat === cat.key;
        const tables = CHILD_TABLES[cat.key];
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

/** Diff 배너의 카운트 칩 — `<prefix> <count> <name>` 형식 (예: `+ 5 added`, `→ 7 renamed`).
   unchanged 는 prefix 없이 `<count> unchanged` 만. */
function DiffChip({ kind, n }: { kind: DiffStatusKey; n: number }) {
  const s = DIFF_STATUS_STYLE[kind];
  return (
    <span style={{ ...styles.diffChip, ...s.badge }}>
      {s.prefix ? `${s.prefix} ${n} ${s.name}` : `${n} ${s.name}`}
    </span>
  );
}

function ExcelWorkbook({
  category,
  projectName,
  selectedTable,
  activeSheet,
  onSelectSheet,
}: ExcelWorkbookProps) {
  const t = useT();
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
  const dataRows: Cell[][] = MOCK_ROWS[category.key]?.[activeSheet] ?? [];

  /* SQL 뷰일 때만 사용 — 현재 (table, sheet) 의 DDL 스크립트. */
  const isSqlView = category.viewType === 'sql';
  const sqlText: string =
    isSqlView && selectedTable
      ? DDL_SCRIPTS[selectedTable]?.[activeSheet as 'AS-IS' | 'TO-BE'] ?? ''
      : '';
  const sqlLines = sqlText ? sqlText.split('\n') : [];

  /* Diff 카테고리 — 선택된 테이블의 ASIS/TOBE 이름 & diff 카운트. */
  const diffMeta =
    category.key === 'diff' && selectedTable ? SCHEMA_DIFF_META[selectedTable] : undefined;

  const handleCopy = () => {
    void copyToClipboard(sqlText);
  };
  const handleDownload = () => {
    /* 다운로드 파일명: <table>.<sheet>.sql — 예: acct_master.AS-IS.ddl.sql */
    const dlName = `${baseName}.${activeSheet}${category.suffix}`;
    downloadText(dlName, sqlText, 'application/sql');
  };
  const handleDownloadXlsx = () => {
    /* 현재 시트를 xlsx (mock CSV) 로 저장. */
    const dlName = `${baseName}.${activeSheet}${category.suffix}`;
    downloadSheetAsXlsx(dlName, cols, dataRows);
  };

  /* fx 수식바 placeholder 치환 — projectName + 카테고리별 mock context.
     사이드바에서 테이블을 선택했으면 {table} 을 그 값으로 override.
     diff 카테고리면 선택 테이블의 SCHEMA_DIFF_META 로 ASIS/TOBE/카운트 override.
     실데이터 wiring 시 MOCK_FORMULA_CTX 자리에 실값 ctx 를 넣으면 됨. */
  const formulaText = substitute(SUMMARY_PLACEHOLDER[category.key], {
    project: projectName,
    ...MOCK_FORMULA_CTX[category.key],
    ...(selectedTable ? { table: selectedTable } : {}),
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

  return (
    <div style={styles.workbook}>
      {/* 1) Title bar — 가운데 정렬 파일명 + 우측 윈도우 버튼 */}
      <div style={styles.titleBar}>
        <div style={styles.titleBarCenter}>
          {filename} ({t('artifacts.workbook.readOnly')}) - Report
        </div>
        <div style={styles.titleBarRight}>
          {isSqlView ? (
            <>
              <button onClick={handleCopy} style={styles.titleBarActionBtn}>Copy</button>
              <button onClick={handleDownload} style={styles.titleBarActionBtn}>Download</button>
            </>
          ) : category.downloadType === 'xlsx' ? (
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

      {/* Diff 카테고리만 — title bar 직하 카운트 칩 배너.
          순서는 프로토타입대로: added → removed → renamed → typed → reordered → unchanged.
          unchanged 는 0 일 때도 표시 (dim text 로). */}
      {diffMeta && (
        <div style={styles.diffBanner}>
          {diffMeta.added     > 0 && <DiffChip kind="added"     n={diffMeta.added} />}
          {diffMeta.removed   > 0 && <DiffChip kind="removed"   n={diffMeta.removed} />}
          {diffMeta.renamed   > 0 && <DiffChip kind="renamed"   n={diffMeta.renamed} />}
          {diffMeta.typed     > 0 && <DiffChip kind="typed"     n={diffMeta.typed} />}
          {diffMeta.reordered > 0 && <DiffChip kind="reordered" n={diffMeta.reordered} />}
          <DiffChip kind="unchanged" n={diffMeta.unchanged} />
        </div>
      )}

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

      {/* 4) Sheet 본문 — viewType='sql' 이면 코드 뷰, 아니면 Excel 그리드 */}
      {isSqlView ? (
        <div style={styles.sqlArea}>
          <pre style={styles.sqlPre}>
            {sqlLines.map((line, i) => (
              <div key={i} style={styles.sqlLineRow}>
                <span style={styles.sqlLineNo}>{i + 1}</span>
                <span style={styles.sqlLineCode}>{highlightSqlLine(line, i)}</span>
              </div>
            ))}
          </pre>
        </div>
      ) : (
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
            {/* (D) 데이터 행 + 시각적 빈 행 padding.
                 - Dashboard/Validation Status 컬럼 → running/blocked/warn/done 배지
                 - Diff 시트 Status 컬럼 → added/removed/typed/... 배지 + 행 전체 색 tint */}
            {Array.from({ length: Math.max(EMPTY_ROWS, dataRows.length) }, (_, r) => {
              const row = dataRows[r];
              /* Diff 시트면 Status 값(enum key)으로, Summary 시트면 첫 컬럼 라벨로 행 색을 결정. */
              const diffStatusKey: DiffStatusKey | undefined =
                category.key === 'diff' && activeSheet === 'Diff' && row
                  ? (row[0] as DiffStatusKey | undefined)
                  : category.key === 'diff' && activeSheet === 'Summary' && row
                    ? detectSummaryKind(row[0])
                    : undefined;
              const rowTint = diffStatusKey ? DIFF_STATUS_STYLE[diffStatusKey]?.rowTint : undefined;
              return (
                <tr key={r}>
                  <td style={styles.rowHeader}>{r + 3}</td>
                  {cols.map((col, c) => {
                    const value = row ? row[c] : null;
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
                    return (
                      <td
                        key={c}
                        style={{
                          ...styles.cell,
                          ...(cellBg ?? {}),
                          ...(diffBadgeStyle ?? plainBadgeStyle ?? ruleBadgeStyle ?? verdictBadgeStyle ?? {}),
                        }}
                      >
                        {isDiffStatus
                          ? DIFF_STATUS_STYLE[diffStatusKey!]?.label
                          : row
                            ? formatCell(value)
                            : ''}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      )}

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

      {/* 6) Status bar — grid 면 cols/rows, sql 이면 lines */}
      <div style={styles.statusBar}>
        Ready ·{' '}
        {isSqlView ? (
          <>lines <span style={styles.statusNum}>{sqlLines.length}</span></>
        ) : (
          <>
            cols <span style={styles.statusNum}>{cols.length}</span> · rows{' '}
            <span style={styles.statusNum}>{dataRows.length}</span>
          </>
        )}
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
};
