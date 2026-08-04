package com.ksinfo.modernize_pro_data.coordinator.load.spi;

import java.sql.Connection;
import java.sql.ResultSet;
import java.util.List;
import java.util.function.BooleanSupplier;

/**
 * CDC 델타 병합 요청 — {@link LoaderAdapter#merge} 입력.
 *
 * <p>좌변 = DuckDB {@code tobe_{table}} 변환 결과(op-type 제어 컬럼 포함)의 {@code SELECT *}
 * ResultSet. 이를 타깃에 <b>PK 기준 upsert(op=I/U) + delete(op=D)</b> 로 병합한다.
 * 전량 적재({@link LoadRequest})와 달리 <b>타깃을 절대 TRUNCATE 하지 않는다</b>.
 *
 * @param columns    ResultSet 컬럼 순서 (opColumn 포함). 데이터 컬럼 = columns − opColumn.
 * @param pkColumns  ON CONFLICT 키. 비어 있으면 병합 불가(caller 가 fail-fast).
 * @param opColumn   op-type 제어 컬럼명 (값 I/U/D). 타깃 본테이블에는 적재하지 않음.
 * @param columns 는 CDC 델타 행이 <b>전체 컬럼 이미지</b>를 담는다는 계약 위에서만 정확하다
 *                (부분 컬럼만 오면 누락 컬럼이 NULL 로 덮임).
 */
public record MergeRequest(
        Connection connection,
        String tobeSchema,
        String tobeTable,
        String qualifiedTable,
        List<String> columns,
        ResultSet resultSet,
        BooleanSupplier cancelled,
        List<String> pkColumns,
        String opColumn) {}
