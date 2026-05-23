import { create } from 'zustand';
import type { Client, StompSubscription } from '@stomp/stompjs';
import { createWebSocket, subscribe } from '../api/ws';
import type { RunLogLine } from '../api/runLogs';

const RING_MAX = 5000;          // Live tail 메모리 캡 — 평균 300B × 5000 ≈ 1.5MB

interface ChunkMessage {
  runId: string;
  projectId: string;
  lines: RunLogLine[];
}

interface LiveLogStore {
  client: Client | null;
  /** projectId → 최근 RING_MAX 라인 (FIFO). subscription 핸들은 모듈 스코프에서 관리. */
  buffers: Record<string, RunLogLine[]>;

  subscribeProject: (projectId: string) => void;
  unsubscribeProject: (projectId: string) => void;
  clearProject: (projectId: string) => void;
}

/* ─────────────────────── module-scope wiring ────────────────────────── */
// StrictMode 에서 effect 가 두 번 돌아도 leak 없이 일관되게 동작하도록,
// 활성 구독은 zustand state 가 아니라 모듈 스코프 Map 으로 관리한다.
// (zustand state 에 함수형 객체를 들고 있으면 serialization · devtools 가 시끄러움)
const subs = new Map<string, StompSubscription>();
const wanted = new Set<string>();
let onConnectInstalled = false;

function installOnConnect(client: Client, applyAll: () => void) {
  if (onConnectInstalled) return;
  onConnectInstalled = true;
  const prev = client.onConnect;
  client.onConnect = (frame) => {
    prev?.(frame);
    applyAll();
  };
}

/* ──────────────────────────────── store ─────────────────────────────── */
export const useLiveLogStore = create<LiveLogStore>((set, get) => {
  const applyAll = () => {
    const client = get().client;
    if (!client || !client.connected) return;
    for (const projectId of wanted) {
      if (subs.has(projectId)) continue;
      const sub = subscribe<ChunkMessage>(client, `/topic/project/${projectId}/log`, (body) => {
        const incoming = body?.lines ?? [];
        if (incoming.length === 0) return;
        set((st) => {
          const prev = st.buffers[projectId] ?? [];
          const merged = prev.concat(incoming);
          const trimmed = merged.length > RING_MAX
            ? merged.slice(merged.length - RING_MAX)
            : merged;
          return { buffers: { ...st.buffers, [projectId]: trimmed } };
        });
      });
      subs.set(projectId, sub);
    }
  };

  return {
    client: null,
    buffers: {},

    subscribeProject: (projectId) => {
      wanted.add(projectId);

      let client = get().client;
      if (!client) {
        client = createWebSocket();
        installOnConnect(client, applyAll);
        client.activate();
        set({ client });
      } else {
        installOnConnect(client, applyAll);
      }

      // 이미 연결돼 있으면 즉시 적용
      if (client.connected) applyAll();
    },

    unsubscribeProject: (projectId) => {
      wanted.delete(projectId);
      const sub = subs.get(projectId);
      try { sub?.unsubscribe(); } catch { /* already gone */ }
      subs.delete(projectId);
    },

    clearProject: (projectId) => {
      set((st) => ({ buffers: { ...st.buffers, [projectId]: [] } }));
    },
  };
});
