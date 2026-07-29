package com.ksinfo.modernize_pro_data.coordinator.worker;

import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingRule;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingTableBinding;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingTableBindingSource;

import java.util.ArrayList;
import java.util.List;

/**
 * TransformStage 의 FROM 절 + 컬럼 alias 생성. composition_kind 별:
 *
 *   - single : FROM "schema"."asis_{table}" AS {source.alias}
 *              source.alias 는 MappingImportService.deriveBindings 가 import 시 자동 부여
 *              (예: CUSTOMERS → "c"). transform_rule SQL 내부 컬럼 참조와 일치해야 한다.
 *              source.alias 가 비어 있으면 SINGLE_ALIAS_FALLBACK ("asis") 사용.
 *   - join   : FROM asis_{primary} {alias} {joinType} JOIN asis_{j} {alias_j} ON {joinOn} ...
 *              컬럼 alias 는 MappingRule.asisTable 로 source 매칭
 *   - union  : FROM (SELECT * FROM asis_t1 UNION ALL SELECT * FROM asis_t2) AS "u"
 *              컬럼 alias 는 "u" (서브쿼리)
 *
 * PoC 단순화:
 *   - union 은 모든 source 가 같은 컬럼 구조 (SELECT *) 가정
 *   - join 의 alias / joinOn 은 mapping UI 에서 작성된 값 그대로 신뢰
 */
public final class SqlComposer {

    /** sources 없을 때만 사용되는 fallback. 정상 single binding 은 source.alias 사용. */
    public static final String SINGLE_ALIAS_FALLBACK = "asis";
    public static final String UNION_ALIAS = "u";

    private SqlComposer() {}

    /** FROM 절 본문 (FROM 키워드 제외). sources 없으면 null (FROM 절 생략). */
    public static String fromClause(String schema, MappingTableBinding binding) {
        List<MappingTableBindingSource> sources = binding.getSources();
        if (sources == null || sources.isEmpty()) return null;
        String kind = kindOf(binding);

        switch (kind) {
            case "union": {
                StringBuilder u = new StringBuilder("(");
                boolean first = true;
                for (MappingTableBindingSource s : sources) {
                    if (!first) u.append(" UNION ALL ");
                    u.append("SELECT * FROM ").append(fq(schema, "asis_" + s.getAsisTable()));
                    first = false;
                }
                u.append(") AS ").append(ident(UNION_ALIAS));
                return u.toString();
            }
            case "join": {
                MappingTableBindingSource primary = primaryOf(sources);
                StringBuilder sb = new StringBuilder();
                sb.append(fq(schema, "asis_" + primary.getAsisTable()))
                  .append(" ").append(ident(aliasOf(primary)));
                for (MappingTableBindingSource s : sources) {
                    if (s == primary) continue;
                    String jt = (s.getJoinType() == null || s.getJoinType().isBlank())
                            ? "LEFT" : s.getJoinType();
                    sb.append(" ").append(jt).append(" JOIN ")
                      .append(fq(schema, "asis_" + s.getAsisTable()))
                      .append(" ").append(ident(aliasOf(s)));
                    if (s.getJoinOn() != null && !s.getJoinOn().isBlank()) {
                        sb.append(" ON ").append(s.getJoinOn());
                    }
                }
                return sb.toString();
            }
            default: { // single
                MappingTableBindingSource only = sources.get(0);
                return fq(schema, "asis_" + only.getAsisTable()) + " AS " + ident(aliasOf(only));
            }
        }
    }

    /** rule 의 AS-IS 컬럼이 참조할 table alias. */
    public static String aliasFor(MappingRule rule, MappingTableBinding binding) {
        String kind = kindOf(binding);
        if ("union".equals(kind)) return UNION_ALIAS;
        if ("join".equals(kind)) {
            List<MappingTableBindingSource> sources = binding.getSources();
            if (sources != null && !sources.isEmpty()) {
                String want = rule.getAsisTable();
                if (want != null && !want.isBlank()) {
                    for (MappingTableBindingSource s : sources) {
                        if (want.equals(s.getAsisTable())) return aliasOf(s);
                    }
                    // 지정된 AS-IS 테이블이 어느 join source 와도 매칭 안 됨.
                    // 조용히 primary alias 로 떨어뜨리면 엉뚱한 테이블에서 컬럼을 읽어
                    // 에러 없이 틀린 데이터가 나온다(silent corruption). → fail-fast 로 표면화.
                    // TransformStage 가 per-table catch → 해당 테이블 failed + Quarantine 카드.
                    throw new IllegalStateException(
                            "join binding 의 mapping_rule 이 참조하는 AS-IS 테이블 '" + want
                            + "' 이 join source 목록에 없습니다 (tobe_table=" + binding.getTobeTable()
                            + ", sources=" + sourceTableNames(sources) + "). 매핑 정의를 확인하세요.");
                }
                // asisTable 미지정 rule — 어느 테이블인지 특정 불가 → primary alias 로 (기존 동작 유지).
                return aliasOf(primaryOf(sources));
            }
        }
        // single — binding source 의 alias 로 통일 (transform_rule 안의 'c.col' 같은 auto-alias 와 매칭)
        List<MappingTableBindingSource> sources = binding.getSources();
        if (sources != null && !sources.isEmpty()) return aliasOf(sources.get(0));
        return SINGLE_ALIAS_FALLBACK;
    }

    /**
     * single/primary source 의 alias — 델타 {@code __op} 제어 컬럼 passthrough 등 rule 없이
     * source 를 참조할 때 사용. FROM 절이 붙이는 alias 와 동일해야 한다.
     */
    public static String primaryAlias(MappingTableBinding binding) {
        List<MappingTableBindingSource> sources = binding.getSources();
        if (sources != null && !sources.isEmpty()) return aliasOf(sources.get(0));
        return SINGLE_ALIAS_FALLBACK;
    }

    /**
     * union binding 방어 가드 (B6) — 각 source 의 컬럼 시그니처(이름+순서)가 모두 동일한지 강제.
     * fromClause 의 union 은 {@code (SELECT * FROM asis_a UNION ALL SELECT * FROM asis_b) AS u} 라
     * UNION ALL 이 컬럼을 **위치**로 붙인다. source 들의 컬럼 순서가 다르면 값이 조용히 뒤섞임
     * (silent corruption). 여기서 시그니처 불일치를 {@link IllegalStateException} 으로 표면화한다
     * (TransformStage 가 per-table catch → 해당 테이블 failed + Quarantine).
     *
     * <p>완전 해결(명시적 컬럼 투영)은 union 매핑이 실제 설계되는 시점 과제. 지금은 "union source 는
     * 동일 컬럼 구조" 라는 문서화된 가정을 런타임에 강제하는 것.
     *
     * @param sourceTables    source AS-IS 테이블명 (메시지용)
     * @param signatures      각 source 의 컬럼명 리스트 (선언 순서). sourceTables 와 같은 순서·길이.
     *                        이름 비교는 대소문자 무시(순서는 유지).
     */
    public static void assertUnionColumnsAligned(List<String> sourceTables, List<List<String>> signatures) {
        if (signatures == null || signatures.size() < 2) return;   // 0/1 source → 정렬 이슈 없음
        List<String> base = lowerAll(signatures.get(0));
        for (int i = 1; i < signatures.size(); i++) {
            if (!base.equals(lowerAll(signatures.get(i)))) {
                throw new IllegalStateException(
                        "union binding 의 source 컬럼 구조가 서로 다릅니다 — SELECT * UNION ALL 이 컬럼을 "
                        + "위치 기준으로 붙여 값이 뒤섞일 수 있습니다(silent corruption). source '"
                        + safeName(sourceTables, 0) + "' 컬럼=" + signatures.get(0)
                        + " vs source '" + safeName(sourceTables, i) + "' 컬럼=" + signatures.get(i)
                        + ". 컬럼 이름/순서를 일치시키거나 명시적 컬럼 투영 매핑이 필요합니다.");
            }
        }
    }

    private static List<String> lowerAll(List<String> xs) {
        List<String> r = new ArrayList<>(xs.size());
        for (String x : xs) r.add(x == null ? null : x.toLowerCase());
        return r;
    }

    private static String safeName(List<String> names, int i) {
        return (names != null && i < names.size()) ? names.get(i) : ("#" + i);
    }

    private static String kindOf(MappingTableBinding b) {
        return (b.getCompositionKind() == null || b.getCompositionKind().isBlank())
                ? "single" : b.getCompositionKind();
    }

    private static MappingTableBindingSource primaryOf(List<MappingTableBindingSource> sources) {
        return sources.stream()
                .filter(s -> "primary".equals(s.getRole()))
                .findFirst().orElse(sources.get(0));
    }

    /** 예외 메시지용 — join source 들의 AS-IS 테이블명 목록. */
    private static String sourceTableNames(List<MappingTableBindingSource> sources) {
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < sources.size(); i++) {
            if (i > 0) sb.append(", ");
            sb.append(sources.get(i).getAsisTable());
        }
        return sb.append("]").toString();
    }

    private static String aliasOf(MappingTableBindingSource s) {
        return (s.getAlias() == null || s.getAlias().isBlank()) ? s.getAsisTable() : s.getAlias();
    }

    private static String fq(String schema, String table) {
        return ident(schema) + "." + ident(table);
    }

    private static String ident(String name) {
        return "\"" + name.replace("\"", "\"\"") + "\"";
    }
}
