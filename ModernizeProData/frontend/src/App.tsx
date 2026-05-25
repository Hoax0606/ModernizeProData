import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { LoginPage } from './pages/LoginPage';
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

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function App() {
  // 테마를 document 에 반영 (Solution settings 의 Dark 토글이 즉시 동작)
  const theme = useSettingsStore((s) => s.theme);
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // 인스톨러가 박은 default language 를 첫 부팅 시 한 번 적용. zustand persist
  // 의 localStorage 가 비어있을 때 (= 진짜 첫 부팅) 만 적용해서 사용자가 한 번
  // 변경한 적 있는 경우는 덮어쓰지 않음.
  useEffect(() => {
    const persisted = localStorage.getItem('modernize-settings');
    if (persisted) return;
    fetch('/api/v1/health/info')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const lang = d?.data?.defaultLanguage;
        if (lang === 'ko' || lang === 'ja' || lang === 'en') {
          useSettingsStore.getState().setLanguage(lang);
        }
      })
      .catch(() => {
        /* endpoint 없음 / dev 환경 - navigator.language fallback 그대로. */
      });
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />

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
      </BrowserRouter>
    </QueryClientProvider>
  );
}

export default App;
