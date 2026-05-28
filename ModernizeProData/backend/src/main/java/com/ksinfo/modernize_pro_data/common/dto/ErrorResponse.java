package com.ksinfo.modernize_pro_data.common.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;

/**
 * 에러 응답 본문.
 * code 는 도구 자체 정의 ("AUTH_INVALID", "MAPPING_LOCKED" 등),
 * message 는 사용자 표시용, details 는 추가 컨텍스트.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ErrorResponse(
        String code,
        String message,
        List<String> details
) {
    public static ErrorResponse of(String code, String message) {
        return new ErrorResponse(code, message, null);
    }

    public static ErrorResponse of(String code, String message, List<String> details) {
        return new ErrorResponse(code, message, details);
    }
}
