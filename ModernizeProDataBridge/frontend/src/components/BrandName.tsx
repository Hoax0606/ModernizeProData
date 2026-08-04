/**
 * 도구 브랜드명.
 *   "ModernizePro" + 초록색 "DataBridge"  → ModernizeProDataBridge
 */
export function BrandName({ style }: { style?: React.CSSProperties }) {
  return (
    <span style={style}>
      ModernizePro<span style={{ color: 'var(--green)' }}>DataBridge</span>
    </span>
  );
}
