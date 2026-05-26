package com.ksinfo.modernize_pro_data.coordinator.site.frozen;

import java.util.List;

/**
 * snapshot 생성 시점에 "이전 버전 대비 변경사항" 을 박제한 데이터.
 * snapshots.changes (JSONB) 컬럼에 직렬화. immutable — 한 번 채워지면 안 변한다.
 *
 * previousVersionId / previousVersion 이 null 이면 첫 snapshot — items 의 모든 항목은
 * kind="added" 로 채워진다.
 */
public record SnapshotChanges(
        String previousVersionId,
        String previousVersion,
        Summary summary,
        List<ChangeItem> items
) {
    public record Summary(int added, int modified, int removed) {
        public int total() {
            return added + modified + removed;
        }
    }

    public record ChangeItem(
            String kind,                       // "added" | "modified" | "removed"
            String category,                   // "rule" | "binding" | "codeMap"
            String key,                        // 사람이 읽을 식별자 (e.g. "public.customer.gender")
            String detail,                     // 짧은 human-readable 요약
            List<FieldChange> fieldChanges     // modified 일 때만 채움. added/removed 면 null.
    ) {}

    /** modified 항목의 필드 단위 변경. before/after 는 문자열로 normalize. */
    public record FieldChange(String field, String before, String after) {}
}
