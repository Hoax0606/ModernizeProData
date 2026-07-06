package com.ksinfo.modernize_pro_data.coordinator.mapping;

import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlColumn;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlColumnRepository;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlTable;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlTableRepository;
import com.ksinfo.modernize_pro_data.coordinator.site.Project;
import com.ksinfo.modernize_pro_data.coordinator.site.ProjectRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Site Overview 의 프로젝트별 매핑 진행률 집계 (2026-06-04).
 *
 * 이전엔 FE 가 프로젝트마다 DDL + rules + bindings 3 API 를 호출해 (N×3 라운드트립)
 * 직접 계산 → Site Overview 진행률 막대가 뜨는 데 지연. 이 서비스가 BE 에서 한 번에
 * 집계해 1 호출로 끝낸다.
 *
 * mapped 판정은 frontend {@code DashboardPage.isMappingRuleMapped} 와 1:1 동치로 유지해야
 * 한다 — 두 곳의 결과가 갈리면 같은 프로젝트가 화면마다 다른 진행률을 보인다.
 *   skip            → 미매핑
 *   null / default  → 매핑
 *   그 외           → asisColumn 비어있지 않거나 transformRule 있으면 매핑
 *
 * 자식 link 테이블(binding.sharedFromProjectId != null)은 master 프로젝트의 rules 를
 * effective rules 로 합산 — FE SiteOverview 의 effectiveRules 로직과 동일.
 */
@Service
@RequiredArgsConstructor
public class MappingProgressService {

    private final ProjectRepository projectRepo;
    private final DdlTableRepository ddlTableRepo;
    private final DdlColumnRepository ddlColumnRepo;
    private final MappingRuleRepository ruleRepo;
    private final MappingTableBindingRepository bindingRepo;

    public record ProjectMappingProgress(
            String projectId,
            int totalTables,
            int totalColumns,
            int mappedColumns,
            int readyTables
    ) {}

    @Transactional(readOnly = true)
    public List<ProjectMappingProgress> forSite(String siteId) {
        Map<String, List<MappingRule>> rulesCache = new HashMap<>();
        List<ProjectMappingProgress> out = new ArrayList<>();
        for (Project p : projectRepo.findBySiteId(siteId)) {
            out.add(forProject(p.getId(), rulesCache));
        }
        return out;
    }

    private List<MappingRule> rulesOf(String projectId, Map<String, List<MappingRule>> cache) {
        return cache.computeIfAbsent(projectId, ruleRepo::findByProjectId);
    }

    private ProjectMappingProgress forProject(String projectId, Map<String, List<MappingRule>> cache) {
        List<DdlTable> tables = ddlTableRepo.findByProjectIdAndSideOrderByOrdinalAsc(projectId, "tobe");
        if (tables.isEmpty()) return new ProjectMappingProgress(projectId, 0, 0, 0, 0);

        // qualified ("schema.table") / short ("table") → tableId. FE 의 qualified-first short-fallback.
        Map<String, String> byQualified = new HashMap<>();
        Map<String, String> byShort = new HashMap<>();
        List<String> tableIds = new ArrayList<>();
        for (DdlTable t : tables) {
            tableIds.add(t.getId());
            String schema = t.getSchemaName() == null ? "" : t.getSchemaName().toLowerCase();
            String phys = t.getPhysicalName() == null ? "" : t.getPhysicalName().toLowerCase();
            String qualified = (schema.isEmpty() ? "" : schema + ".") + phys;
            byQualified.put(qualified, t.getId());
            byShort.putIfAbsent(phys, t.getId());
        }

        // 컬럼 수 — tobe 테이블 전체 컬럼을 1 query 로 받아 tableId 별 집계.
        Map<String, Integer> colCount = new HashMap<>();
        for (DdlColumn c : ddlColumnRepo.findByTableIdInOrderByOrdinalAsc(tableIds)) {
            colCount.merge(c.getTableId(), 1, Integer::sum);
        }

        // effective rules = 자체 rules + 자식 link binding 이 가리키는 master 의 해당 테이블 rules.
        List<MappingRule> effective = new ArrayList<>(rulesOf(projectId, cache));
        for (MappingTableBinding b : bindingRepo.findByProjectId(projectId)) {
            if (b.getSharedFromProjectId() == null) continue;
            String bt = b.getTobeTable() == null ? "" : b.getTobeTable().toLowerCase();
            String bs = b.getTobeSchema() == null ? "" : b.getTobeSchema().toLowerCase();
            for (MappingRule mr : rulesOf(b.getSharedFromProjectId(), cache)) {
                String mt = mr.getTobeTable() == null ? "" : mr.getTobeTable().toLowerCase();
                String ms = mr.getTobeSchema() == null ? "" : mr.getTobeSchema().toLowerCase();
                if (mt.equals(bt) && ms.equals(bs)) effective.add(mr);
            }
        }

        // tableId 별 mapped rule 수.
        Map<String, Integer> mappedByTable = new HashMap<>();
        for (MappingRule r : effective) {
            if (!isMapped(r)) continue;
            String schema = r.getTobeSchema() == null ? "" : r.getTobeSchema().toLowerCase();
            String phys = r.getTobeTable() == null ? "" : r.getTobeTable().toLowerCase();
            String qualified = (schema.isEmpty() ? "" : schema + ".") + phys;
            String tableId = byQualified.getOrDefault(qualified, byShort.get(phys));
            if (tableId == null) continue;
            mappedByTable.merge(tableId, 1, Integer::sum);
        }

        int totalTables = tables.size();
        int totalColumns = 0;
        int mappedColumns = 0;
        int readyTables = 0;
        for (DdlTable t : tables) {
            int total = colCount.getOrDefault(t.getId(), 0);
            int m = Math.min(mappedByTable.getOrDefault(t.getId(), 0), total);
            totalColumns += total;
            mappedColumns += m;
            if (total > 0 && m >= total) readyTables++;
        }
        return new ProjectMappingProgress(projectId, totalTables, totalColumns, mappedColumns, readyTables);
    }

    /** frontend DashboardPage.isMappingRuleMapped 와 동치 — 변경 시 양쪽 동시 수정. */
    private boolean isMapped(MappingRule r) {
        String s = r.getStrategy();
        if ("skip".equals(s)) return false;
        if ("null".equals(s) || "default".equals(s)) return true;
        boolean hasSrc = r.getAsisColumn() != null
                && Arrays.stream(r.getAsisColumn()).anyMatch(c -> c != null && !c.trim().isEmpty());
        boolean hasRule = r.getTransformRule() != null && !r.getTransformRule().trim().isEmpty();
        return hasSrc || hasRule;
    }
}
