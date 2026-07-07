package com.ksinfo.modernize_pro_data.launcher;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.ksinfo.modernize_pro_data.ModernizeProDataBridgeApplication;
import javafx.application.Application;
import javafx.application.Platform;
import javafx.geometry.Pos;
import javafx.scene.Scene;
import javafx.scene.control.Button;
import javafx.scene.control.Label;
import javafx.scene.control.PasswordField;
import javafx.scene.control.TextField;
import javafx.scene.image.Image;
import javafx.scene.layout.BorderPane;
import javafx.scene.layout.VBox;
import javafx.stage.Stage;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.builder.SpringApplicationBuilder;
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

        // pending update 있으면 jar / host swap (Spring 부팅 전). 실패는 silent log.
        UpdateApplier.applyPendingIfAny();

        if (Boolean.getBoolean("mpd.gui.enabled")) {
            String mode = System.getProperty("MPD_MODE", "coordinator");
            if ("worker".equalsIgnoreCase(mode)) {
                WorkerApp.launch(args);
            } else {
                // 2026-05-30 — Coordinator GUI 를 JavaFX WebView (옛 WebKit) 에서 JCEF
                // (Chromium) 기반 Swing 으로 교체. modern React 앱 안정 + crash 차단.
                new SwingGuiApp().start(args);
            }
        } else {
            SpringApplication app = new SpringApplication(ModernizeProDataBridgeApplication.class);
            app.setHeadless(false);
            app.run(args);
        }
    }

    /** GUI-only diagnostics: jpackage's WinExe drops stdout/stderr by default,
     *  so we redirect both to %LOCALAPPDATA%\ModernizeProDataBridge\launcher.log.
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
            File dir = new File(localAppData, "ModernizeProDataBridge");
            if (!dir.exists() && !dir.mkdirs()) return;
            File log = new File(dir, "launcher.log");
            PrintStream ps = new PrintStream(new FileOutputStream(log, true), true);
            System.setOut(ps);
            System.setErr(ps);
            System.out.println("=== launcher start " + java.time.OffsetDateTime.now() + " ===");
        } catch (Exception ignored) {}
    }

    // wireFreshUserData 제거 (2026-05-30) — JavaFX WebView 폐기. Edge `--app` 의
    // --user-data-dir 가 동일 역할 (EdgeAppLauncher 안).

    private static void readInstallerChoicesFromRegistry() {
        if (!System.getProperty("os.name", "").toLowerCase().contains("win")) return;
        try {
            Process p = new ProcessBuilder(
                    "reg", "query", "HKCU\\Software\\ModernizeProDataBridge"
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

    // wireJsDialogs / wireJavaBridge / JavaConnector / loadingHtml 모두 제거 (2026-05-30).
    // 옛 JavaFX WebView 의 JS dialog handler / license file bridge — Edge `--app` 의 Chromium
    // 가 native dialog + file input 직접 처리.

    // Coordinator / Standalone GUI = SwingGuiApp (2026-05-30).

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
                        java.util.Map.entry("url.checkUpdates",      "Check for updates"),
                        java.util.Map.entry("url.checkingUpdates",   "Checking for updates…"),
                        java.util.Map.entry("url.update.availableTitle", "Update available"),
                        java.util.Map.entry("url.update.availableBody",  "A newer version ({latest}) is available (current: {current}). The new binary is being downloaded in the background. Restart this application once to finish applying."),
                        java.util.Map.entry("url.update.upToDateTitle",  "Up to date"),
                        java.util.Map.entry("url.update.upToDateBody",   "Current version {current} is the latest."),
                        java.util.Map.entry("url.update.failTitle",      "Update check failed"),
                        java.util.Map.entry("url.update.failBody",       "Could not reach the update server. If you are on a closed network, this is expected."),
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
                        java.util.Map.entry("worker.loadFailed",  "Failed to load Coordinator UI: {reason}"),
                        java.util.Map.entry("instance.alreadyTitle", "Already running"),
                        java.util.Map.entry("instance.alreadyBody",  "Another ModernizeProDataBridge Worker instance is already running on this PC. Close it first (check Task Manager for java.exe if no window is visible), then launch again.")
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
                        java.util.Map.entry("url.checkUpdates",      "업데이트 확인"),
                        java.util.Map.entry("url.checkingUpdates",   "업데이트 확인 중…"),
                        java.util.Map.entry("url.update.availableTitle", "업데이트 가능"),
                        java.util.Map.entry("url.update.availableBody",  "새 버전 {latest} 이 있습니다 (현재: {current}). 새 binary 는 백그라운드에서 다운로드 중입니다. 도구를 한 번 재실행하시면 적용이 완료됩니다."),
                        java.util.Map.entry("url.update.upToDateTitle",  "최신 상태"),
                        java.util.Map.entry("url.update.upToDateBody",   "현재 버전 {current} 이 최신입니다."),
                        java.util.Map.entry("url.update.failTitle",      "업데이트 확인 실패"),
                        java.util.Map.entry("url.update.failBody",       "업데이트 서버에 연결할 수 없습니다. 폐쇄망 환경이라면 정상입니다."),
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
                        java.util.Map.entry("worker.loadFailed",  "Coordinator UI 로드 실패: {reason}"),
                        java.util.Map.entry("instance.alreadyTitle", "이미 실행 중"),
                        java.util.Map.entry("instance.alreadyBody",  "이 PC 에서 ModernizeProDataBridge Worker 가 이미 실행 중입니다. 먼저 종료한 뒤 다시 실행하세요 (창이 안 보이면 작업관리자에서 java.exe 확인).")
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
                        java.util.Map.entry("url.checkUpdates",      "更新を確認"),
                        java.util.Map.entry("url.checkingUpdates",   "更新を確認中…"),
                        java.util.Map.entry("url.update.availableTitle", "更新あり"),
                        java.util.Map.entry("url.update.availableBody",  "新しいバージョン {latest} があります (現在: {current})。バックグラウンドで新しい binary をダウンロード中です。アプリを一度再起動すると適用が完了します。"),
                        java.util.Map.entry("url.update.upToDateTitle",  "最新"),
                        java.util.Map.entry("url.update.upToDateBody",   "現在のバージョン {current} が最新です。"),
                        java.util.Map.entry("url.update.failTitle",      "更新確認に失敗"),
                        java.util.Map.entry("url.update.failBody",       "更新サーバーに到達できませんでした。閉じたネットワーク環境では正常です。"),
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
                        java.util.Map.entry("worker.loadFailed",  "Coordinator UI の読み込みに失敗: {reason}"),
                        java.util.Map.entry("instance.alreadyTitle", "すでに実行中"),
                        java.util.Map.entry("instance.alreadyBody",  "この PC では ModernizeProDataBridge Worker がすでに実行中です。先に終了してから再起動してください (ウィンドウが見えない場合はタスクマネージャーで java.exe を確認)。")
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

        /** 다중 실행 차단 — Worker 프로세스 단일 인스턴스 보장 (2026-06-03).
         *  %LOCALAPPDATA%\ModernizeProDataBridge\worker.lock 에 OS file lock 을 잡고
         *  프로세스 수명 동안 유지 (static 참조로 GC 방지, 프로세스 종료 시 OS 가
         *  자동 해제 — 좀비/크래시에도 stale lock 안 남음). 두 번째 인스턴스는
         *  tryLock 실패 → 안내 후 즉시 종료. port 8081 충돌의 2차 방어선. */
        private static java.nio.channels.FileChannel instanceLockChannel;
        private static java.nio.channels.FileLock instanceLock;

        private static boolean acquireSingleInstanceLock() {
            try {
                String localAppData = System.getenv("LOCALAPPDATA");
                File dir = new File(
                        (localAppData == null || localAppData.isBlank())
                                ? System.getProperty("java.io.tmpdir") : localAppData,
                        "ModernizeProDataBridge");
                if (!dir.exists() && !dir.mkdirs()) return true; // lock 불가 환경 — 차단하지 않음
                File lockFile = new File(dir, "worker.lock");
                instanceLockChannel = java.nio.channels.FileChannel.open(
                        lockFile.toPath(),
                        java.nio.file.StandardOpenOption.CREATE,
                        java.nio.file.StandardOpenOption.WRITE);
                instanceLock = instanceLockChannel.tryLock();
                if (instanceLock == null) {
                    System.out.println("worker single-instance lock held by another process — exiting");
                    return false;
                }
                return true;
            } catch (Exception e) {
                // lock 메커니즘 자체 실패 (권한 등) 는 실행 차단 사유가 아님.
                System.out.println("worker instance lock skipped: " + e.getMessage());
                return true;
            }
        }

        @Override
        public void start(Stage stage) {
            if (!acquireSingleInstanceLock()) {
                javafx.scene.control.Alert a =
                        new javafx.scene.control.Alert(javafx.scene.control.Alert.AlertType.WARNING);
                a.setTitle("ModernizeProDataBridge");
                a.setHeaderText(WorkerI18n.t("instance.alreadyTitle"));
                a.setContentText(WorkerI18n.t("instance.alreadyBody"));
                a.showAndWait();
                Platform.exit();
                System.exit(0);
                return;
            }
            this.stage = stage;
            root = new BorderPane();
            // Match the React app's brand font. If Hoax Mono JP isn't installed
            // on the host, JavaFX falls back to sans-serif which still keeps
            // the wizard legible.
            root.setStyle("-fx-font-family: 'Hoax Mono JP', 'Segoe UI', sans-serif;"
                    + " -fx-background-color: #f9fafb;");
            stage.setTitle("ModernizeProDataBridge — Worker");
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

            // 버전 단일 소스 — jpackage 가 --java-options 로 박은 modernize.version
            // (build.ps1 auto-bump). dev 콘솔 실행 등 미설정 시 "dev".
            Label footer = new Label("© KS Info System Co., Ltd.   v"
                    + System.getProperty("modernize.version", "dev"));
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

            // Check for updates — ghost button. click → 별 thread 에서 manifest 받기.
            Button updateBtn = new Button(WorkerI18n.t("url.checkUpdates"));
            updateBtn.setMaxWidth(Double.MAX_VALUE);
            updateBtn.setStyle(
                "-fx-background-color: transparent;" +
                "-fx-border-color: " + C_BORDER_STRONG + ";" +
                "-fx-text-fill: " + C_MUTED + ";" +
                "-fx-font-size: 12px;" +
                "-fx-padding: 8 12;" +
                "-fx-background-radius: 4;" +
                "-fx-border-radius: 4;" +
                "-fx-cursor: hand;");
            updateBtn.setOnAction(ev -> {
                updateBtn.setDisable(true);
                updateBtn.setText(WorkerI18n.t("url.checkingUpdates"));
                new Thread(() -> {
                    WorkerUpdateProbe.Result r = WorkerUpdateProbe.probe();
                    Platform.runLater(() -> {
                        updateBtn.setDisable(false);
                        updateBtn.setText(WorkerI18n.t("url.checkUpdates"));
                        showUpdateDialog(r);
                    });
                }, "worker-update-probe").start();
            });

            card.getChildren().add(labeledField(WorkerI18n.t("url.field"), urlField));
            if (errorMsg != null) card.getChildren().add(errorLabel(errorMsg));
            card.getChildren().add(testBtn);
            card.getChildren().add(updateBtn);

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

        /** Update probe 결과 dialog. JavaFX Alert 단순 표시. */
        private void showUpdateDialog(WorkerUpdateProbe.Result r) {
            javafx.scene.control.Alert alert;
            String header;
            String body;
            if (!r.ok) {
                alert = new javafx.scene.control.Alert(javafx.scene.control.Alert.AlertType.WARNING);
                header = WorkerI18n.t("url.update.failTitle");
                body = WorkerI18n.t("url.update.failBody") + "\n\n" + (r.error == null ? "" : r.error);
            } else if (r.updateAvailable) {
                alert = new javafx.scene.control.Alert(javafx.scene.control.Alert.AlertType.INFORMATION);
                header = WorkerI18n.t("url.update.availableTitle");
                body = WorkerI18n.t("url.update.availableBody",
                        java.util.Map.of("current", String.valueOf(r.currentVersion),
                                          "latest",  String.valueOf(r.latestVersion)));
            } else {
                alert = new javafx.scene.control.Alert(javafx.scene.control.Alert.AlertType.INFORMATION);
                header = WorkerI18n.t("url.update.upToDateTitle");
                body = WorkerI18n.t("url.update.upToDateBody",
                        java.util.Map.of("current", String.valueOf(r.currentVersion)));
            }
            alert.setTitle("ModernizeProDataBridge");
            alert.setHeaderText(header);
            alert.setContentText(body);
            alert.showAndWait();
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
                    "reg", "add", "HKCU\\Software\\ModernizeProDataBridge",
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
            // wizard 가 이미 발급받은 JWT 를 WorkerBootstrap 가 재사용 — backend 자체
            // login 시 새 sid 가 발급돼 UI 의 wizard session 을 evict 하는 cycle 회피.
            if (jwt != null) System.setProperty("WORKER_BOOTSTRAP_JWT", jwt);
            // Coordinator app 과 메타 PG 가 같은 host 라는 가정 — 다른 host 면 운영자가
            // 환경 변수 COORDINATOR_DB_URL 으로 override (Launcher 가 set 한 뒤라도
            // Spring 의 -D > 환경 변수 우선순위 따라 envvar 가 이김).
            // port 5432 = installer 동봉 PG (application-prod.yml 과 일치).
            System.setProperty("COORDINATOR_DB_URL",
                    "jdbc:postgresql://" + host + ":5432/mpd_meta");
            // spring.profiles.active 는 jpackage args 의 --java-options 에서 prod,worker 로
            // 이미 박혔다. 추가 설정 불요.

            // ── Spring 시작 (background thread). PG 접속 실패 등은 launcher.log 에서 확인.
            //    프로세스 수명 동안 1회만 — 재 login 시 Spring 재시작은 사용자 manual.
            if (springStarted.compareAndSet(false, true)) {
                new Thread(() -> {
                    try {
                        new SpringApplicationBuilder(ModernizeProDataBridgeApplication.class)
                                .headless(false)
                                .run();
                    } catch (Exception e) {
                        System.err.println("Worker Spring boot failed: " + e.getMessage());
                        e.printStackTrace();
                    }
                }, "worker-spring-boot").start();
            }

            // 2026-05-30 — JavaFX WebView 폐기, OS Edge `--app` (Chromium chrome-less window) 사용.
            // bootstrap_* query 로 JWT/user 핸드오프 (React 의 bootstrap-from-url.ts 가 read).
            String sep = coordUrl.contains("?") ? "&" : "?";
            String bootstrap = buildBootstrapQuery();
            String fullUrl = coordUrl + sep + "_=" + System.currentTimeMillis() + bootstrap;

            // wizard Stage 숨김 — Edge 가 main UI. taskbar 에 wizard window 도 남지
            // 않도록 hide. Edge 종료 시 backend 도 stop (edge-watcher).
            Platform.runLater(() -> stage.hide());
            Process edgeProc = WebViewHostLauncher.launch(
                    fullUrl,
                    "edge-app-worker",
                    "ModernizeProDataBridge - Worker",
                    WebViewHostLauncher.WORKER_APP_ID);
            if (edgeProc != null) {
                new Thread(() -> {
                    try {
                        edgeProc.waitFor();
                    } catch (InterruptedException ignored) {
                        Thread.currentThread().interrupt();
                        return;
                    }
                    System.out.println("Worker Edge process exited, shutting down");
                    // 2026-06-03 — Platform.runLater() 의존 제거. stage.hide() 후 JavaFX 가
                    // implicitExit 으로 toolkit 을 내려버리면 runLater 콜백이 영영 실행되지
                    // 않아 System.exit 미도달 → Spring JVM 좀비가 port 8081 을 계속 점유
                    // (재실행 시 PortInUseException 무한 루프의 원인). serverLogout 은 plain
                    // HTTP 라 FX thread 불요 — watcher thread 에서 직접 호출 후 즉시 exit.
                    // System.exit 은 Spring Boot 의 shutdown hook 을 발동시켜 context 도
                    // 깨끗이 닫힌다 (Undertow stop + HikariCP shutdown).
                    serverLogout();
                    try { Platform.exit(); } catch (Throwable ignored) { /* toolkit 이미 종료 가능 */ }
                    System.exit(0);
                }, "worker-edge-watcher").start();
            } else {
                // Edge/Chrome 미발견 + default browser fallback. Stage 유지 (Stop 용).
                Platform.runLater(() -> stage.show());
            }

            // selfRegister / heartbeat 은 Spring WorkerBootstrap 이 담당 (분산 실행 모드).
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
