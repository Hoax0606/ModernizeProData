package com.ksinfo.modernize_pro_data.coordinator.license;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

/** Backend 기동 시 DB 에서 활성 라이선스 로드 → LicenseService 캐시 채움. */
@Slf4j
@Component
@RequiredArgsConstructor
public class LicenseStartupLoader {

    private final LicenseService licenseService;

    @EventListener(ApplicationReadyEvent.class)
    public void onReady() {
        licenseService.refreshFromDb();
    }
}
