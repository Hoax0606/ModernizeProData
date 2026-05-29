package com.ksinfo.modernize_pro_data.coordinator.site;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

import java.util.List;
import java.util.Optional;

public interface SnapshotRepository extends JpaRepository<Snapshot, String> {
    List<Snapshot> findByProjectId(String projectId);
    List<Snapshot> findByProjectIdIn(List<String> projectIds);
    
    @Query("SELECT s FROM Snapshot s WHERE s.projectId = ?1 ORDER BY s.createdAt DESC LIMIT 1")
    Optional<Snapshot> findLatestByProjectId(String projectId);

    /**
     * Run service の snapshot 解決用 — type ('mapping' / 'cutover') + status='approved' の最新.
     * rehearsal run は 'mapping' approved、cutover run は 'cutover' approved を要求.
     */
    @Query("SELECT s FROM Snapshot s WHERE s.projectId = ?1 AND s.type = ?2 AND s.status = 'approved' ORDER BY s.createdAt DESC LIMIT 1")
    Optional<Snapshot> findLatestApprovedByProjectIdAndType(String projectId, String type);

    /** 프로젝트의 현재 baseline (있으면). partial unique index 로 최대 1 row. */
    Optional<Snapshot> findByProjectIdAndBaselineTrue(String projectId);

    /** type ('mapping' / 'cutover') 의 가장 최근 snapshot — approved 여부 무관.
     *  test runType 처럼 ad-hoc 으로도 snapshot 과 연결하기 위해. */
    @Query("SELECT s FROM Snapshot s WHERE s.projectId = ?1 AND s.type = ?2 ORDER BY s.createdAt DESC LIMIT 1")
    Optional<Snapshot> findLatestByProjectIdAndType(String projectId, String type);

    /** 시간순 직전 snapshot (본인 제외) — changes 의 fallback 비교 대상. */
    @Query("SELECT s FROM Snapshot s WHERE s.projectId = ?1 AND s.id <> ?2 ORDER BY s.createdAt DESC LIMIT 1")
    Optional<Snapshot> findPreviousByProjectIdExcluding(String projectId, String excludeId);
}
