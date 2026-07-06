package com.ksinfo.modernize_pro_data.coordinator.update;

import lombok.Builder;
import lombok.Data;

import java.time.OffsetDateTime;

/**
 * `/api/v1/updates/status` response. FE 의 Settings → Update 화면이 표시.
 */
@Data
@Builder
public class UpdateStatus {
    /** 현재 도구 version (jar 의 Implementation-Version). null 이면 dev 빌드. */
    private String currentVersion;
    /** 마지막 check 시점의 manifest version. 한 번도 check 없으면 null. */
    private String latestVersion;
    /** 마지막 check 시도 시각. */
    private OffsetDateTime lastCheckAt;
    /** 마지막 check 결과 — success / failed / not-yet. */
    private String lastCheckStatus;
    /** 마지막 check fail 시 에러 메시지. */
    private String lastCheckError;
    /** 사용 가능한 update 가 있는지 (latestVersion > currentVersion). */
    private boolean updateAvailable;
    /** release notes (manifest 의 releaseNotes). update 있을 때만 채움. */
    private String releaseNotes;
}
