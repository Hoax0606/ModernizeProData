package com.ksinfo.modernize_pro_data.coordinator.api;

import com.ksinfo.modernize_pro_data.coordinator.site.Site;
import com.ksinfo.modernize_pro_data.coordinator.site.SiteRepository;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.nio.charset.Charset;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Mapping 미리보기 / pre-flight(csv-arrived) 경로의 SJIS 지원 (SourceReader SPI 재사용).
 * site.asisEncoding=Shift_JIS 인 Shift-JIS CSV 를 미리보기하면 SPI 가 UTF-8 로 변환해
 * 헤더/행을 정상 반환해야 한다 (이전엔 SJIS 를 UTF-8 로 읽으려다 실패 → "미도착"/빈 컬럼).
 */
@SpringBootTest
@Testcontainers
class SjisPreviewIT {

    @Container
    static PostgreSQLContainer<?> pg = new PostgreSQLContainer<>("postgres:18-alpine");

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", pg::getJdbcUrl);
        r.add("spring.datasource.username", pg::getUsername);
        r.add("spring.datasource.password", pg::getPassword);
        r.add("spring.datasource.driver-class-name", () -> "org.postgresql.Driver");
        r.add("spring.flyway.enabled", () -> "true");
        r.add("spring.jpa.hibernate.ddl-auto", () -> "validate");
    }

    @Autowired SiteCsvPreviewController controller;
    @Autowired SiteRepository siteRepo;

    @Test
    void shiftJisCsv_previewedAsUtf8(@TempDir Path csvDir) throws Exception {
        // Shift-JIS(MS932) 로 인코딩된 CSV
        String csv = "ACCOUNT_ID,OWNER\n1,あ\n2,髙\n";
        Files.write(csvDir.resolve("ACCOUNTS.csv"), csv.getBytes(Charset.forName("windows-31j")));

        Site site = Site.create("sjis-preview", "prod", "dev", "Shift_JIS", "UTF-8",
                csvDir.toString(), null, "dev", Map.of(), Map.of(), "test");
        siteRepo.save(site);

        var resp = controller.preview(site.getId(), "ACCOUNTS", 100);
        SiteCsvPreviewController.CsvPreview p = resp.data();

        assertThat(p.headers()).containsExactly("ACCOUNT_ID", "OWNER");
        assertThat(p.rows()).hasSize(2);
        assertThat(p.rows().get(0)).containsExactly("1", "あ");   // SJIS → UTF-8 정상 디코드
        assertThat(p.rows().get(1)).containsExactly("2", "髙");   // 벤더문자 보존
    }
}
