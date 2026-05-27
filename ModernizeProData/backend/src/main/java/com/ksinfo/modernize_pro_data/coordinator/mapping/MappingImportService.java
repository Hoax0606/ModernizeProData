package com.ksinfo.modernize_pro_data.coordinator.mapping;

import com.ksinfo.modernize_pro_data.common.duckdb.DuckDbService;
import com.ksinfo.modernize_pro_data.common.exception.ApiException;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 맵핑정의서 (CSV) 임포트 서비스.
 *
 * 1. 두 CSV (column_mapping 필수, code_mapping 옵셔널) 를 임시 파일에 저장
 * 2. DuckDB read_csv_auto 로 파싱
 * 3. 한 트랜잭션 안에서:
 *      - MappingImport 레코드 생성
 *      - 해당 project_id 의 mapping_rules 전체 DELETE
 *      - 해당 project_id 의 mapping_code_maps 전체 DELETE
 *      - 파싱한 신규 row 일괄 INSERT
 *      - rule_count / code_map_count 업데이트
 * 4. 임시 파일 cleanup
 *
 * 협의 (2026-05-23): 매번 전체 덮어쓰기. origin='manual' 룰도 같이 날아감.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class MappingImportService {

    /* column_mapping.csv 필수 컬럼 (case-insensitive 매칭) — 프로젝트 템플릿 convention */
    private static final List<String> REQUIRED_RULE_COLUMNS = List.of(
            "tobe_table", "tobe_column"
    );

    /* code_mapping.csv 필수 컬럼 */
    private static final List<String> REQUIRED_CODE_COLUMNS = List.of(
            "domain", "source_value", "target_value"
    );

    private final DuckDbService duckDbService;
    private final MappingImportRepository importRepo;
    private final MappingRuleRepository ruleRepo;
    private final MappingCodeMapRepository codeRepo;
    private final MappingTableBindingRepository bindingRepo;

    /**
     * @param columnCsv    column_mapping.csv 의 원본 바이트
     * @param columnFilename 화면 표시용 파일명 (mapping_imports.filename 에 저장)
     * @param codeCsv      code_mapping.csv 의 원본 바이트 (없으면 null)
     * @param userName     임포트 수행한 사용자
     */
    @Transactional
    public MappingImport importFromCsv(
            String projectId,
            byte[] columnCsv,
            String columnFilename,
            byte[] codeCsv,
            String codeFilename,
            String userName
    ) {
        return importFromCsv(projectId, columnCsv, columnFilename, codeCsv, codeFilename, userName, null);
    }

    /**
     * tobeTableFilter null = 프로젝트 전체 (기존 동작). 값이 있으면 그 TO-BE 테이블의
     * rule/binding 만 갱신하고(다른 테이블·수동 수정 보존), code 는 그 테이블이 참조하는
     * domain 만 갱신한다.
     */
    @Transactional
    public MappingImport importFromCsv(
            String projectId,
            byte[] columnCsv,
            String columnFilename,
            byte[] codeCsv,
            String codeFilename,
            String userName,
            String tobeTableFilter
    ) {
        if ((columnCsv == null || columnCsv.length == 0) && (codeCsv == null || codeCsv.length == 0)) {
            throw new ApiException(
                    "MAPPING_IMPORT_EMPTY",
                    "column 또는 code 매핑정의서 중 적어도 하나는 필요합니다",
                    HttpStatus.BAD_REQUEST);
        }

        boolean hasColumn = columnCsv != null && columnCsv.length > 0;
        boolean hasCode   = codeCsv   != null && codeCsv.length   > 0;

        Path columnTmp = null;
        Path codeTmp = null;
        try {
            ParsedRules parsed = new ParsedRules(List.of());
            if (hasColumn) {
                columnTmp = writeTemp(columnCsv, "column_mapping");
                parsed = parseColumnCsv(columnTmp);
                // 테이블 단위 적용이면 그 TO-BE 테이블의 룰만 남긴다.
                if (tobeTableFilter != null) {
                    List<RuleRow> only = new ArrayList<>();
                    for (RuleRow r : parsed.rules) {
                        if (tobeTableFilter.equals(r.tobeTable)) only.add(r);
                    }
                    parsed = new ParsedRules(only);
                }
            }

            ParsedCodes codes = new ParsedCodes(List.of());
            if (hasCode) {
                codeTmp = writeTemp(codeCsv, "code_mapping");
                codes = parseCodeCsv(codeTmp);
            }

            // 1) MappingImport 레코드 (업로드한 슬롯만 채움)
            MappingImport mi = new MappingImport();
            mi.setId("mi-" + UUID.randomUUID().toString().substring(0, 8));
            mi.setProjectId(projectId);
            mi.setFilename(hasColumn ? columnFilename : null);
            mi.setCodeFilename(hasCode ? codeFilename : null);
            mi.setColumnCsvContent(hasColumn ? new String(columnCsv, java.nio.charset.StandardCharsets.UTF_8) : null);
            mi.setCodeCsvContent(hasCode ? new String(codeCsv, java.nio.charset.StandardCharsets.UTF_8) : null);
            mi.setFileSize((hasColumn ? columnCsv.length : 0) + (hasCode ? codeCsv.length : 0));
            mi.setFileHash(sha256(hasColumn ? columnCsv : codeCsv));
            mi.setFormat("csv");
            mi.setStatus("success");
            mi.setRuleCount(parsed.rules.size());
            mi.setCodeMapCount(codes.codes.size());
            mi.setImportedBy(userName);
            mi.setImportedAt(OffsetDateTime.now());
            importRepo.save(mi);

            // 2) 부분 덮어쓰기 — 업로드된 슬롯만 wipe + insert
            OffsetDateTime now = OffsetDateTime.now();

            // (a) code map 부터 처리 — column 의 transform_sql 자동 생성 (CASE) 시 lookup 필요
            if (hasCode) {
                // 테이블 단위면 그 테이블의 룰이 참조하는 domain 만 갱신 (parsed 는 위에서 필터됨).
                Set<String> codeDomains = null;
                if (tobeTableFilter != null) {
                    codeDomains = new HashSet<>();
                    for (RuleRow r : parsed.rules) {
                        if (r.codeDomain != null && !r.codeDomain.isBlank()) codeDomains.add(r.codeDomain);
                    }
                }
                if (tobeTableFilter == null) {
                    codeRepo.deleteAllByProjectId(projectId);
                    codeRepo.flush();
                } else if (!codeDomains.isEmpty()) {
                    codeRepo.deleteByProjectIdAndDomainIn(projectId, codeDomains);
                    codeRepo.flush();
                }
                List<MappingCodeMap> codeEntities = new ArrayList<>(codes.codes.size());
                for (CodeRow row : codes.codes) {
                    if (codeDomains != null && !codeDomains.contains(row.domain)) continue;
                    MappingCodeMap e = new MappingCodeMap();
                    e.setId("mc-" + UUID.randomUUID().toString().substring(0, 8));
                    e.setProjectId(projectId);
                    e.setImportId(mi.getId());
                    e.setDomain(row.domain);
                    e.setSourceValue(row.sourceValue);
                    e.setTargetValue(row.targetValue);
                    e.setDescription(row.description);
                    e.setOrdinal(row.ordinal);
                    codeEntities.add(e);
                }
                codeRepo.saveAll(codeEntities);
            }

            // domain → entries 룩업 맵. 이번 업로드에 code 가 있으면 그걸, 없으면 DB 에 남아있는 것.
            Map<String, List<CodeRow>> codeByDomain = new HashMap<>();
            if (hasCode) {
                for (CodeRow c : codes.codes) {
                    codeByDomain.computeIfAbsent(c.domain, k -> new ArrayList<>()).add(c);
                }
            } else {
                for (MappingCodeMap c : codeRepo.findByProjectIdOrderByDomainAscOrdinalAsc(projectId)) {
                    CodeRow cr = new CodeRow();
                    cr.domain = c.getDomain();
                    cr.sourceValue = c.getSourceValue();
                    cr.targetValue = c.getTargetValue();
                    cr.description = c.getDescription();
                    cr.ordinal = c.getOrdinal();
                    codeByDomain.computeIfAbsent(c.getDomain(), k -> new ArrayList<>()).add(cr);
                }
            }

            // (b) column rules
            if (hasColumn) {
                // alias 자동 할당 — (tobe_table 그룹 × asis_table) 마다 단일 alias.
                Map<String, Map<String, String>> aliasMaps = buildAliasMaps(parsed.rules);

                // expression 룰의 transform_sql 자동 생성
                for (RuleRow row : parsed.rules) {
                    if (!"expression".equals(row.strategy)) continue;
                    if (row.transformSql != null && !row.transformSql.isBlank()) continue;
                    if (row.transformRule != null && !row.transformRule.isBlank()) {
                        row.transformSql = row.transformRule;
                        continue;
                    }
                    if (row.asisColumn == null || row.asisColumn.length == 0 || row.asisTable == null) continue;
                    // multi-source (combine) — 자동 transform_sql 생성 불가. 사용자가 row editor 에서
                    // MAKE_DATE / CONCAT 같은 식을 직접 입력하는 것을 기대.
                    if (row.asisColumn.length > 1) continue;
                    String tobeKey = (row.tobeSchema == null ? "" : row.tobeSchema) + "|" + row.tobeTable;
                    Map<String, String> aliasMap = aliasMaps.getOrDefault(tobeKey, Map.of());
                    String alias = aliasMap.get(row.asisTable);
                    if (alias == null) continue;
                    String onlyCol = row.asisColumn[0];
                    String src = alias + "." + onlyCol;
                    String asisTypeFirst = (row.asisType != null && row.asisType.length > 0)
                            ? row.asisType[0] : null;

                    // code_domain 이 지정돼있고 해당 domain 의 entries 가 있으면 CASE 자동 생성
                    if (row.codeDomain != null && codeByDomain.containsKey(row.codeDomain)) {
                        row.transformSql = buildCaseFromCodeMap(src, codeByDomain.get(row.codeDomain));
                    } else if (typeCategoriesMatch(asisTypeFirst, row.tobeType)) {
                        row.transformSql = src;
                    } else {
                        // CHAR(8) YYYYMMDD / CHAR(14) YYYYMMDDHH24MISS 같은 Oracle 컨벤션 패턴 우선
                        String strDateSql = tryStringToDateSql(src, asisTypeFirst, row.tobeType);
                        row.transformSql = strDateSql != null ? strDateSql
                                : "CAST(" + src + " AS " + (row.tobeType != null ? row.tobeType : "VARCHAR") + ")";
                    }
                    row.transformRule = row.transformSql;
                }

                if (tobeTableFilter == null) ruleRepo.deleteAllByProjectId(projectId);
                else ruleRepo.deleteByProjectIdAndTobeTable(projectId, tobeTableFilter);
                ruleRepo.flush();
                List<MappingRule> ruleEntities = new ArrayList<>(parsed.rules.size());
                for (RuleRow row : parsed.rules) {
                    ruleEntities.add(toRuleEntity(row, projectId, mi.getId(), userName, now));
                }
                ruleRepo.saveAll(ruleEntities);

                // 룰에서 테이블 바인딩 자동 derive
                if (tobeTableFilter == null) bindingRepo.deleteAllByProjectId(projectId);
                else bindingRepo.deleteByProjectIdAndTobeTable(projectId, tobeTableFilter);
                bindingRepo.flush();
                List<MappingTableBinding> bindings = deriveBindings(parsed.rules, projectId, mi.getId(), userName, now);
                bindingRepo.saveAll(bindings);
            }

            log.info("Mapping import done — project={} rules={} codeMaps={} (column={}, code={})",
                    projectId, parsed.rules.size(), codes.codes.size(), hasColumn, hasCode);
            return mi;
        } catch (ApiException e) {
            throw e;
        } catch (Exception e) {
            log.warn("Mapping import failed", e);
            throw new ApiException(
                    "MAPPING_IMPORT_FAILED",
                    "임포트 실패: " + e.getMessage(),
                    HttpStatus.INTERNAL_SERVER_ERROR);
        } finally {
            deleteQuiet(columnTmp);
            deleteQuiet(codeTmp);
        }
    }

    /* ──────────────────────────────────────────────
     * Parsing — DuckDB read_csv_auto
     * ────────────────────────────────────────────── */

    /**
     * column_mapping.csv 파싱. 다중 source (combine) 케이스 두 가지 입력 형식을 모두 받아
     * 같은 (tobeSchema, tobeTable, tobeColumn) 의 source 들을 ';' 구분자 문자열로 정규화한다.
     *
     *   ① 한 row 안에 ';' 묶음        — asis_column = "BIRTH_YEAR;BIRTH_MONTH;BIRTH_DAY"
     *   ② 연속 row 행분할              — tobeColumn 같은 row 들이 연이어 등장
     *      (셀결합 흉내: 2번째 이후 row 의 tobe_table/tobe_column 빈칸이면 직전 row 상속)
     *
     * 두 경우 모두 결과는 동일 — DB asis_column = "BIRTH_YEAR;BIRTH_MONTH;BIRTH_DAY".
     * 그룹의 변환 ロジック / default / code_domain / notes 등 메타는 **첫 row 의 값만** 사용한다.
     */
    private ParsedRules parseColumnCsv(Path csv) {
        Map<String, Integer> headers = new HashMap<>();
        // LinkedHashMap — 입력 순서 보존 (셀결합 흉내가 의미 있으려면 순서가 중요).
        LinkedHashMap<String, RuleRow> grouped = new LinkedHashMap<>();

        // read_csv (not _auto) 으로 delimiter / quote / escape 모두 명시.
        String sql = "SELECT * FROM read_csv('" + escape(csv.toString())
                + "', header=true, delim=',', all_varchar=true, null_padding=true)";

        try (Statement st = duckDbService.statement();
             ResultSet rs = st.executeQuery(sql)) {
            ResultSetMetaData md = rs.getMetaData();
            for (int i = 1; i <= md.getColumnCount(); i++) {
                String raw = md.getColumnLabel(i);
                String clean = cleanHeader(raw);
                headers.put(clean, i);
            }
            validateRequired("column_mapping.csv", REQUIRED_RULE_COLUMNS, headers.keySet());

            String lastTobeTableRaw = null;
            String lastTobeColumn   = null;

            while (rs.next()) {
                String tobeTableRaw = trimToNull(get(rs, headers, "tobe_table"));
                String tobeColumn   = trimToNull(get(rs, headers, "tobe_column"));
                // 셀결합 흉내 — tobe 칸 빈 row 는 직전 row 의 tobe 를 상속.
                if (tobeTableRaw == null) tobeTableRaw = lastTobeTableRaw;
                if (tobeColumn == null)   tobeColumn   = lastTobeColumn;
                if (tobeTableRaw == null || tobeColumn == null) {
                    continue; // skip — 초반부터 빈 row
                }
                lastTobeTableRaw = tobeTableRaw;
                lastTobeColumn   = tobeColumn;

                String tobeSchema;
                String tobeTable;
                int dot = tobeTableRaw.indexOf('.');
                if (dot > 0) {
                    tobeSchema = tobeTableRaw.substring(0, dot);
                    tobeTable  = tobeTableRaw.substring(dot + 1);
                } else {
                    tobeSchema = "";
                    tobeTable  = tobeTableRaw;
                }

                String dedupKey = tobeSchema + "|" + tobeTable + "|" + tobeColumn;
                String asisColumnCell = trimToNull(get(rs, headers, "asis_column"));
                String asisTypeCell   = trimToNull(get(rs, headers, "asis_type"));

                RuleRow existing = grouped.get(dedupKey);
                if (existing != null) {
                    // 추가 source row — asis_column / asis_type 만 배열 끝에 append.
                    // tobe_type / strategy / default / code_domain / notes 는 첫 row 값을 그대로.
                    if (asisColumnCell != null) {
                        existing.asisColumn = appendArray(existing.asisColumn, splitSemicolon(asisColumnCell));
                    }
                    if (asisTypeCell != null) {
                        existing.asisType = appendArray(existing.asisType, splitSemicolon(asisTypeCell));
                    }
                    continue;
                }

                // 새 그룹의 첫 row.
                RuleRow row = new RuleRow();
                row.tobeSchema = tobeSchema;
                row.tobeTable  = tobeTable;
                row.tobeColumn = tobeColumn;

                String asisTableRaw = trimToNull(get(rs, headers, "asis_table"));
                if (asisTableRaw != null) {
                    int adot = asisTableRaw.indexOf('.');
                    if (adot > 0) {
                        row.asisSchema = asisTableRaw.substring(0, adot);
                        row.asisTable  = asisTableRaw.substring(adot + 1);
                    } else {
                        row.asisTable = asisTableRaw;
                    }
                }
                // 셀 안에 ';' 가 이미 있을 수 있음 (한 줄에 묶어 입력한 경우) — split 해서 String[] 로.
                row.asisColumn = asisColumnCell == null ? null : splitSemicolon(asisColumnCell).toArray(new String[0]);
                row.asisType   = asisTypeCell   == null ? null : splitSemicolon(asisTypeCell).toArray(new String[0]);
                row.tobeType    = trimToNull(get(rs, headers, "tobe_type"));
                row.codeDomain  = trimToNull(get(rs, headers, "code_domain"));

                String rule    = trimToNull(get(rs, headers, "rule_sql"));
                String strat   = trimToNull(get(rs, headers, "strategy"));
                String defVal  = trimToNull(get(rs, headers, "default_value"));
                row.transformSql = trimToNull(get(rs, headers, "transform_sql"));
                row.notes      = trimToNull(get(rs, headers, "notes"));

                applyStrategy(row, strat, rule, defVal);

                if (row.transformSql == null && "expression".equals(row.strategy)) {
                    row.transformSql = row.transformRule;
                }

                grouped.put(dedupKey, row);
            }
        } catch (SQLException e) {
            throw new ApiException(
                    "MAPPING_PARSE_FAILED",
                    "column_mapping.csv 파싱 실패: " + e.getMessage(),
                    HttpStatus.BAD_REQUEST);
        }
        return new ParsedRules(new ArrayList<>(grouped.values()));
    }

    private ParsedCodes parseCodeCsv(Path csv) {
        Map<String, Integer> headers = new HashMap<>();
        List<CodeRow> out = new ArrayList<>();
        Set<String> seen = new HashSet<>();

        String sql = "SELECT * FROM read_csv('" + escape(csv.toString())
                + "', header=true, delim=',', all_varchar=true, null_padding=true)";

        try (Statement st = duckDbService.statement();
             ResultSet rs = st.executeQuery(sql)) {
            ResultSetMetaData md = rs.getMetaData();
            for (int i = 1; i <= md.getColumnCount(); i++) {
                headers.put(cleanHeader(md.getColumnLabel(i)), i);
            }
            validateRequired("code_mapping.csv", REQUIRED_CODE_COLUMNS, headers.keySet());

            int ordinal = 0;
            while (rs.next()) {
                CodeRow row = new CodeRow();
                row.domain      = trimToNull(get(rs, headers, "domain"));
                row.sourceValue = trimToNull(get(rs, headers, "source_value"));
                row.targetValue = trimToNull(get(rs, headers, "target_value"));
                if (row.domain == null || row.sourceValue == null || row.targetValue == null) {
                    continue;
                }
                row.description = trimToNull(get(rs, headers, "description"));
                String ordStr = trimToNull(get(rs, headers, "ordinal"));
                row.ordinal = ordStr != null ? safeInt(ordStr, ordinal) : ordinal;
                ordinal++;

                String dedupKey = row.domain + "|" + row.sourceValue;
                if (!seen.add(dedupKey)) {
                    log.warn("Duplicate code map ({}, {}) — keeping first", row.domain, row.sourceValue);
                    continue;
                }
                out.add(row);
            }
        } catch (SQLException e) {
            throw new ApiException(
                    "MAPPING_PARSE_FAILED",
                    "code_mapping.csv 파싱 실패: " + e.getMessage(),
                    HttpStatus.BAD_REQUEST);
        }
        return new ParsedCodes(out);
    }

    private void applyStrategy(RuleRow row, String stratColumn, String rule, String defVal) {
        // 1) strategy 컬럼이 명시되어 있으면 그대로 사용 (이전 컨벤션 호환)
        if (stratColumn != null) {
            String s = stratColumn.toLowerCase();
            if (Arrays.asList("expression", "null", "default", "skip").contains(s)) {
                row.strategy = s;
                row.transformRule = "expression".equals(s) ? rule : null;
                row.defaultValue = "default".equals(s) ? defVal : null;
                return;
            }
        }
        // 2) transform_rule 셀의 상수 마커로 추론 (이전 컨벤션 호환)
        if (rule != null) {
            String upper = rule.trim().toUpperCase();
            if (upper.equals("NULL")) {
                row.strategy = "null"; row.transformRule = null;
                return;
            }
            if (upper.equals("DEFAULT")) {
                row.strategy = "default"; row.transformRule = null; row.defaultValue = defVal;
                return;
            }
            if (upper.equals("SKIP")) {
                row.strategy = "skip"; row.transformRule = null;
                return;
            }
        }
        // 3) 새 컨벤션 — 데이터 존재 기반 자동 추론.
        //    asis_column 있으면 expression / 없으면서 default_value 있으면 default / 둘 다 없으면 null
        if (row.asisColumn != null && row.asisColumn.length > 0) {
            row.strategy = "expression";
            row.transformRule = rule; // null 이면 나중에 transform_sql 자동 생성에서 채움
            row.defaultValue = defVal;
        } else if (defVal != null && !defVal.isBlank()) {
            row.strategy = "default";
            row.transformRule = null;
            row.defaultValue = defVal;
        } else {
            row.strategy = "null";
            row.transformRule = null;
            row.defaultValue = null;
        }
    }

    private MappingRule toRuleEntity(RuleRow row, String projectId, String importId,
                                     String userName, OffsetDateTime now) {
        MappingRule e = new MappingRule();
        e.setId("mr-" + UUID.randomUUID().toString().substring(0, 8));
        e.setProjectId(projectId);
        e.setImportId(importId);
        e.setTobeSchema(row.tobeSchema);
        e.setTobeTable(row.tobeTable);
        e.setTobeColumn(row.tobeColumn);
        e.setAsisSchema(row.asisSchema);
        e.setAsisTable(row.asisTable);
        e.setAsisColumn(row.asisColumn);
        e.setAsisType(row.asisType);
        e.setCodeDomain(row.codeDomain);
        e.setStrategy(row.strategy);
        e.setTransformRule(row.transformRule);
        e.setTransformSql(row.transformSql);
        e.setDefaultValue(row.defaultValue);
        e.setNotNullOverride(false);
        e.setRuleOrigin("imported");
        e.setNotes(row.notes);
        e.setCreatedBy(userName);
        e.setCreatedAt(now);
        return e;
    }

    /* ──────────────────────────────────────────────
     * Re-apply latest import — 사용자가 파일 다시 안 골라도
     * 마지막 임포트의 CSV 텍스트로 룰·바인딩·코드맵 모두 재생성. 수동 수정 사라짐.
     * 저장된 CSV content 가 없으면 no-op.
     * ────────────────────────────────────────────── */

    @Transactional
    public MappingImport reapplyLatest(String projectId, String userName) {
        return reapplyLatest(projectId, userName, null);
    }

    @Transactional
    public MappingImport reapplyLatest(String projectId, String userName, String tobeTableFilter) {
        // 가장 최근의 column_csv_content 가 있는 row + code_csv_content 가 있는 row 각각
        var history = importRepo.findByProjectIdOrderByImportedAtDesc(projectId);
        String columnCsv = null, columnFilename = null;
        String codeCsv = null, codeFilename = null;
        for (MappingImport h : history) {
            if (columnCsv == null && h.getColumnCsvContent() != null) {
                columnCsv = h.getColumnCsvContent();
                columnFilename = h.getFilename();
            }
            if (codeCsv == null && h.getCodeCsvContent() != null) {
                codeCsv = h.getCodeCsvContent();
                codeFilename = h.getCodeFilename();
            }
            if (columnCsv != null && codeCsv != null) break;
        }
        if (columnCsv == null && codeCsv == null) {
            throw new ApiException("NO_PREVIOUS_IMPORT",
                    "재적용할 이전 임포트 내역이 없습니다", HttpStatus.BAD_REQUEST);
        }
        byte[] columnBytes = columnCsv != null
                ? columnCsv.getBytes(java.nio.charset.StandardCharsets.UTF_8) : null;
        byte[] codeBytes = codeCsv != null
                ? codeCsv.getBytes(java.nio.charset.StandardCharsets.UTF_8) : null;
        return importFromCsv(projectId, columnBytes, columnFilename, codeBytes, codeFilename, userName, tobeTableFilter);
    }

    /* ──────────────────────────────────────────────
     * Rebuild bindings from current mapping_rules — Apply 시 매번 호출 (멱등)
     * 파일 재업로드 없이도 룰만 보고 bindings 재생성. UI 가 사용.
     * ────────────────────────────────────────────── */

    @Transactional
    public int rebuildBindings(String projectId, String userName) {
        List<MappingRule> existing = ruleRepo.findByProjectId(projectId);
        bindingRepo.deleteAllByProjectId(projectId);
        bindingRepo.flush();
        if (existing.isEmpty()) return 0;

        List<RuleRow> rows = new ArrayList<>(existing.size());
        for (MappingRule e : existing) {
            RuleRow r = new RuleRow();
            r.tobeSchema   = e.getTobeSchema() == null ? "" : e.getTobeSchema();
            r.tobeTable    = e.getTobeTable();
            r.tobeColumn   = e.getTobeColumn();
            r.asisSchema   = e.getAsisSchema();
            r.asisTable    = e.getAsisTable();
            r.asisColumn   = e.getAsisColumn();
            r.asisType     = e.getAsisType();
            r.codeDomain   = e.getCodeDomain();
            r.strategy     = e.getStrategy();
            r.transformRule = e.getTransformRule();
            r.transformSql  = e.getTransformSql();
            r.defaultValue = e.getDefaultValue();
            r.notes        = e.getNotes();
            rows.add(r);
        }
        List<MappingTableBinding> bindings = deriveBindings(
                rows, projectId, /* importId */ null, userName, OffsetDateTime.now());
        bindingRepo.saveAll(bindings);
        return bindings.size();
    }

    /* ──────────────────────────────────────────────
     * Manual rule upsert — row 편집기에서 한 컬럼 룰 저장할 때 호출.
     * 키: (project, tobeSchema, tobeTable, tobeColumn). 없으면 신규, 있으면 갱신.
     * transform_sql 폴백 — 사용자가 명시 안 했고 strategy=expression 이면 rule 값 복사.
     * ────────────────────────────────────────────── */

    public record UpsertRuleRequest(
            String tobeSchema,
            String tobeTable,
            String tobeColumn,
            String asisSchema,
            String asisTable,
            String[] asisColumn,
            String strategy,
            String transformRule,
            String transformSql,
            String defaultValue,
            Boolean notNullOverride
    ) {}

    @Transactional
    public MappingRule upsertRule(String projectId, UpsertRuleRequest req, String userName) {
        if (req == null || req.tobeTable() == null || req.tobeColumn() == null) {
            throw new ApiException("RULE_INVALID",
                    "tobeTable / tobeColumn 이 비어있습니다", HttpStatus.BAD_REQUEST);
        }
        String schema = req.tobeSchema() == null ? "" : req.tobeSchema();
        OffsetDateTime now = OffsetDateTime.now();

        MappingRule r = ruleRepo
                .findByProjectIdAndTobeSchemaAndTobeTableAndTobeColumn(
                        projectId, schema, req.tobeTable(), req.tobeColumn())
                .orElseGet(() -> {
                    MappingRule nr = new MappingRule();
                    nr.setId("mr-" + UUID.randomUUID().toString().substring(0, 8));
                    nr.setProjectId(projectId);
                    nr.setTobeSchema(schema);
                    nr.setTobeTable(req.tobeTable());
                    nr.setTobeColumn(req.tobeColumn());
                    nr.setCreatedBy(userName);
                    nr.setCreatedAt(now);
                    return nr;
                });
        r.setAsisSchema(req.asisSchema());
        r.setAsisTable(req.asisTable());
        r.setAsisColumn(req.asisColumn());
        String strategy = req.strategy() != null ? req.strategy() : "expression";
        r.setStrategy(strategy);
        r.setTransformRule(req.transformRule());
        // transform_sql 폴백 — 명시 안 됐고 expression 이면 rule 값 그대로 복사
        if (req.transformSql() != null) {
            r.setTransformSql(req.transformSql());
        } else if ("expression".equals(strategy)) {
            r.setTransformSql(req.transformRule());
        } else {
            r.setTransformSql(null);
        }
        r.setDefaultValue(req.defaultValue());
        r.setNotNullOverride(Boolean.TRUE.equals(req.notNullOverride()));
        r.setRuleOrigin("manual");
        r.setUpdatedBy(userName);
        r.setUpdatedAt(now);
        return ruleRepo.save(r);
    }

    /* ──────────────────────────────────────────────
     * Manual binding upsert — UI 에서 사용자가 편집할 때 호출
     * ────────────────────────────────────────────── */

    public record UpsertBindingRequest(
            String tobeSchema,
            String tobeTable,
            String compositionKind,
            String whereFilter,
            List<UpsertSourceDto> sources
    ) {}

    public record UpsertSourceDto(
            int ordinal,
            String asisSchema,
            String asisTable,
            String alias,
            String role,
            String joinType,
            String joinOn
    ) {}

    @Transactional
    public MappingTableBinding upsertBinding(String projectId, UpsertBindingRequest req, String userName) {
        if (req == null || req.tobeTable() == null || req.tobeTable().isBlank()) {
            throw new ApiException("BINDING_INVALID", "tobeTable 이 비어있습니다", HttpStatus.BAD_REQUEST);
        }
        String schema = req.tobeSchema() == null ? "" : req.tobeSchema();
        OffsetDateTime now = OffsetDateTime.now();

        // 기존 binding 이 있으면 통째로 DELETE 후 flush — Hibernate 가 orphanRemoval
        // 의 INSERT/DELETE 순서를 잘못 잡아서 alias unique 제약을 위반하는 케이스 회피.
        // createdBy/createdAt 만 보존해서 새 row 에 옮김.
        String createdBy = userName;
        OffsetDateTime createdAt = now;
        var existing = bindingRepo.findByProjectIdAndTobeSchemaAndTobeTable(
                projectId, schema, req.tobeTable());
        if (existing.isPresent()) {
            createdBy  = existing.get().getCreatedBy();
            createdAt  = existing.get().getCreatedAt();
            bindingRepo.delete(existing.get());
            bindingRepo.flush();
        }

        MappingTableBinding b = new MappingTableBinding();
        b.setId("mb-" + UUID.randomUUID().toString().substring(0, 8));
        b.setProjectId(projectId);
        b.setTobeSchema(schema);
        b.setTobeTable(req.tobeTable());
        b.setCompositionKind(req.compositionKind() != null ? req.compositionKind() : "single");
        b.setWhereFilter(req.whereFilter());
        b.setBindingOrigin("manual");
        b.setCreatedBy(createdBy);
        b.setCreatedAt(createdAt);
        b.setUpdatedBy(userName);
        b.setUpdatedAt(now);

        List<UpsertSourceDto> srcDtos = req.sources() == null ? List.of() : req.sources();
        for (UpsertSourceDto s : srcDtos) {
            MappingTableBindingSource src = new MappingTableBindingSource();
            src.setId("ms-" + UUID.randomUUID().toString().substring(0, 8));
            src.setOrdinal(s.ordinal());
            src.setAsisSchema(s.asisSchema());
            src.setAsisTable(s.asisTable());
            src.setAlias(s.alias());
            src.setRole(s.role());
            src.setJoinType(s.joinType());
            src.setJoinOn(s.joinOn());
            b.addSource(src);
        }
        return bindingRepo.save(b);
    }

    /* ──────────────────────────────────────────────
     * Auto table binding derivation
     * ────────────────────────────────────────────── */

    private static final Pattern ALIAS_REF = Pattern.compile(
            "\\b([a-zA-Z_][a-zA-Z0-9_]{0,15})\\.([A-Za-z_][A-Za-z0-9_]*)\\b");

    /**
     * parsed rule row 들을 TO-BE 테이블 기준으로 그룹화해서 binding 생성.
     *
     *   - 1 distinct asis_table  → single + primary
     *   - 2+ distinct asis_table → join + 첫번째 primary, 나머지 join (type/on 은 NULL → UI 에서)
     *   - 0  distinct asis_table → none (added/default/null 룰만 있는 TO-BE)
     *
     * alias 도출: rule_sql 의 {alias}.{column} 토큰을 보고, column 이 그룹 내 row 의
     * asis_column 과 일치하면 그 row 의 asis_table 과 묶음. 못 찾은 테이블은 첫글자 lowercase 폴백.
     */
    private List<MappingTableBinding> deriveBindings(
            List<RuleRow> rules, String projectId, String importId, String userName, OffsetDateTime now
    ) {
        // Group by (tobeSchema, tobeTable) — LinkedHashMap 으로 순서 보존
        Map<String, List<RuleRow>> grouped = new LinkedHashMap<>();
        for (RuleRow r : rules) {
            String key = (r.tobeSchema == null ? "" : r.tobeSchema) + "" + r.tobeTable;
            grouped.computeIfAbsent(key, k -> new ArrayList<>()).add(r);
        }

        List<MappingTableBinding> result = new ArrayList<>();
        for (var entry : grouped.entrySet()) {
            List<RuleRow> grp = entry.getValue();
            RuleRow first = grp.get(0);

            // distinct asis_table preserving first-appearance order, skip null
            LinkedHashMap<String, String> tableToSchema = new LinkedHashMap<>();
            for (RuleRow r : grp) {
                if (r.asisTable != null && !tableToSchema.containsKey(r.asisTable)) {
                    tableToSchema.put(r.asisTable, r.asisSchema);
                }
            }

            String compositionKind;
            if (tableToSchema.isEmpty()) compositionKind = "none";
            else if (tableToSchema.size() == 1) compositionKind = "single";
            else compositionKind = "join";

            // alias map (rule_sql token → asis_table)
            Map<String, String> tableToAlias = extractAliases(grp, tableToSchema.keySet());

            MappingTableBinding b = new MappingTableBinding();
            b.setId("mb-" + UUID.randomUUID().toString().substring(0, 8));
            b.setProjectId(projectId);
            b.setImportId(importId);
            b.setTobeSchema(first.tobeSchema == null ? "" : first.tobeSchema);
            b.setTobeTable(first.tobeTable);
            b.setCompositionKind(compositionKind);
            b.setBindingOrigin("imported");
            b.setCreatedBy(userName);
            b.setCreatedAt(now);

            int ord = 0;
            boolean primaryAssigned = false;
            Set<String> usedAliases = new HashSet<>(tableToAlias.values());
            for (var te : tableToSchema.entrySet()) {
                String tbl = te.getKey();
                String schema = te.getValue();
                String alias = tableToAlias.get(tbl);
                if (alias == null) {
                    alias = generateAlias(tbl, usedAliases);
                    usedAliases.add(alias);
                }

                String role;
                if (compositionKind.equals("union")) role = "union";
                else if (!primaryAssigned) { role = "primary"; primaryAssigned = true; }
                else role = "join";

                MappingTableBindingSource s = new MappingTableBindingSource();
                s.setId("ms-" + UUID.randomUUID().toString().substring(0, 8));
                s.setAsisSchema(schema);
                s.setAsisTable(tbl);
                s.setAlias(alias);
                s.setRole(role);
                s.setOrdinal(ord++);
                // joinType / joinOn 은 null — UI 에서 사용자가 채움
                b.addSource(s);
            }
            result.add(b);
        }
        return result;
    }

    /**
     * 각 TO-BE 테이블 그룹별로 (asis_table → alias) 맵을 일괄 생성.
     * deriveBindings 와 자동 transform_sql 생성이 같은 alias 를 쓰도록.
     */
    private static Map<String, Map<String, String>> buildAliasMaps(List<RuleRow> rules) {
        Map<String, List<RuleRow>> grouped = new LinkedHashMap<>();
        for (RuleRow r : rules) {
            String key = (r.tobeSchema == null ? "" : r.tobeSchema) + "|" + (r.tobeTable == null ? "" : r.tobeTable);
            grouped.computeIfAbsent(key, k -> new ArrayList<>()).add(r);
        }
        Map<String, Map<String, String>> out = new LinkedHashMap<>();
        for (var e : grouped.entrySet()) {
            LinkedHashSet<String> asisTables = new LinkedHashSet<>();
            for (RuleRow r : e.getValue()) {
                if (r.asisTable != null) asisTables.add(r.asisTable);
            }
            Map<String, String> rulesSubset = extractAliases(e.getValue(), asisTables);
            Map<String, String> aliasMap = new LinkedHashMap<>(rulesSubset);
            Set<String> taken = new HashSet<>(aliasMap.values());
            for (String t : asisTables) {
                if (aliasMap.containsKey(t)) continue;
                String alias = generateAlias(t, taken);
                aliasMap.put(t, alias);
                taken.add(alias);
            }
            out.put(e.getKey(), aliasMap);
        }
        return out;
    }

    /**
     * AS-IS 가 string 인데 TO-BE 가 DATE/TIMESTAMP 인 경우 — 단순 CAST 로는 변환 안 됨
     * (DuckDB 가 'YYYYMMDD' 같은 임의 포맷 캐스트 못 함). 컬럼 길이로 Oracle 의 흔한
     * 포맷 추론해서 STRPTIME 사용.
     *  - CHAR(8)  → 'YYYYMMDD'
     *  - CHAR(14) → 'YYYYMMDDHH24MISS'
     *  - CHAR(10) → 'YYYY-MM-DD'
     *  - CHAR(19) → 'YYYY-MM-DD HH:MI:SS'
     * 매칭 안 되면 null 리턴 → 호출부가 일반 CAST 로 폴백.
     */
    private static String tryStringToDateSql(String src, String asisType, String tobeType) {
        if (asisType == null || tobeType == null) return null;
        if (!"string".equals(typeCategory(asisType))) return null;
        String t = tobeType.toUpperCase().trim();
        boolean isDate = t.equals("DATE");
        boolean isTimestamp = t.startsWith("TIMESTAMP");
        if (!isDate && !isTimestamp) return null;

        int len = extractCharLength(asisType);
        String fmt;
        switch (len) {
            case 8:  fmt = "%Y%m%d"; break;
            case 14: fmt = "%Y%m%d%H%M%S"; break;
            case 10: fmt = "%Y-%m-%d"; break;
            case 19: fmt = "%Y-%m-%d %H:%M:%S"; break;
            default: return null;  // unknown — fallback to CAST
        }
        String parsed = "STRPTIME(" + src + ", '" + fmt + "')";
        return isDate ? parsed + "::DATE" : parsed;
    }

    /** "CHAR(8)" / "VARCHAR2(60 CHAR)" 같은 형식에서 숫자 부분만 추출. */
    private static int extractCharLength(String type) {
        if (type == null) return -1;
        int lp = type.indexOf('('), rp = type.indexOf(')');
        if (lp < 0 || rp <= lp) return -1;
        String inside = type.substring(lp + 1, rp).trim();
        // "8" / "8 CHAR" / "8 BYTE" / "60 CHAR"
        String[] parts = inside.split("\\s+");
        try { return Integer.parseInt(parts[0]); }
        catch (NumberFormatException e) { return -1; }
    }

    /** AS-IS / TO-BE 타입이 같은 카테고리면 cast 불필요. */
    private static boolean typeCategoriesMatch(String asisType, String tobeType) {
        String a = typeCategory(asisType);
        String t = typeCategory(tobeType);
        if (a == null || t == null) return true; // 모르면 일단 passthrough
        return a.equals(t);
    }

    /** 거친 타입 카테고리 — string/integer/decimal/boolean/date/timestamp/timestamptz/binary. */
    private static String typeCategory(String type) {
        if (type == null) return null;
        String t = type.toUpperCase().trim();
        if (t.startsWith("TIMESTAMP")) {
            return t.contains("TIME ZONE") ? "timestamptz" : "timestamp";
        }
        if (t.equals("DATE")) return "timestamp"; // Oracle DATE = timestamp 와 동급
        if (t.startsWith("NUMBER")) {
            int lp = t.indexOf('('), rp = t.indexOf(')');
            if (lp > 0 && rp > lp && t.substring(lp + 1, rp).contains(",")) {
                String[] parts = t.substring(lp + 1, rp).split(",");
                try {
                    int scale = Integer.parseInt(parts[1].trim());
                    return scale > 0 ? "decimal" : "integer";
                } catch (NumberFormatException e) { return "integer"; }
            }
            return "integer";
        }
        if (t.startsWith("INT") || t.equals("BIGINT") || t.equals("SMALLINT")
                || t.equals("INTEGER") || t.equals("TINYINT") || t.equals("SERIAL") || t.equals("BIGSERIAL")) {
            return "integer";
        }
        if (t.startsWith("NUMERIC") || t.startsWith("DECIMAL") || t.equals("FLOAT")
                || t.equals("REAL") || t.equals("DOUBLE") || t.equals("DOUBLE PRECISION")) {
            return "decimal";
        }
        if (t.startsWith("VARCHAR") || t.startsWith("CHAR") || t.equals("TEXT")
                || t.equals("CLOB") || t.startsWith("NVARCHAR")) {
            return "string";
        }
        if (t.equals("BOOLEAN") || t.equals("BOOL") || t.equals("BIT")) {
            return "boolean";
        }
        if (t.equals("BLOB") || t.equals("BYTEA") || t.startsWith("RAW")) {
            return "binary";
        }
        return null;
    }

    /**
     * code map entries → `CASE src WHEN s1 THEN t1 WHEN s2 THEN t2 ... END` 표현식.
     * target_value 가 TRUE / FALSE / NULL 키워드면 unquoted (boolean / null literal),
     * 그 외엔 single-quote string literal.
     */
    private static String buildCaseFromCodeMap(String src, List<CodeRow> entries) {
        if (entries == null || entries.isEmpty()) return src;
        StringBuilder sb = new StringBuilder("CASE ").append(src);
        for (CodeRow e : entries) {
            sb.append(" WHEN '").append(sqlEscape(e.sourceValue)).append("'")
              .append(" THEN ").append(formatTargetLiteral(e.targetValue));
        }
        sb.append(" END");
        return sb.toString();
    }

    private static String formatTargetLiteral(String value) {
        if (value == null) return "NULL";
        String u = value.trim().toUpperCase();
        if (u.equals("TRUE") || u.equals("FALSE") || u.equals("NULL")) return u;
        return "'" + sqlEscape(value) + "'";
    }

    private static String sqlEscape(String v) {
        return v == null ? "" : v.replace("'", "''");
    }

    private static Map<String, String> extractAliases(List<RuleRow> rules, Set<String> validTables) {
        // alias → first observed column referenced after that alias
        Map<String, String> aliasToColumn = new LinkedHashMap<>();
        for (RuleRow r : rules) {
            if (r.transformRule == null) continue;
            Matcher m = ALIAS_REF.matcher(r.transformRule);
            while (m.find()) {
                String alias = m.group(1);
                String column = m.group(2);
                aliasToColumn.putIfAbsent(alias, column);
            }
        }
        // alias 의 column 이 그룹 내 어느 row 의 asis_column 과 일치하는지 봐서 → 그 row 의 asis_table 로 묶음.
        // asis_column 은 List<String> — combine 시 여러 원소.
        Map<String, String> tableToAlias = new HashMap<>();
        for (var e : aliasToColumn.entrySet()) {
            String alias = e.getKey();
            String col = e.getValue();
            for (RuleRow r : rules) {
                if (r.asisTable == null || !validTables.contains(r.asisTable)) continue;
                if (r.asisColumn == null) continue;
                boolean matched = false;
                for (String c : r.asisColumn) {
                    if (col.equalsIgnoreCase(c)) { matched = true; break; }
                }
                if (matched) {
                    tableToAlias.putIfAbsent(r.asisTable, alias);
                    break;
                }
            }
        }
        return tableToAlias;
    }

    private static String generateAlias(String tableName, Set<String> taken) {
        if (tableName == null || tableName.isEmpty()) return "t";
        String base = String.valueOf(Character.toLowerCase(tableName.charAt(0)));
        if (!taken.contains(base)) return base;
        for (int i = 2; i < 100; i++) {
            String candidate = base + i;
            if (!taken.contains(candidate)) return candidate;
        }
        return "t" + UUID.randomUUID().toString().substring(0, 4);
    }

    /* ──────────────────────────────────────────────
     * Helpers
     * ────────────────────────────────────────────── */

    private static void validateRequired(String filename, List<String> required, Set<String> have) {
        for (String col : required) {
            if (!have.contains(col)) {
                throw new ApiException(
                        "MAPPING_MISSING_COLUMN",
                        filename + " 에 필수 컬럼이 없습니다: " + col
                                + " (인식된 헤더: " + String.join(", ", have) + ")",
                        HttpStatus.BAD_REQUEST);
            }
        }
    }

    private static String get(ResultSet rs, Map<String, Integer> headers, String key) throws SQLException {
        Integer idx = headers.get(key);
        return idx == null ? null : rs.getString(idx);
    }

    private static String trimToNull(String s) {
        if (s == null) return null;
        String t = s.trim();
        return t.isEmpty() ? null : t;
    }

    /** 한 셀 문자열을 ';' 로 split, 각 원소 trim 후 빈 원소 제거. */
    private static List<String> splitSemicolon(String s) {
        if (s == null) return List.of();
        List<String> out = new ArrayList<>();
        for (String token : s.split(";")) {
            String t = token.trim();
            if (!t.isEmpty()) out.add(t);
        }
        return out;
    }

    /** 기존 String[] 끝에 List<String> 의 원소들을 이어붙여 새 배열 반환. null/empty 안전. */
    private static String[] appendArray(String[] existing, List<String> toAdd) {
        if (toAdd == null || toAdd.isEmpty()) return existing == null ? new String[0] : existing;
        if (existing == null || existing.length == 0) return toAdd.toArray(new String[0]);
        String[] result = Arrays.copyOf(existing, existing.length + toAdd.size());
        for (int i = 0; i < toAdd.size(); i++) result[existing.length + i] = toAdd.get(i);
        return result;
    }

    private static String nz(String s) {
        return s == null ? "" : s.trim();
    }

    private static int safeInt(String s, int fallback) {
        try { return Integer.parseInt(s.trim()); }
        catch (NumberFormatException e) { return fallback; }
    }

    private static String escape(String s) {
        return s.replace("'", "''");
    }

    /**
     * CSV 헤더에서 BOM·zero-width space·NBSP 등 보이지 않는 문자를 제거하고
     * trim + lowercase. {@link String#trim()} 은 U+0020 이하만 잘라내서 U+FEFF
     * 같은 invisible char 가 남으면 contains() 매칭이 실패하기 때문에 명시 제거.
     */
    private static String cleanHeader(String s) {
        if (s == null) return "";
        // ﻿=BOM, ​/C/D=zero-width space/joiner, ⁠=word joiner,  =NBSP
        String stripped = s.replaceAll("[\\uFEFF\\u200B\\u200C\\u200D\\u2060\\u00A0]", "");
        return stripped.trim().toLowerCase();
    }

    private static String toHex(String s) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            sb.append(String.format("U+%04X ", (int) s.charAt(i)));
        }
        return sb.toString().trim();
    }

    private static String sha256(byte[] data) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(md.digest(data));
        } catch (NoSuchAlgorithmException e) {
            throw new RuntimeException(e);
        }
    }

    private static Path writeTemp(byte[] data, String prefix) throws IOException {
        Path tmp = Files.createTempFile("mpd_" + prefix + "_", ".csv");
        Files.write(tmp, data);
        return tmp;
    }

    private static void deleteQuiet(Path p) {
        if (p == null) return;
        try { Files.deleteIfExists(p); }
        catch (IOException e) { log.debug("temp delete failed: {}", p, e); }
    }

    /* ──────────────────────────────────────────────
     * Parsed-row DTOs (서비스 내부)
     * ────────────────────────────────────────────── */

    private record ParsedRules(List<RuleRow> rules) {}
    private record ParsedCodes(List<CodeRow> codes) {}

    private static class RuleRow {
        String tobeSchema = "";
        String tobeTable;
        String tobeColumn;
        String asisSchema;
        String asisTable;
        String[] asisColumn;   // PG text[] 매핑. combine 이면 여러 원소.
        String strategy = "expression";
        String transformRule;
        String transformSql;
        String defaultValue;
        String notes;
        String[] asisType;     // asisColumn 과 동일 길이 기대.
        String tobeType;
        String codeDomain;
    }

    private static class CodeRow {
        String domain;
        String sourceValue;
        String targetValue;
        String description;
        int ordinal;
    }
}
