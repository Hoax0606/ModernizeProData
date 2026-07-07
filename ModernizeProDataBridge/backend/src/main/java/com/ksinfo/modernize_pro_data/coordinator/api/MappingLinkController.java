package com.ksinfo.modernize_pro_data.coordinator.api;

import com.ksinfo.modernize_pro_data.common.dto.ApiResponse;
import com.ksinfo.modernize_pro_data.common.exception.ApiException;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlTable;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlTableRepository;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingTableBinding;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingTableBindingRepository;
import com.ksinfo.modernize_pro_data.coordinator.site.Project;
import com.ksinfo.modernize_pro_data.coordinator.site.ProjectRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Mapping master-child link 의 UI 보조 endpoint.
 *
 * GET /api/v1/projects/{projectId}/mapping/link-candidates
 *   - 자동 추천: 현재 project 의 TO-BE 테이블 중 같은 site 의 다른 project 에도 같은 이름이
 *     있는 케이스 + 현재 link 상태
 *   - 수동 link 용: 같은 site 의 다른 project 의 모든 TO-BE 테이블 list (이름 안 같은 master 도
 *     link 가능하도록)
 */
@RestController
@RequiredArgsConstructor
public class MappingLinkController {

    private final ProjectRepository projectRepository;
    private final DdlTableRepository ddlTableRepository;
    private final MappingTableBindingRepository bindingRepository;

    public record LinkCandidatesResponse(
            List<SuggestedLink> suggestions,
            List<OtherTable> manualOptions,
            /** 이 project 의 테이블 중 다른 project 의 자식들이 link 한 master 인 것 + 자식 list. */
            List<ParentInfo> parentOf
    ) {}

    public record ParentInfo(
            String tobeSchema,
            String tobeTable,
            List<OtherTable> children
    ) {}

    public record SuggestedLink(
            String tobeSchema,
            String tobeTable,
            /** 현재 link 상태 — null 이면 자체 정의 */
            String currentSharedFromProjectId,
            /** 같은 이름의 다른 project 후보들 */
            List<OtherTable> candidates
    ) {}

    public record OtherTable(
            String projectId,
            String projectName,
            String tobeSchema,
            String tobeTable
    ) {}

    @GetMapping("/api/v1/projects/{projectId}/mapping/link-candidates")
    public ApiResponse<LinkCandidatesResponse> getLinkCandidates(@PathVariable String projectId) {
        Project me = projectRepository.findById(projectId)
                .orElseThrow(() -> new ApiException("PROJECT_NOT_FOUND",
                        "프로젝트를 찾을 수 없습니다", HttpStatus.NOT_FOUND));
        String siteId = me.getSiteId();
        if (siteId == null) {
            return ApiResponse.ok(new LinkCandidatesResponse(List.of(), List.of(), List.of()));
        }

        List<Project> siteProjects = projectRepository.findBySiteId(siteId);
        Map<String, String> projectName = new HashMap<>();
        for (Project p : siteProjects) projectName.put(p.getId(), p.getName());

        // 다른 project 의 TO-BE 테이블들
        List<String> otherProjectIds = siteProjects.stream()
                .map(Project::getId)
                .filter(id -> !id.equals(projectId))
                .toList();
        List<OtherTable> otherTables = new ArrayList<>();
        if (!otherProjectIds.isEmpty()) {
            // 이미 자식 link 된 (다른 project 를 가리키는) binding 의 키 set — 후보에서 제외.
            // 자식의 자식 chain 방지.
            java.util.Set<String> alreadyLinkedKeys = new java.util.HashSet<>();
            for (MappingTableBinding b : bindingRepository.findAll()) {
                if (b.getSharedFromProjectId() != null && otherProjectIds.contains(b.getProjectId())) {
                    alreadyLinkedKeys.add(b.getProjectId() + "|" + nz(b.getTobeSchema()) + "|" + b.getTobeTable());
                }
            }

            List<DdlTable> otherDdl = ddlTableRepository.findByProjectIdInAndSide(otherProjectIds, "tobe");
            for (DdlTable t : otherDdl) {
                String key = t.getProjectId() + "|" + nz(t.getSchemaName()) + "|" + t.getPhysicalName();
                if (alreadyLinkedKeys.contains(key)) continue;  // 자식 후보 제외
                otherTables.add(new OtherTable(
                        t.getProjectId(),
                        projectName.getOrDefault(t.getProjectId(), t.getProjectId()),
                        nz(t.getSchemaName()),
                        t.getPhysicalName()));
            }
        }

        // 현재 project 의 TO-BE 테이블들 + 같은 이름 매칭
        List<DdlTable> myDdl = ddlTableRepository.findByProjectIdAndSideOrderByOrdinalAsc(projectId, "tobe");
        // bindings 의 현재 shared_from 상태 lookup
        Map<String, String> currentSharedFrom = new HashMap<>();
        for (MappingTableBinding b : bindingRepository.findByProjectId(projectId)) {
            currentSharedFrom.put(keyOf(b.getTobeSchema(), b.getTobeTable()), b.getSharedFromProjectId());
        }

        List<SuggestedLink> suggestions = new ArrayList<>();
        for (DdlTable mt : myDdl) {
            String key = keyOf(mt.getSchemaName(), mt.getPhysicalName());
            List<OtherTable> matched = new ArrayList<>();
            for (OtherTable o : otherTables) {
                if (keyOf(o.tobeSchema(), o.tobeTable()).equalsIgnoreCase(key)) {
                    matched.add(o);
                }
            }
            String cur = currentSharedFrom.get(key);
            if (!matched.isEmpty() || cur != null) {
                suggestions.add(new SuggestedLink(
                        nz(mt.getSchemaName()),
                        mt.getPhysicalName(),
                        cur,
                        matched));
            }
        }

        // 이 project 의 테이블 중 다른 project 의 자식들이 link 한 master 정보 수집.
        // 같은 site 의 다른 project 의 binding 중 sharedFromProjectId == this projectId 인 row 들.
        Map<String, List<OtherTable>> parentMap = new HashMap<>();
        for (MappingTableBinding b : bindingRepository.findAll()) {
            if (!projectId.equals(b.getSharedFromProjectId())) continue;
            if (!siteProjects.stream().anyMatch(p -> p.getId().equals(b.getProjectId()))) continue;
            String parentKey = nz(b.getTobeSchema()) + "|" + b.getTobeTable();
            parentMap.computeIfAbsent(parentKey, k -> new ArrayList<>()).add(new OtherTable(
                    b.getProjectId(),
                    projectName.getOrDefault(b.getProjectId(), b.getProjectId()),
                    nz(b.getTobeSchema()),
                    b.getTobeTable()));
        }
        List<ParentInfo> parentOf = new ArrayList<>();
        for (DdlTable mt : myDdl) {
            String key = nz(mt.getSchemaName()) + "|" + mt.getPhysicalName();
            List<OtherTable> children = parentMap.get(key);
            if (children != null && !children.isEmpty()) {
                parentOf.add(new ParentInfo(nz(mt.getSchemaName()), mt.getPhysicalName(), children));
            }
        }

        return ApiResponse.ok(new LinkCandidatesResponse(suggestions, otherTables, parentOf));
    }

    private static String keyOf(String schema, String table) {
        return nz(schema) + "|" + table;
    }

    private static String nz(String s) {
        return s == null ? "" : s;
    }
}
