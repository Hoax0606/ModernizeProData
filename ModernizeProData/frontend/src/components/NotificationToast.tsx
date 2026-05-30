import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAuditLogStore, type AuditLogEntry } from '../store/auditLog';
import { useAuthStore } from '../store/auth';
import { useWorkspaceStore } from '../store/workspace';
import { useSettingsStore } from '../store/settings';
import {
  useNotificationPrefsStore,
  isEventEnabled,
  actionToEventKey,
} from '../store/notificationPreferences';

interface ToastItem {
  id: string;          // audit log id
  title: string;
  description: string;
  projectName: string;
  isCutover: boolean;
}

const TOAST_DURATION_MS = 4000;

/**
 * 새 audit log entry 가 생기면 우측 하단에 잠깐 떴다 사라지는 toast.
 * 필터: globalNotifEnabled / event subscription / scope 가 알림 패널과 동일하게 적용.
 * 처음 마운트 시점에 이미 있던 entry 들은 toast 로 띄우지 않음 (latest ID 를 기준점으로 잡음).
 *
 * 2026-05-30 재작성 — 옛 버전은 close 버튼에 inline SVG stroke 를 썼는데 JavaFX
 * WebView 의 옛 WebKit 이 stroke 렌더링에 불안정 (메모리 webview-old-webkit-constraints).
 * 이 버전은 close 버튼을 FontAwesome (fa-xmark) 로 바꿔 stroke 회피.
 * createPortal 로 document.body 끝에 mount 해서 부모의 stacking context 에서 격리.
 */
export function NotificationToast() {
  const allLogs = useAuditLogStore((s) => s.logs);
  const allProjects = useWorkspaceStore((s) => s.projects);
  const activeSiteId = useWorkspaceStore((s) => s.activeSiteId);
  const user = useAuthStore((s) => s.user);
  const globalNotifEnabled = useSettingsStore((s) => s.notifications);
  const globalNotifScope = useSettingsStore((s) => s.notificationScope);
  const notifPrefSubs = useNotificationPrefsStore((s) => s.subs);

  const seenIdsRef = useRef<Set<string>>(new Set());
  const initializedRef = useRef(false);
  // baseline 이 어느 사이트 기준으로 잡혔는지. 사이트 전환 시 재설정 트리거.
  const baselineSiteRef = useRef<string | undefined>(undefined);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => {
    const siteProjIds = new Set(
      allProjects.filter((p) => p.siteId === activeSiteId).map((p) => p.id),
    );
    // 활성 사이트에 속한 로그만 본다. (다른 사이트의 잔여 로그가 토스트로 새지 않게)
    const siteLogs = allLogs.filter((l) => siteProjIds.has(l.projectId));

    // 사이트가 바뀌면 baseline 을 다시 잡는다 — 새 사이트의 기존 로그가 한꺼번에 뜨지 않도록.
    if (baselineSiteRef.current !== activeSiteId) {
      baselineSiteRef.current = activeSiteId;
      initializedRef.current = false;
      seenIdsRef.current = new Set();
    }

    if (!globalNotifEnabled) {
      // 비활성화 중에 쌓인 entry 들도 'seen' 으로 표시 — 다시 켰을 때 한꺼번에 토스트로 뜨지 않게.
      for (const l of siteLogs) seenIdsRef.current.add(l.id);
      return;
    }

    // baseline 미설정: 활성 사이트의 로그가 처음 도착하는 시점에 잡는다.
    // (refresh 직후엔 fetchBySite 가 끝나기 전이라 allLogs 가 비어 있으므로,
    //  여기서 기다렸다가 첫 비어있지 않은 로드를 baseline 으로 삼아야 한꺼번에 토스트가 뜨지 않는다.)
    if (!initializedRef.current) {
      if (siteLogs.length === 0) return;
      initializedRef.current = true;
      seenIdsRef.current = new Set(siteLogs.map((l) => l.id));
      return;
    }

    const projNameById = new Map(allProjects.map((p) => [p.id, p.name]));
    const newItems: ToastItem[] = [];
    for (const l of siteLogs) {
      if (seenIdsRef.current.has(l.id)) continue;
      seenIdsRef.current.add(l.id);
      // Event subscription
      const eventKey = actionToEventKey(l.action);
      if (eventKey && !isEventEnabled(notifPrefSubs, l.projectId, eventKey)) continue;
      // Scope (글로벌)
      if (globalNotifScope === 'mine-only' && user?.username && l.user !== user.username) continue;

      newItems.push(buildItem(l, projNameById));
    }
    if (newItems.length === 0) return;
    setToasts((cur) => [...cur, ...newItems]);
  }, [allLogs, allProjects, activeSiteId, globalNotifEnabled, notifPrefSubs, globalNotifScope, user?.username]);

  // 각 toast 가 일정 시간 후 자동 제거
  useEffect(() => {
    if (toasts.length === 0) return;
    const oldest = toasts[0];
    const id = setTimeout(() => {
      setToasts((cur) => cur.filter((t) => t.id !== oldest.id));
    }, TOAST_DURATION_MS);
    return () => clearTimeout(id);
  }, [toasts]);

  if (toasts.length === 0) return null;

  return createPortal(
    <div
      style={{
        position: 'fixed',
        bottom: 24,
        right: 24,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        zIndex: 3000,
        pointerEvents: 'none',
      }}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          style={{
            position: 'relative',
            minWidth: 280,
            maxWidth: 360,
            padding: '10px 32px 10px 14px',
            background: 'var(--panel)',
            border: '1px solid var(--border-strong)',
            borderLeft: '3px solid var(--navy)',
            borderRadius: 4,
            boxShadow: '0 8px 24px rgba(20,30,50,.16)',
            fontSize: 12,
            color: 'var(--text)',
            pointerEvents: 'auto',
          }}
        >
          <button
            onClick={() => setToasts((cur) => cur.filter((x) => x.id !== t.id))}
            aria-label="Close"
            style={{
              position: 'absolute',
              top: 6,
              right: 6,
              width: 18,
              height: 18,
              padding: 0,
              border: 'none',
              background: 'transparent',
              color: 'var(--text-3)',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 2,
              lineHeight: 1,
              fontSize: 14,
              fontWeight: 600,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--panel-2)'; e.currentTarget.style.color = 'var(--text)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-3)'; }}
            aria-label="Close"
          >
            {/* Unicode ×. inline SVG stroke (WebView 옛 WebKit 불안정) 와 FontAwesome
                (전역 CSS 충돌) 둘 다 회피. WebView 도 unicode glyph 는 안정. */}
            ×
          </button>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 4 }}>
            <span style={{ fontWeight: 700 }}>{t.title}</span>
            {t.isCutover && (
              <span
                style={{
                  fontSize: 9.5,
                  fontWeight: 700,
                  fontFamily: 'var(--mono)',
                  color: 'var(--red, #dc2626)',
                  border: '1px solid var(--red, #dc2626)',
                  background: 'var(--red-50, #fef2f2)',
                  borderRadius: 3,
                  padding: '0 5px',
                  letterSpacing: 0.2,
                }}
              >
                Cutover
              </span>
            )}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-2)', lineHeight: 1.4 }}>{t.description}</div>
          <div style={{ fontSize: 10.5, color: 'var(--text-3)', fontFamily: 'var(--mono)', marginTop: 4 }}>
            {t.projectName}
          </div>
        </div>
      ))}
    </div>,
    document.body,
  );
}

function buildItem(l: AuditLogEntry, projNameById: Map<string, string>): ToastItem {
  const baseTitle = l.action.replace(/\b\w/g, (c) => c.toUpperCase());
  const title = l.snapshotName ? `${baseTitle} · ${l.snapshotName}` : baseTitle;
  const isCutover = l.snapshotType === 'cutover' || l.action.toLowerCase().includes('cutover');
  return {
    id: l.id,
    title,
    description: l.description.split('\n')[0],
    projectName: projNameById.get(l.projectId) ?? '—',
    isCutover,
  };
}
