interface Props {
  on: boolean;
  onChange: () => void;
  ariaLabel?: string;
}

/**
 * 작고 일관된 iOS 스타일 토글 스위치.
 * 36 × 20, 12px 손잡이.
 */
export function Toggle({ on, onChange, ariaLabel }: Props) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      onClick={onChange}
      style={{
        width: 34,
        height: 18,
        background: on ? 'var(--navy)' : 'var(--border-strong)',
        border: 'none',
        borderRadius: 999,
        position: 'relative',
        cursor: 'pointer',
        transition: 'background .15s',
        padding: 0,
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: on ? 18 : 2,
          width: 14,
          height: 14,
          background: '#fff',
          borderRadius: '50%',
          transition: 'left .15s',
          boxShadow: '0 1px 2px rgba(0,0,0,0.18)',
        }}
      />
    </button>
  );
}
