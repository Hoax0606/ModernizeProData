package com.ksinfo.modernize_pro_data.coordinator.api;

import com.ksinfo.modernize_pro_data.common.dto.ApiResponse;
import com.ksinfo.modernize_pro_data.common.exception.ApiException;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlImport;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlImportService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;

/**
 * TO-BE DDL 인포트 API.
 *
 * POST   /api/v1/projects/{id}/tobe-ddl/import — 1 파일 업로드 후 파싱·저장
 * GET    /api/v1/projects/{id}/tobe-ddl        — 인포트된 테이블/컬럼 조회
 * DELETE /api/v1/projects/{id}/tobe-ddl        — 인포트 결과 삭제
 */
@Slf4j
@RestController
@RequiredArgsConstructor
public class TobeDdlController {

    private static final long MAX_FILE_SIZE = 50L * 1024 * 1024; // 50MB

    private final DdlImportService service;

    @PostMapping("/api/v1/projects/{id}/tobe-ddl/import")
    @PreAuthorize("hasAnyRole('MASTER','ADMIN')")
    public ApiResponse<DdlImport> importTobe(
            @PathVariable String id,
            @RequestParam("file") MultipartFile file,
            Authentication auth
    ) {
        if (file == null || file.isEmpty()) {
            throw new ApiException("FILE_EMPTY", "파일이 비어있습니다", HttpStatus.BAD_REQUEST);
        }
        if (file.getSize() > MAX_FILE_SIZE) {
            throw new ApiException("FILE_TOO_LARGE",
                    "파일이 너무 큽니다 (max 50MB)", HttpStatus.BAD_REQUEST);
        }
        byte[] content;
        try {
            content = file.getBytes();
        } catch (IOException e) {
            throw new ApiException("FILE_READ_FAILED",
                    "파일 읽기 실패: " + e.getMessage(), HttpStatus.BAD_REQUEST);
        }
        DdlImport result = service.importDdl(
                id, DdlImportService.SIDE_TOBE, file.getOriginalFilename(), content, auth.getName());
        return ApiResponse.ok(result);
    }

    @GetMapping("/api/v1/projects/{id}/tobe-ddl")
    public ApiResponse<DdlImportService.DdlSchema> getTobe(@PathVariable String id) {
        return ApiResponse.ok(service.getDdl(id, DdlImportService.SIDE_TOBE));
    }

    @DeleteMapping("/api/v1/projects/{id}/tobe-ddl")
    @PreAuthorize("hasAnyRole('MASTER','ADMIN')")
    public ApiResponse<Void> deleteTobe(@PathVariable String id) {
        service.deleteDdl(id, DdlImportService.SIDE_TOBE);
        return ApiResponse.ok(null);
    }
}
