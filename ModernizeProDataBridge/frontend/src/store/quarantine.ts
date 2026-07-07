import { create } from 'zustand';

/**
 * Quarantine queue — LogViewer 와 Execution 페이지가 공유하는 mock store.
 *
 * 데모용. persist 안 함 → 새로고침 시 리셋. 실제 운영에선 BE 의
 * `/api/v1/runs/{runId}/quarantine` 같은 엔드포인트가 들어와야 함.
 *
 *  - LogViewer: ERROR 라인 선택 → "→ Send to quarantine queue" 트리거 → add(seq)
 *  - Execution: 큐 라인을 stage 별로 그룹화해서 표시, Discard/Retry 시 removeMany
 */
interface QuarantineStore {
  /** 큐에 든 라인의 seq. 결정 순서대로 push, 중복은 무시. */
  seqs: number[];

  add: (seq: number) => void;
  removeMany: (toRemove: number[]) => void;
  clear: () => void;
}

export const useQuarantineStore = create<QuarantineStore>((set) => ({
  seqs: [],
  add: (seq) => set((s) =>
    s.seqs.includes(seq) ? s : { seqs: [...s.seqs, seq] },
  ),
  removeMany: (toRemove) => set((s) =>
    ({ seqs: s.seqs.filter((x) => !toRemove.includes(x)) }),
  ),
  clear: () => set({ seqs: [] }),
}));
