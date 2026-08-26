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
        return newController(csvPath, "utf-8");
    }

    private SiteCsvPreviewController newController(String csvPath, String asisEncoding) {
        SiteRepository siteRepo = Mockito.mock(SiteRepository.class);
        Site site = new Site();
        site.setId("st-test");
        site.setCsvPath(csvPath);
        site.setAsisEncoding(asisEncoding);
        Mockito.when(siteRepo.findById("st-test")).thenReturn(Optional.of(site));
        // DuckDbService 는 row-count 경로에서 사용 안 함 (byte scan) — mock 으로 충분.
        // SourceReaderRegistry 는 개행 바이트 판정에 쓰인다 (EBCDIC 은 0x0A 가 없어 0x15/0x25).
        var registry = new com.ksinfo.modernize_pro_data.coordinator.worker.source.SourceReaderRegistry(
                java.util.List.of(
                        new com.ksinfo.modernize_pro_data.coordinator.worker.source.Utf8PassthroughSourceReader(),
                        new com.ksinfo.modernize_pro_data.coordinator.worker.source.EbcdicSourceReader()));
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

    @Test
    void ebcdicRowCount_countsEbcdicNewlineBytes(@TempDir Path dir) throws Exception {
        // EBCDIC 원본에는 ASCII 0x0A 가 하나도 없다 — '\n' 을 세는 옛 경로는 0 을 반환했다.
        String table = "ROWCOUNT_EBCDIC_" + System.nanoTime();
        Path csv = dir.resolve(table + ".csv");
        String content = "ID,NAME\n1,a\n2,b\n3,c\n";   // header + 3 rows
        byte[] ebcdic = content.getBytes(java.nio.charset.Charset.forName("x-IBM930"));
        Files.write(csv, ebcdic);

        for (byte b : ebcdic) {
            assertThat(b).as("EBCDIC 원본에 ASCII 개행이 없어야 테스트가 의미 있음").isNotEqualTo((byte) '\n');
        }

        SiteCsvPreviewController c = newController(dir.toString(), "ebcdic-ibm930");
        assertThat(rowCount(c, table)).isEqualTo(3);
    }

    @Test
    void cacheKeyIncludesEncoding_sameFileTwoSites(@TempDir Path dir) throws Exception {
        /* 두 사이트가 같은 csvPath 를 공유할 수 있다. 캐시 key 에 인코딩이 없으면
           먼저 조회한 쪽의 값이 다른 쪽에 새어나간다. */
        String table = "ROWCOUNT_KEY_" + System.nanoTime();
        Path csv = dir.resolve(table + ".csv");
        // UTF-8 로 읽으면 3행, EBCDIC(0x15/0x25) 기준으로는 0행인 파일.
        Files.writeString(csv, "id\n1\n2\n3\n");

        assertThat(rowCount(newController(dir.toString(), "utf-8"), table)).isEqualTo(3);
        assertThat(rowCount(newController(dir.toString(), "ebcdic-ibm930"), table)).isEqualTo(0);
        // 다시 UTF-8 → EBCDIC 값이 덮어쓰지 않았는지
        assertThat(rowCount(newController(dir.toString(), "utf-8"), table)).isEqualTo(3);
    }
}
