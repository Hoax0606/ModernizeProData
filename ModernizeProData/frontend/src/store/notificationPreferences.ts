import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type NotificationScope = 'mine-only' | 'all-project';

/**
 * Project Settings > Notifications 의 사용자 선택을 영속 저장.
 * - subs: 프로젝트별 event key → 활성 여부 (false 면 알림 패널에서 제외)
 * - scopes: 프로젝트별 'mine-only' vs 'all-project'
 * 둘 다 미설정이면 default true / 'all-project'.
 *
 * (서버 사용자 환경설정 API 가 들어오면 그쪽으로 교체. 현재는 PoC 단계라 localStorage.)
 */
interface State {
  subs: Record<string, Record<string, boolean>>;
  scopes: Record<string, NotificationScope>;
  retentions: Record<string, string>;
  setSubscription: (projectId: string, eventKey: string, enabled: boolean) => void;
  setScope: (projectId: string, scope: NotificationScope) => void;
  setRetention: (projectId: string, retention: string) => void;
}

export const useNotificationPrefsStore = create<State>()(
  persist(
    (set) => ({
      subs: {},
      scopes: {},
      retentions: {},
      setSubscription: (projectId, eventKey, enabled) =>
        set((s) => ({
          subs: {
            ...s.subs,
            [projectId]: { ...(s.subs[projectId] ?? {}), [eventKey]: enabled },
          },
        })),
      setScope: (projectId, scope) =>
        set((s) => ({
          scopes: { ...s.scopes, [projectId]: scope },
        })),
      setRetention: (projectId, retention) =>
        set((s) => ({
          retentions: { ...s.retentions, [projectId]: retention },
        })),
    }),
    { name: 'modernize-notification-prefs' },
  ),
);

export function getRetentionFor(
  retentions: Record<string, string>,
  projectId: string,
): string {
  return retentions[projectId] ?? '90 days';
}

/**
 * 이벤트 알림 표시 여부 — 전 프로젝트 공통(global) 설정 기준.
 * defaults 에 키가 없으면(= 토글이 없는 이벤트) default true(항상 표시).
 */
export function isEventEnabled(
  defaults: Record<string, boolean>,
  eventKey: string,
): boolean {
  return defaults[eventKey] ?? true;
}

/** 미설정 시 default 'all-project'. */
export function getScopeFor(
  scopes: Record<string, NotificationScope>,
  projectId: string,
): NotificationScope {
  return scopes[projectId] ?? 'all-project';
}

/**
 * Audit log action 문자열을 event key 로 매핑.
 * 매핑 안 된 action 은 null — 구독 체크 우회 (항상 표시).
 */
export function actionToEventKey(action: string): string | null {
  const a = action.toLowerCase();
  // snapshot.pending — BE 실제 action 은 "review requested" (구 "approval requested" 아님).
  if (a.includes('review requested') || a.includes('approval requested')
      || (a.includes('approval') && a.includes('request'))) return 'snapshot.pending';
  if (a === 'approved' || a.startsWith('approved ')) return 'snapshot.approved';
  if (a === 'rejected' || a.startsWith('rejected ')) return 'snapshot.rejected';
  if (a.includes('run') && a.includes('fail')) return 'run.failed';
  if (a.includes('run') && a.includes('start')) return 'run.started';
  // run.finished — BE finishRun action 은 "run success" / "run aborted" / "run timed_out"
  // (finish/complete 단어가 안 들어감). 성공·중단·타임아웃 종료를 모두 run.finished 로.
  if (a.includes('run') && (a.includes('finish') || a.includes('complete')
      || a.includes('success') || a.includes('abort') || a.includes('timed_out')
      || a.includes('timed out'))) return 'run.finished';
  // 2026-06-04 추가 — 기존엔 매핑 없어 토글 없이 항상 뜨던 알림들에 event key 부여.
  if (a.includes('snapshot created')) return 'snapshot.created';        // "snapshot created" / "cutover snapshot created"
  if (a.includes('snapshot deleted')) return 'snapshot.deleted';
  if (a.includes('baseline')) return 'snapshot.baseline';               // "baseline set ..." / "baseline cleared"
  if (a.includes('ddl import')) return 'ddl.imported';                  // "DDL imported"
  if (a.includes('project created')) return 'project.created';
  // phase 변경은 알림 안 함 (2026-06-05) — 매핑 없음 → null → 토스트 X (audit 기록은 유지).
  if (a.includes('assignee changed')) return 'project.assignee';        // "assignee changed" / "execution assignee changed"
  return null;
}
