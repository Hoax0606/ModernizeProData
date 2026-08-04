package com.ksinfo.modernize_pro_data.coordinator.load.spi;

import com.ksinfo.modernize_pro_data.coordinator.ddl.DialectUtil;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;

/**
 * TO-BE dbConfig 의 {@code type} 로 LoaderAdapter 선택 (SourceReaderRegistry 미러링).
 *
 * <p><b>기본값 주의</b>: {@code type} 이 없거나 비면 <b>PostgreSQL</b> 로 폴백한다(기존 동작 보존 —
 * 이전엔 LoadStage 가 type 무시하고 항상 PG). DDL 파서용 {@link DialectUtil#normalize}(oracle 폴백)과
 * 다른 이유: 적재 경로의 하위호환 기본은 PG 다. type 이 명시(Oracle 등)면 그 엔진으로.
 */
@Component
@Slf4j
public class LoaderAdapterRegistry {

    private final List<LoaderAdapter> adapters;

    public LoaderAdapterRegistry(List<LoaderAdapter> adapters) {
        this.adapters = adapters;
        log.info("LoaderAdapterRegistry initialized with {} adapter(s): {}",
                adapters.size(), adapters.stream().map(LoaderAdapter::dialect).toList());
    }

    /** dbConfig.type → dialect → adapter. type 없음/빈값 → postgresql 폴백. */
    public LoaderAdapter select(Map<String, Object> dbConfig) {
        Object t = dbConfig == null ? null : dbConfig.get("type");
        String raw = t == null ? null : t.toString();
        String dialect = (raw == null || raw.isBlank()) ? DialectUtil.POSTGRESQL : DialectUtil.normalize(raw);
        return select(dialect);
    }

    public LoaderAdapter select(String dialect) {
        for (LoaderAdapter a : adapters) {
            if (a.supports(dialect)) return a;
        }
        throw new UnsupportedTobeEngineException(dialect);
    }
}
