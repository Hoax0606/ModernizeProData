package com.ksinfo.modernize_pro_data.coordinator.api;

import com.ksinfo.modernize_pro_data.common.dto.ApiResponse;
import com.ksinfo.modernize_pro_data.common.duckdb.DuckDbService;
import com.ksinfo.modernize_pro_data.common.exception.ApiException;
import com.ksinfo.modernize_pro_data.coordinator.site.Site;
import com.ksinfo.modernize_pro_data.coordinator.site.SiteRepository;
import com.ksinfo.modernize_pro_data.common.util.CsvEncoding;
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

    /**
     * csv-row-count caching — 10M+ CSV 의 full line scan (~10-15s) 이 매 호출
     * 발생하면 HikariCP connection + thread 를 오래 점유해 다중 사용자 시 pool
     * exhaust 의 주범. file mtime+size 가 동일하면 캐시값 반환 — CSV 가 야간
     * 추출로 바뀌면 mtime 달라져 자동 invalidate. key = 절대경로.
     */
    private record RowCountCacheEntry(long mtime, long size, long rowCount) {}
    private static final java.util.Map<String, RowCountCacheEntry> ROW_COUNT_CACHE =
            new java.util.concurrent.ConcurrentHashMap<>();
    /**
     * 같은 파일에 대한 동시 full-scan stampede 방지 — Mapping 화면이 전 AS-IS 테이블의
     * row-count 를 한꺼번에 호출하면 cache miss 상태에서 동일 파일을 N 번 scan 해 worker
     * thread 를 고갈시킨다. 첫 요청만 실제 scan, 나머지는 같은 future 를 기다린다.
     */
    private static final java.util.Map<String, java.util.concurrent.CompletableFuture<Long>> ROW_COUNT_INFLIGHT =
            new java.util.concurrent.ConcurrentHashMap<>();

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

        CsvPreview preview = readWithDuckDb(csvFile, tableName, effectiveLimit, site.getAsisEncoding());
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
        // mtime+size 캐시 공유 line count (header 제외). 1.4GB 도 byte-stream 으로 ~10-15초.
        return ApiResponse.ok(new CsvRowCount(tableName, countDataRowsCached(csvFile)));
    }

    /** Site Overview 'Rows' KPI 용 — csvPath 내 모든 CSV 의 data row 수 합 (AS-IS 기준). */
    public record SiteCsvRowTotal(long totalRows, int fileCount) {}

    @GetMapping("/{siteId}/csv-row-count")
    public ApiResponse<SiteCsvRowTotal> rowCountTotal(@PathVariable String siteId) {
        Site site = siteRepository.findById(siteId)
                .orElseThrow(() -> new ApiException(
                        "SITE_NOT_FOUND", "사이트를 찾을 수 없습니다", HttpStatus.NOT_FOUND));
        String csvPath = site.getCsvPath();
        if (csvPath == null || csvPath.isBlank()) {
            // CSV 경로 미설정 site 는 0 으로 — Site Overview 가 에러 없이 표시되도록.
            return ApiResponse.ok(new SiteCsvRowTotal(0, 0));
        }
        Path baseDir;
        try {
            baseDir = Paths.get(csvPath).toAbsolutePath().normalize();
        } catch (Exception e) {
            return ApiResponse.ok(new SiteCsvRowTotal(0, 0));
        }
        if (!Files.isDirectory(baseDir)) {
            return ApiResponse.ok(new SiteCsvRowTotal(0, 0));
        }
        long total = 0;
        int files = 0;
        try (Stream<Path> stream = Files.list(baseDir)) {
            List<Path> csvFiles = stream
                    .filter(Files::isRegularFile)
                    .filter(p -> p.getFileName().toString().toLowerCase().endsWith(".csv"))
                    .toList();
            for (Path f : csvFiles) {
                total += countDataRowsCached(f);
                files++;
            }
        } catch (IOException e) {
            throw new ApiException("CSV_READ_FAILED", "CSV 목록 조회 실패: " + e.getMessage(),
                    HttpStatus.INTERNAL_SERVER_ERROR);
        }
        return ApiResponse.ok(new SiteCsvRowTotal(total, files));
    }

    /** per-table rowCount endpoint 와 동일한 mtime+size 캐시를 공유하는 line count. */
    private long countDataRowsCached(Path csvFile) {
        String cacheKey = csvFile.toString();
        long fMtime, fSize;
        try {
            fMtime = Files.getLastModifiedTime(csvFile).toMillis();
            fSize  = Files.size(csvFile);
        } catch (IOException e) {
            return 0;
        }
        if (isFresh(ROW_COUNT_CACHE.get(cacheKey), fMtime, fSize)) {
            return ROW_COUNT_CACHE.get(cacheKey).rowCount();
        }
        // cache miss → 동일 파일 동시 scan 은 하나로 합친다 (stampede 방지).
        java.util.concurrent.CompletableFuture<Long> mine = new java.util.concurrent.CompletableFuture<>();
        java.util.concurrent.CompletableFuture<Long> running = ROW_COUNT_INFLIGHT.putIfAbsent(cacheKey, mine);
        if (running != null) {
            try {
                return running.get();
            } catch (Exception e) {
                return 0;
            }
        }
        try {
            // 소유권 획득 후 재확인 — 직전에 다른 스레드가 막 채웠을 수 있음.
            if (isFresh(ROW_COUNT_CACHE.get(cacheKey), fMtime, fSize)) {
                long v = ROW_COUNT_CACHE.get(cacheKey).rowCount();
                mine.complete(v);
                return v;
            }
            long v = scanDataRows(csvFile, fMtime, fSize, cacheKey);
            mine.complete(v);
            return v;
        } catch (Throwable t) {
            mine.complete(0L);
            return 0;
        } finally {
            ROW_COUNT_INFLIGHT.remove(cacheKey, mine);
        }
    }

    private static boolean isFresh(RowCountCacheEntry e, long mtime, long size) {
        return e != null && e.mtime() == mtime && e.size() == size;
    }

    /** 실제 byte-stream line count + 캐시 적재. */
    private long scanDataRows(Path csvFile, long fMtime, long fSize, String cacheKey) {
        long lines = 0;
        try (Stream<String> stream = Files.lines(csvFile, java.nio.charset.StandardCharsets.UTF_8)) {
            lines = stream.count();
        } catch (IOException | java.io.UncheckedIOException e) {
            try (java.io.InputStream is = Files.newInputStream(csvFile);
                 java.io.BufferedInputStream bis = new java.io.BufferedInputStream(is, 1 << 20)) {
                byte[] buf = new byte[1 << 16];
                int n;
                while ((n = bis.read(buf)) > 0) {
                    for (int i = 0; i < n; i++) if (buf[i] == '\n') lines++;
                }
            } catch (IOException ex) {
                log.warn("CSV row count failed: {}", csvFile, ex);
                return 0;
            }
        }
        long rowCount = Math.max(0, lines - 1);
        ROW_COUNT_CACHE.put(cacheKey, new RowCountCacheEntry(fMtime, fSize, rowCount));
        return rowCount;
    }

    /**
     * Resolve a CSV under {baseDir}. {tableName} 은 schema 한정(HR_PAYROLL.EMPLOYEES)
     * 또는 bare(employees) 둘 다 허용. 다음 순서로 시도 (모두 case-insensitive):
     *   1) {tableName}.csv               (예: HR_PAYROLL.EMPLOYEES.csv)
     *   2) {첫 점 이후 부분}.csv          (예: EMPLOYEES.csv → customers.csv)
     *   3) bare 이름일 때 {schema}.{tableName}.csv (유일할 때만)
     *      — DDL 이 스키마 없이(CONTACT_INFO) import 됐는데 추출 파일은 스키마 포함
     *        (BANKSYS.CONTACT_INFO.csv)인 경우. run 은 binding 의 schema 로 이미 찾지만
     *        preview/Trial 게이트는 bare DDL 이름으로 조회하므로 여기서 보강한다.
     *        여러 스키마에 같은 table 명이 있으면(EMPLOYEES 등) 모호 → 매칭 안 함.
     * stages/preflight 의 StageHelpers.resolveCsvFile 와 동일 규칙 — preview 와 run 이
     * 같은 파일을 찾도록 일치시킨다. 없으면 null.
     */
    private Path resolveCsvFile(Path baseDir, String tableName) {
        Path direct = tryResolve(baseDir, tableName);
        if (direct != null) return direct;
        int dot = tableName.indexOf('.');
        if (dot > 0 && dot < tableName.length() - 1) {
            Path afterDot = tryResolve(baseDir, tableName.substring(dot + 1));
            if (afterDot != null) return afterDot;
        } else if (dot < 0) {
            return tryResolveSchemaPrefixed(baseDir, tableName);
        }
        return null;
    }

    /** bare 테이블명 {name} → {anySchema}.{name}.csv 파일. 정확히 하나일 때만 반환, 아니면 null. */
    private Path tryResolveSchemaPrefixed(Path baseDir, String name) {
        String suffix = ("." + name + ".csv").toLowerCase();
        try (Stream<Path> stream = Files.list(baseDir)) {
            List<Path> matches = stream
                    .filter(Files::isRegularFile)
                    .filter(p -> p.getFileName().toString().toLowerCase().endsWith(suffix))
                    .limit(2)
                    .toList();
            return matches.size() == 1 ? matches.get(0) : null;
        } catch (IOException e) {
            log.warn("Directory listing failed: {}", baseDir, e);
            return null;
        }
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
    private CsvPreview readWithDuckDb(Path csvFile, String tableName, int limit, String asisEncoding) {
        // csvFile is already validated to live under the site's csvPath; only the
        // single-quote needs escaping for the SQL string literal.
        String escapedPath = csvFile.toString().replace("'", "''");
        // sample_size=1024 — schema detection 용. limit 가 작아 전체 scan 안 함.
        // 옛 -1 은 1GB+ file 에서 schema detect 시간/메모리 폭주 (preflight csv-arrived 호출이
        // 그것 못 견뎌 csv 미도착으로 잘못 판정). all_varchar=true 라 type 추론 무관 — 작은 sample 충분.
        // encoding= : site.asisEncoding 적용 (Shift-JIS 등). 누락 시 UTF-8 로 읽혀 비 UTF-8 CSV 의
        // 헤더가 깨지거나 read 가 실패 → Mapping 소스 컬럼 드롭다운/자동매핑이 빈다.
        String sql = "SELECT * FROM read_csv_auto('" + escapedPath
                + "', header=true, sample_size=1024, all_varchar=true"
                + CsvEncoding.clause(asisEncoding) + ") LIMIT " + (limit + 1);

        List<String> headers = new ArrayList<>();
        List<List<String>> rows = new ArrayList<>();
        boolean truncated = false;

        // 요청별 격리 connection — 공유 connection 동시 사용 시 pending result 무효화 회피.
        try (java.sql.Connection conn = duckDbService.requestConnection();
             Statement st = conn.createStatement();
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
