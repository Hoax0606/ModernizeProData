/**
 * DDL 텍스트에서 DB 종류를 휴리스틱으로 추정 (#71-A).
 *
 * Create New Project 모달은 파일을 서버에 보내기 전이라 정확한 dialect 를 모른다. 파일 텍스트
 * 앞부분의 특징 토큰으로 추정해 사용자에게 즉시 힌트만 준다 (확정값 아님 — 정확한 dialect 는
 * import 후 백엔드 DdlImport.dialect 에서 DdlSchemaPanel 이 표시 #71-B).
 */
export type DialectId = 'oracle' | 'postgresql' | 'mysql' | 'sqlserver' | 'unknown';

const RULES: { id: Exclude<DialectId, 'unknown'>; label: string; patterns: RegExp[] }[] = [
  {
    id: 'oracle',
    label: 'Oracle',
    patterns: [/\bVARCHAR2\b/i, /\bNVARCHAR2\b/i, /\bNUMBER\s*\(/i, /\bCLOB\b/i, /\bsys_guid\b/i,
               /\bdual\b/i, /\brownum\b/i, /\bTABLESPACE\b/i, /\bVARCHAR2\s*\(\s*\d+\s*(BYTE|CHAR)\b/i],
  },
  {
    id: 'postgresql',
    label: 'PostgreSQL',
    patterns: [/\bSERIAL\b/i, /\bBIGSERIAL\b/i, /\bBYTEA\b/i, /\bBOOLEAN\b/i, /\bJSONB\b/i,
               /\bset_config\s*\(/i, /\bOWNER\s+TO\b/i, /::[a-z]/, /\bCREATE\s+SCHEMA\b/i, /\bnow\s*\(\s*\)/i],
  },
  {
    id: 'mysql',
    label: 'MySQL',
    patterns: [/\bAUTO_INCREMENT\b/i, /\bENGINE\s*=/i, /\bUNSIGNED\b/i, /\bTINYINT\b/i,
               /`[^`]+`/, /\bDEFAULT\s+CHARSET\b/i],
  },
  {
    id: 'sqlserver',
    label: 'SQL Server',
    patterns: [/\bNVARCHAR\s*\(\s*MAX\s*\)/i, /\bIDENTITY\s*\(/i, /\[dbo\]\./i, /\bDATETIME2\b/i,
               /^\s*GO\s*$/im, /\bUNIQUEIDENTIFIER\b/i],
  },
];

/** 텍스트 → 추정 dialect. 매칭 패턴 수가 가장 많은 dialect 선택, 0 이면 unknown. */
export function detectDialect(text: string): { id: DialectId; label: string } {
  // 큰 파일은 앞 256KB 만 — 특징 토큰은 보통 초반에 충분.
  const sample = text.length > 262144 ? text.slice(0, 262144) : text;
  let best: { id: DialectId; label: string; score: number } = { id: 'unknown', label: '?', score: 0 };
  for (const rule of RULES) {
    let score = 0;
    for (const p of rule.patterns) if (p.test(sample)) score++;
    if (score > best.score) best = { id: rule.id, label: rule.label, score };
  }
  return { id: best.id, label: best.label };
}

/** File 을 읽어 dialect 추정. 실패 시 unknown. */
export async function detectDialectOfFile(file: File): Promise<{ id: DialectId; label: string }> {
  try {
    const text = await file.text();
    return detectDialect(text);
  } catch {
    return { id: 'unknown', label: '?' };
  }
}
