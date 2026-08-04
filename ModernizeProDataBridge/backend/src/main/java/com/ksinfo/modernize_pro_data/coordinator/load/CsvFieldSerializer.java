package com.ksinfo.modernize_pro_data.coordinator.load;

/**
 * Load-time CSV field 직렬화 계약 — 파이프라인이 DuckDB row 값을 target sink(PG COPY / Oracle
 * sqlldr .dat)로 내보낼 때의 <b>단일 진실</b>. 두 경로가 동일 규칙을 쓰도록 여기로 추출.
 *
 * <p>규칙 (empty↔NULL / quoting):
 * <ul>
 *   <li>{@code null} → empty unquoted field. sink 가 <b>NULL</b> 로 해석 (PG CSV default).</li>
 *   <li>empty {@code String} → {@code ""} (quoted empty). sink 가 <b>빈 문자열</b>로 해석 — NULL 과
 *       구분되는 유일 케이스. (비-text 컬럼에 빈 문자열이 가면 COPY/sqlldr 가 syntax error →
 *       Transform 이 그런 컬럼엔 {@code NULLIF(col,'')} 로 NULL 을 내보내야 함.)</li>
 *   <li>그 외 → {@code v.toString()}. {@code , " \r \n} 포함 시에만 인용, 내부 {@code "} 는 doubling
 *       (RFC 4180). 타입 텍스트는 JDBC 드라이버의 object 렌더링 그대로 — locale/format 가공 없음.</li>
 * </ul>
 *
 * <p><b>인코딩 무관</b>: 여기서는 CSV <i>텍스트</i>만 만든다. 실제 바이트 인코딩(UTF-8 / Shift_JIS /
 * EUC-JP)은 sink 쪽(PGCopyOutputStream=UTF-8, TargetFileEncoder=타깃 charset)이 결정한다.
 */
public final class CsvFieldSerializer {

    private CsvFieldSerializer() {}

    /** 한 값을 CSV line StringBuilder 에 append (위 계약). */
    public static void append(StringBuilder sb, Object v) {
        if (v == null) return;
        String s = v.toString();
        if (s.isEmpty()) {
            sb.append("\"\"");
            return;
        }
        boolean needQuote = false;
        for (int i = 0, n = s.length(); i < n; i++) {
            char c = s.charAt(i);
            if (c == ',' || c == '"' || c == '\n' || c == '\r') {
                needQuote = true;
                break;
            }
        }
        if (needQuote) {
            sb.append('"');
            sb.append(s.replace("\"", "\"\""));
            sb.append('"');
        } else {
            sb.append(s);
        }
    }
}
