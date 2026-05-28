/**
 * 도구 브랜드명. Prototype 의 BrandName 과 동일한 표기.
 *   "ModernizePro" + 초록색 "Data"
 */
export function BrandName({ style }: { style?: React.CSSProperties }) {
  return (
    <span style={style}>
      ModernizePro<span style={{ color: 'var(--green)' }}>Data</span>
    </span>
  );
}
