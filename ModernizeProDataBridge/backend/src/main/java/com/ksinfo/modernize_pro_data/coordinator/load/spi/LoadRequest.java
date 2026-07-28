package com.ksinfo.modernize_pro_data.coordinator.load.spi;

import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlColumn;

import java.nio.file.Path;
import java.sql.Connection;
import java.sql.ResultSet;
import java.util.List;
import java.util.Map;
import java.util.function.BooleanSupplier;

/**
 * 한 테이블 적재 요청 — 엔진별 LoaderAdapter.load 입력.
 *
 * @param dbConfig       site.tobeDbByEnv[env] (Oracle sqlldr 가 userid/host 를 여기서 사용)
 * @param connection     이미 열린 TO-BE 연결 (PG: COPY 대상; Oracle: truncate/verify 용)
 * @param tobeSchema     TO-BE 스키마 (빈 문자열 가능)
 * @param tobeTable      TO-BE 테이블 물리명
 * @param qualifiedTable 엔진 quoting 적용된 schema.table
 * @param columns        적재 컬럼 순서 (DuckDB ResultSet 컬럼 순서와 1:1)
 * @param resultSet      DuckDB {@code tobe_{table}} 의 {@code SELECT *} ResultSet (open 상태; adapter 가 소비, close 는 caller)
 * @param targetCharset  타깃 저장 문자셋 (PG: 무시=UTF-8; Oracle: 파일 인코딩/CTL)
 * @param workDir        임시 파일(.dat/.ctl/.log) 작업 디렉터리
 * @param cancelled      취소 신호 (row 루프에서 검사)
 * @param columnMeta     컬럼 타입 메타 (columns 와 동순서) — Oracle CTL 필드 스펙(날짜 마스크/CHAR 사이징)용.
 *                       PG 는 무시. null 가능(메타 미등록 시).
 */
public record LoadRequest(
        Map<String, Object> dbConfig,
        Connection connection,
        String tobeSchema,
        String tobeTable,
        String qualifiedTable,
        List<String> columns,
        ResultSet resultSet,
        String targetCharset,
        Path workDir,
        BooleanSupplier cancelled,
        List<DdlColumn> columnMeta) {}
