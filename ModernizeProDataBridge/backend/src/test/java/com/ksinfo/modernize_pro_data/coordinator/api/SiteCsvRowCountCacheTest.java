package com.ksinfo.modernize_pro_data.coordinator.api;

import com.ksinfo.modernize_pro_data.common.dto.ApiResponse;
import com.ksinfo.modernize_pro_data.coordinator.site.Site;
import com.ksinfo.modernize_pro_data.coordinator.site.SiteRepository;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.mockito.Mockito;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * csv-row-count 캐시의 invalidation 검증.
 *
 * 캐시 key = 파일 절대경로, invalidate 기준 = mtime + size. 폐쇄망 USB 전송이 mtime 을
 * 보존할 수 있어 mtime 단독으론 stale 위험 — size 조합으로 catch 하는지 확인.
 */
class SiteCsvRowCountCacheTest {

    private SiteCsvPreviewController newController(String csvPath) {
        SiteRepository siteRepo = Mockito.mock(SiteRepository.class);
        Site site = new Site();
        site.setId("st-test");
        site.setCsvPath(csvPath);
        Mockito.when(siteRepo.findById("st-test")).thenReturn(Optional.of(site));
        // DuckDbService 는 row-count 경로에서 사용 안 함 (Files.lines) — mock 으로 충분.
        // SourceReaderRegistry 도 row-count 경로에선 미사용 — UTF-8 passthrough 하나면 충분.
        var registry = new com.ksinfo.modernize_pro_data.coordinator.worker.source.SourceReaderRegistry(
                java.util.List.of(new com.ksinfo.modernize_pro_data.coordinator.worker.source.Utf8PassthroughSourceReader()));
        return new SiteCsvPreviewController(siteRepo,
                Mockito.mock(com.ksinfo.modernize_pro_data.common.duckdb.DuckDbService.class), registry);
    }

    private long rowCount(SiteCsvPreviewController c, String table) {
        ApiResponse<SiteCsvPreviewController.CsvRowCount> r = c.rowCount("st-test", table);
        return r.data().rowCount();
    }

    @Test
    void cacheInvalidatesWhenFileSizeChanges(@TempDir Path dir) throws Exception {
        // 테이블 이름은 캐시 key (절대경로) 가 test 간 충돌하지 않게 unique 하게.
        String table = "ROWCOUNT_SIZE_" + System.nanoTime();
        Path csv = dir.resolve(table + ".csv");
        Files.writeString(csv, "id,name\n1,a\n2,b\n3,c\n");  // header + 3 rows

        SiteCsvPreviewController c = newController(dir.toString());
        assertThat(rowCount(c, table)).isEqualTo(3);

        // 행 추가 → size 변경. mtime 까지 옛 값으로 강제 복원해 "mtime 동일 / 내용 다름"
        // (USB 전송 mtime 보존) 시나리오 재현 — size 로 invalidate 돼야 한다.
        FileTime origMtime = Files.getLastModifiedTime(csv);
        Files.writeString(csv, "id,name\n1,a\n2,b\n3,c\n4,d\n");  // 4 rows
        Files.setLastModifiedTime(csv, origMtime);

        assertThat(rowCount(c, table)).isEqualTo(4);  // stale 3 아닌 재계산 4
    }

    @Test
    void cacheHitReturnsSameValueWhenUnchanged(@TempDir Path dir) throws Exception {
        String table = "ROWCOUNT_HIT_" + System.nanoTime();
        Path csv = dir.resolve(table + ".csv");
        Files.writeString(csv, "id\n1\n2\n");  // header + 2 rows

        SiteCsvPreviewController c = newController(dir.toString());
        assertThat(rowCount(c, table)).isEqualTo(2);
        // 변경 없음 → 같은 값 (cache hit 경로). 결과 동일성만 검증.
        assertThat(rowCount(c, table)).isEqualTo(2);
    }
}
