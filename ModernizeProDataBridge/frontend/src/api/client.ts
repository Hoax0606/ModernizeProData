import axios, { AxiosError, type AxiosResponse } from 'axios';
import { useAuthStore } from '../store/auth';

/**
 * 표준 API 응답 형식 (백엔드 ApiResponse 와 동일).
 */
export interface ApiResponse<T> {
  success: boolean;
  data: T | null;
  message?: string;
  error?: {
    code: string;
    message: string;
    details?: string[];
  };
  timestamp: string;
}

/**
 * 백엔드가 반환한 에러 코드를 보존하는 에러 클래스.
 * 호출부에서 code 로 분기 가능 (예: AUTH_USER_NOT_FOUND vs AUTH_PASSWORD_INVALID).
 */
export class ApiError extends Error {
  code: string;
  status?: number;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

/**
 * 공통 axios 인스턴스.
 *   - baseURL: dev 시 Vite proxy 또는 Coordinator URL 직접
 *   - 자동 JWT 토큰 헤더 부착
 *   - 401 응답 시 자동 로그아웃
 */
export const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8080',
  timeout: 30_000,
  headers: { 'Content-Type': 'application/json' },
});

// Request interceptor — JWT 토큰 자동 첨부
api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Response interceptor — 401 시 자동 로그아웃 + ApiError 변환
// 로그인 요청은 401 이 정상 흐름이므로 자동 logout 에서 제외.
// 라이선스 차단 (403 + LICENSE_MISSING/INVALID/EXPIRED) 도 자동 logout 으로
// 처리: 차단 상태에서는 어차피 사용자 작업이 막히므로 LoginPage 로 보내서
// master 가 새 .lic 를 import 하게 한다.
const LICENSE_BLOCK_CODES = new Set([
  'LICENSE_INVALID',
  'LICENSE_EXPIRED',
]);
// Single-shot: 한 세션에 한 번만 license 차단으로 logout 한다. master 가
// 다시 login 한 직후 dashboard 의 첫 API 호출에서 동일 차단을 또 logout
// 으로 처리하면 무한 loop. flag 는 successful refresh 가 status를 ACTIVE
// 류로 돌려놓을 때 리셋된다 (useLicenseStore 에서).
export let licenseLogoutFired = false;
export function resetLicenseLogoutFlag() { licenseLogoutFired = false; }

api.interceptors.response.use(
  (response: AxiosResponse) => response,
  (error: AxiosError<ApiResponse<unknown>>) => {
    const status = error.response?.status;
    const url = error.config?.url ?? '';
    const code = error.response?.data?.error?.code;
    const isLicenseBlock = status === 403 && !!code && LICENSE_BLOCK_CODES.has(code);
    const shouldLogoutForLicense = isLicenseBlock && !licenseLogoutFired;
    if (status === 401 && !url.includes('/auth/login')) {
      useAuthStore.getState().logout();
    } else if (shouldLogoutForLicense) {
      licenseLogoutFired = true;
      useAuthStore.getState().logout();
      // When the server has no license at all, jump straight to the
      // first-boot wizard instead of /login so the master can re-import.
      // JavaFX WebView doesn't reload on window.location.replace(), so we
      // use History API + popstate so react-router re-renders without a
      // full reload.
      if (code === 'LICENSE_MISSING'
          && window.location.pathname !== '/license-setup') {
        window.history.replaceState(null, '', '/license-setup');
        window.dispatchEvent(new PopStateEvent('popstate'));
      }
    }
    const body = error.response?.data;
    if (body?.error?.code) {
      return Promise.reject(new ApiError(body.error.code, body.error.message, status));
    }
    return Promise.reject(error);
  },
);

/**
 * 헬퍼 — ApiResponse 풀어서 data 만 반환.
 * 에러 시 ApiError (code 보존) 로 throw.
 */
export async function unwrap<T>(promise: Promise<AxiosResponse<ApiResponse<T>>>): Promise<T> {
  const res = await promise;
  if (!res.data.success) {
    const err = res.data.error;
    throw new ApiError(err?.code ?? 'UNKNOWN', err?.message ?? 'Unknown error');
  }
  return res.data.data as T;
}
