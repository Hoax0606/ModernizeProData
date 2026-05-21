import { useRef } from 'react';
import { useT } from '../i18n';

interface Props {
  value: string;
  onChange: (v: string) => void;
}

// File System Access API (Chromium / secure context).
type DirectoryPickerOptions = { id?: string; mode?: 'read' | 'readwrite' };
interface FileSystemDirectoryHandleLike { name: string }
interface WindowWithDirPicker extends Window {
  showDirectoryPicker?: (opts?: DirectoryPickerOptions) => Promise<FileSystemDirectoryHandleLike>;
}

/**
 * CSV 디렉터리 입력 + 폴더 선택 버튼.
 * - Chromium + secure context: showDirectoryPicker 사용 (네이티브 폴더 다이얼로그)
 * - 그 외: <input type="file" webkitdirectory> 로 폴더 선택. (브라우저 보안상 절대경로는
 *   받을 수 없고 폴더명 + 첫 파일의 webkitRelativePath 만 추출 — 사용자가 직접 절대경로를
 *   완성해 줘야 함. desktop 앱(jpackage) 으로 배포되면 네이티브 dialog 로 교체 예정.)
 */
export function CsvPathField({ value, onChange }: Props) {
  const t = useT();
  const fallbackRef = useRef<HTMLInputElement | null>(null);

  const handleBrowse = async () => {
    const w = window as WindowWithDirPicker;
    if (typeof w.showDirectoryPicker === 'function') {
      try {
        const handle = await w.showDirectoryPicker({ mode: 'read' });
        onChange(handle.name);
      } catch {
        /* 사용자 취소 — 무시 */
      }
      return;
    }
    fallbackRef.current?.click();
  };

  const handleFallbackChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const first = files[0] as File & { webkitRelativePath?: string };
    const segments = first.webkitRelativePath?.split('/') ?? [];
    if (segments.length > 1) onChange(segments[0]);
    e.target.value = '';
  };

  return (
    <div style={styles.row}>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t('siteSettings.csvPathPlaceholder')}
        style={styles.input}
        spellCheck={false}
      />
      <button type="button" onClick={handleBrowse} style={styles.btnGhost}>
        {t('siteSettings.csvPathBrowse')}
      </button>
      <input
        ref={fallbackRef}
        type="file"
        // @ts-expect-error — webkitdirectory 는 비표준 attribute
        webkitdirectory=""
        directory=""
        multiple
        style={{ display: 'none' }}
        onChange={handleFallbackChange}
      />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  row: { display: 'flex', gap: 6 },
  input: {
    flex: 1,
    padding: '8px 10px',
    border: '1px solid var(--border-strong)',
    borderRadius: 4,
    background: 'var(--panel)',
    color: 'var(--text)',
    fontSize: 12,
    fontFamily: 'var(--mono)',
    outline: 'none',
  },
  btnGhost: {
    padding: '7px 12px',
    background: 'var(--panel)',
    border: '1px solid var(--border-strong)',
    color: 'var(--text-2)',
    borderRadius: 4,
    fontSize: 12,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
};
