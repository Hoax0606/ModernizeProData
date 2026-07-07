package com.ksinfo.modernize_pro_data.coordinator.site;

import com.ksinfo.modernize_pro_data.coordinator.site.frozen.SnapshotChanges;
import com.ksinfo.modernize_pro_data.coordinator.site.frozen.SnapshotExecutionContext;

import java.time.OffsetDateTime;

/**
 * Snapshot list 응답용 closed projection — 큰 {@code snapshot_data} JSONB 컬럼을
 * SELECT 에서 제외한다.
 *
 * listBySite / listByProject 는 목록 표시용이라 frozen mapping payload
 * (snapshot_data) 가 불필요 — FE 는 {@code /snapshots/{id}/mapping} 으로 lazy
 * fetch 한다. snapshot_data 는 full mapping freeze 라 큰 TOAST read + Jackson
 * 직렬화 비용이 크고, 다중 사용자 동시 시 listBySite peak 가 단일 대비 ~100×
 * 폭증하는 주원인. projection 으로 제외하면 list 가 빨라진다.
 *
 * {@code changes} 는 Versions 화면이 변경 내역 표시에 직접 사용하므로 유지.
 * Jackson 이 getter 이름 기준으로 직렬화 — entity 와 동일 JSON shape
 * (snapshot_data key 만 누락, FE 의 snapshotData? optional 과 호환).
 */
public interface SnapshotSummaryView {
    String getId();
    String getProjectId();
    String getName();
    String getVersion();
    String getDescription();
    String getType();
    String getStatus();
    String getCreatedBy();
    OffsetDateTime getCreatedAt();
    String getApprovedBy();
    OffsetDateTime getApprovedAt();
    String getRejectedBy();
    OffsetDateTime getRejectedAt();
    String getRejectionReason();
    int getTableCount();
    int getRuleCount();
    int getCodeMapCount();
    boolean isBaseline();
    String getPreviousVersionId();
    SnapshotChanges getChanges();
    SnapshotExecutionContext getExecutionContext();
}
