import type { CSSProperties, KeyboardEvent } from 'react';

/**
 * Custom checkbox / radio — native <input> 을 쓰지 않고 <span> 으로 직접 그린다.
 *
 * JavaFX WebView 의 구형 WebKit 은 `appearance:none` 을 완전히 적용하지 못해
 * native 체크 마크가 위에 그대로 남는다 (background-image 로 덮어도 안 가려짐).
 * 그래서 input 자체를 안 쓰고 box + 체크표시를 직접 렌더해 어디서든 동일하게 보이게 한다.
 *
 * controlled only: checked + onChange(nextChecked).
 * <label> 안에서 쓸 땐 label 에 onClick 을 달아 텍스트 클릭도 토글되게 하고,
 * 이 컴포넌트는 stopPropagation 으로 이중 토글을 막는다.
 */
interface Props {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** checkbox 부분 선택(일부만 체크) 표시 — dash. */
  indeterminate?: boolean;
  /** box 에 덧붙일 스타일 (크기/마진 등). */
  style?: CSSProperties;
  ariaLabel?: string;
  title?: string;
}

const baseBox = (filled: boolean, disabled?: boolean): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 16,
  height: 16,
  flexShrink: 0,
  boxSizing: 'border-box',
  border: `1.5px solid ${filled ? 'var(--navy)' : 'var(--text-3)'}`,
  background: filled ? 'var(--navy)' : 'var(--panel)',
  cursor: disabled ? 'not-allowed' : 'pointer',
  opacity: disabled ? 0.5 : 1,
  transition: 'background-color .1s ease, border-color .1s ease',
  userSelect: 'none',
});

export function Checkbox({ checked, onChange, disabled, indeterminate, style, ariaLabel, title }: Props) {
  const toggle = () => { if (!disabled) onChange(!checked); };
  const filled = checked || !!indeterminate;
  return (
    <span
      role="checkbox"
      aria-checked={indeterminate ? 'mixed' : checked}
      aria-label={ariaLabel}
      title={title}
      tabIndex={disabled ? -1 : 0}
      onClick={(e) => { e.stopPropagation(); toggle(); }}
      onKeyDown={(e: KeyboardEvent) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); } }}
      style={{ ...baseBox(filled, disabled), borderRadius: 3, ...style }}
    >
      {indeterminate ? (
        <span style={{ width: 8, height: 2, borderRadius: 1, background: '#fff' }} />
      ) : checked ? (
        <span
          style={{
            width: 5,
            height: 9,
            border: 'solid #fff',
            borderWidth: '0 2px 2px 0',
            transform: 'rotate(45deg)',
            marginTop: -2,
            boxSizing: 'border-box',
          }}
        />
      ) : null}
    </span>
  );
}

export function Radio({ checked, onChange, disabled, style, ariaLabel, title }: Props) {
  const select = () => { if (!disabled) onChange(true); };
  return (
    <span
      role="radio"
      aria-checked={checked}
      aria-label={ariaLabel}
      title={title}
      tabIndex={disabled ? -1 : 0}
      onClick={(e) => { e.stopPropagation(); select(); }}
      onKeyDown={(e: KeyboardEvent) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); select(); } }}
      style={{ ...baseBox(checked, disabled), borderRadius: '50%', ...style }}
    >
      {checked && <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#fff' }} />}
    </span>
  );
}
