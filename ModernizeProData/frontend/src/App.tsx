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
import { ArtifactsPage } from './pages/ArtifactsPage';
import { LogViewerPage } from './pages/LogViewerPage';
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
              <Route path="/site/export" element={<SiteExportPage />} />
              <Route path="/site/approvals" element={<ApprovalsPage />} />
              <Route path="/site/audit" element={<AuditLogPage />} />
              <Route path="/mapping" element={<PlaceholderPage title="Mapping" description="AS-IS → TO-BE 컬럼 매핑 정의" />} />
              <Route path="/versions" element={<VersionsPage />} />
              <Route path="/execution" element={<ExecutionPage />} />
              <Route path="/artifacts" element={<ArtifactsPage />} />
              <Route path="/logs" element={<LogViewerPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Route>
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

export default App;
