import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * 알림의 read / dismissed 상태를 **사용자별로** 보관.
 * 한 브라우저에서 여러 계정을 번갈아 쓸 때 (예: master ↔ worker) 한쪽이 읽었다고
 * 다른 쪽도 읽음 처리되지 않도록 username 으로 키 분리.
 */
interface NotificationState {
  readIds: Record<string, string[]>;
  dismissedIds: Record<string, string[]>;
  markAllRead: (username: string, ids: string[]) => void;
  clearAll: (username: string, ids: string[]) => void;
}

export const useNotificationStore = create<NotificationState>()(
  persist(
    (set) => ({
      readIds: {},
      dismissedIds: {},
      markAllRead: (username, ids) =>
        set((s) => ({
          readIds: {
            ...s.readIds,
            [username]: Array.from(new Set([...(s.readIds[username] ?? []), ...ids])),
          },
        })),
      clearAll: (username, ids) =>
        set((s) => ({
          dismissedIds: {
            ...s.dismissedIds,
            [username]: Array.from(new Set([...(s.dismissedIds[username] ?? []), ...ids])),
          },
        })),
    }),
    { name: 'modernize-notifications' },
  ),
);
