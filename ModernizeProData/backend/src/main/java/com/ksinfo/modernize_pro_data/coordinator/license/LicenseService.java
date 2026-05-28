package com.ksinfo.modernize_pro_data.coordinator.license;

import com.ksinfo.modernize_pro_data.common.exception.ApiException;
import com.ksinfo.modernize_pro_data.coordinator.site.AuditLogService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 라이선스 관리 — 검증, 캐시, 만료 단계 계산, 업로드.
 *
 * Singleton 캐시: 한 Coordinator = 한 활성 라이선스. 매 요청마다 DB 조회는 비용이라
 * 캐시 + last-seen 갱신은 throttle (LicenseEnforcementFilter 에서).
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class LicenseService {

    private final LicenseRepository repo;
    private final LicenseVerifier verifier;
    private final AuditLogService auditLogService;
    private final LicenseSealedClock sealedClock;
    private final HardwareFingerprint hardwareFingerprint;

    /** 캐시된 현재 활성 라이선스. startup + upload 시 갱신. */
    private final AtomicReference<License> active = new AtomicReference<>(null);

    /** sealed clock 검사 결과 — false 면 시계 조작 의심으로 INVALID. */
    private final AtomicReference<Boolean> clockSane = new AtomicReference<>(Boolean.TRUE);

    public void refreshFromDb() {
        Optional<License> latest = repo.findFirstByOrderByImportedAtDesc();
        active.set(latest.orElse(null));
        if (latest.isPresent()) {
            License lic = latest.get();
            log.info("License loaded: customer={}, siteId={}, edition={}, expires={}",
                    lic.getCustomer(), lic.getSiteId(), lic.getEdition(), lic.getExpiresAt());
            boolean ok = sealedClock.checkClockSanity(lic.getPublicKeyFp());
            clockSane.set(ok);
            if (!ok) {
                auditLogService.record(null, null, "system", "LICENSE_CLOCK_TAMPER")
                        .target(lic.getCustomer())
                        .details("system clock < sealed last-seen — rollback suspected")
                        .save();
            } else {
                sealedClock.touch(lic.getLicenseId(), lic.getPublicKeyFp());
            }
        } else {
            log.warn("No license loaded — Coordinator will reject all non-license API calls.");
            clockSane.set(Boolean.TRUE);
        }
    }

    public License getActive() {
        return active.get();
    }

    public LicenseStatus currentStatus() {
        License lic = active.get();
        if (lic == null) return LicenseStatus.MISSING;
        if (Boolean.FALSE.equals(clockSane.get())) return LicenseStatus.INVALID;
        // v=2 hardware binding: when the license names a specific machine, reject
        // any other machine even if signature + clock + expiry all pass.
        String bound = lic.getHardwareId();
        if (bound != null && !bound.isBlank()
                && !bound.equalsIgnoreCase(hardwareFingerprint.value())) {
            return LicenseStatus.INVALID;
        }
        LicenseDocument.Payload p = toPayload(lic);
        return verifier.statusOf(p, LocalDate.now());
    }

    /** True when the active license is hardware-bound to a different PC than
     *  this one. Useful for the React banner to distinguish the INVALID cause
     *  from signature failure / clock tamper. */
    public boolean isHardwareMismatch() {
        License lic = active.get();
        if (lic == null) return false;
        String bound = lic.getHardwareId();
        return bound != null && !bound.isBlank()
                && !bound.equalsIgnoreCase(hardwareFingerprint.value());
    }

    public LicenseDocument.Payload toPayload(License lic) {
        String bound = lic.getHardwareId();
        int v = (bound != null && !bound.isBlank()) ? 2 : 1;
        return new LicenseDocument.Payload(
                v,
                lic.getLicenseId(),
                lic.getCustomer(),
                lic.getSiteId(),
                lic.getEdition(),
                lic.getFeatures(),
                lic.getIssuedAt(),
                lic.getExpiresAt(),
                lic.getGraceDays(),
                lic.getPublicKeyFp(),
                bound
        );
    }

    /** master 가 .lic 파일 업로드 → 검증 → DB 저장 → 캐시 갱신. */
    @Transactional
    public License upload(byte[] licBytes, String actor) {
        LicenseDocument doc = verifier.verify(licBytes);
        if (doc == null) {
            auditLogService.record(null, null, actor, "LICENSE_INVALID_SIG").save();
            throw new ApiException("LICENSE_INVALID_SIG",
                    "라이선스 서명 검증 실패 — 발급 본사 확인 필요", HttpStatus.BAD_REQUEST);
        }
        License lic = License.create(doc.payload(), new String(licBytes, StandardCharsets.UTF_8), actor);
        repo.save(lic);
        active.set(lic);
        clockSane.set(Boolean.TRUE);
        sealedClock.touch(lic.getLicenseId(), lic.getPublicKeyFp());
        log.info("License imported: customer={}, siteId={}, expires={}",
                doc.payload().customer(), doc.payload().siteId(), doc.payload().expiresAt());
        auditLogService.record(null, null, actor, "LICENSE_LOADED")
                .target(doc.payload().customer())
                .details("siteId=" + doc.payload().siteId() + ", expires=" + doc.payload().expiresAt())
                .save();
        return lic;
    }

    /** dev 용도 — 현재 라이선스 DB 행 + 캐시 비움. 개발 중 MISSING 상태 테스트용. */
    @Transactional
    public void clear(String actor) {
        repo.deleteAll();
        active.set(null);
        clockSane.set(Boolean.TRUE);
        log.info("License cleared by {}", actor);
        auditLogService.record(null, null, actor, "LICENSE_CLEARED").save();
    }

    /** features 안에 해당 키가 있는지 — site / project 생성 게이트 등에서 호출. */
    public boolean hasFeature(String feature) {
        License lic = active.get();
        if (lic == null) return false;
        List<String> features = lic.getFeatures();
        return features != null && features.contains(feature);
    }

    /** last_seen_at 갱신 — Enforcement filter 에서 throttle 로 호출. DB + sealed file 동시 갱신. */
    @Transactional
    public void touchLastSeen() {
        License lic = active.get();
        if (lic == null) return;
        lic.setLastSeenAt(OffsetDateTime.now());
        repo.save(lic);
        sealedClock.touch(lic.getLicenseId(), lic.getPublicKeyFp());
    }
}
