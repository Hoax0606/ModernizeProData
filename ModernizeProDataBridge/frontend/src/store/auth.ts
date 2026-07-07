import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type UserRole = 'master' | 'admin' | 'viewer';

export interface AuthUser {
  username: string;
  role: UserRole;
}

/**
 * 역할 표시명 — 도구 용어와 통일.
 * master → Coordinator (전체 운영·승인 권한)
 * admin  → Worker (실행·매핑 작업)
 * viewer → Viewer (조회만)
 */
export function roleLabel(role: UserRole | undefined | null): string {
  if (role === 'master') return 'Coordinator';
  if (role === 'admin')  return 'Worker';
  if (role === 'viewer') return 'Viewer';
  return '—';
}

interface AuthState {
  token: string | null;
  user: AuthUser | null;
  expiresAt: string | null;
  lastSignInAt: string | null;
  loginAt: string | null;

  setAuth: (token: string, user: AuthUser, expiresAt: string, lastSignInAt: string | null) => void;
  logout: () => void;
  isAuthenticated: () => boolean;
  hasRole: (...roles: UserRole[]) => boolean;
}

/**
 * 인증 store.
 * 로그인 후 JWT 토큰·사용자 정보를 localStorage 에 영속.
 * 페이지 새로고침 후에도 유지.
 */
export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      token: null,
      user: null,
      expiresAt: null,
      lastSignInAt: null,
      loginAt: null,

      setAuth: (token, user, expiresAt, lastSignInAt) =>
        set({ token, user, expiresAt, lastSignInAt, loginAt: new Date().toISOString() }),

      logout: () => set({ token: null, user: null, expiresAt: null, lastSignInAt: null, loginAt: null }),

      isAuthenticated: () => {
        const { token, expiresAt } = get();
        if (!token || !expiresAt) return false;
        // 토큰 만료 시각 검사
        return new Date(expiresAt) > new Date();
      },

      hasRole: (...roles) => {
        const role = get().user?.role;
        return role ? roles.includes(role) : false;
      },
    }),
    {
      name: 'modernize-auth',
    },
  ),
);
