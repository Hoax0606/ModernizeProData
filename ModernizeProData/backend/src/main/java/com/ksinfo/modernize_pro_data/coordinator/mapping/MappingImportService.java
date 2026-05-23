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
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

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
            if (hasColumn) {
                ruleRepo.deleteAllByProjectId(projectId);
                ruleRepo.flush();
                List<MappingRule> ruleEntities = new ArrayList<>(parsed.rules.size());
                for (RuleRow row : parsed.rules) {
                    ruleEntities.add(toRuleEntity(row, projectId, mi.getId(), userName, now));
                }
                ruleRepo.saveAll(ruleEntities);
            }
            if (hasCode) {
                codeRepo.deleteAllByProjectId(projectId);
                codeRepo.flush();
                List<MappingCodeMap> codeEntities = new ArrayList<>(codes.codes.size());
                for (CodeRow row : codes.codes) {
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

    private ParsedRules parseColumnCsv(Path csv) {
        Map<String, Integer> headers = new HashMap<>();
        List<RuleRow> out = new ArrayList<>();
        Set<String> seen = new HashSet<>();

        // read_csv (not _auto) 으로 delimiter / quote / escape 모두 명시.
        // _auto 의 dialect 추론이 작은 파일에서 실패하는 케이스 회피.
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

            while (rs.next()) {
                RuleRow row = new RuleRow();
                // tobe_table 은 'SCHEMA.TABLE' 형태도 허용 — '.' 으로 split
                String tobeTableRaw = trimToNull(get(rs, headers, "tobe_table"));
                row.tobeColumn  = trimToNull(get(rs, headers, "tobe_column"));
                if (tobeTableRaw == null || row.tobeColumn == null) {
                    continue; // skip incomplete row
                }
                int dot = tobeTableRaw.indexOf('.');
                if (dot > 0) {
                    row.tobeSchema = tobeTableRaw.substring(0, dot);
                    row.tobeTable  = tobeTableRaw.substring(dot + 1);
                } else {
                    row.tobeSchema = "";
                    row.tobeTable  = tobeTableRaw;
                }
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
                row.asisColumn  = trimToNull(get(rs, headers, "asis_column"));

                String rule    = trimToNull(get(rs, headers, "rule_sql"));
                String strat   = trimToNull(get(rs, headers, "strategy"));
                String defVal  = trimToNull(get(rs, headers, "default_value"));
                row.notes      = trimToNull(get(rs, headers, "notes"));

                applyStrategy(row, strat, rule, defVal);

                String dedupKey = row.tobeSchema + "|" + row.tobeTable + "|" + row.tobeColumn;
                if (!seen.add(dedupKey)) {
                    log.warn("Duplicate mapping target {} — keeping first occurrence", dedupKey);
                    continue;
                }
                out.add(row);
            }
        } catch (SQLException e) {
            throw new ApiException(
                    "MAPPING_PARSE_FAILED",
                    "column_mapping.csv 파싱 실패: " + e.getMessage(),
                    HttpStatus.BAD_REQUEST);
        }
        return new ParsedRules(out);
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
        // 1) strategy 컬럼이 명시되어 있으면 그대로 사용
        if (stratColumn != null) {
            String s = stratColumn.toLowerCase();
            if (Arrays.asList("expression", "null", "default", "skip").contains(s)) {
                row.strategy = s;
                row.transformRule = "expression".equals(s) ? rule : null;
                row.defaultValue = "default".equals(s) ? defVal : null;
                return;
            }
        }
        // 2) transform_rule 셀의 상수 마커로 추론
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
        // 3) 기본
        row.strategy = "expression";
        row.transformRule = rule; // null 이어도 OK (pass-through)
        row.defaultValue = defVal;
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
        e.setStrategy(row.strategy);
        e.setTransformRule(row.transformRule);
        e.setDefaultValue(row.defaultValue);
        e.setNotNullOverride(false);
        e.setRuleOrigin("imported");
        e.setNotes(row.notes);
        e.setCreatedBy(userName);
        e.setCreatedAt(now);
        return e;
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
        String asisColumn;
        String strategy = "expression";
        String transformRule;
        String defaultValue;
        String notes;
    }

    private static class CodeRow {
        String domain;
        String sourceValue;
        String targetValue;
        String description;
        int ordinal;
    }
}
