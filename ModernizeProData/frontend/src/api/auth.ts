import { api, unwrap, type ApiResponse } from './client';
import type { UserRole } from '../store/auth';

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  token: string;
  username: string;
  role: UserRole;
  expiresAt: string;
  lastSignInAt: string | null;
}

export const authApi = {
  login: (req: LoginRequest) =>
    unwrap(api.post<ApiResponse<LoginResponse>>('/api/v1/auth/login', req)),

  logout: () =>
    unwrap(api.post<ApiResponse<{ message: string }>>('/api/v1/auth/logout')),

  /** Login 거부 (AUTH_SESSION_ACTIVE_ELSEWHERE) 후 "끊고 로그인" 선택 시 호출. */
  forceSelfLogout: (username: string, password: string) =>
    unwrap(api.post<ApiResponse<{ message: string }>>('/api/v1/auth/force-self-logout', { username, password })),
};

export interface HealthInfo {
  name: string;
  mode: string;
  /** Coordinator 설치 앱 버전 (예: 1.0.25). 개발 실행 시 'dev'. */
  appVersion?: string;
  /** Coordinator self user — 이 username 의 run 은 Coordinator 안에서 local 실행되어
   *  Worker daemon heartbeat 가 없으므로, online dot 은 항상 online 으로 표시한다. */
  coordinatorSelfUsername?: string;
  javaVersion: string;
  osName: string;
  timestamp: string;
}

export const healthApi = {
  ping: () =>
    unwrap(api.get<ApiResponse<{ status: string; timestamp: string }>>('/api/v1/health')),

  info: () =>
    unwrap(api.get<ApiResponse<HealthInfo>>('/api/v1/health/info')),
};
