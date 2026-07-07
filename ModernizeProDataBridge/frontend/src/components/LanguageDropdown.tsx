import { useEffect, useRef, useState } from 'react';
import { type Language } from '../store/settings';
import { LANGUAGE_LABELS } from '../i18n';

/**
 * 언어 선택 드롭다운 — Login / License setup 등 인증 전 화면에서 사용.
 * (구 LoginPage 내부 컴포넌트를 공유 컴포넌트로 추출, 2026-06-05.)
 */
export function LanguageDropdown({ language, onChange }: { language: Language; onChange: (l: Language) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const langs = Object.keys(LANGUAGE_LABELS) as Language[];

  return (
    <div ref={ref} style={dropdownStyles.wrap}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{ ...dropdownStyles.trigger, ...(open ? dropdownStyles.triggerOpen : {}) }}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span>{LANGUAGE_LABELS[language]}</span>
        <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ transform: open ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform .12s' }}>
          <path d="M2 3.5L5 6.5L8 3.5" />
        </svg>
      </button>
      {open && (
        <div role="listbox" style={dropdownStyles.menu}>
          {langs.map((k) => {
            const active = k === language;
            return (
              <button
                key={k}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => { onChange(k); setOpen(false); }}
                style={{ ...dropdownStyles.item, ...(active ? dropdownStyles.itemActive : {}) }}
              >
                {LANGUAGE_LABELS[k]}
                {active && (
                  <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M2 6L5 9L10 3" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const dropdownStyles: Record<string, React.CSSProperties> = {
  wrap: { position: 'relative', display: 'inline-block' },
  trigger: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '3px 8px',
    border: '1px solid var(--border)',
    borderRadius: 3,
    background: 'var(--panel)',
    color: 'var(--text-2)',
    fontSize: 11,
    fontWeight: 500,
    cursor: 'pointer',
    lineHeight: 1.3,
  },
  triggerOpen: {
    borderColor: 'var(--navy)',
    color: 'var(--navy)',
    background: 'var(--navy-50)',
  },
  menu: {
    position: 'absolute',
    top: 'calc(100% + 4px)',
    right: 0,
    minWidth: 120,
    background: 'var(--panel)',
    border: '1px solid var(--border-strong)',
    borderRadius: 4,
    boxShadow: '0 6px 18px rgba(12,31,27,0.12)',
    padding: 3,
    display: 'flex',
    flexDirection: 'column',
    gap: 1,
    zIndex: 50,
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    padding: '6px 10px',
    border: 'none',
    background: 'transparent',
    color: 'var(--text)',
    fontSize: 11.5,
    fontWeight: 500,
    cursor: 'pointer',
    borderRadius: 3,
    textAlign: 'left',
  },
  itemActive: {
    background: 'var(--navy-50)',
    color: 'var(--navy)',
    fontWeight: 700,
  },
};
