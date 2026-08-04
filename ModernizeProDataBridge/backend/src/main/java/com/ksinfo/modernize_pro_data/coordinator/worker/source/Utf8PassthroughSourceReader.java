package com.ksinfo.modernize_pro_data.coordinator.worker.source;

import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

import java.nio.file.Path;

/**
 * 기본 SourceReader — 입력이 이미 UTF-8 이라는 파이프라인 계약을 그대로 반영 (no-op passthrough).
 * encoding 이 UTF-8 / 미지정이면 원본 파일을 변환 없이 반환. (계획서 A4 의 현재 구현체)
 *
 * <p>{@code @Order(LOWEST)} — registry 가 구체 인코딩 reader 를 먼저 매칭하고, 남으면 여기로.
 */
@Component
@Order
public class Utf8PassthroughSourceReader implements SourceReader {

    @Override
    public boolean supports(String encoding) {
        if (encoding == null || encoding.isBlank()) return true;
        String e = encoding.trim().toUpperCase();
        return e.equals("UTF-8") || e.equals("UTF8");
    }

    @Override
    public Path toUtf8(Path source, String declaredEncoding, Path workDir) {
        return source;   // 변환 없음 — 이미 UTF-8.
    }
}
