import type { ProjectPhase } from '../store/workspace';
import type { StageView } from '../api/runs';

/**
 * buildStagesFromStageViews 의 入力型. StageView (Execution 画面) と ExecStageSummary
 * (ExecutionOverview 画面) を両方受けられる最小スーパーセット. tables 配列等は不要.
 */
export type StageProgressInput = Pick<
  StageView,
  'stageKey' | 'seq' | 'status' | 'pct' | 'tablesTotal' | 'tablesSuccess'
> & {
  tablesFailed?: number;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  errorSummary?: string;
};

/**
 * Pipeline stage tile 의 색상 결정용.
 *  - idle    : 미실행 / pending — 회색
 *  - running : 실행 중 — 파랑
 *  - ok      : success — 초록
 *  - warn    : failed_with_pending_warnings — amber (WARN 만, 운영자 ack 미존재)
 *  - err     : failed — 빨강 (FAIL 있음)
 */
export type StageTone = 'idle' | 'running' | 'ok' | 'warn' | 'err';

export interface Stage {
  id: string;
  name: string;
  sub: string;
  pct: number;
  tone: StageTone;
  rate: string;
  eta: string;
  shortName?: string;
}

/** 8-stage 메타데이터 (validation 추가 2026-05-30). 실 진행률은 BE polling(StageView)
 *  또는 phase fallback 으로 채운다. validation 은 non-blocking stage — fail 여도 run 통과. */
export const BASE_STAGES: Array<Omit<Stage, 'pct' | 'tone'>> = [
  { id: 'check',      name: 'Check',      sub: 'source format & encoding check', shortName: 'check',      rate: '—', eta: '—' },
  { id: 'extract',    name: 'Extract',    sub: 'UTF-8 CSV → Parquet (CP1)',      shortName: 'extract',    rate: '—', eta: '—' },
  { id: 'reconcile',  name: 'Reconcile',  sub: 'CSV ↔ CP1 parity',               shortName: 'reconcile',  rate: '—', eta: '—' },
  { id: 'transform',  name: 'Transform',  sub: 'apply rule engine → CP2',        shortName: 'transform',  rate: '—', eta: '—' },
  { id: 'audit',      name: 'Audit',      sub: 'CP1 ↔ CP2 parity',               shortName: 'audit',      rate: '—', eta: '—' },
  { id: 'load',       name: 'Load',       sub: 'apply to TO-BE',                 shortName: 'load',       rate: '—', eta: '—' },
  { id: 'verify',     name: 'Verify',     sub: 'CP2 ↔ TO-BE parity',             shortName: 'verify',     rate: '—', eta: '—' },
  { id: 'validation', name: 'Validation', sub: 'SUM / NULL / Data integrity audit report', shortName: 'validation', rate: '—', eta: '—' },
];

/** activeRun 이 없을 때의 fallback. hypercare/done 은 완료, 그 외는 모두 idle. */
export function buildStages(phase: ProjectPhase): Stage[] {
  const completePhases: ProjectPhase[] = ['hypercare', 'done'];
  if (completePhases.includes(phase)) {
    return BASE_STAGES.map((s) => ({ ...s, pct: 100, tone: 'ok', rate: '—', eta: 'done' }));
  }
  return BASE_STAGES.map((s) => ({ ...s, pct: 0, tone: 'idle' }));
}

/**
 * 통일된 stage tone → 진행바 채움색. (ExecutionPage 의 OverallProgress + ProgressBar,
 * ExecutionOverviewPage 의 per-row 파이프라인 바가 모두 이 함수를 공유한다.)
 *  - running : 밝은 hue (--green)              ← 실행 중
 *  - ok      : 같은 hue 의 어두운 톤 (--green-dark) ← 완료 (#6-4)
 *  - err     : 빨강 (--red)                     ← 실패 (#6-3)
 *  - warn    : 빨강 (--red)                     ← failed_with_pending_warnings = 부분 실패 (#6-3)
 *  - idle    : 미실행 대기 (--amber)
 */
export function stageFillColor(tone: StageTone): string {
  switch (tone) {
    case 'running': return 'var(--green)';
    case 'ok':      return 'var(--green-dark)';
    case 'err':     return 'var(--red)';
    case 'warn':    return 'var(--red)';
    case 'idle':
    default:        return 'var(--amber)';
  }
}

/** 完了した stage 의 数 (tone === 'ok'). 分数 표시용. */
export function countDoneStages(stages: Stage[]): number {
  return stages.filter((s) => s.tone === 'ok').length;
}

/**
 * BE polling 結果 (StageView[]) を UI モデル (Stage[]) に変換.
 *
 * - stageKey は BE 側에서 'check'/'extract'/'reconcile'/'transform'/'audit'/'load'/'verify' の
 *   いずれか. BASE_STAGES の id 와 일치 전제.
 * - status='pending' → tone='idle' (まだ実行되지 않음 / ゲート中断後).
 * - status='running' → tone='running'.
 * - status='success' → tone='ok'.
 * - status='failed' → tone='err'.
 * - pct 는 BE 計算値 (tablesSuccess/tablesTotal 割合) をそのまま使用.
 * - rate 는 성공한 테이블 수 / 전체 카운트 표기 (예: "12/24 tables"). 실패한 테이블은 분자에서 제외.
 * - eta 는 durationMs / finishedAt 가 분かれば 산출, 없으면 '—'.
 *
 * BE response 에 포함되지 않는 stage 는 idle/0 으로 채움 (=미실행. 하이브리드 표시의 "pending" = 회색).
 */
export function buildStagesFromStageViews(stageViews: StageProgressInput[]): Stage[] {
  const byKey = new Map<string, StageProgressInput>();
  for (const sv of stageViews) byKey.set(sv.stageKey, sv);

  return BASE_STAGES.map((base) => {
    const sv = byKey.get(base.id);
    if (!sv) {
      // BE response 에 해당 stage 없음 = 미실행 / pending.
      return { ...base, pct: 0, tone: 'idle' as StageTone };
    }
    const tone: StageTone =
      sv.status === 'success' ? 'ok'
      : sv.status === 'failed_with_pending_warnings' ? 'warn'
      : sv.status === 'failed' ? 'err'
      : sv.status === 'running' ? 'running'
      : 'idle';
    const pct = Math.max(0, Math.min(100, sv.pct ?? 0));
    /* 분자 = 성공한 테이블 수만 (실패 제외). 사용자 인지 — "3개 중 1개 에러 = 2/3" 가 자연스럽다. */
    const successCount = sv.tablesSuccess ?? 0;
    const rate = sv.tablesTotal > 0 ? `${successCount}/${sv.tablesTotal} tables` : '—';
    /* eta: 대략 미완료 테이블 수 × 평균 처리시간. BE 가 값을 안 주는 한 '—'. */
    let eta = '—';
    if (sv.status === 'success') eta = 'done';
    else if (sv.status === 'failed') eta = 'failed';
    else if (sv.status === 'failed_with_pending_warnings') eta = 'review';
    else if (sv.status === 'pending') eta = '—';
    else if (sv.status === 'running' && sv.startedAt && sv.tablesTotal > 0) {
      const elapsed = Date.now() - new Date(sv.startedAt).getTime();
      const doneCount = (sv.tablesSuccess ?? 0) + (sv.tablesFailed ?? 0);
      if (doneCount > 0 && elapsed > 0) {
        const perTable = elapsed / doneCount;
        const remain = (sv.tablesTotal - doneCount) * perTable;
        const remSec = Math.max(0, Math.ceil(remain / 1000));
        eta = `00:${String(Math.min(remSec, 99)).padStart(2, '0')}`;
      }
    }
    return { ...base, pct, tone, rate, eta };
  });
}
