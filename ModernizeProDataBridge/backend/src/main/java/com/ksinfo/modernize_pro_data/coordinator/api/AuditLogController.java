package com.ksinfo.modernize_pro_data.coordinator.api;

import com.ksinfo.modernize_pro_data.common.dto.ApiResponse;
import com.ksinfo.modernize_pro_data.common.exception.ApiException;
import com.ksinfo.modernize_pro_data.coordinator.site.AuditLog;
import com.ksinfo.modernize_pro_data.coordinator.site.AuditLogRepository;
import com.ksinfo.modernize_pro_data.coordinator.site.SiteRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
@RequiredArgsConstructor
public class AuditLogController {

    private final AuditLogRepository auditLogRepository;
    private final SiteRepository siteRepository;

    @GetMapping("/api/v1/sites/{siteId}/audit-logs")
    public ApiResponse<List<AuditLog>> listBySite(@PathVariable String siteId) {
        if (!siteRepository.existsById(siteId)) {
            throw new ApiException("SITE_NOT_FOUND", "사이트를 찾을 수 없습니다", HttpStatus.NOT_FOUND);
        }
        return ApiResponse.ok(auditLogRepository.findBySiteOrdered(siteId));
    }

    @GetMapping("/api/v1/projects/{projectId}/audit-logs")
    public ApiResponse<List<AuditLog>> listByProject(@PathVariable String projectId) {
        return ApiResponse.ok(auditLogRepository.findByProjectOrdered(projectId));
    }
}
