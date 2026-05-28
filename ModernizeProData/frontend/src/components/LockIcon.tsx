interface Props {
  open?: boolean;
  color?: string;
  size?: number;
  title?: string;
}

export function LockIcon({ open = false, color = 'var(--green)', size = 14, title }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke={color}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label={title}
      style={{ display: 'inline-block', verticalAlign: 'middle' }}
    >
      {title && <title>{title}</title>}
      {open
        ? <path d="M6 9V6a4 4 0 0 1 7.6-1.6" />
        : <path d="M6 9V6a4 4 0 0 1 8 0v3" />
      }
      <rect x="3.5" y="9" width="13" height="8" rx="1.6" />
      <circle cx="10" cy="13" r="1" fill={color} stroke="none" />
    </svg>
  );
}
