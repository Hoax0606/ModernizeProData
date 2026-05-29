package com.ksinfo.modernize_pro_data.launcher;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.ksinfo.modernize_pro_data.ModernizeProDataApplication;
import javafx.application.Application;
import javafx.application.Platform;
import javafx.geometry.Insets;
import javafx.geometry.Pos;
import javafx.scene.Scene;
import javafx.scene.control.Alert;
import javafx.scene.control.Alert.AlertType;
import javafx.scene.control.Button;
import javafx.scene.control.ButtonType;
import javafx.scene.control.Label;
import javafx.scene.control.PasswordField;
import javafx.scene.control.TextField;
import javafx.scene.control.TextInputDialog;
import javafx.scene.image.Image;
import javafx.scene.layout.BorderPane;
import javafx.scene.layout.GridPane;
import javafx.scene.layout.VBox;
import javafx.scene.web.WebEngine;
import javafx.scene.web.WebView;
import javafx.stage.FileChooser;
import javafx.stage.Stage;
import javafx.stage.StageStyle;
import netscape.javascript.JSObject;

import java.util.Optional;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.PrintStream;
import java.net.InetAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.time.Duration;

/**
 * jpackage 인스톨러용 메인 진입점.
 *
 * <ul>
 *   <li>mode=coordinator / standalone → {@link GuiApp} : 자체 Spring Boot
 *       + 자체 PG + WebView 가 localhost:8080.</li>
 *   <li>mode=worker → {@link WorkerApp} : Spring / PG 안 시작. WebView 가
 *       Coordinator URL 의 React UI 를 직접 로드 + 백그라운드 thread 가
 *       login + self-register + heartbeat.</li>
 * </ul>
 *
 * <p>이전엔 Worker 도구도 자체 backend 띄웠는데 — Worker PC 에 PG 가 없을 때
 * Spring 부팅 자체가 실패해서 Starting 에서 멈췄다. Worker 는 Coordinator
 * 통신만 하면 되므로 자체 backend 가 의미 없음.
 */
public class Launcher {

    public static void main(String[] args) {
        redirectStdoutToFile();
        readInstallerChoicesFromRegistry();

        if (Boolean.getBoolean("mpd.gui.enabled")) {
            String mode = System.getProperty("MPD_MODE", "coordinator");
            if ("worker".equalsIgnoreCase(mode)) {
                WorkerApp.launch(args);
            } else {
                GuiApp.launch(args);
            }
        } else {
            SpringApplication app = new SpringApplication(ModernizeProDataApplication.class);
            app.setHeadless(false);
            app.run(args);
        }
    }

    /** GUI-only diagnostics: jpackage's WinExe drops stdout/stderr by default,
     *  so we redirect both to %LOCALAPPDATA%\ModernizeProData\launcher.log.
     *  Lets us see Spring boot errors and WebView events when the GUI seems
     *  stuck.
     *
     *  콘솔에서 띄운 경우 (개발자가 mvnw spring-boot:run, java -jar 등) 에는
     *  redirect 를 skip — stdout 이 사용자가 보는 콘솔로 흘러야 디버깅이 됨.
     *  System.console() 은 jpackage 의 console-less WinExe 에선 null 이라
     *  의도하는 GUI 진단 경로만 잘 발동된다. */
    private static void redirectStdoutToFile() {
        if (System.console() != null) return;
        try {
            String localAppData = System.getenv("LOCALAPPDATA");
            if (localAppData == null || localAppData.isBlank()) return;
            File dir = new File(localAppData, "ModernizeProData");
            if (!dir.exists() && !dir.mkdirs()) return;
            File log = new File(dir, "launcher.log");
            PrintStream ps = new PrintStream(new FileOutputStream(log, true), true);
            System.setOut(ps);
            System.setErr(ps);
            System.out.println("=== launcher start " + java.time.OffsetDateTime.now() + " ===");
        } catch (Exception ignored) {}
    }

    /** Build a fresh, temporary user-data-directory for the WebView so its
     *  WebKit cache / localStorage / cookies don't leak between runs.
     *  Without this, a stale /api/v1/health/info response from a previous
     *  session can pin the UI to /login even after the server changed to
     *  licenseStatus=MISSING. */
    private static void wireFreshUserData(WebView webView) {
        try {
            File dir = Files.createTempDirectory("mpd-webview-").toFile();
            dir.deleteOnExit();
            webView.getEngine().setUserDataDirectory(dir);
            System.out.println("WebView userDataDir = " + dir.getAbsolutePath());
        } catch (Exception e) {
            System.out.println("setUserDataDirectory failed: " + e.getMessage());
        }
    }

    private static void readInstallerChoicesFromRegistry() {
        if (!System.getProperty("os.name", "").toLowerCase().contains("win")) return;
        try {
            Process p = new ProcessBuilder(
                    "reg", "query", "HKCU\\Software\\ModernizeProData"
            ).redirectErrorStream(true).start();
            byte[] out = p.getInputStream().readAllBytes();
            p.waitFor();
            for (String line : new String(out).split("\\R")) {
                String t = line.trim();
                if (!t.contains("REG_SZ")) continue;
                String[] parts = t.split("\\s+REG_SZ\\s+", 2);
                if (parts.length != 2) continue;
                String name = parts[0].trim();
                String value = parts[1].trim();
                if ("Language".equals(name) && System.getProperty("mpd.default-lang") == null) {
                    if (value.equals("ko") || value.equals("ja") || value.equals("en")) {
                        System.setProperty("mpd.default-lang", value);
                    }
                } else if ("Mode".equals(name) && System.getProperty("MPD_MODE") == null) {
                    if (value.equals("coordinator") || value.equals("worker") || value.equals("standalone")) {
                        System.setProperty("MPD_MODE", value);
                    }
                } else if ("CoordinatorUrl".equals(name) && !value.isEmpty()
                        && System.getProperty("modernize.coordinator.url") == null) {
                    System.setProperty("modernize.coordinator.url", value);
                }
            }
        } catch (Exception ignored) {
            // reg.exe missing — leave properties unset.
        }
    }

    private static void applyStandardWindowChrome(Stage stage) {
        // Defensive: make sure the window stays a normal decorated frame the
        // user can drag/close. JavaFX defaults are right but a few setters
        // help diagnose Stage.fullScreen-style reports from field PCs.
        stage.setFullScreen(false);
        stage.setFullScreenExitHint("");
        stage.setMaximized(false);
        stage.setIconified(false);
        stage.setResizable(true);
    }

    private static void tryLoadIcon(Stage stage) {
        try (InputStream is = Launcher.class.getResourceAsStream("/icons/mpd.png")) {
            if (is != null) stage.getIcons().add(new Image(is));
        } catch (Exception ignored) { /* default Windows icon is fine */ }
    }

    /**
     * JavaFX WebView's defaults silently swallow {@code window.confirm()} /
     * {@code window.alert()} / {@code window.prompt()} -- confirm returns
     * false, alert is dropped on the floor. Without these handlers every
     * confirm() in the React app behaves as if the user clicked Cancel,
     * which is why buttons like "Clear license" appeared to do nothing.
     */
    private static void wireJsDialogs(WebEngine engine, Stage owner) {
        engine.setConfirmHandler(message -> {
            Alert a = new Alert(AlertType.CONFIRMATION, message, ButtonType.OK, ButtonType.CANCEL);
            a.setHeaderText(null);
            a.initOwner(owner);
            Optional<ButtonType> r = a.showAndWait();
            return r.isPresent() && r.get() == ButtonType.OK;
        });
        engine.setOnAlert(evt -> {
            Alert a = new Alert(AlertType.INFORMATION, evt.getData(), ButtonType.OK);
            a.setHeaderText(null);
            a.initOwner(owner);
            a.showAndWait();
        });
        engine.setPromptHandler(data -> {
            // Bridge — JS calls window.prompt('OPEN_LICENSE_FILE') to trigger
            // a native FileChooser. We hijack the prompt handler because
            // JavaFX 21's JSObject.setMember() exposes Java instances but
            // does not surface their methods to JS (deep-reflection limit on
            // unnamed modules). The prompt handler is the simplest channel
            // that lets us synchronously return a String to JS.
            if ("OPEN_LICENSE_FILE".equals(data.getMessage())) {
                FileChooser fc = new FileChooser();
                fc.setTitle("Select license file");
                fc.getExtensionFilters().addAll(
                        new FileChooser.ExtensionFilter("License (*.lic)", "*.lic"),
                        new FileChooser.ExtensionFilter("JSON (*.json)", "*.json"),
                        new FileChooser.ExtensionFilter("All files", "*.*"));
                File f = fc.showOpenDialog(owner);
                if (f == null) return null;
                try {
                    return Files.readString(f.toPath());
                } catch (Exception ex) {
                    System.out.println("readString failed: " + ex.getMessage());
                    return null;
                }
            }
            TextInputDialog d = new TextInputDialog(data.getDefaultValue());
            d.setHeaderText(null);
            d.setContentText(data.getMessage());
            d.initOwner(owner);
            return d.showAndWait().orElse(null);
        });
    }

    /**
     * Exposes a `window.javaConnector` JS object so the React UI can invoke
     * native JavaFX dialogs (e.g. FileChooser). JavaFX 21 WebView does not
     * surface a native file picker on `<input type="file">`, so we bridge it
     * explicitly. Re-attached on every document load so SPA + full reloads
     * both retain the binding.
     */
    private static void wireJavaBridge(WebEngine engine, Stage owner) {
        engine.documentProperty().addListener((obs, oldDoc, newDoc) -> {
            if (newDoc == null) return;
            try {
                JSObject window = (JSObject) engine.executeScript("window");
                window.setMember("javaConnector", new JavaConnector(owner));
                System.out.println("javaConnector bridge attached");
            } catch (Exception e) {
                System.out.println("javaConnector wiring failed: " + e.getMessage());
            }
        });
    }

    /**
     * Public surface called from JS via {@code window.javaConnector.<method>()}.
     * Methods run on the JavaFX Application Thread (the WebView JS engine
     * already executes there), so we can open dialogs synchronously and
     * return the chosen value.
     */
    public static class JavaConnector {
        private final Stage owner;
        JavaConnector(Stage owner) { this.owner = owner; }

        /** Opens a native FileChooser, reads the selected file as UTF-8,
         *  returns its content. Returns null if the user cancels. */
        public String openLicenseFile() {
            try {
                FileChooser fc = new FileChooser();
                fc.setTitle("Select license file");
                fc.getExtensionFilters().addAll(
                        new FileChooser.ExtensionFilter("License (*.lic)", "*.lic"),
                        new FileChooser.ExtensionFilter("JSON (*.json)", "*.json"),
                        new FileChooser.ExtensionFilter("All files", "*.*"));
                File f = fc.showOpenDialog(owner);
                if (f == null) return null;
                return Files.readString(f.toPath());
            } catch (Exception e) {
                System.out.println("openLicenseFile error: " + e.getMessage());
                return null;
            }
        }
    }

    /** Coordinator / Standalone -- own Spring Boot + PG + WebView 가 localhost. */
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
            wireFreshUserData(webView);
            webView.getEngine().locationProperty().addListener((o, oldUrl, newUrl) ->
                    System.out.println("WebView nav: " + newUrl));
            webView.getEngine().loadContent(loadingHtml());
            wireJsDialogs(webView.getEngine(), stage);
            wireJavaBridge(webView.getEngine(), stage);

            stage.setTitle("ModernizeProData");
            tryLoadIcon(stage);
            BorderPane root = new BorderPane(webView);
            root.setStyle("-fx-font-family: 'Hoax Mono JP', 'Segoe UI', sans-serif;");
            stage.setScene(new Scene(root, 1200, 760));
            applyStandardWindowChrome(stage);
            stage.setOnCloseRequest(e -> shutdown());
            stage.show();
            stage.centerOnScreen();

            Thread bootThread = new Thread(() -> {
                springCtx = new SpringApplicationBuilder(ModernizeProDataApplication.class)
                        .headless(false)
                        .listeners((ApplicationReadyEvent ev) ->
                                Platform.runLater(() ->
                                        // Cache-bust query so JavaFX WebView's WebKit cache can't
                                        // serve a stale LICENSE_MISSING JSON from a previous run.
                                        webView.getEngine().load(
                                                "http://localhost:8080/?_=" + System.currentTimeMillis())))
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

        private String loadingHtml() {
            return """
                    <!doctype html>
                    <html><head><meta charset="utf-8"><title>ModernizeProData</title>
                    <style>
                      body { font-family: 'Segoe UI', system-ui, sans-serif;
                        display: flex; align-items: center; justify-content: center;
                        height: 100vh; margin: 0; background: #f9fafb; color: #0e7268; }
                      .panel { text-align: center; }
                      .brand { margin: 0 0 24px; font-weight: 600; font-size: 28px; }
                      .spinner { width: 48px; height: 48px; margin: 0 auto 18px;
                        border: 4px solid #d4eae6; border-top-color: #0e7268;
                        border-radius: 50%; animation: spin 0.9s linear infinite; }
                      @keyframes spin { to { transform: rotate(360deg); } }
                      .status { margin: 0; color: #678b86; font-size: 14px; }
                      .hint { margin-top: 18px; color: #9bb5b0; font-size: 12px; max-width: 340px; }
                    </style></head>
                    <body><div class="panel">
                      <div class="spinner"></div>
                      <h1 class="brand">ModernizeProData</h1>
                      <p class="status">Starting…</p>
                      <p class="hint">backend, database, and UI are warming up.</p>
                    </div></body></html>
                    """;
        }
    }

    /**
     * Tiny i18n bag for the Worker wizard. WorkerApp is not part of the
     * Spring context, so it can't go through the React i18n store. The
     * language is whichever locale the installer wrote into HKCU
     * (read into {@code mpd.default-lang} by {@link #readInstallerChoicesFromRegistry()}),
     * falling back to the JVM default locale, then English.
     */
    static final class WorkerI18n {
        private static final java.util.Map<String, java.util.Map<String, String>> DICT = java.util.Map.of(
                "en", java.util.Map.ofEntries(
                        java.util.Map.entry("url.title",       "Connect to Coordinator"),
                        java.util.Map.entry("url.hint",        "Enter your Coordinator's URL. We'll verify it's reachable before asking for credentials."),
                        java.util.Map.entry("url.field",       "Coordinator URL"),
                        java.util.Map.entry("url.placeholder", "http://192.168.x.x:8080"),
                        java.util.Map.entry("url.test",        "Test connection"),
                        java.util.Map.entry("url.probing",     "Probing {url} …"),
                        java.util.Map.entry("url.required",    "Coordinator URL is required."),
                        java.util.Map.entry("url.unreachable", "Cannot reach {url} (host unreachable / firewall)."),
                        java.util.Map.entry("url.timeout",     "Timed out connecting to {url}."),
                        java.util.Map.entry("url.probeFailed", "Probe failed: {reason}"),
                        java.util.Map.entry("url.httpStatus",  "Coordinator responded HTTP {status}."),
                        java.util.Map.entry("creds.title",       "Sign in"),
                        java.util.Map.entry("creds.hint",        "Use the Coordinator account your master created for you."),
                        java.util.Map.entry("creds.coordinator", "Coordinator: {url}"),
                        java.util.Map.entry("creds.username",    "Username"),
                        java.util.Map.entry("creds.usernamePh",  "username"),
                        java.util.Map.entry("creds.password",    "Password"),
                        java.util.Map.entry("creds.passwordPh",  "password"),
                        java.util.Map.entry("creds.signIn",      "Sign in"),
                        java.util.Map.entry("creds.signingIn",   "Signing in…"),
                        java.util.Map.entry("creds.changeUrl",   "← Change URL"),
                        java.util.Map.entry("creds.required",    "Username and password are required."),
                        java.util.Map.entry("creds.wrongPw",     "Wrong username or password."),
                        java.util.Map.entry("creds.tokenMissing","Login response missing token."),
                        java.util.Map.entry("creds.refused",     "Account refused (license / role)."),
                        java.util.Map.entry("creds.connectFailed","Connect failed: {reason}"),
                        java.util.Map.entry("worker.loadFailed",  "Failed to load Coordinator UI: {reason}")
                ),
                "ko", java.util.Map.ofEntries(
                        java.util.Map.entry("url.title",       "Coordinator 에 연결"),
                        java.util.Map.entry("url.hint",        "Coordinator URL 을 입력해 주세요. 자격 증명 입력 전에 연결 가능 여부를 확인합니다."),
                        java.util.Map.entry("url.field",       "Coordinator URL"),
                        java.util.Map.entry("url.placeholder", "http://192.168.x.x:8080"),
                        java.util.Map.entry("url.test",        "연결 테스트"),
                        java.util.Map.entry("url.probing",     "{url} 확인 중…"),
                        java.util.Map.entry("url.required",    "Coordinator URL 을 입력하세요."),
                        java.util.Map.entry("url.unreachable", "{url} 에 도달할 수 없습니다 (호스트 미응답 / 방화벽)."),
                        java.util.Map.entry("url.timeout",     "{url} 연결 시간이 초과됐습니다."),
                        java.util.Map.entry("url.probeFailed", "연결 확인 실패: {reason}"),
                        java.util.Map.entry("url.httpStatus",  "Coordinator 가 HTTP {status} 로 응답했습니다."),
                        java.util.Map.entry("creds.title",       "로그인"),
                        java.util.Map.entry("creds.hint",        "master 가 생성해 준 Coordinator 계정으로 로그인하세요."),
                        java.util.Map.entry("creds.coordinator", "Coordinator: {url}"),
                        java.util.Map.entry("creds.username",    "사용자명"),
                        java.util.Map.entry("creds.usernamePh",  "username"),
                        java.util.Map.entry("creds.password",    "비밀번호"),
                        java.util.Map.entry("creds.passwordPh",  "password"),
                        java.util.Map.entry("creds.signIn",      "로그인"),
                        java.util.Map.entry("creds.signingIn",   "로그인 중…"),
                        java.util.Map.entry("creds.changeUrl",   "← URL 변경"),
                        java.util.Map.entry("creds.required",    "사용자명과 비밀번호를 모두 입력하세요."),
                        java.util.Map.entry("creds.wrongPw",     "사용자명 또는 비밀번호가 잘못됐습니다."),
                        java.util.Map.entry("creds.tokenMissing","로그인 응답에 토큰이 없습니다."),
                        java.util.Map.entry("creds.refused",     "계정이 거부됐습니다 (라이선스 / 권한)."),
                        java.util.Map.entry("creds.connectFailed","연결 실패: {reason}"),
                        java.util.Map.entry("worker.loadFailed",  "Coordinator UI 로드 실패: {reason}")
                ),
                "ja", java.util.Map.ofEntries(
                        java.util.Map.entry("url.title",       "Coordinator に接続"),
                        java.util.Map.entry("url.hint",        "Coordinator の URL を入力してください。認証情報を入力する前に接続を確認します。"),
                        java.util.Map.entry("url.field",       "Coordinator URL"),
                        java.util.Map.entry("url.placeholder", "http://192.168.x.x:8080"),
                        java.util.Map.entry("url.test",        "接続テスト"),
                        java.util.Map.entry("url.probing",     "{url} を確認中…"),
                        java.util.Map.entry("url.required",    "Coordinator URL を入力してください。"),
                        java.util.Map.entry("url.unreachable", "{url} に到達できません (ホスト未応答 / ファイアウォール)。"),
                        java.util.Map.entry("url.timeout",     "{url} への接続がタイムアウトしました。"),
                        java.util.Map.entry("url.probeFailed", "接続確認に失敗しました: {reason}"),
                        java.util.Map.entry("url.httpStatus",  "Coordinator が HTTP {status} を返しました。"),
                        java.util.Map.entry("creds.title",       "サインイン"),
                        java.util.Map.entry("creds.hint",        "master が発行した Coordinator アカウントでサインインしてください。"),
                        java.util.Map.entry("creds.coordinator", "Coordinator: {url}"),
                        java.util.Map.entry("creds.username",    "ユーザー名"),
                        java.util.Map.entry("creds.usernamePh",  "username"),
                        java.util.Map.entry("creds.password",    "パスワード"),
                        java.util.Map.entry("creds.passwordPh",  "password"),
                        java.util.Map.entry("creds.signIn",      "サインイン"),
                        java.util.Map.entry("creds.signingIn",   "サインイン中…"),
                        java.util.Map.entry("creds.changeUrl",   "← URL を変更"),
                        java.util.Map.entry("creds.required",    "ユーザー名とパスワードを入力してください。"),
                        java.util.Map.entry("creds.wrongPw",     "ユーザー名またはパスワードが正しくありません。"),
                        java.util.Map.entry("creds.tokenMissing","ログイン応答にトークンがありません。"),
                        java.util.Map.entry("creds.refused",     "アカウントが拒否されました (ライセンス / 権限)。"),
                        java.util.Map.entry("creds.connectFailed","接続失敗: {reason}"),
                        java.util.Map.entry("worker.loadFailed",  "Coordinator UI の読み込みに失敗: {reason}")
                )
        );

        static String currentLang() {
            String p = System.getProperty("mpd.default-lang");
            if ("ko".equals(p) || "ja".equals(p) || "en".equals(p)) return p;
            String jvm = java.util.Locale.getDefault().getLanguage();
            if ("ko".equals(jvm) || "ja".equals(jvm)) return jvm;
            return "en";
        }

        static String t(String key) {
            java.util.Map<String, String> dict = DICT.getOrDefault(currentLang(), DICT.get("en"));
            String s = dict.get(key);
            return s == null ? key : s;
        }

        static String t(String key, java.util.Map<String, Object> vars) {
            String s = t(key);
            for (var e : vars.entrySet()) {
                s = s.replace("{" + e.getKey() + "}", String.valueOf(e.getValue()));
            }
            return s;
        }
    }

    /** Worker -- no Spring, no PG. Connect form first, then WebView. */
    public static class WorkerApp extends Application {
        private final HttpClient http = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(5)).build();
        private final ObjectMapper mapper = new ObjectMapper();
        private volatile String jwt;
        /** Full /api/v1/auth/login response.data — username, role, expiresAt,
         *  lastSignInAt. Used to seed the WebView's localStorage so the user
         *  doesn't have to sign in twice (once in the JavaFX form, once
         *  in the React UI). */
        private volatile JsonNode authData;
        private Stage stage;
        private BorderPane root;
        private Thread heartbeatThread;
        /** 현재 연결된 Coordinator URL + 로그인 username. 창 X 닫기 시 backend
         *  logout 을 보내거나 React Sign out 후 credentials 화면으로 돌아갈 때 쓴다. */
        private volatile String coordUrl;
        private volatile String username;
        /** Spring 은 한 프로세스에서 한 번만 부팅. React Sign out 후 재 login 으로
         *  swapToWebView 가 다시 불려도 Spring 컨텍스트는 그대로 재사용. credentials 가
         *  바뀌었으면 사용자가 앱 재시작해야 새 credentials 가 datasource / WorkerBootstrap 에 적용. */
        private final java.util.concurrent.atomic.AtomicBoolean springStarted =
                new java.util.concurrent.atomic.AtomicBoolean(false);

        /** backend 세션 정리 — currentSessionId 를 null 로. 실패해도 무시 (best-effort). */
        private void serverLogout() {
            if (jwt == null || coordUrl == null) return;
            try { post(coordUrl, "/api/v1/auth/logout", "{}", true); }
            catch (Exception e) { System.out.println("worker logout failed: " + e.getMessage()); }
        }

        public static void launch(String[] args) {
            Application.launch(WorkerApp.class, args);
        }

        @Override
        public void start(Stage stage) {
            this.stage = stage;
            root = new BorderPane();
            // Match the React app's brand font. If Hoax Mono JP isn't installed
            // on the host, JavaFX falls back to sans-serif which still keeps
            // the wizard legible.
            root.setStyle("-fx-font-family: 'Hoax Mono JP', 'Segoe UI', sans-serif;"
                    + " -fx-background-color: #f9fafb;");
            stage.setTitle("ModernizeProData — Worker");
            tryLoadIcon(stage);
            stage.setScene(new Scene(root, 1200, 760));
            applyStandardWindowChrome(stage);
            stage.setOnCloseRequest(e -> {
                // 창 닫을 때 backend 세션 정리 (best-effort, 짧은 timeout 의 동기 호출).
                serverLogout();
                Platform.exit();
                System.exit(0);
            });
            stage.show();
            stage.centerOnScreen();

            // Coordinator URL is now entered in-app on every first boot;
            // installer no longer collects it.
            String coordUrl = System.getProperty("modernize.coordinator.url", "");
            showUrlStep(coordUrl, null);
        }

        // ---- Brand palette (mirrors React's CSS variables in index.css). ----
        // Keep these in sync with frontend/src/index.css :root --bg / --panel /
        // --navy / --green / --text-* / --border* / --red* if those values
        // change.  The React light theme uses --navy = #0e7268 (teal navy);
        // the previous WorkerApp value (#1c3d5a deep blue) was off-brand.
        private static final String C_BG            = "#f9fafb";
        private static final String C_PANEL         = "#ffffff";
        private static final String C_NAVY          = "#0e7268";
        private static final String C_NAVY_HOVER    = "#0a5850";
        private static final String C_GREEN         = "#0c9e6a";
        private static final String C_BORDER        = "#dae3e0";
        private static final String C_BORDER_STRONG = "#b8cec9";
        private static final String C_TEXT          = "#0c1f1b";
        private static final String C_MUTED         = "#678b86";
        private static final String C_RED           = "#c42f2f";
        private static final String C_RED_BG        = "#fce6e6";

        /** Build the LoginPage-style outer column (logo + brand text + card +
         *  footer). The card body is whatever the caller hands in. */
        private VBox brandColumn(VBox card) {
            VBox brandBlock = new VBox(8);
            brandBlock.setAlignment(Pos.CENTER);
            try {
                java.io.InputStream is = Launcher.class.getResourceAsStream("/icons/mpd.png");
                if (is != null) {
                    javafx.scene.image.ImageView iv = new javafx.scene.image.ImageView(new Image(is));
                    iv.setFitWidth(56); iv.setFitHeight(56);
                    brandBlock.getChildren().add(iv);
                }
            } catch (Exception ignored) {}
            // "ModernizePro" + green "Data" — mirrors React BrandName component.
            javafx.scene.text.Text brandFirst = new javafx.scene.text.Text("ModernizePro");
            brandFirst.setStyle("-fx-fill: " + C_TEXT + "; -fx-font-size: 24px; -fx-font-weight: 700;");
            javafx.scene.text.Text brandAccent = new javafx.scene.text.Text("Data");
            brandAccent.setStyle("-fx-fill: " + C_GREEN + "; -fx-font-size: 24px; -fx-font-weight: 700;");
            javafx.scene.text.TextFlow brand = new javafx.scene.text.TextFlow(brandFirst, brandAccent);
            brand.setStyle("-fx-text-alignment: center;");
            brand.setTextAlignment(javafx.scene.text.TextAlignment.CENTER);
            brandBlock.getChildren().add(brand);

            Label footer = new Label("© KS Info System Co., Ltd.   v0.1.0-dev");
            footer.setStyle("-fx-font-size: 12px; -fx-text-fill: " + C_MUTED + ";");

            VBox column = new VBox(22, brandBlock, card, footer);
            column.setAlignment(Pos.CENTER);
            column.setMaxWidth(420);
            column.setPrefWidth(420);
            return column;
        }

        private VBox makeCard(String cardTitleText, String cardHintText) {
            Label cardTitle = new Label(cardTitleText);
            cardTitle.setStyle("-fx-font-size: 15px; -fx-font-weight: 700; -fx-text-fill: " + C_NAVY + ";");

            VBox card = new VBox(14);
            card.setStyle(
                "-fx-background-color: " + C_PANEL + ";" +
                "-fx-border-color: " + C_BORDER + ";" +
                "-fx-border-radius: 6;" +
                "-fx-background-radius: 6;" +
                "-fx-padding: 24;");
            card.setMaxWidth(420);
            card.setPrefWidth(420);
            card.setFillWidth(true);
            card.getChildren().add(cardTitle);
            if (cardHintText != null && !cardHintText.isEmpty()) {
                Label hint = new Label(cardHintText);
                hint.setStyle("-fx-font-size: 12px; -fx-text-fill: " + C_MUTED + "; -fx-wrap-text: true;");
                hint.setWrapText(true);
                card.getChildren().add(hint);
            }
            return card;
        }

        private VBox labeledField(String labelText, javafx.scene.control.Control field) {
            Label l = new Label(labelText);
            l.setStyle("-fx-font-size: 13px; -fx-font-weight: 600; -fx-text-fill: " + C_TEXT + ";");
            VBox box = new VBox(6, l, field);
            return box;
        }

        private void styleInput(javafx.scene.control.TextInputControl ctl) {
            ctl.setStyle(
                "-fx-background-color: " + C_PANEL + ";" +
                "-fx-border-color: " + C_BORDER_STRONG + ";" +
                "-fx-border-radius: 4;" +
                "-fx-background-radius: 4;" +
                "-fx-padding: 8 12;" +
                "-fx-font-size: 13px;" +
                "-fx-font-family: 'Hoax Mono JP', 'Consolas', monospace;");
        }

        private Button primaryButton(String text) {
            Button b = new Button(text);
            b.setMaxWidth(Double.MAX_VALUE);
            final String baseStyle =
                "-fx-text-fill: white;" +
                "-fx-font-size: 14px;" +
                "-fx-font-weight: 700;" +
                "-fx-padding: 11 12;" +
                "-fx-background-radius: 4;" +
                "-fx-cursor: hand;";
            b.setStyle("-fx-background-color: " + C_NAVY + ";" + baseStyle);
            b.setOnMouseEntered(e -> b.setStyle("-fx-background-color: " + C_NAVY_HOVER + ";" + baseStyle));
            b.setOnMouseExited(e ->  b.setStyle("-fx-background-color: " + C_NAVY + ";" + baseStyle));
            return b;
        }

        private Label errorLabel(String text) {
            Label l = new Label(text);
            l.setStyle(
                "-fx-background-color: " + C_RED_BG + ";" +
                "-fx-text-fill: " + C_RED + ";" +
                "-fx-border-color: " + C_RED + ";" +
                "-fx-border-radius: 4;" +
                "-fx-background-radius: 4;" +
                "-fx-padding: 8 10;" +
                "-fx-font-size: 12px;" +
                "-fx-wrap-text: true;");
            l.setWrapText(true);
            l.setMaxWidth(Double.MAX_VALUE);
            return l;
        }

        /** Step 1: URL + Test connection. */
        private void showUrlStep(String url, String errorMsg) {
            root.setStyle("-fx-background-color: " + C_BG + ";");

            VBox card = makeCard(WorkerI18n.t("url.title"), WorkerI18n.t("url.hint"));

            TextField urlField = new TextField(url == null ? "" : url);
            urlField.setPromptText(WorkerI18n.t("url.placeholder"));
            styleInput(urlField);

            Button testBtn = primaryButton(WorkerI18n.t("url.test"));
            testBtn.setDefaultButton(true);

            card.getChildren().add(labeledField(WorkerI18n.t("url.field"), urlField));
            if (errorMsg != null) card.getChildren().add(errorLabel(errorMsg));
            card.getChildren().add(testBtn);

            testBtn.setOnAction(ev -> {
                String u = urlField.getText().trim();
                if (u.isEmpty()) {
                    showUrlStep(url, WorkerI18n.t("url.required"));
                    return;
                }
                testBtn.setDisable(true);
                testBtn.setText(WorkerI18n.t("url.probing", java.util.Map.of("url", u)));
                new Thread(() -> {
                    String err = tryHealthProbe(u);
                    Platform.runLater(() -> {
                        if (err == null) {
                            persistRegistry(u, null, null);
                            showCredentialsStep(u, "", null);
                        } else {
                            showUrlStep(u, err);
                        }
                    });
                }, "worker-url-test").start();
            });

            VBox column = brandColumn(card);
            BorderPane wrap = new BorderPane(column);
            wrap.setStyle("-fx-background-color: " + C_BG + "; -fx-padding: 20;");
            root.setCenter(wrap);
        }

        /** Step 2: username + password + Sign in. URL is locked at the top. */
        private void showCredentialsStep(String url, String username, String errorMsg) {
            root.setStyle("-fx-background-color: " + C_BG + ";");

            VBox card = makeCard(WorkerI18n.t("creds.title"), WorkerI18n.t("creds.hint"));

            Label urlLine = new Label(WorkerI18n.t("creds.coordinator", java.util.Map.of("url", url)));
            urlLine.setStyle("-fx-font-size: 11.5px; -fx-text-fill: " + C_MUTED + "; -fx-font-family: 'Hoax Mono JP', monospace;");
            card.getChildren().add(urlLine);

            TextField userField = new TextField(username == null ? "" : username);
            userField.setPromptText(WorkerI18n.t("creds.usernamePh"));
            styleInput(userField);

            PasswordField pwField = new PasswordField();
            pwField.setPromptText(WorkerI18n.t("creds.passwordPh"));
            styleInput(pwField);

            Button loginBtn = primaryButton(WorkerI18n.t("creds.signIn"));
            loginBtn.setDefaultButton(true);

            Button backBtn = new Button(WorkerI18n.t("creds.changeUrl"));
            backBtn.setStyle(
                "-fx-background-color: transparent;" +
                "-fx-border-color: " + C_BORDER_STRONG + ";" +
                "-fx-text-fill: " + C_MUTED + ";" +
                "-fx-font-size: 12px;" +
                "-fx-padding: 9 12;" +
                "-fx-background-radius: 4;" +
                "-fx-border-radius: 4;" +
                "-fx-cursor: hand;");
            backBtn.setMaxWidth(Double.MAX_VALUE);

            card.getChildren().addAll(
                labeledField(WorkerI18n.t("creds.username"), userField),
                labeledField(WorkerI18n.t("creds.password"), pwField));
            if (errorMsg != null) card.getChildren().add(errorLabel(errorMsg));
            card.getChildren().addAll(loginBtn, backBtn);

            backBtn.setOnAction(ev -> showUrlStep(url, null));
            loginBtn.setOnAction(ev -> {
                String n = userField.getText().trim();
                String p = pwField.getText();
                if (n.isEmpty() || p.isEmpty()) {
                    showCredentialsStep(url, n, WorkerI18n.t("creds.required"));
                    return;
                }
                loginBtn.setDisable(true);
                loginBtn.setText(WorkerI18n.t("creds.signingIn"));
                new Thread(() -> {
                    String err = tryLogin(url, n, p);
                    Platform.runLater(() -> {
                        if (err == null) {
                            swapToWebView(url, n, p);
                        } else {
                            showCredentialsStep(url, n, err);
                        }
                    });
                }, "worker-login").start();
            });

            VBox column = brandColumn(card);
            BorderPane wrap = new BorderPane(column);
            wrap.setStyle("-fx-background-color: " + C_BG + "; -fx-padding: 20;");
            root.setCenter(wrap);
        }

        /** Anonymous health probe to verify a URL before asking for credentials. */
        private String tryHealthProbe(String coordUrl) {
            try {
                String base = coordUrl.endsWith("/")
                        ? coordUrl.substring(0, coordUrl.length() - 1)
                        : coordUrl;
                HttpRequest req = HttpRequest.newBuilder()
                        .uri(URI.create(base + "/api/v1/health"))
                        .timeout(Duration.ofSeconds(5))
                        .GET()
                        .build();
                HttpResponse<String> resp = http.send(req, HttpResponse.BodyHandlers.ofString());
                if (resp.statusCode() / 100 != 2) {
                    return WorkerI18n.t("url.httpStatus", java.util.Map.of("status", resp.statusCode()));
                }
                return null;
            } catch (java.net.ConnectException ce) {
                return WorkerI18n.t("url.unreachable", java.util.Map.of("url", coordUrl));
            } catch (java.net.http.HttpTimeoutException te) {
                return WorkerI18n.t("url.timeout", java.util.Map.of("url", coordUrl));
            } catch (Exception e) {
                String reason = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
                return WorkerI18n.t("url.probeFailed", java.util.Map.of("reason", reason));
            }
        }

        private Label makeLabel(String text) {
            Label l = new Label(text);
            l.setStyle("-fx-font-size: 12px; -fx-text-fill: #1c3d5a;");
            return l;
        }

        /** Returns null on success, else a human-friendly error message. */
        private String tryLogin(String coordUrl, String username, String password) {
            try {
                String body = "{\"username\":\"" + esc(username) + "\","
                        + "\"password\":\"" + esc(password) + "\"}";
                JsonNode res = post(coordUrl, "/api/v1/auth/login", body, false);
                String token = res.path("data").path("token").asText(null);
                if (token == null || token.isBlank()) return WorkerI18n.t("creds.tokenMissing");
                jwt = token;
                authData = res.path("data");
                return null;
            } catch (java.net.ConnectException ce) {
                return WorkerI18n.t("url.unreachable", java.util.Map.of("url", coordUrl));
            } catch (java.net.http.HttpTimeoutException te) {
                return WorkerI18n.t("url.timeout", java.util.Map.of("url", coordUrl));
            } catch (Exception e) {
                String m = e.getMessage();
                if (m != null && m.startsWith("HTTP 401")) return WorkerI18n.t("creds.wrongPw");
                if (m != null && m.startsWith("HTTP 403")) return WorkerI18n.t("creds.refused");
                String reason = m == null ? e.getClass().getSimpleName() : m;
                return WorkerI18n.t("creds.connectFailed", java.util.Map.of("reason", reason));
            }
        }

        /** Persist the URL (only) so the next launch pre-fills it. Username
         *  and password are typed in every launch and never stored. */
        private void persistRegistry(String url, String username, String password) {
            try {
                runReg("CoordinatorUrl", url);
                System.setProperty("modernize.coordinator.url", url);
            } catch (Exception e) {
                System.err.println("Failed to update HKCU: " + e.getMessage());
            }
        }

        private void runReg(String name, String value) throws Exception {
            new ProcessBuilder(
                    "reg", "add", "HKCU\\Software\\ModernizeProData",
                    "/v", name, "/t", "REG_SZ", "/d", value, "/f"
            ).redirectErrorStream(true).start().waitFor();
        }

        /** Swap the form for a WebView pointed at the Coordinator UI + start
         *  the Spring worker backend (분산 실행).
         *
         *  <p>2026-05-29 변경: 기존엔 Spring 안 띄우고 JavaFX-side 의 selfRegister/heartbeat
         *  만 돌렸다. 분산 실행 (RUN_START WS push → executeRun) 을 위해서는 Spring
         *  컨텍스트가 떠 있어야 WorkerBootstrap + STOMP subscribe + RunExecutionListener 가
         *  살아난다. 그래서 credentials 확정 후 SpringApplicationBuilder 로 backend 시작.
         *  selfRegister/heartbeat 은 Spring WorkerBootstrap 이 담당. */
        private void swapToWebView(String coordUrl, String username, String password) {
            this.coordUrl = coordUrl;
            this.username = username;

            // ── Spring 부팅 전: wizard 입력값을 system property 로 박아 application-worker.yml
            //    의 ${COORDINATOR_URL} / ${WORKER_USERNAME} / ${WORKER_PASSWORD} /
            //    ${COORDINATOR_DB_URL} / ${WORKER_HOSTNAME} placeholder 가 채워지게 한다.
            String host = "localhost";
            try {
                java.net.URI u = new java.net.URI(coordUrl);
                if (u.getHost() != null) host = u.getHost();
            } catch (Exception ignored) {}
            String hostname = "worker-pc";
            try { hostname = InetAddress.getLocalHost().getHostName(); }
            catch (Exception ignored) {}

            System.setProperty("modernize.coordinator.url", coordUrl);
            System.setProperty("COORDINATOR_URL",     coordUrl);
            System.setProperty("WORKER_USERNAME",     username);
            System.setProperty("WORKER_PASSWORD",     password);
            System.setProperty("WORKER_HOSTNAME",     hostname);
            // Coordinator app 과 메타 PG 가 같은 host 라는 가정 — 다른 host 면 운영자가
            // 환경 변수 COORDINATOR_DB_URL 으로 override (Launcher 가 set 한 뒤라도
            // Spring 의 -D > 환경 변수 우선순위 따라 envvar 가 이김).
            System.setProperty("COORDINATOR_DB_URL",
                    "jdbc:postgresql://" + host + ":5432/mpd_meta");
            // spring.profiles.active 는 jpackage args 의 --java-options 에서 prod,worker 로
            // 이미 박혔다. 추가 설정 불요.

            // ── Spring 시작 (background thread). PG 접속 실패 등은 launcher.log 에서 확인.
            //    프로세스 수명 동안 1회만 — 재 login 시 Spring 재시작은 사용자 manual.
            if (springStarted.compareAndSet(false, true)) {
                new Thread(() -> {
                    try {
                        new SpringApplicationBuilder(ModernizeProDataApplication.class)
                                .headless(false)
                                .run();
                    } catch (Exception e) {
                        System.err.println("Worker Spring boot failed: " + e.getMessage());
                        e.printStackTrace();
                    }
                }, "worker-spring-boot").start();
            }

            WebView webView = new WebView();
            wireFreshUserData(webView);
            wireJsDialogs(webView.getEngine(), stage);

            // worker 의 로그아웃은 WebView 안 React 의 "Sign out" 하나로 통일.
            // React 가 Sign out → authApi.logout() (backend 세션 정리) → /login 으로
            // 이동하는데, JavaFX 쪽 heartbeat 가 살아 있으면 60초 후 401 → 자동
            // 재로그인으로 세션이 되살아난다. 그래서 WebView 가 /login 으로 가는
            // 순간 (단, 한 번 앱에 진입한 뒤) heartbeat 를 끊고 credentials 화면으로
            // 되돌린다. reachedApp 플래그로 초기 부팅 중 잠깐 스치는 /login 은 무시.
            final boolean[] reachedApp = {false};
            webView.getEngine().locationProperty().addListener((o, oldUrl, newUrl) -> {
                System.out.println("WorkerWebView nav: " + newUrl);
                if (newUrl == null || !newUrl.startsWith("http")) return;
                if (newUrl.contains("/login")) {
                    if (reachedApp[0]) {
                        Platform.runLater(() -> {
                            if (heartbeatThread != null) heartbeatThread.interrupt();
                            jwt = null;
                            authData = null;
                            showCredentialsStep(coordUrl, username, null);
                        });
                    }
                } else {
                    reachedApp[0] = true;
                }
            });

            // If the WebView fails to load the Coordinator URL (process died,
            // network dropped mid-handshake, …), bail back to the credentials
            // step with the failure reason — otherwise the user just sees a
            // blank white panel.
            webView.getEngine().getLoadWorker().stateProperty().addListener((o, oldS, newS) -> {
                if (newS == javafx.concurrent.Worker.State.FAILED) {
                    Throwable ex = webView.getEngine().getLoadWorker().getException();
                    String reason = ex == null ? "unknown"
                            : (ex.getMessage() == null ? ex.getClass().getSimpleName() : ex.getMessage());
                    Platform.runLater(() -> {
                        if (heartbeatThread != null) heartbeatThread.interrupt();
                        showCredentialsStep(coordUrl, username,
                                WorkerI18n.t("worker.loadFailed", java.util.Map.of("reason", reason)));
                    });
                }
            });

            root.setCenter(webView);
            // Cache-bust so a previously-blocked LICENSE_MISSING response can't
            // be served by the WebView cache. bootstrap_* params hand the
            // JWT/user info from the JavaFX form's login over to the React
            // app's zustand store (read by src/bootstrap-from-url.ts) so
            // the user doesn't have to sign in a second time.
            String sep = coordUrl.contains("?") ? "&" : "?";
            String bootstrap = buildBootstrapQuery();
            webView.getEngine().load(coordUrl + sep + "_=" + System.currentTimeMillis() + bootstrap);

            // selfRegister / heartbeat 은 Spring WorkerBootstrap 이 담당 (분산 실행 모드).
            // 401 시 자동 재로그인도 WorkerBootstrap 의 heartbeat loop 에서 처리.
            // 영구 credential 변경 같은 hard-fail 케이스는 운영자가 manual restart.
        }

        private JsonNode post(String coordUrl, String path, String body, boolean authed) throws Exception {
            String base = coordUrl.endsWith("/") ? coordUrl.substring(0, coordUrl.length() - 1) : coordUrl;
            HttpRequest.Builder rb = HttpRequest.newBuilder()
                    .uri(URI.create(base + path))
                    .timeout(Duration.ofSeconds(10))
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(body));
            if (authed && jwt != null) rb.header("Authorization", "Bearer " + jwt);
            HttpResponse<String> resp = http.send(rb.build(), HttpResponse.BodyHandlers.ofString());
            if (resp.statusCode() / 100 != 2) {
                throw new RuntimeException("HTTP " + resp.statusCode() + ": " + resp.body());
            }
            return mapper.readTree(resp.body());
        }

        private static String esc(String s) {
            return s.replace("\\", "\\\\").replace("\"", "\\\"");
        }

        /** Encode the JWT + user info from tryLogin() as URL query params
         *  for handoff to the WebView. Read by src/bootstrap-from-url.ts.
         *  Returns "" (no params) if we somehow don't have auth data yet. */
        private String buildBootstrapQuery() {
            if (jwt == null || authData == null) return "";
            try {
                String username = authData.path("username").asText("");
                String role = authData.path("role").asText("");
                String exp = authData.path("expiresAt").asText("");
                String last = authData.path("lastSignInAt").asText("");
                String userJson = "{\"username\":\"" + esc(username) + "\",\"role\":\"" + esc(role) + "\"}";
                return "&bootstrap_token=" + enc(jwt)
                        + "&bootstrap_user=" + enc(userJson)
                        + "&bootstrap_exp=" + enc(exp)
                        + "&bootstrap_last=" + enc(last);
            } catch (Exception e) {
                System.out.println("buildBootstrapQuery failed: " + e.getMessage());
                return "";
            }
        }

        private static String enc(String s) {
            return java.net.URLEncoder.encode(s, java.nio.charset.StandardCharsets.UTF_8);
        }
    }
}
