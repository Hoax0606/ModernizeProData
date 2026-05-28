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

try {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
} catch (e) {
  showErr('createRoot/render', e instanceof Error ? e.message + '\n' + (e.stack ?? '') : String(e));
}
