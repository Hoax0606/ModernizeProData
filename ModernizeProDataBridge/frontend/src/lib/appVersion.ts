/**
 * 단일 버전 소스 — installer/build.ps1 이 vite build 직전에 VITE_APP_VERSION
 * (auto-bump 1.0.<counter>) 을 주입한다. dev (npm run dev) 에선 미설정이라
 * fallback 표시. 버전을 보여주는 모든 화면 (AboutModal / LoginPage /
 * LicenseSetupPage / ...) 은 반드시 이 상수를 쓸 것 — 하드코딩 금지.
 */
export const APP_VERSION: string =
  (import.meta.env.VITE_APP_VERSION as string | undefined) || '1.0.0-dev';
