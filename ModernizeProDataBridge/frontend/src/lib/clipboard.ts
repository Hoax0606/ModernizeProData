/**
 * 클립보드 복사 — navigator.clipboard 가 없는 환경(예: JavaFX WebView, 비 secure
 * context)에서도 동작하도록 textarea + execCommand 로 폴백한다.
 *
 * navigator.clipboard 를 그대로 호출하면 WebView 에서 undefined 라 TypeError 가
 * 나므로, 반드시 이 헬퍼를 통해 복사한다.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to execCommand */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
