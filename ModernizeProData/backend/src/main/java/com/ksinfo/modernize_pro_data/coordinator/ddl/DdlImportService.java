package com.ksinfo.modernize_pro_data.coordinator.ddl;

import com.ksinfo.modernize_pro_data.common.exception.ApiException;
import com.ksinfo.modernize_pro_data.coordinator.ddl.parser.OracleDdlParser;
import com.ksinfo.modernize_pro_data.coordinator.ddl.parser.ParsedColumn;
import com.ksinfo.modernize_pro_data.coordinator.ddl.parser.ParsedDdl;
import com.ksinfo.modernize_pro_data.coordinator.ddl.parser.ParsedTable;
import com.ksinfo.modernize_pro_data.coordinator.site.Project;
import com.ksinfo.modernize_pro_data.coordinator.site.ProjectRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * AS-IS / TO-BE DDL ファイルの共通インポート/取得/削除サービス.
 *
 * side ('asis' | 'tobe') を引数で受け取り、同じ ddl_imports / ddl_tables / ddl_columns に格納する.
 * 再インポート時は同じ project_id + side の既存データを CASCADE 削除して上書きする.
 * AS-IS の場合 projects.table_count を、TO-BE の場合 projects.tobe_table_count を更新する.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class DdlImportService {

    public static final String SIDE_ASIS = "asis";
    public static final String SIDE_TOBE = "tobe";
    private static final Set<String> VALID_SIDES = Set.of(SIDE_ASIS, SIDE_TOBE);

    private final DdlImportRepository ddlImportRepo;
    private final DdlTableRepository ddlTableRepo;
    private final DdlColumnRepository ddlColumnRepo;
    private final ProjectRepository projectRepo;
    private final OracleDdlParser parser;

    @Transactional
    public DdlImport importDdl(String projectId, String side, String filename, byte[] content, String importedBy) {
        validateSide(side);
        Project project = projectRepo.findById(projectId)
                .orElseThrow(() -> new ApiException("PROJECT_NOT_FOUND",
                        "프로젝트를 찾을 수 없습니다", HttpStatus.NOT_FOUND));

        String sql = new String(content, StandardCharsets.UTF_8);
        ParsedDdl parsed;
        try {
            parsed = parser.parse(sql);
        } catch (RuntimeException e) {
            log.error("DDL parse failed for project {} (side={}): {}", projectId, side, e.getMessage(), e);
            throw new ApiException("DDL_PARSE_FAILED",
                    "DDL 파싱 실패: " + e.getMessage(), HttpStatus.BAD_REQUEST);
        }
        if (parsed.getTables().isEmpty()) {
            throw new ApiException("DDL_EMPTY",
                    "DDL 파일에서 CREATE TABLE 문을 찾지 못했습니다", HttpStatus.BAD_REQUEST);
        }

        ddlImportRepo.deleteByProjectIdAndSide(projectId, side);
        ddlImportRepo.flush();

        DdlImport ddlImport = DdlImport.create(
                projectId, side, filename, content.length,
                sha256Hex(content), "oracle", importedBy);
        ddlImport.setTableCount(parsed.getTables().size());
        ddlImport.setColumnCount(parsed.totalColumnCount());
        ddlImportRepo.save(ddlImport);

        for (ParsedTable pt : parsed.getTables()) {
            DdlTable dt = DdlTable.create(projectId, side, ddlImport.getId(),
                    pt.getSchemaName(), pt.getPhysicalName(), pt.getOrdinal());
            dt.setLogicalName(pt.getLogicalName());
            dt.setTableComment(pt.getTableComment());
            ddlTableRepo.save(dt);

            for (ParsedColumn pc : pt.getColumns()) {
                DdlColumn dc = DdlColumn.create(dt.getId(), pc.getOrdinal(),
                        pc.getPhysicalName(), pc.getDataTypeRaw(), pc.getDataType());
                dc.setLogicalName(pc.getLogicalName());
                dc.setLength(pc.getLength());
                dc.setPrecision(pc.getPrecision());
                dc.setScale(pc.getScale());
                dc.setNullable(pc.isNullable());
                dc.setPkOrder(pc.getPkOrder());
                dc.setDefaultValue(pc.getDefaultValue());
                dc.setColumnComment(pc.getColumnComment());
                ddlColumnRepo.save(dc);
            }
        }

        applyTableCountToProject(project, side, parsed.getTables().size());
        autoAdvancePhaseIfBothDdlImported(project);
        projectRepo.save(project);

        log.info("DDL imported: project={}, side={}, file={}, tables={}, columns={}",
                projectId, side, filename, parsed.getTables().size(), parsed.totalColumnCount());
        return ddlImport;
    }

    /**
     * AS-IS と TO-BE の DDL がそろった瞬間に phase が 'planning' であれば 'analysis' に進める.
     * planning より進んだ phase は触らない (test/sign-off/... を巻き戻さない).
     */
    private void autoAdvancePhaseIfBothDdlImported(Project project) {
        if ("planning".equals(project.getPhase())
                && project.getTableCount() > 0
                && project.getTobeTableCount() > 0) {
            project.setPhase("analysis");
            log.info("Project {} auto-advanced phase: planning → analysis (both DDLs imported)",
                    project.getId());
        }
    }

    @Transactional(readOnly = true)
    public DdlSchema getDdl(String projectId, String side) {
        validateSide(side);
        if (!projectRepo.existsById(projectId)) {
            throw new ApiException("PROJECT_NOT_FOUND",
                    "프로젝트를 찾을 수 없습니다", HttpStatus.NOT_FOUND);
        }
        DdlImport latest = ddlImportRepo
                .findFirstByProjectIdAndSideOrderByImportedAtDesc(projectId, side)
                .orElse(null);
        if (latest == null) {
            return new DdlSchema(null, List.of());
        }
        List<DdlTable> tables = ddlTableRepo
                .findByProjectIdAndSideOrderByOrdinalAsc(projectId, side);
        List<String> tableIds = tables.stream().map(DdlTable::getId).toList();
        List<DdlColumn> columns = tableIds.isEmpty()
                ? List.of()
                : ddlColumnRepo.findByTableIdInOrderByOrdinalAsc(tableIds);
        Map<String, List<DdlColumn>> byTable = columns.stream()
                .collect(Collectors.groupingBy(DdlColumn::getTableId));
        List<DdlTableWithColumns> dtos = tables.stream()
                .map(t -> new DdlTableWithColumns(t, byTable.getOrDefault(t.getId(), List.of())))
                .toList();
        return new DdlSchema(latest, dtos);
    }

    @Transactional
    public void deleteDdl(String projectId, String side) {
        validateSide(side);
        Project project = projectRepo.findById(projectId)
                .orElseThrow(() -> new ApiException("PROJECT_NOT_FOUND",
                        "프로젝트를 찾을 수 없습니다", HttpStatus.NOT_FOUND));
        ddlImportRepo.deleteByProjectIdAndSide(projectId, side);
        applyTableCountToProject(project, side, 0);
        projectRepo.save(project);
        log.info("DDL deleted: project={}, side={}", projectId, side);
    }

    private void applyTableCountToProject(Project project, String side, int count) {
        if (SIDE_ASIS.equals(side)) {
            project.setTableCount(count);
        } else {
            project.setTobeTableCount(count);
        }
    }

    private void validateSide(String side) {
        if (!VALID_SIDES.contains(side)) {
            throw new ApiException("INVALID_SIDE",
                    "side 는 'asis' 또는 'tobe' 여야 합니다 (입력: " + side + ")",
                    HttpStatus.BAD_REQUEST);
        }
    }

    private String sha256Hex(byte[] bytes) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(md.digest(bytes));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }

    public record DdlSchema(DdlImport latestImport, List<DdlTableWithColumns> tables) {}

    public record DdlTableWithColumns(DdlTable table, List<DdlColumn> columns) {}
}
