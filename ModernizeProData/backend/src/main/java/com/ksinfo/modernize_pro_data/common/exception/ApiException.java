package com.ksinfo.modernize_pro_data.common.exception;

import lombok.Getter;
import org.springframework.http.HttpStatus;

/**
 * 도구 자체 비즈니스 예외.
 * code 는 매핑된 에러 식별자 (AUTH_INVALID, MAPPING_LOCKED 등),
 * status 는 HTTP 상태 코드.
 */
@Getter
public class ApiException extends RuntimeException {

    private final String code;
    private final HttpStatus status;

    public ApiException(String code, String message, HttpStatus status) {
        super(message);
        this.code = code;
        this.status = status;
    }

    public ApiException(String code, String message) {
        this(code, message, HttpStatus.BAD_REQUEST);
    }
}
