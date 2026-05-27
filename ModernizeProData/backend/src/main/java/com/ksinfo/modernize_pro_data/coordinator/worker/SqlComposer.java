package com.ksinfo.modernize_pro_data.coordinator.worker;

import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingRule;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingTableBinding;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingTableBindingSource;

import java.util.List;

/**
 * TransformStage 의 FROM 절 + 컬럼 alias 생성. composition_kind 별:
 *
 *   - single : FROM "schema"."asis_{table}" AS "asis"   (기존 호환 — alias 고정 "asis")
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

    public static final String SINGLE_ALIAS = "asis";
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
                return fq(schema, "asis_" + only.getAsisTable()) + " AS " + ident(SINGLE_ALIAS);
            }
        }
    }

    /** rule 의 AS-IS 컬럼이 참조할 table alias. */
    public static String aliasFor(MappingRule rule, MappingTableBinding binding) {
        String kind = kindOf(binding);
        if ("union".equals(kind)) return UNION_ALIAS;
        if ("join".equals(kind)) {
            List<MappingTableBindingSource> sources = binding.getSources();
            if (sources != null && rule.getAsisTable() != null) {
                for (MappingTableBindingSource s : sources) {
                    if (rule.getAsisTable().equals(s.getAsisTable())) return aliasOf(s);
                }
            }
            // 매칭 실패 → primary alias fallback
            if (sources != null && !sources.isEmpty()) return aliasOf(primaryOf(sources));
        }
        return SINGLE_ALIAS;
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
