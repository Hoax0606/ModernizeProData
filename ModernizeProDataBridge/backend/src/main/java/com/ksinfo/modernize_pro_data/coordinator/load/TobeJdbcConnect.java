package com.ksinfo.modernize_pro_data.coordinator.load;

import com.ksinfo.modernize_pro_data.coordinator.ddl.DialectUtil;

import java.util.Map;
import java.util.Properties;
import java.util.Set;

/**
 * TO-BE dbConfig → JDBC (url, props) 빌더 — <b>도달성/헬스/ping 경로 공용</b>. 적재(LoaderAdapter)와 달리
 * 짧은 timeout + isValid 로 "닿는가"만 본다. 이전엔 3곳(TobeDbController / TobeDbHealthService /
 * CheckStage)이 각자 {@code jdbc:postgresql} 를 하드코딩했으나, 여기로 모아 엔진(PG/Oracle) 분기를 일원화.
 *
 * <p>URL 포맷은 적재 어댑터와 동일: PG {@code jdbc:postgresql://h:p/db}, Oracle
 * {@code jdbc:oracle:thin:@//h:p/service}. dbConfig.type 없음/빈값 → PostgreSQL(하위호환).
 */
public final class TobeJdbcConnect {

    private TobeJdbcConnect() {}

    /** 실시간 도달성 probe 가 지원하는 엔진. 그 외(mssql/mysql/db2)는 configured=true, reachable=false 로 표시. */
    public static final Set<String> SUPPORTED = Set.of(DialectUtil.POSTGRESQL, DialectUtil.ORACLE);

    /** dbConfig.type → 정규화 dialect. 없음/빈값 → postgresql (하위호환). */
    public static String dialect(Map<String, Object> cfg) {
        Object t = cfg == null ? null : cfg.get("type");
        String raw = t == null ? null : t.toString();
        return (raw == null || raw.isBlank()) ? DialectUtil.POSTGRESQL : DialectUtil.normalize(raw);
    }

    public static boolean isSupported(String dialect) {
        return SUPPORTED.contains(dialect);
    }

    public static int port(Map<String, Object> cfg) {
        Object p = cfg == null ? null : cfg.get("port");
        if (p instanceof Number n) return n.intValue();
        if (p instanceof String s && !s.isBlank()) return Integer.parseInt(s.trim());
        return DialectUtil.ORACLE.equals(dialect(cfg)) ? 1521 : 5432;
    }

    /** dialect 별 JDBC URL. */
    public static String url(Map<String, Object> cfg) {
        String host = str(cfg.get("host"));
        String db = str(cfg.get("database"));
        int port = port(cfg);
        if (DialectUtil.ORACLE.equals(dialect(cfg))) {
            return "jdbc:oracle:thin:@//" + host + ":" + port + "/" + db;
        }
        return "jdbc:postgresql://" + host + ":" + port + "/" + db;
    }

    /** user/password + dialect 별 timeout props (짧게 — 내려간 환경에서 매달리지 않게). */
    public static Properties props(Map<String, Object> cfg, int timeoutSec) {
        Properties props = new Properties();
        String user = str(cfg.get("username"));
        if (!user.isEmpty()) props.setProperty("user", user);
        props.setProperty("password", str(cfg.get("password")));
        if (DialectUtil.ORACLE.equals(dialect(cfg))) {
            // Oracle thin: timeout 은 ms 단위 property.
            props.setProperty("oracle.net.CONNECT_TIMEOUT", String.valueOf(timeoutSec * 1000));
            props.setProperty("oracle.jdbc.ReadTimeout", String.valueOf((timeoutSec + 1) * 1000));
        } else {
            // pgjdbc: 초 단위.
            props.setProperty("connectTimeout", String.valueOf(timeoutSec));
            props.setProperty("loginTimeout", String.valueOf(timeoutSec));
            props.setProperty("socketTimeout", String.valueOf(timeoutSec + 1));
        }
        return props;
    }

    private static String str(Object o) {
        return o == null ? "" : o.toString();
    }
}
