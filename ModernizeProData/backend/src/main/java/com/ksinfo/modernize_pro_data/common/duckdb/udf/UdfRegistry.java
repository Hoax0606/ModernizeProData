package com.ksinfo.modernize_pro_data.common.duckdb.udf;

import lombok.extern.slf4j.Slf4j;

import java.sql.Connection;
import java.sql.SQLException;

/**
 * 번들 UDF 일괄 등록.
 *
 * {@link com.ksinfo.modernize_pro_data.common.duckdb.DuckDbService#getConnection()}
 * 가 새 connection 을 열 때마다 1 회 호출한다. DuckDB 의 UDF 는 connection 별로
 * 등록되므로 connection pool 도입 시에도 같은 hook 위치에서 호출하면 된다.
 *
 * UDF 기준 (Notion "변환구조" §3-1):
 *   - null 입력 → null 반환 (예외 throw 금지) — Quarantine 분기로 흘러감
 *   - 호출마다 다른 값이 나와야 하면 {@code withVolatile()} 필수
 *   - 벡터화 콜백의 {@code DuckDBDataChunkReader} 는 콜백 밖에 저장 금지
 */
@Slf4j
public final class UdfRegistry {

    private UdfRegistry() {}

    public static void registerAll(Connection conn) {
        try {
            // 숫자 / 소수점
            ApplyScaleUdf.register(conn);
            UnpackZoneDecimalUdf.register(conn);
            UnpackCompUdf.register(conn);
            UnpackCompFloatUdf.register(conn);
            UnpackSignedSeparateUdf.register(conn);
            UnpackOverpunchUdf.register(conn);
            // 날짜 / 시간
            ConvertEraUdf.register(conn);
            // 채번
            AssignSeqUdf.register(conn);
            // 식별자 검증
            ValidateBiznoUdf.register(conn);
            // 마스킹 / 해시
            MaskPhoneUdf.register(conn);
            HashSha256Udf.register(conn);
            // 문자열 정규화
            NormalizeCorpUdf.register(conn);
            log.info("DuckDB UDFs registered (12): apply_scale, unpack_zone_decimal, "
                    + "unpack_comp, unpack_comp_float, unpack_signed_separate, unpack_overpunch, "
                    + "convert_era, assign_seq, validate_bizno, mask_phone, hash_sha256, normalize_corp");
        } catch (SQLException e) {
            log.error("DuckDB UDF registration failed", e);
            throw new RuntimeException("UDF registration failed", e);
        }
    }
}
