package com.ksinfo.modernize_pro_data.coordinator.worker;

import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingRule;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingTableBinding;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingTableBindingSource;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * SqlComposer — TransformStage 의 FROM 절 + 컬럼 alias 생성 정합성 (핸드오프 Task B).
 *
 * 검증 포인트:
 *  - B5 (alias): fromClause 의 테이블 alias 와 aliasFor(rule) 가 항상 일치해야 한다.
 *                (과거 FROM 은 source.alias, 컬럼참조는 "asis" 고정이던 mismatch 가 없어야 함)
 *  - B6 (union): SELECT * UNION ALL — 서브쿼리 alias "u" 로 통일.
 *  - B7 (join fallback): rule.asisTable 이 소스에 매칭되면 그 alias, 아니면 primary alias.
 */
class SqlComposerTest {

    private static final String SCHEMA = "run_abc";

    private static MappingTableBindingSource src(
            int ordinal, String asisTable, String alias, String role, String joinType, String joinOn) {
        MappingTableBindingSource s = new MappingTableBindingSource();
        s.setOrdinal(ordinal);
        s.setAsisTable(asisTable);
        s.setAlias(alias);
        s.setRole(role);
        s.setJoinType(joinType);
        s.setJoinOn(joinOn);
        return s;
    }

    private static MappingTableBinding binding(String kind, MappingTableBindingSource... sources) {
        MappingTableBinding b = new MappingTableBinding();
        b.setCompositionKind(kind);
        for (MappingTableBindingSource s : sources) b.addSource(s);
        return b;
    }

    private static MappingRule ruleForTable(String asisTable) {
        MappingRule r = new MappingRule();
        r.setAsisTable(asisTable);
        return r;
    }

    // ---- single -----------------------------------------------------------

    @Test
    void single_fromAndAlias_useSourceAlias_andAgree() {
        MappingTableBinding b = binding("single", src(0, "CUSTOMERS", "c", "primary", null, null));

        assertEquals("\"run_abc\".\"asis_CUSTOMERS\" AS \"c\"",
                SqlComposer.fromClause(SCHEMA, b));
        // 컬럼참조 alias 는 FROM 의 alias 와 같아야 한다 (transform_rule 안의 c.col 매칭).
        assertEquals("c", SqlComposer.aliasFor(ruleForTable("CUSTOMERS"), b));
    }

    @Test
    void single_blankAlias_fallsBackToAsisTableName_consistently() {
        // alias 가 비어 있으면 aliasOf 가 asisTable 명을 alias 로 사용 → FROM/aliasFor 동일.
        MappingTableBinding b = binding("single", src(0, "ORDERS", "", "primary", null, null));

        assertEquals("\"run_abc\".\"asis_ORDERS\" AS \"ORDERS\"",
                SqlComposer.fromClause(SCHEMA, b));
        assertEquals("ORDERS", SqlComposer.aliasFor(ruleForTable("ORDERS"), b));
    }

    @Test
    void nullCompositionKind_treatedAsSingle() {
        MappingTableBinding b = binding(null, src(0, "T", "t", "primary", null, null));
        assertEquals("\"run_abc\".\"asis_T\" AS \"t\"", SqlComposer.fromClause(SCHEMA, b));
    }

    @Test
    void noSources_fromClauseNull_aliasFallback() {
        MappingTableBinding b = binding("single"); // no sources
        assertNull(SqlComposer.fromClause(SCHEMA, b));
        assertEquals(SqlComposer.SINGLE_ALIAS_FALLBACK, SqlComposer.aliasFor(ruleForTable("X"), b));
    }

    // ---- join -------------------------------------------------------------

    @Test
    void join_buildsPrimaryThenJoins_withPerTableAlias() {
        MappingTableBinding b = binding("join",
                src(0, "ACCOUNTS", "a", "primary", null, null),
                src(1, "TRANSACTIONS", "t", "join", "LEFT", "a.id = t.account_id"));

        assertEquals(
                "\"run_abc\".\"asis_ACCOUNTS\" \"a\""
                        + " LEFT JOIN \"run_abc\".\"asis_TRANSACTIONS\" \"t\""
                        + " ON a.id = t.account_id",
                SqlComposer.fromClause(SCHEMA, b));

        // 각 rule 은 자기 asisTable 의 alias 를 받아야 한다.
        assertEquals("a", SqlComposer.aliasFor(ruleForTable("ACCOUNTS"), b));
        assertEquals("t", SqlComposer.aliasFor(ruleForTable("TRANSACTIONS"), b));
    }

    @Test
    void join_defaultsToLeftJoin_whenJoinTypeBlank() {
        MappingTableBinding b = binding("join",
                src(0, "A", "a", "primary", null, null),
                src(1, "B", "b", "join", "", "a.k = b.k"));
        assertEquals(
                "\"run_abc\".\"asis_A\" \"a\" LEFT JOIN \"run_abc\".\"asis_B\" \"b\" ON a.k = b.k",
                SqlComposer.fromClause(SCHEMA, b));
    }

    @Test
    void join_unmatchedRuleTable_failsFast_notSilentPrimaryFallback() {
        // B7 방어: rule.asisTable 이 지정됐는데 어느 source 와도 매칭 안 되면, 조용히 primary 로
        // 떨어뜨리지 말고 IllegalStateException 으로 표면화 (silent 오테이블 조인 방지).
        MappingTableBinding b = binding("join",
                src(0, "A", "a", "primary", null, null),
                src(1, "B", "b", "join", "INNER", "a.k = b.k"));
        IllegalStateException ex = assertThrows(IllegalStateException.class,
                () -> SqlComposer.aliasFor(ruleForTable("NOT_A_SOURCE"), b));
        assertTrue(ex.getMessage().contains("NOT_A_SOURCE"), "메시지에 문제 테이블명 포함");
        assertTrue(ex.getMessage().contains("[A, B]"), "메시지에 실제 source 목록 포함");
    }

    @Test
    void join_nullRuleTable_stillFallsBackToPrimary() {
        // asisTable 미지정(null) rule 은 어느 테이블인지 특정 불가 → primary alias 유지(기존 동작).
        // (실데이터에 join binding + null asisTable rule 이 존재하므로 이 경로는 깨지면 안 됨.)
        MappingTableBinding b = binding("join",
                src(0, "A", "a", "primary", null, null),
                src(1, "B", "b", "join", "INNER", "a.k = b.k"));
        assertEquals("a", SqlComposer.aliasFor(ruleForTable(null), b));
    }

    @Test
    void join_primaryChosenByRole_notOrdinal() {
        // ordinal 0 이 join, ordinal 1 이 primary 여도 primary role 이 FROM 의 선두여야 한다.
        MappingTableBinding b = binding("join",
                src(0, "CHILD", "ch", "join", "LEFT", "p.id = ch.pid"),
                src(1, "PARENT", "p", "primary", null, null));
        String from = SqlComposer.fromClause(SCHEMA, b);
        assertEquals(
                "\"run_abc\".\"asis_PARENT\" \"p\""
                        + " LEFT JOIN \"run_abc\".\"asis_CHILD\" \"ch\""
                        + " ON p.id = ch.pid",
                from);
    }

    // ---- union ------------------------------------------------------------

    @Test
    void union_buildsSelectStarSubquery_withUnionAlias() {
        MappingTableBinding b = binding("union",
                src(0, "SALES_2023", "s1", "primary", null, null),
                src(1, "SALES_2024", "s2", "union", null, null));

        assertEquals(
                "(SELECT * FROM \"run_abc\".\"asis_SALES_2023\""
                        + " UNION ALL SELECT * FROM \"run_abc\".\"asis_SALES_2024\") AS \"u\"",
                SqlComposer.fromClause(SCHEMA, b));

        // union 은 서브쿼리 하나로 평탄화되므로 모든 rule 이 "u" 를 참조.
        assertEquals(SqlComposer.UNION_ALIAS, SqlComposer.aliasFor(ruleForTable("SALES_2023"), b));
        assertEquals(SqlComposer.UNION_ALIAS, SqlComposer.aliasFor(ruleForTable("SALES_2024"), b));
    }

    // ---- union 방어 가드 (B6) — assertUnionColumnsAligned ------------------

    @Test
    void union_sameColumnOrder_passes() {
        SqlComposer.assertUnionColumnsAligned(
                List.of("SALES_2023", "SALES_2024"),
                List.of(List.of("region", "amount"), List.of("region", "amount")));
        // 예외 없이 통과.
    }

    @Test
    void union_caseInsensitiveNames_passes() {
        // 이름 대소문자만 다르고 순서 같으면 정상 (SELECT * 위치정렬 문제 없음).
        SqlComposer.assertUnionColumnsAligned(
                List.of("A", "B"),
                List.of(List.of("Region", "Amount"), List.of("region", "amount")));
    }

    @Test
    void union_swappedColumnOrder_failsFast() {
        // 순서가 뒤바뀌면 SELECT * UNION ALL 이 값을 뒤섞음 → fail-fast.
        IllegalStateException ex = assertThrows(IllegalStateException.class, () ->
                SqlComposer.assertUnionColumnsAligned(
                        List.of("A", "B"),
                        List.of(List.of("code", "note"), List.of("note", "code"))));
        assertTrue(ex.getMessage().contains("silent corruption"));
        assertTrue(ex.getMessage().contains("A") && ex.getMessage().contains("B"));
    }

    @Test
    void union_differentColumnCount_failsFast() {
        assertThrows(IllegalStateException.class, () ->
                SqlComposer.assertUnionColumnsAligned(
                        List.of("A", "B"),
                        List.of(List.of("id", "name"), List.of("id", "name", "extra"))));
    }

    @Test
    void union_singleOrZeroSource_noOp() {
        // 0/1 source 는 정렬 이슈가 없어 검사 skip (예외 없음).
        SqlComposer.assertUnionColumnsAligned(List.of(), List.of());
        SqlComposer.assertUnionColumnsAligned(List.of("A"), List.of(List.of("id", "name")));
    }

    // ---- identifier quoting ----------------------------------------------

    @Test
    void identifiersAreDoubleQuoted_andEmbeddedQuotesEscaped() {
        MappingTableBinding b = binding("single", src(0, "WEIRD\"NAME", "w", "primary", null, null));
        // schema/table 은 "" 로 감싸고 내부 " 는 "" 로 이스케이프.
        assertEquals("\"run_abc\".\"asis_WEIRD\"\"NAME\" AS \"w\"",
                SqlComposer.fromClause(SCHEMA, b));
    }
}
