// MUST be the first import. Reads bootstrap_token / bootstrap_user query
// params (set by WorkerApp.swapToWebView) into localStorage *before*
// zustand stores hydrate, so the Worker can sign in once via the JavaFX
// form and reach the dashboard directly instead of re-typing credentials.
import './bootstrap-from-url';

// Module-level error catcher: any uncaught error in bundle evaluation,
// React mount, or runtime gets dumped straight into the DOM so we get
// visibility on JavaFX WebView where there's no devtools.
const showErr = (label: string, msg: string, src?: string) => {
  try {
    document.body.innerHTML =
      '<pre style="padding:24px;color:#c42f2f;background:#fff;font:12px/1.5 monospace;white-space:pre-wrap;margin:0;min-height:100vh;">' +
      '<b>' + label + '</b>\n\n' + msg + (src ? '\n\n' + src : '') + '</pre>';
  } catch {}
};
window.addEventListener('error', (e) => {
  showErr('window error', String(e.message), (e.filename || '') + ':' + (e.lineno || '') + ':' + (e.colno || ''));
});
window.addEventListener('unhandledrejection', (e) => {
  const r: unknown = e.reason;
  showErr('unhandledrejection', r instanceof Error ? r.message + '\n' + (r.stack ?? '') : String(r));
});

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// beforeunload 의 best-effort logout 제거 (2026-05-31). 옛 정책 (confirm-to-evict)
// 에서는 옛 session 강제 clear 위해 필요했지만 AuthService 가 last-write-wins 로
// 전환 후 = 다음 login 시 자동 evict. beforeunload logout 은 F5 시도 fire 되어
// reload 후 옛 token 이 sid mismatch (server 가 session clear 함) → 401 → logout
// cycle 의 진짜 원인이었음.

// F5 / Ctrl+R 자체 disable — Edge --app mode 의 chromeless 상태에서 사용자가
// 실수로 누르거나 의도적 reload 가 의미 없는 시나리오 (zustand 가 state 보유 +
// STOMP / polling 이 자동 재연결). 의도된 reload 가 진짜 필요한 dev 상황은
// Ctrl+F5 (cache bypass) 로 우회 가능 — 그것은 막지 않음.
window.addEventListener('keydown', (e) => {
  if (e.key === 'F5' && !e.ctrlKey && !e.shiftKey) {
    e.preventDefault();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'r' || e.key === 'R') && !e.shiftKey) {
    e.preventDefault();
    return;
  }
});

// Right-click context menu 차단 — Edge --app 모드의 chromeless 일관성. text
// selection 등 시스템 컨텍스트 메뉴 (브라우저 / Inspect / View source) 가 도구
// 사용 흐름과 무관하므로 전체 disable.
window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
});

// 파일 다운로드 트리거 차단 — 도구 내부 다운로드 (export 등) 는 page 가 직접
// blob → <a download> 클릭으로 처리하므로 user-initiated drag 외 외부 link
// 의 download attribute 만 가로채는 건 의미 없음. 대신 download attr 의
// click 을 가로채 새 탭 열림 등 chrome 다운로드 bar 노출 방지는 Edge 의
// --disable-features 로 처리 (EdgeAppLauncher 의 flags).

try {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
} catch (e) {
  showErr('createRoot/render', e instanceof Error ? e.message + '\n' + (e.stack ?? '') : String(e));
}

