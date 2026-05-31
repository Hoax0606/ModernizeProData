package com.ksinfo.modernize_pro_data.launcher;

import java.awt.Desktop;
import java.io.File;
import java.io.IOException;
import java.net.URI;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;

/**
 * OS 의 Edge / Chrome 의 chrome-less window (--app 모드) launch. SwingGuiApp 과
 * Launcher.WorkerApp 공용.
 *
 * <p>fallback chain:
 * <ol>
 *   <li>Edge (Program Files / Program Files (x86))</li>
 *   <li>Chrome (Program Files / Program Files (x86) / LocalAppData)</li>
 *   <li>Desktop.getDesktop().browse() — 사용자 default browser, 일반 mode</li>
 * </ol>
 *
 * <p>옵션:
 * <ul>
 *   <li>{@code --app=URL} — chrome-less window (no tab / address bar / bookmark)</li>
 *   <li>{@code --user-data-dir=...} — 사용자 일반 Edge profile 과 분리 (cookie/session 격리)</li>
 *   <li>{@code --window-size=1280,800} — 초기 size</li>
 *   <li>{@code --no-first-run} / {@code --no-default-browser-check} — 첫 launch wizard skip</li>
 * </ul>
 */
public final class EdgeAppLauncher {

    private EdgeAppLauncher() {}

    /**
     * chrome-less window 띄움. Edge/Chrome 발견 못 하면 사용자 default browser fallback.
     *
     * @param url            띄울 URL
     * @param profileSubdir  user-data-dir 의 subdir 이름 (예: "edge-app" / "edge-app-worker").
     *                       사용자 home 의 .modernize/<subdir>/ 에 profile 격리.
     * @return launched Process — Edge/Chrome 띄운 경우. fallback (default browser) 또는 fail = null.
     */
    public static Process launch(String url, String profileSubdir) {
        try {
            File userDataDir = new File(System.getProperty("user.home"), ".modernize/" + profileSubdir);
            Files.createDirectories(userDataDir.toPath());
            Process p = launchChromiumApp(url, userDataDir);
            if (p != null) return p;
            // fallback — 일반 default browser.
            openDefaultBrowser(url);
            return null;
        } catch (Throwable e) {
            System.err.println("EdgeAppLauncher.launch failed: " + e.getMessage());
            e.printStackTrace();
            try { openDefaultBrowser(url); } catch (Exception ignored) {}
            return null;
        }
    }

    private static Process launchChromiumApp(String url, File userDataDir) throws IOException {
        List<String> candidates = new ArrayList<>();
        String pf    = System.getenv("ProgramFiles");
        String pf86  = System.getenv("ProgramFiles(x86)");
        String local = System.getenv("LOCALAPPDATA");
        if (pf86  != null) candidates.add(pf86  + "\\Microsoft\\Edge\\Application\\msedge.exe");
        if (pf    != null) candidates.add(pf    + "\\Microsoft\\Edge\\Application\\msedge.exe");
        if (pf86  != null) candidates.add(pf86  + "\\Google\\Chrome\\Application\\chrome.exe");
        if (pf    != null) candidates.add(pf    + "\\Google\\Chrome\\Application\\chrome.exe");
        if (local != null) candidates.add(local + "\\Google\\Chrome\\Application\\chrome.exe");

        for (String path : candidates) {
            File exe = new File(path);
            if (exe.isFile()) {
                System.out.println("EdgeAppLauncher: " + exe.getName() + " --app=" + url);
                return new ProcessBuilder(
                        exe.getAbsolutePath(),
                        "--app=" + url,
                        "--user-data-dir=" + userDataDir.getAbsolutePath(),
                        "--window-size=1280,800",
                        "--no-first-run",
                        "--no-default-browser-check",
                        // password save / autofill prompt 비활성 — 우리 도구의 login
                        // form 이 web service 가 아니므로 browser 의 credential
                        // manager 가 끼어들 필요 없음.
                        // password save / autofill / 다운로드 bubble & shelf / 번역 prompt /
                        // Edge 의 Bing 통합 (사이드바·검색) / recovery dialog 비활성. 도구의
                        // chromeless --app 일관성 — browser chrome UI 가 사용자에게 노출되지 않게.
                        "--disable-features=PasswordManagerOnboarding,"
                                + "AutofillEnableAccountWalletStorage,"
                                + "AutofillServerCommunication,"
                                + "DownloadBubble,DownloadBubbleV2,DownloadShelfNotifier,"
                                + "Translate,TranslateUI,"
                                + "msEdgeBing,EdgeRecovery",
                        "--password-store=basic",
                        "--disable-translate"
                ).redirectErrorStream(true).start();
            }
        }
        return null;
    }

    private static void openDefaultBrowser(String url) {
        try {
            if (Desktop.isDesktopSupported() && Desktop.getDesktop().isSupported(Desktop.Action.BROWSE)) {
                Desktop.getDesktop().browse(URI.create(url));
            }
        } catch (Exception e) {
            System.err.println("openDefaultBrowser failed: " + e.getMessage());
        }
    }
}
