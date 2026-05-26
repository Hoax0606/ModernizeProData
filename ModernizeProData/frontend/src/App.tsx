import { Component, useEffect, type ErrorInfo, type ReactNode } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { LoginPage } from './pages/LoginPage';
import { LicenseSetupPage } from './pages/LicenseSetupPage';
import { DashboardPage } from './pages/DashboardPage';
import { PlaceholderPage } from './pages/PlaceholderPage';
import { SettingsPage } from './pages/SettingsPage';
import { SiteExportPage } from './pages/SiteExportPage';
import { AuditLogPage } from './pages/AuditLogPage';
import { VersionsPage } from './pages/VersionsPage';
import { ApprovalsPage } from './pages/ApprovalsPage';
import { ExecutionPage } from './pages/ExecutionPage';
import { ExecutionOverviewPage } from './pages/ExecutionOverviewPage';
import { MappingPage } from './pages/MappingPage';
import { ArtifactsPage } from './pages/ArtifactsPage';
import { SchedulerPage } from './pages/SchedulerPage';
import { LogViewerPage } from './pages/LogViewerPage';
import { SiteQuarantinePage } from './pages/SiteQuarantinePage';
import { AppShell } from './layout/AppShell';
import { ProtectedRoute } from './routes/ProtectedRoute';
import { useSettingsStore } from './store/settings';
import { useAuthStore } from './store/auth';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

/**
 * Catches any uncaught React render error and shows the message on screen
 * — without this, a thrown component leaves a blank white page on JavaFX
 * WebView (no devtools available, no console visible).
 */
class ErrorBoundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) { return { err }; }
  componentDidCatch(err: Error, info: ErrorInfo) {
    fetch('/api/v1/health/info?clientError=' + encodeURIComponent(err.message.slice(0, 200)), {
      cache: 'no-store',
    }).catch(() => {});
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', err, info);
  }
  render() {
    if (this.state.err) {
      return (
        <div style={{
          padding: 24,
          fontFamily: 'monospace',
          whiteSpace: 'pre-wrap',
          color: '#c42f2f',
          background: '#fff',
          minHeight: '100vh',
        }}>
          <h2 style={{ margin: 0, marginBottom: 12 }}>React render error</h2>
          <div style={{ marginBottom: 8, fontSize: 14 }}>{this.state.err.message}</div>
          <pre style={{ fontSize: 11, color: '#666' }}>{this.state.err.stack}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

/** Routes + per-navigation health probe live inside the router so the
 *  useLocation hook can re-trigger licenseStatus checks on every navigate. */
function AppRoutes() {
  const theme = useSettingsStore((s) => s.theme);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // License-state probe on every navigation. Uses react-router navigate()
  // instead of window.location.replace() because JavaFX 21 WebView's
  // location-mutator APIs update the URL but do NOT reload the page —
  // that left users stuck on /login forever even after the URL changed.
  useEffect(() => {
    if (location.pathname === '/license-setup') return;
    fetch('/api/v1/health/info?_=' + Date.now(), { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const lic = d?.data?.licenseStatus;
        if (lic === 'MISSING') {
          try { useAuthStore.getState().logout(); } catch {}
          navigate('/license-setup', { replace: true });
          return;
        }
        try {
          const persisted = localStorage.getItem('modernize-settings');
          if (!persisted) {
            const lang = d?.data?.defaultLanguage;
            if (lang === 'ko' || lang === 'ja' || lang === 'en') {
              useSettingsStore.getState().setLanguage(lang);
            }
          }
        } catch {}
      })
      .catch(() => {});
  }, [location.pathname, navigate]);

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/license-setup" element={<LicenseSetupPage />} />

      {/* 인증 필요한 라우트 */}
      <Route element={<ProtectedRoute />}>
        <Route element={<AppShell />}>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/site/execution" element={<ExecutionOverviewPage />} />
          <Route path="/site/quarantine" element={<SiteQuarantinePage />} />
          <Route path="/site/export" element={<SiteExportPage />} />
          <Route path="/site/approvals" element={<ApprovalsPage />} />
          <Route path="/site/audit" element={<AuditLogPage />} />
          <Route path="/mapping" element={<MappingPage />} />
          <Route path="/versions" element={<VersionsPage />} />
          <Route path="/execution" element={<ExecutionPage />} />
          <Route path="/artifacts" element={<ArtifactsPage />} />
          <Route path="/logs" element={<LogViewerPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/site/scheduler" element={<SchedulerPage />} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;
