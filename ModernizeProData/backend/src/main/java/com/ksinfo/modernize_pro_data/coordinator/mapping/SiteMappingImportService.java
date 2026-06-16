package com.ksinfo.modernize_pro_data.coordinator.mapping;

import com.ksinfo.modernize_pro_data.common.exception.ApiException;
import com.ksinfo.modernize_pro_data.coordinator.site.Project;
import com.ksinfo.modernize_pro_data.coordinator.site.ProjectRepository;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 사이트 단위 맵핑정의서 일괄 import.
 *
 * 하나의 column/code CSV 를 사이트의 여러 프로젝트에 분배한다. 실제 import 로직은
 * {@link MappingImportService#importFromCsv}(per-project) 를 그대로 재사용 — 각 프로젝트는
 * 자기 AS-IS/TO-BE DDL 에 맞는 row 만 가져가고(schema-lenient 슬라이싱), 기존 rules 는
 * 전체 교체된다(per-project import 와 동일 동작).
 *
 * 각 프로젝트 import 는 독립 트랜잭션(importFromCsv -> persistImport)이라, 한 프로젝트가
 * 실패해도 나머지는 계속 진행한다(결과에 프로젝트별 성공/실패를 담아 반환).
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class SiteMappingImportService {

    private final MappingImportService importService;
    private final ProjectRepository projectRepo;

    /**
     * @param projectIds null/빈 list = 사이트 전체 프로젝트. 값이 있으면 그 프로젝트들만
     *                   (사이트 소속 여부 검증).
     */
    public SiteImportResult importForSite(
            String siteId,
            List<String> projectIds,
            byte[] columnCsv,
            String columnFilename,
            byte[] codeCsv,
            String codeFilename,
            String userName
    ) {
        List<Project> siteProjects = projectRepo.findBySiteId(siteId);
        if (siteProjects.isEmpty()) {
            throw new ApiException("SITE_NO_PROJECTS",
                    "사이트에 프로젝트가 없습니다", HttpStatus.NOT_FOUND);
        }

        List<Project> targets;
        if (projectIds == null || projectIds.isEmpty()) {
            targets = siteProjects;
        } else {
            Map<String, Project> byId = new LinkedHashMap<>();
            for (Project p : siteProjects) byId.put(p.getId(), p);
            targets = new ArrayList<>();
            for (String pid : projectIds) {
                Project p = byId.get(pid);
                if (p == null) {
                    throw new ApiException("PROJECT_NOT_IN_SITE",
                            "프로젝트 " + pid + " 가 사이트 " + siteId + " 소속이 아닙니다",
                            HttpStatus.BAD_REQUEST);
                }
                targets.add(p);
            }
        }

        List<ProjectOutcome> outcomes = new ArrayList<>(targets.size());
        for (Project p : targets) {
            try {
                MappingImport mi = importService.importFromCsv(
                        p.getId(), columnCsv, columnFilename, codeCsv, codeFilename, userName, null);
                outcomes.add(new ProjectOutcome(
                        p.getId(), p.getName(), "success",
                        mi.getRuleCount(), mi.getCodeMapCount(), null));
            } catch (ApiException e) {
                log.warn("[site-mapping-import] project {} failed: {}", p.getId(), e.getMessage());
                outcomes.add(new ProjectOutcome(p.getId(), p.getName(), "failed", 0, 0, e.getMessage()));
            } catch (Exception e) {
                log.warn("[site-mapping-import] project {} failed", p.getId(), e);
                outcomes.add(new ProjectOutcome(p.getId(), p.getName(), "failed", 0, 0,
                        e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()));
            }
        }

        int succeeded = (int) outcomes.stream().filter(o -> "success".equals(o.status())).count();
        return new SiteImportResult(siteId, targets.size(), succeeded, outcomes);
    }

    /** 프로젝트 1건 import 결과. */
    public record ProjectOutcome(
            String projectId,
            String projectName,
            String status,       // success | failed
            int ruleCount,
            int codeMapCount,
            String error
    ) {}

    /** 사이트 일괄 import 집계 결과. */
    public record SiteImportResult(
            String siteId,
            int total,
            int succeeded,
            List<ProjectOutcome> projects
    ) {}
}
