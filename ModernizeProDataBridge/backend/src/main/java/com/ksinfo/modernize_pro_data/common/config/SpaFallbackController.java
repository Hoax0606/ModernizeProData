package com.ksinfo.modernize_pro_data.common.config;

import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.RequestMapping;

/**
 * React Router 의 클라이언트 라우팅이 새로고침 시 backend 에서 404 가 아닌
 * /index.html 로 forward 되도록 한다.
 *
 * <p>{@code [^.]*} — dot 이 들어간 path 는 정적 자산 (index.html, *.css, *.js,
 * *.png 등) 이므로 fallback 대상에서 제외. 이걸 안 하면 forward(/index.html)
 * 가 또 같은 매핑에 잡혀서 무한 forward loop → StackOverflowError 가 남.
 *
 * <p>{@code (?!api|ws|assets|favicon|mpd)} — API, WebSocket, 정적 자산 prefix
 * 는 Spring 의 본래 핸들러 (컨트롤러 / ResourceHttpRequestHandler) 가 처리하게 둠.
 */
@Controller
public class SpaFallbackController {

    private static final String SPA_ROUTE = "^(?!api|ws|assets|favicon|mpd)[^.]*$";

    @RequestMapping("/{path:" + SPA_ROUTE + "}")
    public String forwardRoot() {
        return "forward:/index.html";
    }

    @RequestMapping("/{path:" + SPA_ROUTE + "}/**")
    public String forwardSub() {
        return "forward:/index.html";
    }
}
