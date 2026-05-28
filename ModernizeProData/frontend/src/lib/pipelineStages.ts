import type { ProjectPhase } from '../store/workspace';
import type { StageView } from '../api/runs';

export type StageTone = 'idle' | 'running' | 'ok' | 'err';

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

/** 7-stage 메타데이터. 실 진행률은 BE polling(StageView) 또는 phase fallback 으로 채운다. */
export const BASE_STAGES: Array<Omit<Stage, 'pct' | 'tone'>> = [
  { id: 'check',     name: 'Check',     sub: 'source format & encoding check', shortName: 'check',     rate: '—', eta: '—' },
  { id: 'extract',   name: 'Extract',   sub: 'UTF-8 CSV → Parquet (CP1)',      shortName: 'extract',   rate: '—', eta: '—' },
  { id: 'reconcile', name: 'Reconcile', sub: 'CSV ↔ CP1 parity',               shortName: 'reconcile', rate: '—', eta: '—' },
  { id: 'transform', name: 'Transform', sub: 'apply rule engine → CP2',        shortName: 'transform', rate: '—', eta: '—' },
  { id: 'audit',     name: 'Audit',     sub: 'CP1 ↔ CP2 parity',               shortName: 'audit',     rate: '—', eta: '—' },
  { id: 'load',      name: 'Load',      sub: 'apply to TO-BE',                 shortName: 'load',      rate: '—', eta: '—' },
  { id: 'verify',    name: 'Verify',    sub: 'CP2 ↔ TO-BE parity',             shortName: 'verify',    rate: '—', eta: '—' },
];

/** activeRun 이 없을 때의 fallback. hypercare/done 은 완료, 그 외는 모두 idle. */
export function buildStages(phase: ProjectPhase): Stage[] {
  const completePhases: ProjectPhase[] = ['hypercare', 'done'];
  if (completePhases.includes(phase)) {
    return BASE_STAGES.map((s) => ({ ...s, pct: 100, tone: 'ok', rate: '—', eta: 'done' }));
  }
  return BASE_STAGES.map((s) => ({ ...s, pct: 0, tone: 'idle' }));
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
 * - rate 는 tablesSuccess + tablesFailed 進捗 카운트 표기 (예: "12/24 tables").
 * - eta 는 durationMs / finishedAt 가 분かれば 산출, 없으면 '—'.
 *
 * BE response 에 포함되지 않는 stage 는 idle/0 으로 채움 (=미실행. 하이브리드 표시의 "pending" = 회색).
 */
export function buildStagesFromStageViews(stageViews: StageView[]): Stage[] {
  const byKey = new Map<string, StageView>();
  for (const sv of stageViews) byKey.set(sv.stageKey, sv);

  return BASE_STAGES.map((base) => {
    const sv = byKey.get(base.id);
    if (!sv) {
      // BE response 에 해당 stage 없음 = 미실행 / pending.
      return { ...base, pct: 0, tone: 'idle' as StageTone };
    }
    const tone: StageTone =
      sv.status === 'success' ? 'ok'
      : sv.status === 'failed' ? 'err'
      : sv.status === 'running' ? 'running'
      : 'idle';
    const pct = Math.max(0, Math.min(100, sv.pct ?? 0));
    const done = (sv.tablesSuccess ?? 0) + (sv.tablesFailed ?? 0);
    const rate = sv.tablesTotal > 0 ? `${done}/${sv.tablesTotal} tables` : '—';
    /* eta: 대략 미완료 테이블 수 × 평균 처리시간. BE 가 값을 안 주는 한 '—'. */
    let eta = '—';
    if (sv.status === 'success') eta = 'done';
    else if (sv.status === 'failed') eta = 'failed';
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
