package com.ksinfo.modernize_pro_data.coordinator.site;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.util.Map;

/**
 * Audit log 기록 helper.
 *
 * 다른 service / controller 에서 호출:
 *   auditLogService.record(siteId, projectId, username, action)
 *           .snapshot(snapshotId, snapshotName)
 *           .target(target)
 *           .details(details)
 *           .save();
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class AuditLogService {

    private final AuditLogRepository repo;
    /** 알림 즉시 전달용 — audit_log 는 FE 의 알림 source 인데 기존엔 30초 폴링으로만
     *  반영돼 Start 등 알림이 늦게 떴다. commit 後 /topic/notifications 로 push 해
     *  FE 가 즉시 audit 를 refetch (2026-06-04). */
    private final SimpMessagingTemplate stomp;

    public Builder record(String siteId, String projectId, String username, String action) {
        return new Builder(siteId, projectId, username, action);
    }

    /** project 정보로부터 site 자동 추출 */
    public Builder record(Project project, String username, String action) {
        return new Builder(project.getSiteId(), project.getId(), username, action);
    }

    @Transactional
    public AuditLog save(AuditLog entry) {
        try {
            AuditLog saved = repo.save(entry);
            notifyAfterCommit(saved.getSiteId());
            return saved;
        } catch (Exception e) {
            // audit 실패가 메인 트랜잭션을 깨면 안 됨 — 로깅만 하고 swallow
            log.warn("Failed to save audit log: {}", e.getMessage());
            return entry;
        }
    }

    /** Multi-entry batch save — 1 transaction 안에서 동시에 INSERT 모아 commit.
     *  ProjectController.update 처럼 같은 PATCH 안에서 phase/assignee/executionAssignee
     *  3 change 가 동시에 발생할 때 nested save 3 번 대신 1 batch 로 transaction time 단축. */
    @Transactional
    public java.util.List<AuditLog> saveAll(java.util.List<AuditLog> entries) {
        if (entries == null || entries.isEmpty()) return java.util.List.of();
        try {
            java.util.List<AuditLog> saved = repo.saveAll(entries);
            notifyAfterCommit(saved.isEmpty() ? null : saved.get(0).getSiteId());
            return saved;
        } catch (Exception e) {
            log.warn("Failed to save audit log batch ({}): {}", entries.size(), e.getMessage());
            return entries;
        }
    }

    /**
     * audit row commit 後 /topic/notifications 로 가벼운 신호 push → FE 가 그 site 의
     * audit 를 즉시 refetch. 트랜잭션 안이면 afterCommit 까지 미뤄 FE refetch 가 commit 된
     * row 를 보게 한다 (commit 前 push 면 FE 가 못 본 채 refetch 하는 race). 트랜잭션
     * 밖이면 즉시. 실패는 무시 (알림은 best-effort, polling 이 fallback).
     */
    private void notifyAfterCommit(String siteId) {
        Runnable push = () -> {
            try {
                stomp.convertAndSend("/topic/notifications",
                        Map.of("type", "audit", "siteId", siteId == null ? "" : siteId));
            } catch (Exception e) {
                log.debug("notification push failed: {}", e.getMessage());
            }
        };
        if (TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override public void afterCommit() { push.run(); }
            });
        } else {
            push.run();
        }
    }

    public class Builder {
        private final AuditLog a;

        private Builder(String siteId, String projectId, String username, String action) {
            this.a = AuditLog.create(siteId, projectId, username, action);
        }

        public Builder snapshot(String id, String name) {
            a.setSnapshotId(id);
            a.setSnapshotName(name);
            return this;
        }

        public Builder target(String t) { a.setTarget(t); return this; }
        public Builder details(String d) { a.setDetails(d); return this; }

        public AuditLog save() {
            return AuditLogService.this.save(a);
        }
    }
}
