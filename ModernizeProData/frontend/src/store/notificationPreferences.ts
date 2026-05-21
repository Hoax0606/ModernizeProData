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

/** 미설정 시 default true. */
export function isEventEnabled(
  subs: Record<string, Record<string, boolean>>,
  projectId: string,
  eventKey: string,
): boolean {
  return subs[projectId]?.[eventKey] ?? true;
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
  if (a.includes('approval requested') || (a.includes('approval') && a.includes('request'))) return 'snapshot.pending';
  if (a === 'approved' || a.startsWith('approved ')) return 'snapshot.approved';
  if (a === 'rejected' || a.startsWith('rejected ')) return 'snapshot.rejected';
  if (a.includes('run') && a.includes('fail')) return 'run.failed';
  if (a.includes('run') && a.includes('start')) return 'run.started';
  if (a.includes('run') && (a.includes('finish') || a.includes('complete'))) return 'run.finished';
  return null;
}
