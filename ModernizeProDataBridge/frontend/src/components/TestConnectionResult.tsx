import type { CSSProperties } from 'react';

export type TestStatus = 'idle' | 'testing' | 'ok' | 'failed';

interface Props {
  status: TestStatus;
  message: string | null;
  testingLabel: string;
  okLabel: string;
  failedLabel: string;
}

/**
 * TO-BE DB test connection 결과 표시 — ✓/✗ + 색 + (선택) 백엔드 메시지.
 * SiteSettingsModal · CreateSiteModal 공용.
 */
export function TestConnectionResult({
  status, message, testingLabel, okLabel, failedLabel,
}: Props) {
  if (status === 'idle') return null;
  const color =
    status === 'ok'     ? 'var(--green)' :
    status === 'failed' ? 'var(--red)'   :
                          'var(--amber)';
  const label =
    status === 'ok'     ? `✓ ${okLabel}` :
    status === 'failed' ? `✗ ${failedLabel}` :
                          testingLabel;
  return (
    <span style={{ ...styles.line, color }}>
      <span style={styles.label}>{label}</span>
      {message && status !== 'testing' && (
        <span style={styles.message} title={message}>— {message}</span>
      )}
    </span>
  );
}

const styles: Record<string, CSSProperties> = {
  line: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 11.5,
    fontFamily: 'var(--mono)',
  },
  label: { fontWeight: 600, flexShrink: 0 },
  message: {
    color: 'var(--text-3)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
};
