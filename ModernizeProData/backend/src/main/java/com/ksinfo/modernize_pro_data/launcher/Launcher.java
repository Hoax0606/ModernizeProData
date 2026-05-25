package com.ksinfo.modernize_pro_data.launcher;

import com.ksinfo.modernize_pro_data.ModernizeProDataApplication;
import javafx.application.Application;
import javafx.application.Platform;
import javafx.scene.Scene;
import javafx.scene.image.Image;
import javafx.scene.web.WebView;
import javafx.stage.Stage;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.InputStream;

/**
 * jpackage 인스톨러용 메인 진입점.
 *
 * <p>두 모드:
 * <ul>
 *   <li>{@code mpd.gui.enabled=true} (인스톨러 launcher 가 설정) →
 *       JavaFX Stage 가 즉시 뜨고 그 안 WebView 가 Spring Boot 가 ready
 *       되면 {@code http://localhost:8080/} 를 로드. native 데스크탑 창
 *       사용자 경험.</li>
 *   <li>그 외 (dev 환경 {@code mvn spring-boot:run}) → JavaFX 안 띄움.
 *       바로 SpringApplication 실행. 기존 dev workflow 그대로.</li>
 * </ul>
 *
 * <p>JavaFX 의존성은 {@code provided} scope 라 fat jar 에 포함되지 않음.
 * jpackage 의 {@code --module-path + --add-modules} 가 런타임 모듈을 주입.
 * dev 환경에서 GUI 모드를 켜고 싶다면 JavaFX SDK 를 별도 module-path 로
 * 지정해 java 명령에 직접 넘기면 됨.
 */
public class Launcher {

    public static void main(String[] args) {
        // .msi 설치 시 사용자가 고른 언어가 HKCU\Software\ModernizeProData\Language 에
        // 저장되어 있으면 mpd.default-lang system property 로 노출. Spring/REST 가
        // 그 값을 frontend 에 전달하면 첫 부팅 시 default language 로 사용.
        readDefaultLanguageFromRegistry();

        if (Boolean.getBoolean("mpd.gui.enabled")) {
            GuiApp.launch(args);
        } else {
            // dev / headless 모드 — 기존 ModernizeProDataApplication 의 동작과 동일.
            SpringApplication app = new SpringApplication(ModernizeProDataApplication.class);
            app.setHeadless(false);
            app.run(args);
        }
    }

    /** Windows registry 의 HKCU\Software\ModernizeProData\Language 를 reg.exe 로 읽어
     *  mpd.default-lang system property 로 노출. 비Windows / 값 없음 시 no-op. */
    private static void readDefaultLanguageFromRegistry() {
        if (!System.getProperty("os.name", "").toLowerCase().contains("win")) return;
        if (System.getProperty("mpd.default-lang") != null) return; // already set

        try {
            Process p = new ProcessBuilder(
                    "reg", "query", "HKCU\\Software\\ModernizeProData", "/v", "Language"
            ).redirectErrorStream(true).start();
            byte[] out = p.getInputStream().readAllBytes();
            p.waitFor();
            // Expected line: "    Language    REG_SZ    ko"
            for (String line : new String(out).split("\\R")) {
                String t = line.trim();
                if (t.startsWith("Language") && t.contains("REG_SZ")) {
                    String[] parts = t.split("REG_SZ", 2);
                    if (parts.length == 2) {
                        String lang = parts[1].trim();
                        if (lang.equals("ko") || lang.equals("ja") || lang.equals("en")) {
                            System.setProperty("mpd.default-lang", lang);
                        }
                        return;
                    }
                }
            }
        } catch (Exception ignored) {
            // reg.exe missing or registry key absent — leave property unset.
        }
    }

    /**
     * JavaFX Application 본체. {@code mpd.gui.enabled=true} 일 때만 사용.
     * 외부에서 직접 호출하지 않도록 별도 inner class 로 분리 (Application.launch
     * 가 static init 으로 JavaFX runtime 을 잡는 부수 효과를 dev 모드와 격리).
     */
    public static class GuiApp extends Application {
        private static String[] startArgs = new String[0];

        public static void launch(String[] args) {
            startArgs = args;
            Application.launch(GuiApp.class, args);
        }

        private ConfigurableApplicationContext springCtx;

        @Override
        public void start(Stage stage) {
            WebView webView = new WebView();
            webView.getEngine().loadContent(loadingHtml());

            stage.setTitle("ModernizeProData");
            tryLoadIcon(stage);
            stage.setScene(new Scene(webView, 1280, 800));
            stage.setOnCloseRequest(e -> shutdown());
            stage.show();

            // Spring Boot 를 백그라운드 thread 에서 시작 (JavaFX UI thread 점유 방지).
            Thread bootThread = new Thread(() -> {
                springCtx = new SpringApplicationBuilder(ModernizeProDataApplication.class)
                        .headless(false)
                        .listeners((ApplicationReadyEvent ev) ->
                                Platform.runLater(() ->
                                        webView.getEngine().load("http://localhost:8080/")))
                        .run(startArgs);
            }, "spring-boot-launcher");
            bootThread.setDaemon(false);
            bootThread.start();
        }

        private void shutdown() {
            if (springCtx != null) {
                try { SpringApplication.exit(springCtx, () -> 0); } catch (Exception ignored) {}
            }
            Platform.exit();
            System.exit(0);
        }

        private void tryLoadIcon(Stage stage) {
            try (InputStream is = GuiApp.class.getResourceAsStream("/icons/mpd.png")) {
                if (is != null) stage.getIcons().add(new Image(is));
            } catch (Exception ignored) {
                // 아이콘 로드 실패는 무시 — 윈도우 기본 아이콘 사용.
            }
        }

        private String loadingHtml() {
            return """
                    <!doctype html>
                    <html><head><meta charset="utf-8"><title>ModernizeProData</title>
                    <style>
                      body {
                        font-family: 'Segoe UI', system-ui, sans-serif;
                        display: flex; align-items: center; justify-content: center;
                        height: 100vh; margin: 0;
                        background: #f9fafb; color: #0e7268;
                      }
                      .panel { text-align: center; }
                      .brand { margin: 0 0 24px; font-weight: 600; font-size: 28px; }
                      .spinner {
                        width: 48px; height: 48px; margin: 0 auto 18px;
                        border: 4px solid #d4eae6;
                        border-top-color: #0e7268;
                        border-radius: 50%;
                        animation: spin 0.9s linear infinite;
                      }
                      @keyframes spin { to { transform: rotate(360deg); } }
                      .status { margin: 0; color: #678b86; font-size: 14px; }
                      .status .dots::after {
                        content: '';
                        animation: dots 1.4s steps(4, end) infinite;
                      }
                      @keyframes dots {
                        0%, 20%   { content: ''; }
                        40%       { content: '.'; }
                        60%       { content: '..'; }
                        80%, 100% { content: '...'; }
                      }
                      .hint {
                        margin-top: 18px; color: #9bb5b0; font-size: 12px;
                        max-width: 340px;
                      }
                    </style></head>
                    <body>
                      <div class="panel">
                        <div class="spinner"></div>
                        <h1 class="brand">ModernizeProData</h1>
                        <p class="status">Starting<span class="dots"></span></p>
                        <p class="hint">backend, database, and UI are warming up. The window will switch to the login page when ready.</p>
                      </div>
                    </body></html>
                    """;
        }
    }
}
