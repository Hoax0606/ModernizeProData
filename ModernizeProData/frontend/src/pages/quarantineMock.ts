/**
 * Quarantine groups — rule-violation 기반의 격리 묶음 mock.
 *
 * 한 group = 한 가지 위반 사유(reason). row 들이 그 사유로 격리된다.
 * 화면(LogViewerPage 의 Quarantine 모드) 은 group 단위 카드 + sample rows 표.
 *
 * BE 가 들어오면 `/api/v1/runs/{runId}/quarantine` 가 같은 shape 으로 응답할 것.
 * 그때 buildQuarantineGroups 호출 부분을 fetch 결과로 swap.
 *
 * ─── columns 선택 컨벤션 ──────────────────────────────────────────────
 * 한 테이블이 보통 20~60 컬럼이라 모든 컬럼을 표에 그대로 그리면 가로 스크롤이
 * 과해 운영자가 분류 작업하기 어렵다. 그래서 각 group 은 **3 종류의 컬럼만**
 * 골라 보여준다 — 이 셋이 카드의 가독성·진단력 균형점:
 *
 *   pk       : 식별자 — "어느 행인지" 알아보는 키 (보통 테이블 PK 또는 surrogate ID).
 *   violated : 위반 룰이 직접 참조한 컬럼 — 격리 사유의 원인. UI 에서 강조.
 *   context  : 참고용 인접 컬럼 — 행의 비즈니스 맥락 (금액·이름 등) 으로 우선순위
 *              판단을 돕는다. 1~2 개만.
 *
 * columns / columnRoles 배열은 같은 인덱스로 매칭. 길이 동일.
 *
 * ─── BE 가 들어오면 columns / columnRoles 결정 룰 ────────────────────
 *   pk       ← 테이블 DDL (V7__ddl_schema.sql) 의 primary key 정의에서 자동
 *   violated ← validation rule 정의의 `column` 필드에서 자동 추출
 *   context  ← rule 정의의 `context_columns` 옵션 (운영자가 룰 작성 시 명시)
 *              없으면 BE 휴리스틱 (자주 조회되는 컬럼·금액 등) 으로 결정
 *
 * 즉 UI 는 이 shape 만 받으면 동작이 동일하다. 룰 정의 → DB → 응답까지의
 * 결정 과정은 BE 책임.
 */
/* 'pk'/'violated'/'context' = row 단위 위반(error 류) 표시용.
   'metric'/'asis_value'/'tobe_value' = 집계 비교 위반(validate.min_max / validate.checksum 등 warning)
   에서 BE 가 보내는 롤 — metric=비교 대상(컬럼/테이블명), asis_value=AS-IS 측 값, tobe_value=TO-BE 측 값.
   (이 롤들을 헬퍼가 인식해야 warning 카드도 error 처럼 무엇이 다른지 값으로 보여준다 — 2026-06-01 fix) */
export type QuarantineColumnRole =
  | 'pk' | 'violated' | 'context'
  | 'metric' | 'asis_value' | 'tobe_value';

export type QuarantineSeverity = 'error' | 'warning';

export type QuarantineCell = string | number | null;

/** WARN 그룹의 명시 ack 메타 — BE QuarantineController.byRun 응답의 ack 필드. */
export interface QuarantineGroupAck {
  acknowledgmentId: number;
  acknowledgedBy: string;
  acknowledgedAt: string;                        // ISO timestamp
  phase: 'test' | 'rehearsal' | 'cutover';
}

export interface QuarantineGroup {
  id: string;
  bindingId?: string;                            // BE 만 채움. mock 은 비움. parquet 다운로드 endpoint key.
  reason: string;                                // 짧은 제목 — severity color 로 강조
  detail: string;                                // 세부 (어떤 컬럼/제약), 예: "GL_ENTRY.acct_no → ACCT_MASTER.account_no"
  severity: QuarantineSeverity;
  stage: string;                                 // 검증 stage, 예: "validate.fk"
  firstSeenAt: string;                           // ISO timestamp
  table: string;                                 // 대상 테이블
  columns: string[];                             // sample row 의 컬럼 헤더 (3 종 분류: pk + violated + context)
  columnRoles: QuarantineColumnRole[];           // columns 와 같은 인덱스 — 각 컬럼의 역할
  sampleRows: QuarantineCell[][];                // 각 row = columns 순서대로의 셀
  /**
   * 각 sampleRow 와 같은 인덱스로 매칭되는 TO-BE 값. 룰 엔진의 transform 시도 결과:
   *  - 대부분의 검증 실패 (FK / notnull / range / type / lookup / unique-dup) → null (행 자체가 거부됨)
   *  - validate.length → 잘린 문자열 (loader 가 truncate 후 적재한 결과)
   *  - encode fallback → U+FFFD 로 대체된 문자열 (적재는 됐으나 데이터 일부 손상)
   *  - verify.checksum → null (행이 적재됐으나 group 단위로 거부)
   * BE 가 들어오면 룰 엔진의 실제 transform 출력을 그대로 채움.
   */
  toBeValues?: QuarantineCell[];
  rowCount: number;                              // 그룹의 총 violated row 수 (sampleRows.length 보다 클 수 있음)
  /** AS-IS CSV fingerprint (BE 만 채움). WARN ack 시 그대로 전송 → 같은 CSV 재실행 시 carry-over (정책 3·6). */
  csvMtimeMs?: number | null;
  csvSize?: number | null;
  /** 명시 ack 메타. null/undefined = ack 없음. 같은 (binding, rule, reason) 의 carry-over ack. */
  ack?: QuarantineGroupAck | null;
  /** 같은 group key (binding+rule+reason) 의 explicit ack 총 개수 — fingerprint 무관.
   *  ack==null + priorAckCount>0 = "다른 CSV/phase 의 ack 만 있음" → FE 가 hint 표시. */
  priorAckCount?: number;
}

/**
 * 결정적 mock — runId 와 무관하게 같은 6 group / 36 rows / 8 error · 28 warning
 * 분포를 만들어 화면 검증을 쉽게 한다.
 */
export function buildQuarantineGroups(_runId: string): QuarantineGroup[] {
  return [
    {
      id: 'g1',
      reason: 'FK violation — child key not found in parent',
      detail: 'GL_ENTRY.acct_no → ACCT_MASTER.account_no',
      severity: 'error',
      stage: 'validate.fk',
      firstSeenAt: timeAt(9, 41, 6, 998),
      table: 'GL_ENTRY',
      columns:     ['TXN_ID', 'ACCT_NO',  'AMT'],
      columnRoles: ['pk',     'violated', 'context'],
      sampleRows: [
        ['T20240315001', 'AC00881104', 1250],
        ['T20240315002', 'AC00881105', 88200],
        ['T20240315003', 'AC00881106', 450],
        ['T20240315004', 'AC00881107', 12540.5],
      ],
      /* FK 위반 — JOIN 미스로 행 자체가 거부됨. */
      toBeValues: [null, null, null, null],
      rowCount: 4,
    },
    {
      id: 'g2',
      reason: 'NOT NULL violation — required column is empty',
      detail: 'CUSTOMER.email is NULL',
      severity: 'error',
      stage: 'validate.notnull',
      firstSeenAt: timeAt(9, 41, 7, 142),
      table: 'CUSTOMER',
      columns:     ['CUST_ID', 'NAME',    'EMAIL'],
      columnRoles: ['pk',      'context', 'violated'],
      sampleRows: [
        ['C001023', '佐藤 美咲',    null],
        ['C001047', '김민준',       null],
        ['C001088', 'Liu Wei',      null],
        ['C001094', '田中 健一',    null],
      ],
      /* NOT NULL — 빈 값 그대로 거부됨. */
      toBeValues: [null, null, null, null],
      rowCount: 4,
    },
    {
      id: 'g3',
      reason: 'Unique key duplicate — second occurrence dropped',
      detail: 'PRODUCT.sku duplicated 6 times across batch',
      severity: 'warning',
      stage: 'validate.unique',
      firstSeenAt: timeAt(9, 41, 8, 305),
      table: 'PRODUCT',
      columns:     ['SKU',      'NAME',    'PRICE'],
      // SKU 는 PK 이자 unique 위반의 직접 대상이라 둘 다 해당 — UI 강조 우선이라 violated.
      columnRoles: ['violated', 'context', 'context'],
      sampleRows: [
        ['SKU-44011', 'Cable HDMI 2m',     1980],
        ['SKU-44011', 'Cable HDMI 2m',     1980],
        ['SKU-90238', 'USB-C Hub 7-in-1',  4480],
        ['SKU-90238', 'USB-C Hub 7-in-1',  4480],
        ['SKU-12345', 'Wireless Mouse',     890],
        ['SKU-12345', 'Wireless Mouse',     890],
      ],
      /* Unique dup — 첫 occurrence 만 적재, 2번째는 dropped. */
      toBeValues: ['SKU-44011', null, 'SKU-90238', null, 'SKU-12345', null],
      rowCount: 6,
    },
    {
      id: 'g4',
      reason: 'Value out of range — negative qty',
      detail: 'ORDERS.qty must be ≥ 0',
      severity: 'warning',
      stage: 'validate.range',
      firstSeenAt: timeAt(9, 41, 9, 511),
      table: 'ORDERS',
      columns:     ['ORDER_ID', 'PRODUCT_SKU', 'QTY'],
      columnRoles: ['pk',       'context',     'violated'],
      sampleRows: [
        ['O20240315-2201', 'SKU-12345',  -1],
        ['O20240315-2208', 'SKU-23456',  -3],
        ['O20240315-2219', 'SKU-34567',  -2],
        ['O20240315-2231', 'SKU-45678', -10],
        ['O20240315-2242', 'SKU-56789',  -1],
        ['O20240315-2255', 'SKU-67890',  -5],
        ['O20240315-2266', 'SKU-78901',  -7],
        ['O20240315-2278', 'SKU-89012', -12],
        ['O20240315-2289', 'SKU-90123',  -4],
        ['O20240315-2298', 'SKU-01234',  -2],
      ],
      /* Range — 음수 거부, 적재되지 않음. */
      toBeValues: [null, null, null, null, null, null, null, null, null, null],
      rowCount: 10,
    },
    {
      id: 'g5',
      reason: 'Type mismatch — value not parseable as DATE',
      detail: 'INVOICE.due_date format expected YYYY-MM-DD',
      severity: 'warning',
      stage: 'validate.type',
      firstSeenAt: timeAt(9, 41, 10, 84),
      table: 'INVOICE',
      columns:     ['INVOICE_NO', 'DUE_DATE', 'AMOUNT'],
      columnRoles: ['pk',         'violated', 'context'],
      sampleRows: [
        ['INV-2024-00891', '15/03/2024',    23800],
        ['INV-2024-00897', 'Mar 17 2024',    7400],
        ['INV-2024-00902', '2024.03.20',   91200],
        ['INV-2024-00911', '20240322',      1820],
        ['INV-2024-00920', '03-25-2024',    4560],
        ['INV-2024-00928', '25-Mar-2024',  12300],
        ['INV-2024-00935', '2024年3月27日',  8700],
        ['INV-2024-00942', '',              2100],
      ],
      /* Type parse fail — UDF 가 null 반환, 행 거부. */
      toBeValues: [null, null, null, null, null, null, null, null],
      rowCount: 8,
    },
    {
      id: 'g6',
      reason: 'Length exceeded — value longer than column allows',
      detail: 'CUSTOMER.phone defined VARCHAR(20)',
      severity: 'warning',
      stage: 'validate.length',
      firstSeenAt: timeAt(9, 41, 10, 776),
      table: 'CUSTOMER',
      columns:     ['CUST_ID', 'PHONE'],
      columnRoles: ['pk',      'violated'],
      sampleRows: [
        ['C001112', '+81-90-1234-5678 ext.2024'],
        ['C001127', '+82-10-2345-6789 (mobile)'],
        ['C001145', '+86-13-9876-5432 (work)'],
        ['C001168', '+81-3-1234-5678 / 090-1111-2222'],
      ],
      /* Length VARCHAR(20) — loader 가 앞 20자만 잘라 적재 (truncation warning). */
      toBeValues: [
        '+81-90-1234-5678 ext',
        '+82-10-2345-6789 (mo',
        '+86-13-9876-5432 (wo',
        '+81-3-1234-5678 / 09',
      ],
      rowCount: 4,
    },
  ];
}

/**
 * Site 전체 quarantine 보기용 — "전체 프로젝트를 한 번에 실행했을 때" 집계된 격리 묶음.
 *
 * 의미상 LogViewer 의 per-project quarantine 과는 다른 이벤트 (개별 run vs 통합 run)
 * 라서 mock 도 독립된 base 데이터를 사용한다. buildQuarantineGroups 를 호출하지 않음.
 * 각 group 은 어느 프로젝트에서 발생했는지 projectId 메타를 들고 있으며, 같은 사이트
 * 의 프로젝트들에 round-robin 으로 배정된다.
 *
 * BE 가 들어오면 `/api/v1/sites/{siteId}/quarantine` 가 같은 shape 으로 응답할 것.
 */
export interface SiteQuarantineGroup extends QuarantineGroup {
  projectId: string;
  projectName: string;
}

function buildSiteQuarantineBase(): QuarantineGroup[] {
  return [
    {
      id: 'sg1',
      reason: 'Orphan child — referenced parent not migrated yet',
      detail: 'ORDER_ITEM.order_id has no matching ORDER_HEADER.id',
      severity: 'error',
      stage: 'validate.fk',
      firstSeenAt: timeAt(10, 12, 4, 211),
      table: 'ORDER_ITEM',
      columns:     ['ITEM_ID', 'ORDER_ID', 'QTY'],
      columnRoles: ['pk',      'violated', 'context'],
      sampleRows: [
        ['I-9920113', 'O-7700451', 3],
        ['I-9920114', 'O-7700452', 1],
        ['I-9920120', 'O-7700458', 5],
        ['I-9920133', 'O-7700471', 2],
        ['I-9920147', 'O-7700485', 1],
      ],
      toBeValues: [null, null, null, null, null],
      rowCount: 5,
    },
    {
      id: 'sg2',
      reason: 'Currency code unknown — not in ISO-4217 lookup',
      detail: 'PAYMENT.currency_cd not found in lookup CURRENCY_CODE',
      severity: 'error',
      stage: 'validate.lookup',
      firstSeenAt: timeAt(10, 12, 5, 84),
      table: 'PAYMENT',
      columns:     ['PAYMENT_ID',  'CURRENCY_CD', 'AMOUNT'],
      columnRoles: ['pk',          'violated',    'context'],
      sampleRows: [
        ['PMT-2024-3301', 'JPN', 145000],
        ['PMT-2024-3309', 'KRW', 320000],
        ['PMT-2024-3317', 'CNY', 56000],
      ],
      toBeValues: [null, null, null],
      rowCount: 3,
    },
    {
      id: 'sg3',
      reason: 'Date out of range — value exceeds target column',
      detail: 'CONTRACT.expiry_date > 9999-12-31',
      severity: 'warning',
      stage: 'validate.range',
      firstSeenAt: timeAt(10, 12, 6, 470),
      table: 'CONTRACT',
      columns:     ['CONTRACT_NO', 'EXPIRY_DATE', 'CUSTOMER_ID'],
      columnRoles: ['pk',          'violated',    'context'],
      sampleRows: [
        ['CT-001022', '99991231', 'C001023'],
        ['CT-001047', '99991231', 'C001047'],
        ['CT-001088', '99991231', 'C001088'],
        ['CT-001112', '99991231', 'C001112'],
      ],
      toBeValues: [null, null, null, null],
      rowCount: 4,
    },
    {
      id: 'sg4',
      reason: 'Checksum mismatch — batch sum differs from header',
      detail: 'BATCH_REPORT.sum_amount ≠ Σ TXN.amount',
      severity: 'error',
      stage: 'verify.checksum',
      firstSeenAt: timeAt(10, 12, 7, 612),
      table: 'BATCH_REPORT',
      columns:     ['BATCH_ID',   'SUM_AMOUNT', 'EXPECTED'],
      columnRoles: ['pk',         'violated',   'context'],
      sampleRows: [
        ['BR-20240315-01', 12450000, 12455000],
        ['BR-20240315-04',  8200500,  8201000],
      ],
      toBeValues: [null, null],
      rowCount: 2,
    },
    {
      id: 'sg5',
      reason: 'Encoding fallback — undecodable bytes replaced with U+FFFD',
      detail: 'KYC_DOCUMENT.note_text contains 0xFA (CP-037 out of range)',
      severity: 'warning',
      stage: 'encode',
      firstSeenAt: timeAt(10, 12, 8, 38),
      table: 'KYC_DOCUMENT',
      columns:     ['DOC_ID',   'NOTE_TEXT', 'OWNER_ID'],
      columnRoles: ['pk',       'violated',  'context'],
      sampleRows: [
        ['KYC-44011', 'Customer state: �����', 'C001023'],
        ['KYC-44023', '���正常',                'C001047'],
        ['KYC-44031', '���',                    'C001088'],
        ['KYC-44045', 'unreadable ��',          'C001112'],
        ['KYC-44058', 'note ��',                'C001127'],
        ['KYC-44062', '���',                    'C001145'],
        ['KYC-44071', '���',                    'C001168'],
      ],
      /* Encoding fallback — 행은 적재됐으나 일부 글자가 U+FFFD 로 손상됨. */
      toBeValues: [
        'Customer state: �����',
        '���正常',
        '���',
        'unreadable ��',
        'note ��',
        '���',
        '���',
      ],
      rowCount: 7,
    },
    {
      id: 'sg6',
      reason: 'Length exceeded — value longer than column allows',
      detail: 'CUSTOMER.address VARCHAR(120) — Shift-JIS expansion overflow',
      severity: 'warning',
      stage: 'validate.length',
      firstSeenAt: timeAt(10, 12, 9, 920),
      table: 'CUSTOMER',
      columns:     ['CUST_ID', 'ADDRESS'],
      columnRoles: ['pk',      'violated'],
      sampleRows: [
        ['C001023', '東京都千代田区丸の内一丁目1-1 丸ビル25階 (アジア太平洋本部宛て)'],
        ['C001047', '서울특별시 강남구 테헤란로 521 파르나스타워 27층'],
        ['C001088', '上海市黄浦区南京东路100号 国际中心写字楼 35层 (亚太总部)'],
      ],
      /* Length VARCHAR(120) — UTF-8 변환 후 잘림. 가시화를 위해 앞 40자만 표시. */
      toBeValues: [
        '東京都千代田区丸の内一丁目1-1 丸ビル25階 (アジア太平洋本部宛',
        '서울특별시 강남구 테헤란로 521 파르나스타워 27',
        '上海市黄浦区南京东路100号 国际中心写字楼 35层 (亚',
      ],
      rowCount: 3,
    },
  ];
}

export function buildSiteQuarantineGroups(
  projects: ReadonlyArray<{ id: string; name: string }>,
): SiteQuarantineGroup[] {
  if (projects.length === 0) return [];
  const base = buildSiteQuarantineBase();
  /* group 을 프로젝트들에 round-robin 으로 배정 — 같은 group 이 모든 project 에 복제되지 않음. */
  return base.map((g, i) => {
    const p = projects[i % projects.length];
    return { ...g, projectId: p.id, projectName: p.name };
  });
}

/**
 * Stream 의 ERROR/WARN 라인 카운트와 Quarantine 카드 뷰의 rowCount 합계가
 * 어긋나지 않도록 logViewerMock 이 이 값을 import 해서 generation 한다.
 * quarantineMock 이 single source of truth.
 */
export function quarantineTotals(): { errRows: number; warnRows: number } {
  const groups = buildQuarantineGroups('totals');
  let errRows = 0, warnRows = 0;
  for (const g of groups) {
    if (g.severity === 'error') errRows += g.rowCount; else warnRows += g.rowCount;
  }
  return { errRows, warnRows };
}

/** Today 09:41:xx — 화면 비교용 결정적 timestamp. */
function timeAt(h: number, m: number, s: number, ms: number): string {
  const d = new Date();
  d.setHours(h, m, s, ms);
  return d.toISOString();
}

/* ──────────────────────────────────────────────── humanize ────────── */

/**
 * Quarantine group 의 원시 필드(stage / table / columnRoles / detail) 에서
 * 사람말 한 줄 설명을 도출. 하드코딩이 아니라 데이터에서 파생되므로
 * BE 가 같은 shape 으로 데이터를 내려줘도 그대로 동작한다.
 *
 *  - stage 로 위반 종류 분기.
 *  - 컬럼 이름은 columnRoles 의 violated 위치에서 자동 추출.
 *  - FK 류는 detail 의 "A.col → B.col" 패턴을 파싱해 자식/부모 양쪽을 넣음.
 *  - stage 가 알 수 없거나 데이터가 부족하면 null — 카드는 그 줄을 숨김.
 */
type HumanizeT = (key: string, vars?: Record<string, string>) => string;

const FK_ARROW_RE = /([^\s.]+)\.([^\s.]+)\s*→\s*([^\s.]+)\.([^\s.]+)/;

export function humanizeQuarantineDetail(
  g: QuarantineGroup,
  t: HumanizeT,
): string | null {
  const violatedIdx = g.columnRoles.findIndex((r) => r === 'violated');
  const violatedCol = violatedIdx >= 0 ? g.columns[violatedIdx] : null;

  /* FK / lookup — detail 의 "A.col → B.col" 패턴을 우선 시도. */
  if (g.stage === 'validate.fk' || g.stage === 'validate.lookup') {
    const m = FK_ARROW_RE.exec(g.detail);
    if (m) {
      return t('logs.quarantine.human.fk', {
        childTable:  m[1], childCol:  m[2],
        parentTable: m[3], parentCol: m[4],
      });
    }
    if (violatedCol) {
      return t('logs.quarantine.human.lookup', { table: g.table, col: violatedCol });
    }
    return null;
  }

  /* 단일 컬럼 위반 — violated 컬럼 이름 필요. */
  if (!violatedCol) {
    if (g.stage === 'verify.checksum') {
      return t('logs.quarantine.human.checksum', { table: g.table });
    }
    return null;
  }

  switch (g.stage) {
    case 'validate.notnull': return t('logs.quarantine.human.notnull', { table: g.table, col: violatedCol });
    case 'validate.unique':  return t('logs.quarantine.human.unique',  { table: g.table, col: violatedCol });
    case 'validate.range':   return t('logs.quarantine.human.range',   { table: g.table, col: violatedCol });
    case 'validate.type':    return t('logs.quarantine.human.type',    { table: g.table, col: violatedCol });
    case 'validate.length':  return t('logs.quarantine.human.length',  { table: g.table, col: violatedCol });
    case 'verify.checksum':  return t('logs.quarantine.human.checksum',{ table: g.table });
    case 'encode':           return t('logs.quarantine.human.encode',  { table: g.table, col: violatedCol });
    default:                 return null;
  }
}

/**
 * 한 group 의 TO-BE 제약 한 줄. detail / stage 에서 가능한 만큼 구체적으로 파싱
 * (예: VARCHAR(20) → "≤ 20 글자", "≥ 0" → "0 이상", YYYY-MM-DD → "YYYY-MM-DD 형식").
 * BE 가 같은 detail 포맷으로 내려주면 그대로 동작. 못 알아보면 일반 라벨로 fallback.
 */
export function quarantineToBeConstraint(g: QuarantineGroup, t: HumanizeT): string {
  if (g.stage === 'validate.fk' || g.stage === 'validate.lookup') {
    const m = FK_ARROW_RE.exec(g.detail);
    if (m) return t('logs.quarantine.tobe.fk', { parentTable: m[3], parentCol: m[4] });
    return t('logs.quarantine.tobe.lookup');
  }
  switch (g.stage) {
    case 'validate.notnull': return t('logs.quarantine.tobe.notnull');
    case 'validate.unique':  return t('logs.quarantine.tobe.unique');
    case 'validate.range': {
      const m = /≥\s*(-?\d+)/.exec(g.detail);
      if (m) return t('logs.quarantine.tobe.rangeGte', { n: m[1] });
      return t('logs.quarantine.tobe.range');
    }
    case 'validate.type': {
      const m = /(Y{2,4}[-/]M{1,2}[-/]D{1,2})/.exec(g.detail);
      if (m) return t('logs.quarantine.tobe.typeFormat', { fmt: m[1] });
      return t('logs.quarantine.tobe.type');
    }
    case 'validate.length': {
      const m = /VARCHAR\s*\(\s*(\d+)\s*\)/i.exec(g.detail);
      if (m) return t('logs.quarantine.tobe.lengthLte', { n: m[1] });
      return t('logs.quarantine.tobe.length');
    }
    case 'verify.checksum': return t('logs.quarantine.tobe.checksum');
    case 'encode':          return t('logs.quarantine.tobe.encode');
    default:                return '';
  }
}

/** sample row 의 AS-IS 표시값. row 위반은 'violated', 집계 비교(warning)는 'asis_value' 컬럼. 없으면 null. */
export function quarantineRowAsIs(g: QuarantineGroup, rowIdx: number): QuarantineCell {
  let idx = g.columnRoles.findIndex((r) => r === 'violated');
  if (idx < 0) idx = g.columnRoles.findIndex((r) => r === 'asis_value');
  if (idx < 0) return null;
  return g.sampleRows[rowIdx]?.[idx] ?? null;
}

/** sample row 의 식별 컬럼 값. row 위반은 'pk', 집계 비교(warning)는 'metric'(비교 대상명). 없으면 null. */
export function quarantineRowPk(g: QuarantineGroup, rowIdx: number): QuarantineCell {
  let idx = g.columnRoles.findIndex((r) => r === 'pk');
  if (idx < 0) idx = g.columnRoles.findIndex((r) => r === 'metric');
  if (idx < 0) return null;
  return g.sampleRows[rowIdx]?.[idx] ?? null;
}

/** 식별 컬럼명 — 헤더 fallback 라벨용. 'pk' 없으면 'metric'. 없으면 null. */
export function quarantinePkColumnName(g: QuarantineGroup): string | null {
  let idx = g.columnRoles.findIndex((r) => r === 'pk');
  if (idx < 0) idx = g.columnRoles.findIndex((r) => r === 'metric');
  return idx >= 0 ? g.columns[idx] ?? null : null;
}

/** violated 컬럼명 — 헤더 AS-IS 옆 표기용. row 위반에서만 의미 있음(집계 비교 warning 은 metric 열/reason 이 대상 표시). 없으면 null. */
export function quarantineViolatedColumnName(g: QuarantineGroup): string | null {
  const idx = g.columnRoles.findIndex((r) => r === 'violated');
  return idx >= 0 ? g.columns[idx] ?? null : null;
}

/** TO-BE 표시값. 룰 엔진 transform 결과(toBeValues) 우선, 없으면 집계 비교(warning)의 'tobe_value' 컬럼. */
export function quarantineRowToBe(g: QuarantineGroup, rowIdx: number): QuarantineCell {
  if (Array.isArray(g.toBeValues)) return g.toBeValues[rowIdx] ?? null;
  const idx = g.columnRoles.findIndex((r) => r === 'tobe_value');
  if (idx >= 0) return g.sampleRows[rowIdx]?.[idx] ?? null;
  return null;
}
