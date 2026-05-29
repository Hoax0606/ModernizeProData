package com.ksinfo.modernize_pro_data.common.config;

import org.springframework.context.annotation.Configuration;
import org.springframework.messaging.simp.config.MessageBrokerRegistry;
import org.springframework.web.socket.config.annotation.EnableWebSocketMessageBroker;
import org.springframework.web.socket.config.annotation.StompEndpointRegistry;
import org.springframework.web.socket.config.annotation.WebSocketMessageBrokerConfigurer;

/**
 * WebSocket (STOMP) 설정.
 *
 * - Endpoint: /ws (Vite dev server 와 SockJS fallback 지원)
 * - Server → Client broadcast 경로: /topic/**
 *   예) /topic/run/{runId}/progress, /topic/notifications, /topic/lock
 * - Client → Server 메시지 경로: /app/**
 */
@Configuration
@EnableWebSocketMessageBroker
public class WebSocketConfig implements WebSocketMessageBrokerConfigurer {

    @Override
    public void configureMessageBroker(MessageBrokerRegistry config) {
        config.enableSimpleBroker("/topic", "/queue");
        config.setApplicationDestinationPrefixes("/app");
        config.setUserDestinationPrefix("/user");
    }

    @Override
    public void registerStompEndpoints(StompEndpointRegistry registry) {
        // /ws — 브라우저 (frontend) 용. SockJS fallback 활성. raw WS upgrade 는 거부됨.
        registry.addEndpoint("/ws")
                .setAllowedOriginPatterns("*")
                .withSockJS();
        // /ws-raw — Worker daemon (StandardWebSocketClient) 용 pure WebSocket endpoint.
        // SockJS 안 끼고 직접 ws:// upgrade.
        registry.addEndpoint("/ws-raw")
                .setAllowedOriginPatterns("*");
    }
}
