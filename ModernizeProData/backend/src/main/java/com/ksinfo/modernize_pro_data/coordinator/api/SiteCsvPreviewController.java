package com.ksinfo.modernize_pro_data.coordinator.api;

import com.ksinfo.modernize_pro_data.common.dto.ApiResponse;
import com.ksinfo.modernize_pro_data.common.duckdb.DuckDbService;
import com.ksinfo.modernize_pro_data.common.exception.ApiException;
import com.ksinfo.modernize_pro_data.coordinator.site.Site;
import com.ksinfo.modernize_pro_data.coordinator.site.SiteRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * AS-IS CSV preview endpoint.
 * Reads {csvPath}/{tableName}.csv from the site directory via DuckDB
 * (read_csv_auto) and returns up to {limit} parsed rows. Used by the
 * Mapping Report viewer to show real source data instead of placeholders.
 *
 *   GET /api/v1/sites/{siteId}/csv-preview/{tableName}?limit=50
 */
@Slf4j
@RestController
@RequestMapping("/api/v1/sites")
@RequiredArgsConstructor
public class SiteCsvPreviewController {

    private static final Pattern SAFE_TABLE_NAME = Pattern.compile("[A-Za-z0-9_.\\-]+");
    private static final int DEFAULT_LIMIT = 50;
    private static final int MAX_LIMIT = 1000;

    private final SiteRepository siteRepository;
    private final DuckDbService duckDbService;

    public record CsvPreview(
            String table,
            String resolvedPath,
            List<String> headers,
            List<List<String>> rows,
            int rowCount,
            boolean truncated
    ) {}

    @GetMapping("/{siteId}/csv-preview/{tableName}")
    public ApiResponse<CsvPreview> preview(
            @PathVariable String siteId,
            @PathVariable String tableName,
            @RequestParam(name = "limit", required = false) Integer limit
    ) {
        Site site = siteRepository.findById(siteId)
                .orElseThrow(() -> new ApiException(
                        "SITE_NOT_FOUND", "사이트를 찾을 수 없습니다", HttpStatus.NOT_FOUND));

        String csvPath = site.getCsvPath();
        if (csvPath == null || csvPath.isBlank()) {
            throw new ApiException(
                    "CSV_PATH_NOT_SET",
                    "사이트에 CSV 경로가 설정되지 않았습니다",
                    HttpStatus.BAD_REQUEST);
        }

        if (!SAFE_TABLE_NAME.matcher(tableName).matches()) {
            throw new ApiException(
                    "INVALID_TABLE_NAME",
                    "허용되지 않은 테이블 이름입니다: " + tableName,
                    HttpStatus.BAD_REQUEST);
        }

        Path baseDir;
        try {
            baseDir = Paths.get(csvPath).toAbsolutePath().normalize();
        } catch (Exception e) {
            throw new ApiException(
                    "CSV_PATH_INVALID",
                    "CSV 경로 형식이 잘못되었습니다: " + csvPath,
                    HttpStatus.BAD_REQUEST);
        }
        if (!Files.isDirectory(baseDir)) {
            throw new ApiException(
                    "CSV_PATH_NOT_DIRECTORY",
                    "CSV 경로가 디렉터리가 아닙니다: " + baseDir,
                    HttpStatus.BAD_REQUEST);
        }

        Path csvFile = resolveCsvFile(baseDir, tableName);
        if (csvFile == null) {
            throw new ApiException(
                    "CSV_FILE_NOT_FOUND",
                    "CSV 파일을 찾을 수 없습니다: " + tableName + ".csv",
                    HttpStatus.NOT_FOUND);
        }

        int effectiveLimit = limit == null ? DEFAULT_LIMIT : Math.min(Math.max(limit, 1), MAX_LIMIT);

        CsvPreview preview = readWithDuckDb(csvFile, tableName, effectiveLimit);
        return ApiResponse.ok(preview);
    }

    /** AS-IS csv 의 data row 수 (header 제외) — Mapping page 좌측 tree 표시용. */
    public record CsvRowCount(String table, long rowCount) {}

    @GetMapping("/{siteId}/csv-row-count/{tableName}")
    public ApiResponse<CsvRowCount> rowCount(
            @PathVariable String siteId,
            @PathVariable String tableName
    ) {
        Site site = siteRepository.findById(siteId)
                .orElseThrow(() -> new ApiException(
                        "SITE_NOT_FOUND", "사이트를 찾을 수 없습니다", HttpStatus.NOT_FOUND));
        String csvPath = site.getCsvPath();
        if (csvPath == null || csvPath.isBlank()) {
            throw new ApiException("CSV_PATH_NOT_SET", "사이트에 CSV 경로가 설정되지 않았습니다", HttpStatus.BAD_REQUEST);
        }
        if (!SAFE_TABLE_NAME.matcher(tableName).matches()) {
            throw new ApiException("INVALID_TABLE_NAME", "허용되지 않은 테이블 이름: " + tableName, HttpStatus.BAD_REQUEST);
        }
        Path baseDir;
        try {
            baseDir = Paths.get(csvPath).toAbsolutePath().normalize();
        } catch (Exception e) {
            throw new ApiException("CSV_PATH_INVALID", "CSV 경로 형식이 잘못됨: " + csvPath, HttpStatus.BAD_REQUEST);
        }
        if (!Files.isDirectory(baseDir)) {
            throw new ApiException("CSV_PATH_NOT_DIRECTORY", "CSV 경로가 디렉터리가 아님: " + baseDir, HttpStatus.BAD_REQUEST);
        }
        Path csvFile = resolveCsvFile(baseDir, tableName);
        if (csvFile == null) {
            throw new ApiException("CSV_FILE_NOT_FOUND", "CSV 파일을 찾을 수 없음: " + tableName + ".csv", HttpStatus.NOT_FOUND);
        }
        // raw line count (header 제외). 1.4GB 도 byte-stream 으로 ~10-15초.
        long lines = 0;
        try (Stream<String> stream = Files.lines(csvFile, java.nio.charset.StandardCharsets.UTF_8)) {
            lines = stream.count();
        } catch (IOException | java.io.UncheckedIOException e) {
            // UTF-8 디코딩 실패 시 byte 단위 newline count fallback (인코딩 무관).
            try (java.io.InputStream is = Files.newInputStream(csvFile);
                 java.io.BufferedInputStream bis = new java.io.BufferedInputStream(is, 1 << 20)) {
                byte[] buf = new byte[1 << 16];
                int n;
                while ((n = bis.read(buf)) > 0) {
                    for (int i = 0; i < n; i++) if (buf[i] == '\n') lines++;
                }
            } catch (IOException ex) {
                throw new ApiException("CSV_READ_FAILED", "CSV row count 실패: " + ex.getMessage(), HttpStatus.INTERNAL_SERVER_ERROR);
            }
        }
        long rowCount = Math.max(0, lines - 1);  // header 제외
        return ApiResponse.ok(new CsvRowCount(tableName, rowCount));
    }

    /**
     * Resolve a CSV under {baseDir}. {tableName} 은 schema 한정(HR_PAYROLL.EMPLOYEES)
     * 또는 bare(employees) 둘 다 허용. 다음 순서로 시도 (둘 다 case-insensitive):
     *   1) {tableName}.csv               (예: HR_PAYROLL.EMPLOYEES.csv)
     *   2) {첫 점 이후 부분}.csv          (예: EMPLOYEES.csv → customers.csv)
     * stages/preflight 의 StageHelpers.resolveCsvFile 와 동일 규칙 — preview 와 run 이
     * 같은 파일을 찾도록 일치시킨다. 없으면 null.
     */
    private Path resolveCsvFile(Path baseDir, String tableName) {
        Path direct = tryResolve(baseDir, tableName);
        if (direct != null) return direct;
        int dot = tableName.indexOf('.');
        if (dot > 0 && dot < tableName.length() - 1) {
            return tryResolve(baseDir, tableName.substring(dot + 1));
        }
        return null;
    }

    /** Exact then case-insensitive match for {name}.csv under {baseDir}. */
    private Path tryResolve(Path baseDir, String name) {
        Path exact = baseDir.resolve(name + ".csv").normalize();
        if (!exact.startsWith(baseDir)) {
            throw new ApiException(
                    "PATH_TRAVERSAL_DENIED",
                    "허용되지 않은 경로 접근",
                    HttpStatus.BAD_REQUEST);
        }
        if (Files.isRegularFile(exact)) return exact;

        String want = (name + ".csv").toLowerCase();
        try (Stream<Path> stream = Files.list(baseDir)) {
            return stream
                    .filter(Files::isRegularFile)
                    .filter(p -> p.getFileName().toString().toLowerCase().equals(want))
                    .findFirst()
                    .orElse(null);
        } catch (IOException e) {
            log.warn("Directory listing failed: {}", baseDir, e);
            return null;
        }
    }

    /**
     * Read up to {limit} rows via DuckDB. {limit+1} rows are queried so we can
     * flag truncation. CSV dialect (delimiter / quote / encoding) is auto-detected.
     */
    private CsvPreview readWithDuckDb(Path csvFile, String tableName, int limit) {
        // csvFile is already validated to live under the site's csvPath; only the
        // single-quote needs escaping for the SQL string literal.
        String escapedPath = csvFile.toString().replace("'", "''");
        // sample_size=1024 — schema detection 용. limit 가 작아 전체 scan 안 함.
        // 옛 -1 은 1GB+ file 에서 schema detect 시간/메모리 폭주 (preflight csv-arrived 호출이
        // 그것 못 견뎌 csv 미도착으로 잘못 판정). all_varchar=true 라 type 추론 무관 — 작은 sample 충분.
        String sql = "SELECT * FROM read_csv_auto('" + escapedPath
                + "', header=true, sample_size=1024, all_varchar=true) LIMIT " + (limit + 1);

        List<String> headers = new ArrayList<>();
        List<List<String>> rows = new ArrayList<>();
        boolean truncated = false;

        try (Statement st = duckDbService.statement();
             ResultSet rs = st.executeQuery(sql)) {
            ResultSetMetaData md = rs.getMetaData();
            int colCount = md.getColumnCount();
            for (int i = 1; i <= colCount; i++) {
                headers.add(md.getColumnLabel(i));
            }
            int count = 0;
            while (rs.next()) {
                if (count >= limit) {
                    truncated = true;
                    break;
                }
                List<String> row = new ArrayList<>(colCount);
                for (int i = 1; i <= colCount; i++) {
                    String v = rs.getString(i);
                    row.add(v != null ? v : "");
                }
                rows.add(row);
                count++;
            }
        } catch (SQLException e) {
            log.warn("DuckDB CSV read failed: {}", csvFile, e);
            throw new ApiException(
                    "CSV_READ_FAILED",
                    "CSV 읽기 실패 (DuckDB): " + e.getMessage(),
                    HttpStatus.INTERNAL_SERVER_ERROR);
        }

        return new CsvPreview(tableName, csvFile.toString(), headers, rows, rows.size(), truncated);
    }
}
