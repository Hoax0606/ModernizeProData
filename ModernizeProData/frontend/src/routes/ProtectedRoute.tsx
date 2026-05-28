import { Navigate, Outlet } from 'react-router-dom';
import { useAuthStore, type UserRole } from '../store/auth';

interface Props {
  roles?: UserRole[];
}

/**
 * 인증 필요한 라우트 보호.
 *  - 미로그인: /login 으로 redirect
 *  - 역할 부족: /forbidden 또는 dashboard 로 redirect
 *  - 통과: 자식 라우트 렌더링
 */
export function ProtectedRoute({ roles }: Props) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated());
  const userRole = useAuthStore((s) => s.user?.role);

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  if (roles && roles.length > 0 && userRole && !roles.includes(userRole)) {
    return <Navigate to="/" replace />;
  }

  return <Outlet />;
}
