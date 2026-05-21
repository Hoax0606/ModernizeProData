import type { RunLogLine } from '../api/runLogs';

/**
 * LogViewer demo / mock generator.
 *
 *  - 결정적 (seq → 동일 값). 데모 도중 새로고침해도 같은 화면.
 *  - 금융 데이터 이행 도메인의 실제 로그 톤 흉내 (LOAD/CHECKSUM/FK violation/encoding 등).
 *  - 비율: ~80% INFO / 13% WARN / 7% ERROR.
 *  - ERROR 라인은 suggestion 포함. 액션 버튼이 그 위에 떠야 함.
 *
 *  실제 BE ingest 가 들어오면 LogViewerPage 의 USE_MOCK 플래그만 false 로 돌려 떼낸다.
 */

const TABLES = [
  'TXN_JOURNAL_2024', 'ACCT_MASTER', 'GL_ENTRY', 'GL_BALANCE',
  'LOAN_REPAYMENT', 'KYC_DOCUMENT', 'LAST_CONTACT',
  'CUSTOMER_PROFILE', 'PAYMENT_INSTRUCTION', 'BRANCH_LEDGER',
];

interface Tmpl {
  stage: string;
  level: number;            // 0 INFO 1 WARN 2 ERROR
  build: (i: number) => string;
  suggestion?: string;
}

const TEMPLATES: Tmpl[] = [
  // INFO — 대부분 차지하는 잡음
  { stage: 'loader.copy',  level: 0, build: (i) => `LOAD ${tableFor(i)} chunk=${(rnd(i) % 50) + 1} rows=50000 elapsed=${280 + rnd(i) % 80}ms` },
  { stage: 'loader.batch', level: 0, build: (i) => `read /vol/etl/${tableFor(i)} chunk=${(rnd(i) % 50) + 1} bytes=104857000 elapsed=${680 + rnd(i + 1) % 120}ms` },
  { stage: 'transform',    level: 0, build: (i) => `stage.transform unicode normalize NFC items=${(rnd(i) % 24) + 1}/24 ok` },
  { stage: 'rule.apply',   level: 0, build: (i) => `rule.apply tax_code remap 0xC3 → JIS-1 chunk=${rnd(i) % 40} skipped=0` },
  { stage: 'rule.apply',   level: 0, build: (i) => `rule.apply currency_cy zero pad rows=${20000 + rnd(i) % 10000} alt=- chunk=${rnd(i) % 40}` },
  { stage: 'verify.checksum', level: 0, build: (i) => `CHECKSUM ${tableFor(i)} acct=${rnd(i) % 50} fund=0 elapsed=${20 + rnd(i) % 30}ms` },
  { stage: 'verify.checksum', level: 0, build: (i) => `CHECKSUM ${tableFor(i)} sha256-${(rnd(i) * 7).toString(16).slice(0, 4)} rows=${10000 + rnd(i) % 5000} elapsed=${30 + rnd(i) % 20}ms` },
  { stage: 'worker',       level: 0, build: (i) => `worker pool ${8 + rnd(i) % 8} active / 16 total` },
  { stage: 'queue',        level: 0, build: (i) => `queue depth=${30 + rnd(i) % 30}` },
  { stage: 'backpressure', level: 0, build: (i) => `backpressure lag ${200 + rnd(i) % 50}ms threshold=500ms = OK` },
  { stage: 'encode',       level: 0, build: (i) => `encode shift-jis → utf-8 rows=${5000 + rnd(i) % 5000} elapsed=${40 + rnd(i) % 30}ms` },
  { stage: 'validate.pk',  level: 0, build: (i) => `validate.pk ${tableFor(i)} unique=true rows=${10000 + rnd(i) % 8000}` },

  // WARN — 사진에 보이는 어두운 노랑 톤
  { stage: 'encode',    level: 1, build: (i) => `COMP-3 sign rebase unexpected 0xFF cell=${tableFor(i)} rows=${(rnd(i) % 5) + 1} fixed=${(rnd(i) % 5) + 1}` },
  { stage: 'transform', level: 1, build: (i) => `last_txn_ts null-coerced rows=${(rnd(i) % 20) + 1} table=${tableFor(i)}` },
  { stage: 'encode',    level: 1, build: (i) => `DETECTED EBCDIC byte 0x3F at offset 0x${(rnd(i) * 137).toString(16).toUpperCase().padStart(6, '0')} table=${tableFor(i)}` },
  { stage: 'rule.apply', level: 1, build: (i) => `rule.apply LOAN_REPAYMENT genealogy lookahead invalid rows=${(rnd(i) % 30) + 1}, alt=-` },

  // ERROR — 빨강 배경 + suggestion
  {
    stage: 'validate.fk', level: 2,
    build: (i) => `FK violation GL_ENTRY.acct_no → ACCT_MASTER.account_no rows=${(rnd(i) % 5) + 1} first=AC${(rnd(i) * 10000).toString().slice(0, 7)}N`,
    suggestion: '부모 레코드가 아직 로드되지 않았습니다. ACCT_MASTER 의 계좌 데이터가 먼저 적재되기를 기다리거나, 이 행을 quarantine 처리한 후 재시도하세요.',
  },
  {
    stage: 'verify.checksum', level: 2,
    build: (i) => `LOAN_REPAYMENT verify checksum mismatch JID ${rnd(i) * 100} fallback 0xFFFD rows=1`,
    suggestion: '원본 인코딩이 예상과 다릅니다. --encoding=cp932 옵션으로 다시 실행하거나, 해당 offset 의 raw byte 를 직접 확인하세요.',
  },
  {
    stage: 'rule.apply', level: 2,
    build: (i) => `icons divide-zero rule=PM-90 fix=0 row=${rnd(i) * 7}`,
    suggestion: 'PM-90 규칙에서 분자는 0 이 아닌데 분모가 0 인 행이 발견되었습니다. 상위 단계에 0-divide 가드를 추가하거나, 이 행을 quarantine 처리하세요.',
  },
  {
    stage: 'encode', level: 2,
    build: (i) => `invalid EBCDIC byte 0xFA at row=${(rnd(i) * 13) % 9999} table=KYC_DOCUMENT`,
    suggestion: 'CP-037 범위 밖의 바이트입니다. 텍스트 컬럼에 binary 데이터가 섞여 들어왔을 가능성이 높습니다. 이 행을 quarantine 처리하고 계속 진행하세요.',
  },
];

function tableFor(i: number): string { return TABLES[i % TABLES.length]; }

/** xorshift-ish — i 기반 결정적 의사난수 */
function rnd(i: number): number {
  let x = (i + 1) * 2654435761;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return (x & 0x7fffffff);
}

export function buildMockLines(runId: string, count = 240): RunLogLine[] {
  const lines: RunLogLine[] = [];
  // 250ms 간격, 240줄 = 약 60초 분량
  const baseTs = Date.now() - count * 250;

  const infoTpl  = TEMPLATES.filter((t) => t.level === 0);
  const warnTpl  = TEMPLATES.filter((t) => t.level === 1);
  const errorTpl = TEMPLATES.filter((t) => t.level === 2);

  for (let i = 0; i < count; i++) {
    const roll = rnd(i * 31) % 100;
    const pool = roll < 80 ? infoTpl : roll < 93 ? warnTpl : errorTpl;
    const t = pool[rnd(i * 17) % pool.length];
    const ts = new Date(baseTs + i * 250 + (rnd(i) % 200)).toISOString();
    lines.push({
      seq: i + 1,
      runId,
      ts,
      level: t.level,
      stage: t.stage,
      message: t.build(i),
      suggestion: t.suggestion,
    });
  }
  return lines;
}

/* ────────────── stage stats — INFO 선택 시 우측 패널 ──────────── */

export interface StageStats {
  stage: string;
  total: number;
  error: number;
  warn: number;
  avgElapsedMs: number | null;
  totalRows: number | null;
}

/**
 * 한 stage 의 요약 통계. mock 메시지 패턴에서 elapsed=Nms / lag Nms / rows=N 을
 * 정규식으로 뽑아 평균·합계 계산. 패턴 없는 stage (worker, queue 등) 는
 * 해당 필드가 null 로 반환되어 화면에서 행이 hide 된다.
 */
export function computeStageStats(allLines: RunLogLine[], stage: string): StageStats {
  let total = 0, error = 0, warn = 0;
  let elapsedSum = 0, elapsedCount = 0;
  let rowsSum = 0, rowsCount = 0;
  for (const l of allLines) {
    if (l.stage !== stage) continue;
    total++;
    if (l.level === 2) error++;
    else if (l.level === 1) warn++;
    const e = /(?:elapsed=|lag\s+)(\d+)\s*ms/.exec(l.message);
    if (e) { elapsedSum += +e[1]; elapsedCount++; }
    const r = /rows=(\d+)/.exec(l.message);
    if (r) { rowsSum += +r[1]; rowsCount++; }
  }
  return {
    stage,
    total, error, warn,
    avgElapsedMs: elapsedCount > 0 ? Math.round(elapsedSum / elapsedCount) : null,
    totalRows:    rowsCount    > 0 ? rowsSum                                : null,
  };
}

/* ────────────── stage 색 팔레트 (다크 테마용) ──────────── */

const STAGE_PALETTE = [
  '#5fb3a3', // teal
  '#a778d5', // purple
  '#e8b563', // amber
  '#e85d75', // pink
  '#5fa3e8', // blue
  '#7dc78a', // green
  '#d6a35c', // ochre
  '#c878d5', // magenta
  '#65c5c0', // cyan
];

export function stageColor(stage: string): string {
  let h = 0;
  for (let i = 0; i < stage.length; i++) h = (h * 31 + stage.charCodeAt(i)) >>> 0;
  return STAGE_PALETTE[h % STAGE_PALETTE.length];
}
