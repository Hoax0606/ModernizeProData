package com.ksinfo.modernize_pro_data.coordinator.load.spi;

import com.ksinfo.modernize_pro_data.coordinator.load.PgCopyManager;
import com.ksinfo.modernize_pro_data.coordinator.load.PostgresLoaderAdapter;
import com.ksinfo.modernize_pro_data.coordinator.load.oracle.OracleLoaderAdapter;
import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;

/** LoaderAdapterRegistry — dbConfig.type → 어댑터 선택 + 하위호환 기본(PG) + 미지원 예외. */
class LoaderAdapterRegistrySelectionTest {

    private final PostgresLoaderAdapter pg = new PostgresLoaderAdapter(new PgCopyManager());
    private final OracleLoaderAdapter oracle = new OracleLoaderAdapter();
    private final LoaderAdapterRegistry registry = new LoaderAdapterRegistry(List.of(pg, oracle));

    private static Map<String, Object> cfg(String type) {
        Map<String, Object> m = new HashMap<>();
        if (type != null) m.put("type", type);
        return m;
    }

    @Test
    void oracleTypeSelectsOracleAdapter() {
        assertInstanceOf(OracleLoaderAdapter.class, registry.select(cfg("oracle")));
        assertInstanceOf(OracleLoaderAdapter.class, registry.select(cfg("Oracle")));
    }

    @Test
    void postgresAliasesSelectPgAdapter() {
        assertInstanceOf(PostgresLoaderAdapter.class, registry.select(cfg("postgresql")));
        assertInstanceOf(PostgresLoaderAdapter.class, registry.select(cfg("postgres")));
    }

    @Test
    void absentOrBlankTypeDefaultsToPostgres() {
        assertInstanceOf(PostgresLoaderAdapter.class, registry.select(cfg(null)));
        assertInstanceOf(PostgresLoaderAdapter.class, registry.select(cfg("")));
        assertInstanceOf(PostgresLoaderAdapter.class, registry.select((Map<String, Object>) null));
    }

    @Test
    void unsupportedEngineThrows() {
        // mysql 은 DialectUtil 이 인식하지만 적재 어댑터가 없음 → 명확 예외.
        assertThrows(UnsupportedTobeEngineException.class, () -> registry.select(cfg("mysql")));
    }
}
