import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

const STORAGE_KEY = 'mpd:demo';

/**
 * Demo 진입로 종류.
 * - `preflight`: Pre-flight 8 fail Fix 흐름 시연.
 * - `run-fail`: Pre-flight 자동 pass 처리 + 사용자가 Start → 원하는 시점에 Trigger fail.
 */
export type DemoMode = 'preflight' | 'run-fail';
const VALID_MODES: readonly DemoMode[] = ['preflight', 'run-fail'] as const;

function isDemoMode(v: string | null): v is DemoMode {
  return v != null && (VALID_MODES as readonly string[]).includes(v);
}

function readSessionMode(): DemoMode | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = window.sessionStorage.getItem(STORAGE_KEY);
    return isDemoMode(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Demo 모드 진입/유지 hook.
 *
 * - URL `?demo=preflight` / `?demo=run-fail` 가 demo 진입로. 진입 시 sessionStorage 에
 *   mode 를 set 하고 isDemo=true / demoMode=값 반환.
 * - 이후 다른 페이지로 navigate 해 URL query 가 빠져도 sessionStorage flag 가 살아있으면
 *   isDemo 그대로 true → AppShell fixture 유지.
 * - `exitDemo` 호출 시 sessionStorage + URL ?demo 둘 다 정리.
 * - sessionStorage 라 탭 닫으면 cleanup → 무한정 남지 않음.
 *
 * 반환 shape 은 이전 `{ isDemo, exitDemo }` 와 호환 — `demoMode` 만 추가.
 */
export function useDemoMode(): { isDemo: boolean; demoMode: DemoMode | null; exitDemo: () => void } {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawUrlMode = searchParams.get('demo');
  const urlMode: DemoMode | null = isDemoMode(rawUrlMode) ? rawUrlMode : null;

  // 초기값 — URL 진입 또는 이미 세션에 저장된 mode.
  const [active, setActive] = useState<DemoMode | null>(() => urlMode ?? readSessionMode());

  // URL 에 ?demo=<mode> 가 들어오면 session 에도 set.
  useEffect(() => {
    if (urlMode) {
      try { window.sessionStorage.setItem(STORAGE_KEY, urlMode); } catch { /* sandbox */ }
      setActive(urlMode);
    } else {
      const session = readSessionMode();
      if (session) setActive(session);
    }
  }, [urlMode]);

  const exitDemo = useCallback(() => {
    try { window.sessionStorage.removeItem(STORAGE_KEY); } catch { /* sandbox */ }
    setActive(null);
    if (searchParams.has('demo')) {
      const next = new URLSearchParams(searchParams);
      next.delete('demo');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  return { isDemo: active !== null, demoMode: active, exitDemo };
}
