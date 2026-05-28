package com.ksinfo.modernize_pro_data.coordinator.license;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;

/**
 * Backend 기동 시:
 * <ol>
 *   <li>DB 에 활성 라이선스가 없으면, installer (Launcher.exe) 가 둔
 *       bootstrap .lic 파일 ({@link #bootstrapPath()}) 을 시도해서 자동 import.</li>
 *   <li>DB 의 활성 라이선스를 LicenseService 캐시로 로드 (이미 있었으면 그대로,
 *       방금 import 했으면 새로 들어간 row).</li>
 * </ol>
 *
 * <p>Bootstrap 파일은 import 성공 시 {@code license.lic.imported} 로 rename 해서
 * 다음 부팅에 또 자동 import 되는 일을 막는다. Settings 에서 master 가 새 .lic
 * 을 update 하면 그 흐름은 그대로 동작 (LicenseService.upload).
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class LicenseStartupLoader {

    private final LicenseService licenseService;

    @EventListener(ApplicationReadyEvent.class)
    public void onReady() {
        try {
            tryBootstrapImport();
        } catch (Exception e) {
            log.warn("Bootstrap license import threw — falling back to DB-only load: {}", e.getMessage());
        }
        licenseService.refreshFromDb();
    }

    private void tryBootstrapImport() {
        // Already have a license in the DB — never overwrite with a stale
        // bootstrap file. (Master can still upload via Settings.)
        licenseService.refreshFromDb();
        if (licenseService.getActive() != null) return;

        Path bootstrap = bootstrapPath();
        if (bootstrap == null || !Files.exists(bootstrap)) return;

        try {
            byte[] bytes = Files.readAllBytes(bootstrap);
            licenseService.upload(bytes, "installer");
            log.info("License imported from bootstrap file: {}", bootstrap);
            try {
                Path imported = bootstrap.resolveSibling("license.lic.imported");
                Files.move(bootstrap, imported, StandardCopyOption.REPLACE_EXISTING);
                setHidden(imported);
            } catch (Exception e) {
                log.warn("Could not rename bootstrap file after import: {}", e.getMessage());
            }
        } catch (Exception e) {
            log.warn("Bootstrap license import failed ({}): {}", bootstrap, e.getMessage());
        }
    }

    /** Hidden config dir under the install location so a user browsing
     *  {@code %LOCALAPPDATA%\ModernizeProData\} does not stumble on the .lic.
     *  Launcher.exe writes to the exact same path; both sides must agree. */
    private Path bootstrapPath() {
        String localAppData = System.getenv("LOCALAPPDATA");
        if (localAppData != null && !localAppData.isBlank()) {
            return Paths.get(localAppData, "ModernizeProData", ".config", "license.lic");
        }
        String home = System.getProperty("user.home");
        if (home != null) return Paths.get(home, ".modernize", "license.lic");
        return null;
    }

    private static void setHidden(Path path) {
        try {
            Files.setAttribute(path, "dos:hidden", Boolean.TRUE);
        } catch (Exception ignored) {
            // Not on Windows or filesystem doesn't support DOS attrs — fine.
        }
    }
}
