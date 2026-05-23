import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

const STORAGE_KEY = 'mpd:demo';
const DEMO_VALUE = 'preflight';

function readSessionFlag(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.sessionStorage.getItem(STORAGE_KEY) === DEMO_VALUE;
  } catch {
    return false;
  }
}

/**
 * Demo 모드 진입/유지 hook.
 *
 * - URL `?demo=preflight` 는 "demo 진입로". 해당 URL 로 들어오면 sessionStorage 에
 *   flag 를 set 하고 isDemo=true 를 반환.
 * - 이후 다른 페이지로 navigate 해 URL 에서 query 가 빠져도 sessionStorage flag 가
 *   살아있으면 isDemo 가 그대로 true → AppShell 의 demo fixture 가 유지된다.
 * - `exitDemo` 호출 시 sessionStorage flag + URL ?demo 둘 다 정리.
 * - sessionStorage 인 이유: tab 닫으면 자동 cleanup → demo 가 무한정 남지 않는다.
 */
export function useDemoMode(): { isDemo: boolean; exitDemo: () => void } {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlDemo = searchParams.get('demo') === DEMO_VALUE;

  // 초기값 — URL 진입 또는 이미 세션에 저장된 상태.
  const [active, setActive] = useState<boolean>(() => urlDemo || readSessionFlag());

  // URL 에 ?demo=preflight 가 들어오면 session 에도 set.
  useEffect(() => {
    if (urlDemo) {
      try { window.sessionStorage.setItem(STORAGE_KEY, DEMO_VALUE); } catch { /* sandbox */ }
      setActive(true);
    } else if (readSessionFlag()) {
      setActive(true);
    }
  }, [urlDemo]);

  const exitDemo = useCallback(() => {
    try { window.sessionStorage.removeItem(STORAGE_KEY); } catch { /* sandbox */ }
    setActive(false);
    if (searchParams.has('demo')) {
      const next = new URLSearchParams(searchParams);
      next.delete('demo');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  return { isDemo: active, exitDemo };
}
