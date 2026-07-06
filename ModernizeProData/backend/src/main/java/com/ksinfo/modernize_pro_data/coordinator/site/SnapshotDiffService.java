package com.ksinfo.modernize_pro_data.coordinator.site;

import com.ksinfo.modernize_pro_data.coordinator.site.frozen.FrozenAsisSkip;
import com.ksinfo.modernize_pro_data.coordinator.site.frozen.FrozenBinding;
import com.ksinfo.modernize_pro_data.coordinator.site.frozen.FrozenBindingSource;
import com.ksinfo.modernize_pro_data.coordinator.site.frozen.FrozenCodeMap;
import com.ksinfo.modernize_pro_data.coordinator.site.frozen.FrozenRule;
import com.ksinfo.modernize_pro_data.coordinator.site.frozen.SnapshotChanges;
import com.ksinfo.modernize_pro_data.coordinator.site.frozen.SnapshotData;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * 두 SnapshotData 비교 → SnapshotChanges 생성.
 *
 * key (같은 항목 식별):
 *   - rule    : (tobeSchema, tobeTable, tobeColumn)
 *   - binding : (tobeSchema, tobeTable)
 *   - codeMap : (domain, sourceValue)
 *
 * id 는 키로 안 씀 — DDL 재임포트로 id 가 바뀌어도 이름이 같으면 같은 항목.
 *
 * rule diff 는 사용자 요구에 따라 핵심 4 필드 (asisSchema, asisTable, asisColumn,
 * transformSql) 로 한정 — 나머지 필드 (strategy/notes/ruleOrigin 등) 변경은 사실상
 * 부수 효과라 changes 에 노출 안 함. 매핑 미지정 값은 "(unassigned)" 로 표시.
 *
 * ADDED / DELETED 도 같은 4 필드를 fieldChanges 에 채움 (한쪽이 "(unassigned)"):
 *   - ADDED  : before = "(unassigned)", after = 실제 값
 *   - DELETED: before = 실제 값,        after = "(unassigned)"
 *
 * MODIFIED 는 4 필드 중 실제로 다른 항목만 fieldChanges 에 담는다.
 */
@Service
public class SnapshotDiffService {

    private static final String UNASSIGNED = "(unassigned)";

    public SnapshotChanges diff(
            SnapshotData previous,
            SnapshotData current,
            String previousVersionId,
            String previousVersion
    ) {
        List<SnapshotChanges.ChangeItem> items = new ArrayList<>();

        diffRules(previous == null ? List.of() : previous.rules(),
                current == null ? List.of() : current.rules(), items);
        diffBindings(previous == null ? List.of() : previous.bindings(),
                current == null ? List.of() : current.bindings(), items);
        diffCodeMaps(previous == null ? List.of() : previous.codeMaps(),
                current == null ? List.of() : current.codeMaps(), items);
        diffAsisSkips(previous == null ? List.of() : previous.asisSkips(),
                current == null ? List.of() : current.asisSkips(), items);

        int added = 0, modified = 0, removed = 0;
        for (var it : items) {
            switch (it.kind()) {
                case "added"    -> added++;
                case "modified" -> modified++;
                case "removed"  -> removed++;
                default -> { /* ignore */ }
            }
        }
        return new SnapshotChanges(
                previousVersionId,
                previousVersion,
                new SnapshotChanges.Summary(added, modified, removed),
                items
        );
    }

    /* ── rules ──────────────────────────────────── */

    private void diffRules(List<FrozenRule> prev, List<FrozenRule> curr,
                           List<SnapshotChanges.ChangeItem> out) {
        Map<String, FrozenRule> prevMap = indexBy(prev, this::ruleKey);
        Map<String, FrozenRule> currMap = indexBy(curr, this::ruleKey);

        for (var e : currMap.entrySet()) {
            FrozenRule p = prevMap.get(e.getKey());
            FrozenRule c = e.getValue();
            if (p == null) {
                // ADDED — detail 빈 문자열 (헤더 우측에 라벨 없음)
                out.add(new SnapshotChanges.ChangeItem("added", "rule",
                        e.getKey(), "", ruleAddedFields(c)));
            } else {
                List<SnapshotChanges.FieldChange> changes = ruleModifiedFields(p, c);
                if (!changes.isEmpty()) {
                    String label = modifiedRuleDetail(changes);
                    out.add(new SnapshotChanges.ChangeItem("modified", "rule",
                            e.getKey(), label, changes));
                }
            }
        }
        for (var e : prevMap.entrySet()) {
            if (!currMap.containsKey(e.getKey())) {
                // DELETED — 펼치면 변경 전 값 보이게 fieldChanges 채움, detail 빈 문자열
                out.add(new SnapshotChanges.ChangeItem("removed", "rule",
                        e.getKey(), "", ruleRemovedFields(e.getValue())));
            }
        }
    }

    private String ruleKey(FrozenRule r) {
        return nz(r.tobeSchema()) + "." + nz(r.tobeTable()) + "." + nz(r.tobeColumn());
    }

    /** ADDED rule: 2 필드 (asisColumn, transformSql) — before=(unassigned), after=실제. */
    private List<SnapshotChanges.FieldChange> ruleAddedFields(FrozenRule c) {
        List<SnapshotChanges.FieldChange> out = new ArrayList<>();
        out.add(new SnapshotChanges.FieldChange("asisColumn",   UNASSIGNED, arrFmt(c.asisColumn())));
        out.add(new SnapshotChanges.FieldChange("transformSql", UNASSIGNED, fmt(c.transformSql())));
        return out;
    }

    /** DELETED rule: 2 필드 — before=실제 (옛 값), after=(unassigned). */
    private List<SnapshotChanges.FieldChange> ruleRemovedFields(FrozenRule p) {
        List<SnapshotChanges.FieldChange> out = new ArrayList<>();
        out.add(new SnapshotChanges.FieldChange("asisColumn",   arrFmt(p.asisColumn()),    UNASSIGNED));
        out.add(new SnapshotChanges.FieldChange("transformSql", fmt(p.transformSql()),     UNASSIGNED));
        return out;
    }

    /** MODIFIED rule: 2 필드 (asisColumn, transformSql) 중 실제로 다른 것만. */
    private List<SnapshotChanges.FieldChange> ruleModifiedFields(FrozenRule a, FrozenRule b) {
        List<SnapshotChanges.FieldChange> out = new ArrayList<>();
        cmpArr(out, "asisColumn",   a.asisColumn(),   b.asisColumn());
        cmpStr(out, "transformSql", a.transformSql(), b.transformSql());
        return out;
    }

    /** MODIFIED 라벨: 어떤 필드가 바뀌었는지에 따라 다르게. */
    private String modifiedRuleDetail(List<SnapshotChanges.FieldChange> changes) {
        boolean col = changes.stream().anyMatch(f -> "asisColumn".equals(f.field()));
        boolean sql = changes.stream().anyMatch(f -> "transformSql".equals(f.field()));
        if (col && sql) return "column / rule changed";
        if (col)        return "column changed";
        if (sql)        return "rule changed";
        return "rule changed"; // fallback (도달 안 함)
    }

    /* ── bindings ───────────────────────────────── */

    private void diffBindings(List<FrozenBinding> prev, List<FrozenBinding> curr,
                              List<SnapshotChanges.ChangeItem> out) {
        Map<String, FrozenBinding> prevMap = indexBy(prev, this::bindingKey);
        Map<String, FrozenBinding> currMap = indexBy(curr, this::bindingKey);

        for (var e : currMap.entrySet()) {
            FrozenBinding p = prevMap.get(e.getKey());
            FrozenBinding c = e.getValue();
            if (p == null) {
                out.add(new SnapshotChanges.ChangeItem("added", "binding",
                        e.getKey(), "binding added", bindingAddedFields(c)));
            } else {
                List<SnapshotChanges.FieldChange> changes = bindingModifiedFields(p, c);
                if (!changes.isEmpty()) {
                    out.add(new SnapshotChanges.ChangeItem("modified", "binding",
                            e.getKey(), "binding changed", changes));
                }
            }
        }
        for (var e : prevMap.entrySet()) {
            if (!currMap.containsKey(e.getKey())) {
                out.add(new SnapshotChanges.ChangeItem("removed", "binding",
                        e.getKey(), "binding deleted", bindingRemovedFields(e.getValue())));
            }
        }
    }

    private String bindingKey(FrozenBinding b) {
        return nz(b.tobeSchema()) + "." + nz(b.tobeTable());
    }

    private List<SnapshotChanges.FieldChange> bindingAddedFields(FrozenBinding c) {
        List<SnapshotChanges.FieldChange> out = new ArrayList<>();
        out.add(new SnapshotChanges.FieldChange("compositionKind", UNASSIGNED, fmt(c.compositionKind())));
        out.add(new SnapshotChanges.FieldChange("sources",         UNASSIGNED, sourcesToString(c.sources())));
        if (c.whereFilter() != null && !c.whereFilter().isBlank()) {
            out.add(new SnapshotChanges.FieldChange("whereFilter", UNASSIGNED, fmt(c.whereFilter())));
        }
        if (c.groupByExpr() != null && !c.groupByExpr().isBlank()) {
            out.add(new SnapshotChanges.FieldChange("groupByExpr", UNASSIGNED, fmt(c.groupByExpr())));
        }
        if (c.expandExpr() != null && !c.expandExpr().isBlank()) {
            out.add(new SnapshotChanges.FieldChange("expandExpr", UNASSIGNED, fmt(c.expandExpr())));
        }
        if (c.sharedFromProjectId() != null) {
            out.add(new SnapshotChanges.FieldChange("sharedFromProjectId", UNASSIGNED, fmt(c.sharedFromProjectId())));
        }
        return out;
    }

    private List<SnapshotChanges.FieldChange> bindingRemovedFields(FrozenBinding p) {
        List<SnapshotChanges.FieldChange> out = new ArrayList<>();
        out.add(new SnapshotChanges.FieldChange("compositionKind", fmt(p.compositionKind()),    UNASSIGNED));
        out.add(new SnapshotChanges.FieldChange("sources",         sourcesToString(p.sources()), UNASSIGNED));
        if (p.whereFilter() != null && !p.whereFilter().isBlank()) {
            out.add(new SnapshotChanges.FieldChange("whereFilter", fmt(p.whereFilter()), UNASSIGNED));
        }
        if (p.groupByExpr() != null && !p.groupByExpr().isBlank()) {
            out.add(new SnapshotChanges.FieldChange("groupByExpr", fmt(p.groupByExpr()), UNASSIGNED));
        }
        if (p.expandExpr() != null && !p.expandExpr().isBlank()) {
            out.add(new SnapshotChanges.FieldChange("expandExpr", fmt(p.expandExpr()), UNASSIGNED));
        }
        if (p.sharedFromProjectId() != null) {
            out.add(new SnapshotChanges.FieldChange("sharedFromProjectId", fmt(p.sharedFromProjectId()), UNASSIGNED));
        }
        return out;
    }

    private List<SnapshotChanges.FieldChange> bindingModifiedFields(FrozenBinding a, FrozenBinding b) {
        List<SnapshotChanges.FieldChange> out = new ArrayList<>();
        cmpStr(out, "compositionKind", a.compositionKind(), b.compositionKind());
        String sa = sourcesToString(a.sources());
        String sb = sourcesToString(b.sources());
        if (!Objects.equals(sa, sb)) {
            out.add(new SnapshotChanges.FieldChange("sources", sa, sb));
        }
        cmpStr(out, "whereFilter", a.whereFilter(), b.whereFilter());
        cmpStr(out, "groupByExpr", a.groupByExpr(), b.groupByExpr());
        cmpStr(out, "expandExpr",  a.expandExpr(),  b.expandExpr());
        cmpStr(out, "sharedFromProjectId", a.sharedFromProjectId(), b.sharedFromProjectId());
        return out;
    }

    private String sourcesToString(List<FrozenBindingSource> srcs) {
        if (srcs == null || srcs.isEmpty()) return UNASSIGNED;
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < srcs.size(); i++) {
            if (i > 0) sb.append(", ");
            var s = srcs.get(i);
            sb.append(nz(s.role())).append(":")
              .append(nz(s.alias())).append("=")
              .append(nz(s.asisSchema())).append(".").append(nz(s.asisTable()));
            if (s.joinType() != null) {
                sb.append(" ").append(s.joinType());
                if (s.joinOn() != null) sb.append(" ON ").append(s.joinOn());
            }
        }
        return sb.toString();
    }

    /* ── code maps ─────────────────────────────── */

    private void diffCodeMaps(List<FrozenCodeMap> prev, List<FrozenCodeMap> curr,
                              List<SnapshotChanges.ChangeItem> out) {
        Map<String, FrozenCodeMap> prevMap = indexBy(prev, this::codeMapKey);
        Map<String, FrozenCodeMap> currMap = indexBy(curr, this::codeMapKey);

        for (var e : currMap.entrySet()) {
            FrozenCodeMap p = prevMap.get(e.getKey());
            FrozenCodeMap c = e.getValue();
            if (p == null) {
                out.add(new SnapshotChanges.ChangeItem("added", "codeMap",
                        e.getKey(), "code map added", codeMapAddedFields(c)));
            } else {
                List<SnapshotChanges.FieldChange> changes = codeMapModifiedFields(p, c);
                if (!changes.isEmpty()) {
                    out.add(new SnapshotChanges.ChangeItem("modified", "codeMap",
                            e.getKey(), "code map changed", changes));
                }
            }
        }
        for (var e : prevMap.entrySet()) {
            if (!currMap.containsKey(e.getKey())) {
                out.add(new SnapshotChanges.ChangeItem("removed", "codeMap",
                        e.getKey(), "code map deleted", codeMapRemovedFields(e.getValue())));
            }
        }
    }

    private String codeMapKey(FrozenCodeMap m) {
        return nz(m.domain()) + ":" + nz(m.sourceValue());
    }

    private List<SnapshotChanges.FieldChange> codeMapAddedFields(FrozenCodeMap c) {
        return List.of(new SnapshotChanges.FieldChange("targetValue", UNASSIGNED, fmt(c.targetValue())));
    }

    private List<SnapshotChanges.FieldChange> codeMapRemovedFields(FrozenCodeMap p) {
        return List.of(new SnapshotChanges.FieldChange("targetValue", fmt(p.targetValue()), UNASSIGNED));
    }

    private List<SnapshotChanges.FieldChange> codeMapModifiedFields(FrozenCodeMap a, FrozenCodeMap b) {
        List<SnapshotChanges.FieldChange> out = new ArrayList<>();
        cmpStr(out, "targetValue", a.targetValue(), b.targetValue());
        return out;
    }

    /* ── asisSkips ──────────────────────────────── */

    /**
     * AS-IS 컬럼 단위 skip 마킹 diff. key = (asisSchema, asisTable, asisColumn).
     * skip 추가 → "added", 해제 → "removed". row 내용 비교는 없음 (마킹 자체가 본질).
     */
    private void diffAsisSkips(List<FrozenAsisSkip> prev, List<FrozenAsisSkip> curr,
                               List<SnapshotChanges.ChangeItem> out) {
        Map<String, FrozenAsisSkip> prevMap = indexBy(prev, this::asisSkipKey);
        Map<String, FrozenAsisSkip> currMap = indexBy(curr, this::asisSkipKey);

        for (var e : currMap.entrySet()) {
            if (!prevMap.containsKey(e.getKey())) {
                out.add(new SnapshotChanges.ChangeItem("added", "asisSkip",
                        e.getKey(), "AS-IS column skip added",
                        List.of(new SnapshotChanges.FieldChange("asisSkip", UNASSIGNED, "skipped"))));
            }
        }
        for (var e : prevMap.entrySet()) {
            if (!currMap.containsKey(e.getKey())) {
                out.add(new SnapshotChanges.ChangeItem("removed", "asisSkip",
                        e.getKey(), "AS-IS column skip removed",
                        List.of(new SnapshotChanges.FieldChange("asisSkip", "skipped", UNASSIGNED))));
            }
        }
    }

    private String asisSkipKey(FrozenAsisSkip s) {
        return nz(s.asisSchema()) + "." + nz(s.asisTable()) + "." + nz(s.asisColumn());
    }

    /* ── field comparators ─────────────────────── */

    private void cmpStr(List<SnapshotChanges.FieldChange> out, String field, String a, String b) {
        if (!Objects.equals(a, b)) {
            out.add(new SnapshotChanges.FieldChange(field, fmt(a), fmt(b)));
        }
    }

    private void cmpArr(List<SnapshotChanges.FieldChange> out, String field, String[] a, String[] b) {
        if (!Arrays.equals(a, b)) {
            out.add(new SnapshotChanges.FieldChange(field, arrFmt(a), arrFmt(b)));
        }
    }

    /** null / empty / 빈 배열 모두 "(unassigned)" 로 통일. */
    private String fmt(String s) {
        if (s == null || s.isEmpty()) return UNASSIGNED;
        return s;
    }

    private String arrFmt(String[] a) {
        if (a == null || a.length == 0) return UNASSIGNED;
        return "[" + String.join(", ", a) + "]";
    }

    /* ── helpers ───────────────────────────────── */

    private <T> Map<String, T> indexBy(List<T> list, java.util.function.Function<T, String> keyFn) {
        Map<String, T> out = new LinkedHashMap<>();
        for (T item : list) {
            out.put(keyFn.apply(item), item);
        }
        return out;
    }

    private String nz(String s) { return s == null ? "" : s; }
}
