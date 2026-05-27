import type { ActiveRunState } from '../store/executionPreflight';
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

/* Frontend mock simulation 의 시간 모델. 각 stage 5초, 7 stage = 35초.
   백엔드 run engine 연결 시점에 이 부분이 실제 진행률 / WS 이벤트로 교체된다. */
export const STAGE_MS = 5000;
export const TOTAL_STAGES = 7;
export const TOTAL_RUN_MS = STAGE_MS * TOTAL_STAGES;

export const BASE_STAGES: Array<Omit<Stage, 'pct' | 'tone'> & { defaultPct: number; defaultTone: StageTone }> = [
  { id: 'check',     name: 'Check',     sub: 'source format & encoding check', shortName: 'check',     defaultPct: 0, defaultTone: 'idle', rate: '—', eta: '—' },
  { id: 'extract',   name: 'Extract',   sub: 'UTF-8 CSV → Parquet (CP1)',      shortName: 'extract',   defaultPct: 0, defaultTone: 'idle', rate: '—', eta: '—' },
  { id: 'reconcile', name: 'Reconcile', sub: 'CSV ↔ CP1 parity',               shortName: 'reconcile', defaultPct: 0, defaultTone: 'idle', rate: '—', eta: '—' },
  { id: 'transform', name: 'Transform', sub: 'apply rule engine → CP2',        shortName: 'transform', defaultPct: 0, defaultTone: 'idle', rate: '—', eta: '—' },
  { id: 'audit',     name: 'Audit',     sub: 'CP1 ↔ CP2 parity',               shortName: 'audit',     defaultPct: 0, defaultTone: 'idle', rate: '—', eta: '—' },
  { id: 'load',      name: 'Load',      sub: 'apply to TO-BE',                 shortName: 'load',      defaultPct: 0, defaultTone: 'idle', rate: '—', eta: '—' },
  { id: 'verify',    name: 'Verify',    sub: 'CP2 ↔ TO-BE parity',             shortName: 'verify',    defaultPct: 0, defaultTone: 'idle', rate: '—', eta: '—' },
];

/** activeRun 이 없을 때의 fallback. hypercare/done 은 완료, 그 외는 모두 idle. */
export function buildStages(phase: ProjectPhase): Stage[] {
  const completePhases: ProjectPhase[] = ['hypercare', 'done'];
  if (completePhases.includes(phase)) {
    return BASE_STAGES.map((s) => ({ ...s, pct: 100, tone: 'ok', rate: '—', eta: 'done' }));
  }
  return BASE_STAGES.map((s) => ({ ...s, pct: s.defaultPct, tone: s.defaultTone }));
}

/** activeRun 의 startedAt + pauseAccumMs 로부터 elapsed ms 를 derive. completed 면 즉시 max.
 *  ref 우선순위: pausedAt (일시정지) → haltedAt (failed/aborted) → Date.now() (running).
 *  haltedAt 가 없으면 정지 후에도 시계가 흘러 partial pct 가 자라는 버그가 생기므로 반드시 둘 다 본다. */
export function computeElapsedMs(activeRun: ActiveRunState): number {
  if (activeRun.runStatus === 'completed') return STAGE_MS * BASE_STAGES.length;
  const ref = activeRun.pausedAt ?? activeRun.haltedAt ?? Date.now();
  const raw = ref - activeRun.startedAt - activeRun.pauseAccumMs;
  return Math.max(0, Math.min(raw, STAGE_MS * BASE_STAGES.length));
}

/** Mock simulation 의 진행 상태를 stage 단위 progress 로 변환.
 *  Failed: 멈춘 stage 가 'err' (빨강) / Aborted: 멈춘 stage 가 'idle' (회색). 그 외 stage 는 동일 규칙. */
export function buildStagesFromActiveRun(activeRun: ActiveRunState, totalMs: number): Stage[] {
  const halted = (activeRun.runStatus === 'failed' || activeRun.runStatus === 'aborted')
    && activeRun.failedStageIndex != null;
  const haltIdx = activeRun.failedStageIndex ?? -1;
  const haltedTone: StageTone = activeRun.runStatus === 'failed' ? 'err' : 'idle';
  const haltedEta = activeRun.runStatus === 'failed' ? 'failed' : 'stopped';
  const elapsed = computeElapsedMs(activeRun);

  return BASE_STAGES.map((s, i) => {
    if (halted) {
      if (i < haltIdx) return { ...s, pct: 100, tone: 'ok' as StageTone, rate: 'mock', eta: 'done' };
      if (i === haltIdx) {
        const stageStart = i * STAGE_MS;
        const partial = Math.max(0, Math.min(elapsed - stageStart, STAGE_MS));
        const pct = (partial / STAGE_MS) * 100;
        return { ...s, pct, tone: haltedTone, rate: 'mock', eta: haltedEta };
      }
      return { ...s, pct: 0, tone: 'idle' as StageTone, rate: '—', eta: '—' };
    }
    const stageStart = i * STAGE_MS;
    const stageEnd = stageStart + STAGE_MS;
    if (elapsed >= stageEnd || elapsed >= totalMs) {
      return { ...s, pct: 100, tone: 'ok' as StageTone, rate: 'mock', eta: 'done' };
    }
    if (elapsed > stageStart) {
      const pct = ((elapsed - stageStart) / STAGE_MS) * 100;
      const remainSec = Math.ceil((stageEnd - elapsed) / 1000);
      return { ...s, pct, tone: 'running' as StageTone, rate: 'mock', eta: `00:${String(remainSec).padStart(2, '0')}` };
    }
    return { ...s, pct: 0, tone: 'idle' as StageTone, rate: '—', eta: '—' };
  });
}

/** 完了した stage の数 (tone === 'ok'). 分数表示用. */
export function countDoneStages(stages: Stage[]): number {
  return stages.filter((s) => s.tone === 'ok').length;
}

/**
 * BE polling 結果 (StageView[]) を UI モデル (Stage[]) に変換.
 * Demo / mock 用の buildStagesFromActiveRun と並存. 実モードはこちら.
 *
 * - stageKey は BE 側で 'check'/'extract'/'reconcile'/'transform'/'audit'/'load'/'verify' の
 *   いずれか. BASE_STAGES の id と一致させる前提.
 * - status='pending' は tone='idle' (まだ実行されてない / ゲート中断後).
 * - status='running' は tone='running'.
 * - status='success' は tone='ok'.
 * - status='failed' は tone='err'.
 * - pct は BE 計算値 (tablesSuccess/tablesTotal 割合) をそのまま使う.
 * - rate は tablesSuccess + tablesFailed の進捗カウント表記 (例: "12/24 tables").
 * - eta は durationMs / finishedAt が分かれば算出、無ければ '—'.
 *
 * BE response に含まれない stage は BASE_STAGES の defaultPct/defaultTone で埋める
 * (=未実行 idle 状態. ハイブリッド表示の「pending」 = グレー).
 */
export function buildStagesFromStageViews(stageViews: StageView[]): Stage[] {
  const byKey = new Map<string, StageView>();
  for (const sv of stageViews) byKey.set(sv.stageKey, sv);

  return BASE_STAGES.map((base) => {
    const sv = byKey.get(base.id);
    if (!sv) {
      // BE response に該当 stage が無い = 未実行 / pending.
      return { ...base, pct: base.defaultPct, tone: base.defaultTone };
    }
    const tone: StageTone =
      sv.status === 'success' ? 'ok'
      : sv.status === 'failed' ? 'err'
      : sv.status === 'running' ? 'running'
      : 'idle';
    const pct = Math.max(0, Math.min(100, sv.pct ?? 0));
    const done = (sv.tablesSuccess ?? 0) + (sv.tablesFailed ?? 0);
    const rate = sv.tablesTotal > 0 ? `${done}/${sv.tablesTotal} tables` : '—';
    /* eta: 大雑把に未完了テーブル数 * 平均処理時間. ここでは BE が値を返さない限り '—'. */
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
