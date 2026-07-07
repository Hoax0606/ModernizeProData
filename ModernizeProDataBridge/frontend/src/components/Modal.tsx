import { createPortal } from 'react-dom';
import { useEffect } from 'react';

interface Props {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  children: React.ReactNode;
  width?: number;
  /** 헤더 오른쪽 영역. 지정하면 기본 X 버튼 대신 이것이 렌더된다. */
  headerRight?: React.ReactNode;
}

/**
 * 공통 모달 — Prototype 의 OverlayShell 패턴.
 * ESC = close (Cancel 과 동등). Backdrop click 은 무시 — 사용자 실수 방지.
 */
export function Modal({ open, onClose, title, children, width = 440, headerRight }: Props) {
  // ESC 로 닫기 — open 일 때만 listener.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing) {
        // stopImmediatePropagation — 같은 window 의 다른 keydown listener
        // (Inspector close 등) 가 연속 발사되지 않도록.
        e.stopImmediatePropagation();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div style={styles.backdrop}>
      <div style={{ ...styles.shell, width }}>
        {title && (
          <div style={styles.header}>
            <div style={styles.title}>{title}</div>
            {headerRight !== undefined
              ? headerRight
              : <button type="button" onClick={onClose} style={styles.closeBtn} aria-label="Close">✕</button>}
          </div>
        )}
        <div style={styles.body}>{children}</div>
      </div>
    </div>,
    document.body,
  );
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(10,18,16,0.45)',
    display: 'grid',
    placeItems: 'center',
    zIndex: 2000,
  },
  shell: {
    background: 'var(--panel)',
    border: '1px solid var(--border-strong)',
    borderRadius: 5,
    boxShadow: '0 30px 80px rgba(10,20,18,0.35)',
    maxWidth: '90vw',
    maxHeight: '90vh',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  header: {
    padding: '12px 16px',
    borderBottom: '1px solid var(--border)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: { fontSize: 13, fontWeight: 600, color: 'var(--text)' },
  closeBtn: {
    width: 22,
    height: 22,
    border: '1px solid var(--border)',
    background: 'var(--panel)',
    color: 'var(--text-3)',
    borderRadius: 3,
    cursor: 'pointer',
    fontSize: 11,
  },
  body: {
    padding: 16,
    overflow: 'auto',
  },
};
