package com.ksinfo.modernize_pro_data.coordinator.ddl;

import com.ksinfo.modernize_pro_data.common.exception.ApiException;
import com.ksinfo.modernize_pro_data.common.util.HashUtil;
import com.ksinfo.modernize_pro_data.coordinator.ddl.parser.OracleDdlParser;
import com.ksinfo.modernize_pro_data.coordinator.ddl.parser.ParsedColumn;
import com.ksinfo.modernize_pro_data.coordinator.ddl.parser.ParsedConstraint;
import com.ksinfo.modernize_pro_data.coordinator.ddl.parser.ParsedConstraintColumn;
import com.ksinfo.modernize_pro_data.coordinator.ddl.parser.ParsedDdl;
import com.ksinfo.modernize_pro_data.coordinator.ddl.parser.ParsedForeignKey;
import com.ksinfo.modernize_pro_data.coordinator.ddl.parser.ParsedIndex;
import com.ksinfo.modernize_pro_data.coordinator.ddl.parser.ParsedIndexColumn;
import com.ksinfo.modernize_pro_data.coordinator.ddl.parser.ParsedTable;
import com.ksinfo.modernize_pro_data.coordinator.ddl.parser.PgSchemaExtractor;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingCodeMapRepository;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingRuleRepository;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingTableBindingRepository;
import com.ksinfo.modernize_pro_data.coordinator.site.Project;
import com.ksinfo.modernize_pro_data.coordinator.site.ProjectRepository;
import com.ksinfo.modernize_pro_data.coordinator.site.Site;
import com.ksinfo.modernize_pro_data.coordinator.site.SiteRepository;
import com.ksinfo.modernize_pro_data.coordinator.site.AuditLogService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
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
 *
 * mapping 連携: import / delete どちらも該当 project の mapping_rules /
 * mapping_table_bindings / mapping_code_maps を一律 wipe する. re-import 時 mapping
 * 保存はサイレント不整合 (DDL 側 column rename / drop で rule が孤児化) のリスクが
 * 大きいため、「DDL を入れ直す ＝ mapping もやり直し」で統一. ReImport ボタンは
 * Delete → Import の単なるショートカット.
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
    private final DdlIndexRepository ddlIndexRepo;
    private final DdlIndexColumnRepository ddlIndexColumnRepo;
    private final DdlConstraintRepository ddlConstraintRepo;
    private final DdlConstraintColumnRepository ddlConstraintColumnRepo;
    private final DdlForeignKeyRepository ddlForeignKeyRepo;
    private final ProjectRepository projectRepo;
    private final SiteRepository siteRepo;
    private final OracleDdlParser parser;
    private final PgSchemaExtractor pgSchemaExtractor;
    private final MappingRuleRepository mappingRuleRepo;
    private final MappingTableBindingRepository mappingBindingRepo;
    private final MappingCodeMapRepository mappingCodeMapRepo;
    private final AuditLogService auditLogService;

    @Transactional
    public DdlImport importDdl(String projectId, String side, String filename, byte[] content, String importedBy) {
        validateSide(side);
        Project project = projectRepo.findById(projectId)
                .orElseThrow(() -> new ApiException("PROJECT_NOT_FOUND",
                        "프로젝트를 찾을 수 없습니다", HttpStatus.NOT_FOUND));

        // DDL 파싱을 선언된 엔진 dialect 로 분기 (AS-IS/TO-BE 대칭). 저장용 dialect 도 이 값을 재사용.
        //   postgresql → PgSchemaExtractor(staging apply), 그 외(oracle 등) → OracleDdlParser(정규식, DB 불필요).
        String dialect = resolveDialect(project, side);
        ParsedDdl parsed;
        try {
            if (DialectUtil.POSTGRESQL.equals(dialect)) {
                // PostgreSQL — staging schema 에 적용해 pg_catalog 로 메타 추출. 비-PG 문법이면 PG 가 거부
                // → TobeDdlApplyException → 400.
                parsed = pgSchemaExtractor.extract(content);
            } else {
                // Oracle(및 load 미지원 엔진 fallback) — 정규식 파서.
                parsed = parser.parse(new String(content, StandardCharsets.UTF_8));
            }
        } catch (PgSchemaExtractor.TobeDdlApplyException e) {
            log.error("TO-BE DDL apply failed for project {}: {}", projectId, e.getMessage());
            throw new ApiException("TOBE_DDL_APPLY_FAILED",
                    e.getMessage(), HttpStatus.BAD_REQUEST);
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

        /* DDL import 는 「やり直し動作」으로 취급 — deleteDdl 와 同じく project 의
           mapping_rules / mapping_table_bindings / mapping_code_maps 를 全 wipe.
           re-import (旣存 DDL 上書き) 인 경우 mapping 보존 동작이 「軽한 DDL 수정으로
           mapping 살아남음」 vs 「DDL 와 mapping 不整合」 의 trade-off 였으나, 후자가
           사일런트 오류로 더 위험하다는 사용자 결정. 初回 import 라면 wipe 할 게
           없어 no-op. ReImport 버튼 = Delete + Import 의 ショートカット. */
        int rules = mappingRuleRepo.deleteAllByProjectId(projectId);
        int bindings = mappingBindingRepo.deleteAllByProjectId(projectId);
        int codes = mappingCodeMapRepo.deleteAllByProjectId(projectId);
        if (rules + bindings + codes > 0) {
            log.info("DDL import wiped mapping (re-import): project={}, side={}, rules={}, bindings={}, codeMaps={}",
                    projectId, side, rules, bindings, codes);
        }

        DdlImport ddlImport = DdlImport.create(
                projectId, side, filename, content.length,
                HashUtil.sha256Hex(content), dialect, importedBy);
        ddlImport.setTableCount(parsed.getTables().size());
        ddlImport.setColumnCount(parsed.totalColumnCount());
        ddlImportRepo.save(ddlImport);

        Map<String, String> tableIdByName = new java.util.HashMap<>();
        for (ParsedTable pt : parsed.getTables()) {
            DdlTable dt = DdlTable.create(projectId, side, ddlImport.getId(),
                    pt.getSchemaName(), pt.getPhysicalName(), pt.getOrdinal());
            dt.setLogicalName(pt.getLogicalName());
            dt.setTableComment(pt.getTableComment());
            ddlTableRepo.save(dt);
            tableIdByName.put(pt.getPhysicalName(), dt.getId());

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

        // 인덱스 저장 (보조 인덱스 + UK 의 underlying 은 PgSchemaExtractor 에서 제외됨)
        for (ParsedIndex pi : parsed.getIndexes()) {
            String tableId = tableIdByName.get(pi.getTableName());
            if (tableId == null) {
                log.warn("DDL index {} references unknown table {}, skip", pi.getName(), pi.getTableName());
                continue;
            }
            DdlIndex idx = DdlIndex.create(projectId, tableId, side, pi.getName(), pi.getType(), pi.isUnique());
            idx.setPartial(pi.isPartial());
            idx.setWhereClause(pi.getWhereClause());
            idx.setExpression(pi.getExpression());
            ddlIndexRepo.save(idx);

            for (ParsedIndexColumn pic : pi.getColumns()) {
                DdlIndexColumn ic = DdlIndexColumn.create(idx.getId(), pic.getOrdinal(), pic.getColumnName());
                ic.setSortOrder(pic.getSortOrder());
                ddlIndexColumnRepo.save(ic);
            }
        }

        // 제약 저장 (UK / FK / CHECK). PK 는 ddl_columns.pk_order 가 표현.
        for (ParsedConstraint pc : parsed.getConstraints()) {
            String tableId = tableIdByName.get(pc.getTableName());
            if (tableId == null) {
                log.warn("DDL constraint {} references unknown table {}, skip", pc.getName(), pc.getTableName());
                continue;
            }
            DdlConstraint dc = DdlConstraint.create(projectId, tableId, side, pc.getName(), pc.getType());
            dc.setCheckExpression(pc.getCheckExpression());
            ddlConstraintRepo.save(dc);

            for (ParsedConstraintColumn pcc : pc.getColumns()) {
                DdlConstraintColumn cc = DdlConstraintColumn.create(
                        dc.getId(), pcc.getOrdinal(), pcc.getColumnName(), pcc.getRefColumnName());
                ddlConstraintColumnRepo.save(cc);
            }

            if (ParsedConstraint.TYPE_FK.equals(pc.getType()) && pc.getForeignKey() != null) {
                ParsedForeignKey pfk = pc.getForeignKey();
                DdlForeignKey fk = DdlForeignKey.create(dc.getId(), pfk.getRefSchemaName(), pfk.getRefTableName());
                fk.setOnDelete(pfk.getOnDelete());
                fk.setOnUpdate(pfk.getOnUpdate());
                fk.setDeferrableInfo(pfk.getDeferrableInfo());
                ddlForeignKeyRepo.save(fk);
            }
        }

        applyTableCountToProject(project, side, parsed.getTables().size());
        autoAdvancePhaseIfBothDdlImported(project);
        projectRepo.save(project);

        // DDL import 알림 — toast 대신 audit_log 에 기록해서 알림 벨(Notification)로 노출.
        String sideLabel = SIDE_ASIS.equals(side) ? "AS-IS" : "TO-BE";
        auditLogService.record(project, importedBy, "DDL imported")
                .target(side)
                .details(sideLabel + " · " + filename + " · " + parsed.getTables().size() + " tables")
                .save();

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

    /**
     * AS-IS 또는 TO-BE DDL 중 하나라도 없으면 (둘 다 import 되지 않으면) phase 를 planning 으로
     * 되돌린다. autoAdvancePhaseIfBothDdlImported 의 역 — DDL 이 불완전하면 무조건 planning.
     */
    private void demoteToPlanningIfDdlIncomplete(Project project) {
        if ((project.getTableCount() == 0 || project.getTobeTableCount() == 0)
                && !"planning".equals(project.getPhase())) {
            String prev = project.getPhase();
            project.setPhase("planning");
            log.info("Project {} demoted phase: {} → planning (DDL incomplete)",
                    project.getId(), prev);
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
        demoteToPlanningIfDdlIncomplete(project);
        projectRepo.save(project);

        /* DDL 削除는 「やり直し動作」으로 취급 — AS-IS / TO-BE 어느 쪽이든 그 project 의
           mapping_rules / mapping_table_bindings / mapping_code_maps 를 전체 wipe.
           이유: 한쪽 DDL 이 없어지면 rule 의 참조가 끊겨 의미가 없고, 한쪽 DDL 만 보존된
           mapping 정의는 의미가 없다. import 側도 同 동작 (재 import 시 wipe). */
        int rules = mappingRuleRepo.deleteAllByProjectId(projectId);
        int bindings = mappingBindingRepo.deleteAllByProjectId(projectId);
        int codes = mappingCodeMapRepo.deleteAllByProjectId(projectId);

        log.info("DDL deleted: project={}, side={}, mapping wiped (rules={}, bindings={}, codeMaps={})",
                projectId, side, rules, bindings, codes);
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

    /**
     * Project 의 Site 정보로 DDL dialect 를 결정 (파서 선택 + 저장 공용).
     *   side=asis → site.asisDbType, side=tobe → site.tobeDbByEnv[env].type
     * <b>type 미설정 시 기본값은 side 별로 다르다(현재 동작·로더 규칙 보존)</b>:
     *   AS-IS → oracle, TO-BE → postgresql ({@code LoaderAdapterRegistry} 의 "빈값→PG" 와 일치 —
     *   기존 PG TO-BE 프로젝트가 Oracle 파서로 오라우팅되지 않게).
     */
    private String resolveDialect(Project project, String side) {
        String raw = rawDbType(project, side);
        if (raw == null || raw.isBlank()) {
            return SIDE_TOBE.equals(side) ? DialectUtil.POSTGRESQL : DialectUtil.ORACLE;
        }
        return DialectUtil.normalize(raw);
    }

    /** Site/Project 설정에서 side 별 원본 DB type 문자열 (없으면 null). */
    private String rawDbType(Project project, String side) {
        if (project.getSiteId() == null) return null;
        Site site = siteRepo.findById(project.getSiteId()).orElse(null);
        if (site == null) return null;
        if (SIDE_ASIS.equals(side)) return site.getAsisDbType();
        if (SIDE_TOBE.equals(side)) {
            // scope='project' 면 Project.tobeDbByEnv 우선, 아니면 Site.tobeDbByEnv.
            Map<String, Object> byEnv = "project".equals(site.getTobeDbScope())
                    ? project.getTobeDbByEnv()
                    : site.getTobeDbByEnv();
            if (byEnv != null && site.getEnvironment() != null) {
                Object envConn = byEnv.get(site.getEnvironment());
                if (envConn instanceof Map<?, ?> conn) {
                    Object t = conn.get("type");
                    if (t != null) return t.toString();
                }
            }
        }
        return null;
    }

    public record DdlSchema(DdlImport latestImport, List<DdlTableWithColumns> tables) {}

    public record DdlTableWithColumns(DdlTable table, List<DdlColumn> columns) {}
}
