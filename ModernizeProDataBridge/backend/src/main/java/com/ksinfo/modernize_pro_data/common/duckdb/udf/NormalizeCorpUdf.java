package com.ksinfo.modernize_pro_data.common.duckdb.udf;

import org.duckdb.DuckDBFunctions;

import java.sql.Connection;
import java.sql.SQLException;
import java.util.function.Function;
import java.util.regex.Pattern;

/**
 * normalize_corp(VARCHAR corp_name) → VARCHAR
 *
 * 일본 법인명에서 회사 형태 표기 (株式会社, 有限会社 등) 와 약식 기호 (㈱, ㈲) 를
 * 제거하고 앞뒤·연속 공백을 정리. 동명 회사 매칭·중복 제거 전처리에 사용.
 *
 *   "株式会社 田中商事"  → "田中商事"
 *   "㈱田中商事"         → "田中商事"
 *   "田中商事(株)"       → "田中商事"
 *   "  ABC 株式会社  "   → "ABC"
 *   "有限会社さくら"     → "さくら"
 *   ""                   → null   (빈 결과)
 *   null                 → null
 *
 * 제거 대상 (앞·중간·뒤 어느 위치든 동일):
 *   株式会社 / 有限会社 / 合同会社 / 合資会社 / 合名会社 / 一般社団法人 / 一般財団法人
 *   ㈱ / ㈲ / (株) / (有) / (株) / (有)
 *
 * 한자·약식·전각/반각 괄호 모두 커버. 다만 영문 "Inc." "Ltd." 등은 별도 UDF
 * 로 분리 권장 (영어권 정규화는 케이스 다양).
 */
public final class NormalizeCorpUdf {

    private NormalizeCorpUdf() {}

    private static final Pattern CORP_FORMS = Pattern.compile(
            "株式会社|有限会社|合同会社|合資会社|合名会社|一般社団法人|一般財団法人"
            + "|㈱|㈲|\\(株\\)|\\(有\\)|(株)|(有)"
    );
    private static final Pattern MULTI_SPACE = Pattern.compile("\\s+");

    public static void register(Connection conn) throws SQLException {
        DuckDBFunctions.scalarFunction()
                .withName("normalize_corp")
                .withParameter(String.class)
                .withReturnType(String.class)
                .withFunction((Function<String, String>) NormalizeCorpUdf::apply)
                .withNullInNullOut()
                .register(conn);
    }

    static String apply(String corpName) {
        if (corpName == null) return null;
        String s = CORP_FORMS.matcher(corpName).replaceAll("");
        s = MULTI_SPACE.matcher(s).replaceAll(" ").trim();
        return s.isEmpty() ? null : s;
    }
}
