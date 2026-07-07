package com.ksinfo.modernize_pro_data.launcher;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

/**
 * Spawn the bundled {@code ModernizeProDataBridgeUI.exe} (.NET 8 WebView2 host) and
 * return the {@link Process}. Replaces the previous {@link EdgeAppLauncher}.
 *
 * <p>이 host process 는 우리 binary 라 OS taskbar / 우클릭 / AUMID 모두
 * 우리가 결정. Edge `--app` 의 "Microsoft Edge" 브랜드 잔향 제거가 목적.
 *
 * <p>위치 우선순위:
 * <ol>
 *   <li>{@code $APPDIR/ModernizeProDataBridgeUI.exe} (jpackage MSI 설치본)</li>
 *   <li>실행 jar 의 동일 디렉터리 (mvnw spring-boot:run 로컬 검증)</li>
 *   <li>{@code installer/webview-host/dist/ModernizeProDataBridgeUI.exe} (dev fallback)</li>
 * </ol>
 *
 * <p>발견 못 하면 {@link EdgeAppLauncher} 로 fallback (Edge `--app`).
 */
public final class WebViewHostLauncher {

    private WebViewHostLauncher() {}

    public static final String COORDINATOR_APP_ID = "KsInfo.ModernizeProDataBridge.Coordinator";
    public static final String WORKER_APP_ID      = "KsInfo.ModernizeProDataBridge.Worker";

    /**
     * Launch UI host. fallback = Edge `--app` (host 미발견 시).
     *
     * @param url      Spring Boot URL
     * @param profile  user-data subdir 이름
     * @param title    window title
     * @param appId    AppUserModelID
     * @return spawned process, or null if both host and Edge fallback fail.
     */
    public static Process launch(String url, String profile, String title, String appId) {
        File exe = locateHostExe();
        if (exe != null) {
            try {
                List<String> cmd = new ArrayList<>();
                cmd.add(exe.getAbsolutePath());
                cmd.add("--url=" + url);
                cmd.add("--profile=" + profile);
                cmd.add("--title=" + title);
                cmd.add("--app-id=" + appId);
                System.out.println("WebViewHostLauncher: " + exe.getName() + " --url=" + url);
                return new ProcessBuilder(cmd).redirectErrorStream(true).start();
            } catch (IOException e) {
                System.err.println("WebViewHostLauncher: failed to spawn " + exe + ": " + e.getMessage());
            }
        } else {
            System.err.println("WebViewHostLauncher: ModernizeProDataBridgeUI.exe not found. Falling back to Edge `--app`.");
        }
        // fallback — 옛 경로. Edge brand 가 다시 나타나지만 사용성은 유지.
        return EdgeAppLauncher.launch(url, profile);
    }

    private static File locateHostExe() {
        java.util.List<String> candidates = new java.util.ArrayList<>();

        // 1. jpackage layout: launcher exe 의 sibling 인 `app/` subdir 에 위치.
        //    `jpackage.app-path` = launcher exe full path (e.g. <install>\ModernizeProDataBridge.exe).
        String appPath = System.getProperty("jpackage.app-path");
        if (appPath != null) {
            File launcherDir = new File(appPath).getParentFile();
            if (launcherDir != null) {
                candidates.add(new File(launcherDir, "app/ModernizeProDataBridgeUI.exe").getAbsolutePath());
                candidates.add(new File(launcherDir, "ModernizeProDataBridgeUI.exe").getAbsolutePath());
            }
        }

        // 2. java.home 기반 — jpackage runtime image = <install>/runtime. 그 parent 의 app/.
        //    `jpackage.app-path` 가 null 인 일부 경로 (예: Spring Boot launcher class loader) 대비 fallback.
        String javaHome = System.getProperty("java.home");
        if (javaHome != null) {
            File runtimeDir = new File(javaHome);
            File installDir = runtimeDir.getParentFile();
            if (installDir != null) {
                candidates.add(new File(installDir, "app/ModernizeProDataBridgeUI.exe").getAbsolutePath());
            }
        }

        // 3. jar sibling — mvnw spring-boot:run 등 dev path. Spring Boot fat jar 의 classloader 가
        //    nested URL 을 반환하기도 하지만 jpackage build 본은 fat jar 가 그대로 app/ 에 stage 됨.
        candidates.add(jarSiblingExe());

        // 4. dev workspace 절대/상대 fallback
        candidates.add("ModernizeProDataBridge/installer/webview-host/dist/ModernizeProDataBridgeUI.exe");
        candidates.add("installer/webview-host/dist/ModernizeProDataBridgeUI.exe");

        for (String p : candidates) {
            if (p == null) continue;
            File f = new File(p);
            if (f.isFile()) {
                System.out.println("WebViewHostLauncher: located host exe at " + f.getAbsolutePath());
                return f;
            }
        }
        System.err.println("WebViewHostLauncher: tried candidates: " + candidates);
        return null;
    }

    private static String jarSiblingExe() {
        try {
            File jar = new File(WebViewHostLauncher.class.getProtectionDomain()
                    .getCodeSource().getLocation().toURI());
            File dir = jar.getParentFile();
            if (dir == null) return null;
            return new File(dir, "ModernizeProDataBridgeUI.exe").getAbsolutePath();
        } catch (Exception e) {
            return null;
        }
    }
}
