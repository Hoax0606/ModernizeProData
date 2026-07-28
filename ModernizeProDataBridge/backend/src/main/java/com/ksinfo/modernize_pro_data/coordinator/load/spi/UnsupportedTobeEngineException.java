package com.ksinfo.modernize_pro_data.coordinator.load.spi;

/** 지원하지 않는 TO-BE DB 엔진(dialect) 요청 시. 조용한 fallback 대신 명확히 실패. */
public class UnsupportedTobeEngineException extends RuntimeException {
    public UnsupportedTobeEngineException(String dialect) {
        super("지원하지 않는 TO-BE DB 엔진: '" + dialect + "' (등록된 LoaderAdapter 없음)");
    }
}
