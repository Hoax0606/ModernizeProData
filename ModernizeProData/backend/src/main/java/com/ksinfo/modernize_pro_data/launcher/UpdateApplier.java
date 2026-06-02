package com.ksinfo.modernize_pro_data.launcher;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.time.OffsetDateTime;
import java.time.format.DateTimeFormatter;
import java.util.stream.Stream;

/**
 * Launcher 가 Spring Boot 부팅 직전에 호출 — staging dir 에 새 binary 가 와 있으면
 * install dir 의 옛 jar / host exe 와 swap. swap 후 backup dir 에 옛 binary 보관
 * (rollback 용).
 *
 * <p>Staging layout (UpdateService.applyLatest 가 만듦):
 * <pre>
 * %LOCALAPPDATA%/ModernizeProData/update-staging/
 *     pending-version.txt   (마커. 내용 = 새 version)
 *     next-1.0.1/
 *         modernize-pro-data-*.jar
 *         ModernizeProDataUI.exe
 *         db_migration/V*.sql   (정보용 — jar 안에도 동봉됨)
 * </pre>
 *
 * <p>Install layout (jpackage 가 만든 dir):
 * <pre>
 * %LOCALAPPDATA%/ModernizeProData/
 *     app/
 *         modernize-pro-data-*.jar
 *         ModernizeProDataUI.exe
 *         ...
 *     runtime/
 *     ModernizeProData.exe
 *     ModernizeProData.cfg
 * </pre>
 *
 * <p>이 클래스는 Spring 의존성 없는 plain Java — SpringApplication.run 호출 전에
 * 사용. 실패는 모두 silent log (System.err) — update 가 못 들어가도 옛 binary 그대로 부팅.
 */
public final class UpdateApplier {

    private UpdateApplier() {}

    /** Launcher 의 main / SwingGuiApp.bootSpring 직전에 1회 호출. 실패는 silent. */
    public static void applyPendingIfAny() {
        try {
            Path installRoot = resolveInstallRoot();
            Path stagingDir = installRoot.resolve("update-staging");
            Path marker = stagingDir.resolve("pending-version.txt");
            if (!Files.exists(marker)) return;

            String version = Files.readString(marker).trim();
            Path nextDir = stagingDir.resolve("next-" + version);
            if (!Files.isDirectory(nextDir)) {
                System.err.println("UpdateApplier: marker present but next-" + version + " missing — clearing marker.");
                Files.deleteIfExists(marker);
                return;
            }

            Path appDir = installRoot.resolve("app");
            if (!Files.isDirectory(appDir)) {
                System.err.println("UpdateApplier: install app/ dir not found at " + appDir + " — skipping swap.");
                return;
            }

            // Backup dir = backup/<timestamp>-<old-version>. version 정보가 없어도 timestamp 충돌 X.
            String stamp = OffsetDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss"));
            Path backupDir = installRoot.resolve("backup").resolve(stamp);
            Files.createDirectories(backupDir);

            // 1. swap *.jar (Spring Boot fat jar)
            swapMatching(appDir, nextDir, backupDir, ".jar");
            // 2. swap host exe
            swapByName(appDir, nextDir, backupDir, "ModernizeProDataUI.exe");
            // db_migration 폴더 = jar 의 BOOT-INF/classes/db/migration 안에도 동봉됨. 별도 swap 안 함.

            // Marker 삭제 + staged next-X dir 정리. backup 은 보존 (수동 rollback 용).
            Files.deleteIfExists(marker);
            deleteRecursiveQuiet(nextDir);

            System.out.println("UpdateApplier: applied update " + version + " (backup at " + backupDir + ")");
        } catch (Throwable t) {
            System.err.println("UpdateApplier: skipped — " + t.getMessage());
        }
    }

    /** appDir 의 첫 *.jar 와 nextDir 의 첫 *.jar 를 swap. backup 으로 옛 jar 이동. */
    private static void swapMatching(Path appDir, Path nextDir, Path backupDir, String ext) throws IOException {
        Path oldJar = firstByExt(appDir, ext);
        Path newJar = firstByExt(nextDir, ext);
        if (newJar == null) return;
        if (oldJar != null) {
            Files.move(oldJar, backupDir.resolve(oldJar.getFileName()), StandardCopyOption.REPLACE_EXISTING);
        }
        // 새 jar 이름은 기존과 다를 수도 — jpackage cfg 가 wildcard 일 가능성. 안전하게 새 이름 그대로.
        Files.move(newJar, appDir.resolve(newJar.getFileName()), StandardCopyOption.REPLACE_EXISTING);
    }

    /** 정확한 파일명으로 swap. */
    private static void swapByName(Path appDir, Path nextDir, Path backupDir, String name) throws IOException {
        Path newFile = nextDir.resolve(name);
        if (!Files.isRegularFile(newFile)) return;
        Path oldFile = appDir.resolve(name);
        if (Files.exists(oldFile)) {
            Files.move(oldFile, backupDir.resolve(name), StandardCopyOption.REPLACE_EXISTING);
        }
        Files.move(newFile, oldFile, StandardCopyOption.REPLACE_EXISTING);
    }

    private static Path firstByExt(Path dir, String ext) throws IOException {
        try (Stream<Path> s = Files.list(dir)) {
            return s.filter(p -> p.getFileName().toString().toLowerCase().endsWith(ext))
                    .findFirst().orElse(null);
        }
    }

    private static Path resolveInstallRoot() {
        String localAppData = System.getenv("LOCALAPPDATA");
        if (localAppData == null || localAppData.isBlank()) {
            localAppData = System.getProperty("user.home");
        }
        return Paths.get(localAppData, "ModernizeProData");
    }

    private static void deleteRecursiveQuiet(Path p) {
        try (Stream<Path> s = Files.walk(p)) {
            s.sorted((a, b) -> b.getNameCount() - a.getNameCount()).forEach(x -> {
                try { Files.deleteIfExists(x); } catch (IOException ignored) {}
            });
        } catch (Exception ignored) {}
    }
}
