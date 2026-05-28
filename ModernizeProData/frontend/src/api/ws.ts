import { Client, type IMessage } from '@stomp/stompjs';
import SockJS from 'sockjs-client';
import { useAuthStore } from '../store/auth';

/**
 * WebSocket (STOMP over SockJS) 클라이언트.
 *
 * 백엔드 endpoint: /ws (WebSocketConfig 와 일치)
 * Server → Client 채널: /topic/**, /queue/**
 * Client → Server 메시지: /app/**
 *
 * 사용 예:
 *   const ws = createWebSocket();
 *   ws.activate();
 *   ws.subscribe('/topic/run/123/progress', (msg) => { ... });
 */
const WS_URL = import.meta.env.VITE_WS_BASE_URL ?? 'http://localhost:8080';

export function createWebSocket(): Client {
  const client = new Client({
    webSocketFactory: () => new SockJS(`${WS_URL}/ws`),
    reconnectDelay: 5_000,
    heartbeatIncoming: 10_000,
    heartbeatOutgoing: 10_000,
    debug: () => {}, // 디버그 로그 비활성. 필요 시 console.log.
  });

  // 연결 직전에 최신 토큰 set (재연결 시에도 동적 반영)
  client.beforeConnect = () => {
    const token = useAuthStore.getState().token;
    client.connectHeaders = token ? { Authorization: `Bearer ${token}` } : {};
  };

  return client;
}

/**
 * 구독 헬퍼.
 * 사용 예: subscribe(client, '/topic/notifications', (body) => ...);
 */
export function subscribe<T = unknown>(
  client: Client,
  destination: string,
  handler: (body: T, message: IMessage) => void,
) {
  return client.subscribe(destination, (message) => {
    try {
      const body = JSON.parse(message.body) as T;
      handler(body, message);
    } catch {
      handler(message.body as T, message);
    }
  });
}
