package com.ksinfo.modernize_pro_data.coordinator.site;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

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
            return repo.save(entry);
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
            return repo.saveAll(entries);
        } catch (Exception e) {
            log.warn("Failed to save audit log batch ({}): {}", entries.size(), e.getMessage());
            return entries;
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
