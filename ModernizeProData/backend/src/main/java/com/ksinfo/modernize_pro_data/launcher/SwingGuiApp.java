package com.ksinfo.modernize_pro_data.launcher;

import com.ksinfo.modernize_pro_data.ModernizeProDataApplication;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.context.WebServerInitializedEvent;
import org.springframework.context.ConfigurableApplicationContext;

import javax.swing.ImageIcon;
import javax.swing.JButton;
import javax.swing.JFrame;
import javax.swing.JLabel;
import javax.swing.JPanel;
import javax.swing.JWindow;
import javax.swing.SwingConstants;
import javax.swing.SwingUtilities;
import javax.swing.WindowConstants;
import javax.swing.border.LineBorder;
import java.awt.BorderLayout;
import java.awt.Color;
import java.awt.Component;
import java.awt.Font;
import java.awt.Image;
import java.awt.event.WindowAdapter;
import java.awt.event.WindowEvent;
import java.io.InputStream;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Coordinator / Standalone main GUI — JavaFX WebView (옛 WebKit) 와 JCEF (jpackage 환경
 * 통합 fail) 모두 폐기 후 **OS Edge `--app` chrome-less window** 사용 (2026-05-30).
 *
 * <p>흐름:
 * <ol>
 *   <li>작은 control JFrame 띄움 — 상태 라벨 + Stop 버튼.</li>
 *   <li>Spring Boot background 시작.</li>
 *   <li>Spring ready → Edge / Chrome / fallback browser `--app=http://localhost:8080` launch.</li>
 *   <li>Edge process 별 thread 에서 waitFor — 사용자가 Edge 창 닫으면 backend 도 shutdown.</li>
 *   <li>Control JFrame X 또는 Stop 클릭 → Edge kill + Spring shutdown + exit.</li>
 * </ol>
 *
 * <p>왜 OS Edge?
 * <ul>
 *   <li>Modern Chromium engine — font / icon / WebSocket / polling 안정.</li>
 *   <li>JCEF / JxBrowser native bundle 없음 → MSI 가벼움.</li>
 *   <li>Windows 11 = Edge 자동 설치 (현장 가정).</li>
 *   <li>`--app` chrome-less window → 사용자 시각 native desktop app (VS Code / Notion / Slack 동일 기술).</li>
 * </ul>
 */
public class SwingGuiApp {

    private static final String START_URL = "http://localhost:8080";

    /** Excel-style splash — undecorated JWindow. title bar / 버튼 없음. Edge 떠면 dispose. */
    private JWindow splash;
    /** Fallback control frame — Edge/Chrome 미발견 시만 표시. Stop 버튼. */
    private JFrame fallbackFrame;
    private JLabel statusLabel;
    private JButton stopBtn;

    private final AtomicReference<ConfigurableApplicationContext> springCtxRef = new AtomicReference<>();
    private final AtomicReference<Process> edgeProcRef = new AtomicReference<>();
    private final AtomicBoolean shuttingDown = new AtomicBoolean(false);
    private final AtomicBoolean uiLaunched = new AtomicBoolean(false);

    public void start(String[] startArgs) {
        SwingUtilities.invokeLater(this::createSplash);
        new Thread(this::bootSpring, "spring-boot-launcher").start();
    }

    /* ── Excel-style splash (undecorated JWindow) ─────────────────────── */

    private void createSplash() {
        splash = new JWindow();
        splash.setSize(420, 260);
        splash.setLocationRelativeTo(null);
        splash.setBackground(Color.WHITE);

        JPanel panel = new JPanel(new BorderLayout());
        panel.setBackground(Color.WHITE);
        panel.setBorder(new LineBorder(new Color(0xd0, 0xd5, 0xd9), 1));

        JPanel center = new JPanel();
        center.setLayout(new javax.swing.BoxLayout(center, javax.swing.BoxLayout.Y_AXIS));
        center.setOpaque(false);

        // logo
        JLabel logoLabel = new JLabel("", SwingConstants.CENTER);
        logoLabel.setAlignmentX(Component.CENTER_ALIGNMENT);
        try (InputStream is = SwingGuiApp.class.getResourceAsStream("/icons/mpd.png")) {
            if (is != null) {
                Image img = javax.imageio.ImageIO.read(is);
                Image scaled = img.getScaledInstance(72, 72, Image.SCALE_SMOOTH);
                logoLabel.setIcon(new ImageIcon(scaled));
            }
        } catch (Exception ignored) {}

        // brand name
        JLabel brand = new JLabel("ModernizeProData", SwingConstants.CENTER);
        brand.setAlignmentX(Component.CENTER_ALIGNMENT);
        brand.setFont(brand.getFont().deriveFont(Font.BOLD, 22f));
        brand.setForeground(new Color(0x0e, 0x72, 0x68));
        brand.setBorder(javax.swing.BorderFactory.createEmptyBorder(16, 0, 0, 0));

        center.add(logoLabel);
        center.add(brand);

        JPanel wrap = new JPanel(new java.awt.GridBagLayout());
        wrap.setOpaque(false);
        wrap.add(center);
        panel.add(wrap, BorderLayout.CENTER);

        splash.setContentPane(panel);
        splash.setVisible(true);
    }

    private void setStatus(String msg) {
        // Excel-style splash 에는 status label 없음. fallback frame 에 statusLabel 있으면 갱신.
        SwingUtilities.invokeLater(() -> {
            if (statusLabel != null) statusLabel.setText(msg);
        });
    }

    /* ── Spring Boot ──────────────────────────────────────────────────── */

    private void bootSpring() {
        try {
            setStatus("Starting backend (this may take ~10 sec)…");
            // WebServerInitializedEvent = HTTP port 열린 시점 = ApplicationReady 보다 1~2s
            // 빠름. lazy-init=true 라 dispatcherServlet / controllers 는 첫 request 에 init.
            // 그 사이 Edge / Chromium 가 spawn + paint 라 backend init 과 병렬 진행.
            ConfigurableApplicationContext ctx = new SpringApplicationBuilder(ModernizeProDataApplication.class)
                    .headless(false)
                    .listeners((WebServerInitializedEvent ev) -> {
                        setStatus("Launching UI…");
                        launchEdgeOnce();
                    })
                    .run();
            springCtxRef.set(ctx);
            // safety net.
            launchEdgeOnce();
        } catch (Throwable e) {
            System.err.println("Spring boot failed: " + e.getMessage());
            e.printStackTrace();
            setStatus("Backend start failed: " + e.getMessage());
        }
    }

    /* ── Edge `--app` launch ──────────────────────────────────────────── */

    private void launchEdgeOnce() {
        if (!uiLaunched.compareAndSet(false, true)) return;
        Process p = EdgeAppLauncher.launch(START_URL, "edge-app-coordinator");
        if (p == null) {
            // Edge/Chrome 미발견 → default browser fallback. splash dispose + fallback frame
            // (Stop 버튼 only) 표시. 사용자가 default browser 닫아도 backend 살아있으니 Stop 필요.
            SwingUtilities.invokeLater(() -> {
                disposeSplash();
                showFallbackControlFrame();
            });
            return;
        }
        edgeProcRef.set(p);

        // Edge launch 성공 → splash dispose. VSCode / Notion 패턴 = main window 1개 only.
        SwingUtilities.invokeLater(this::disposeSplash);

        // Edge process 종료 감시 — Edge X 닫으면 backend 도 stop.
        new Thread(() -> {
            try {
                p.waitFor();
                System.out.println("Edge process exited, shutting down backend");
                shutdown();
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
        }, "edge-watcher").start();
    }

    private void disposeSplash() {
        if (splash != null) {
            splash.setVisible(false);
            splash.dispose();
            splash = null;
        }
    }

    private void showFallbackControlFrame() {
        fallbackFrame = new JFrame("ModernizeProData");
        fallbackFrame.setDefaultCloseOperation(WindowConstants.DO_NOTHING_ON_CLOSE);
        fallbackFrame.setSize(380, 200);
        fallbackFrame.setLocationRelativeTo(null);
        tryLoadIcon(fallbackFrame);

        JPanel panel = new JPanel(new BorderLayout());
        panel.setBackground(Color.WHITE);

        JPanel center = new JPanel();
        center.setLayout(new javax.swing.BoxLayout(center, javax.swing.BoxLayout.Y_AXIS));
        center.setOpaque(false);

        JLabel brand = new JLabel("ModernizeProData", SwingConstants.CENTER);
        brand.setAlignmentX(Component.CENTER_ALIGNMENT);
        brand.setFont(brand.getFont().deriveFont(Font.BOLD, 18f));
        brand.setForeground(new Color(0x0e, 0x72, 0x68));

        statusLabel = new JLabel("Running in default browser", SwingConstants.CENTER);
        statusLabel.setAlignmentX(Component.CENTER_ALIGNMENT);
        statusLabel.setFont(statusLabel.getFont().deriveFont(Font.PLAIN, 12f));
        statusLabel.setForeground(new Color(0x67, 0x8b, 0x86));
        statusLabel.setBorder(javax.swing.BorderFactory.createEmptyBorder(12, 0, 12, 0));

        stopBtn = new JButton("Stop");
        stopBtn.setAlignmentX(Component.CENTER_ALIGNMENT);
        stopBtn.addActionListener(e -> shutdown());

        center.add(brand);
        center.add(statusLabel);
        center.add(stopBtn);

        JPanel wrap = new JPanel(new java.awt.GridBagLayout());
        wrap.setOpaque(false);
        wrap.add(center);
        panel.add(wrap, BorderLayout.CENTER);

        fallbackFrame.setContentPane(panel);
        fallbackFrame.addWindowListener(new WindowAdapter() {
            @Override
            public void windowClosing(WindowEvent e) {
                shutdown();
            }
        });
        fallbackFrame.setVisible(true);
    }

    /* ── Shutdown ─────────────────────────────────────────────────────── */

    private void shutdown() {
        if (!shuttingDown.compareAndSet(false, true)) return;
        try {
            Process p = edgeProcRef.get();
            if (p != null && p.isAlive()) p.destroy();
        } catch (Exception ignored) {}
        try {
            ConfigurableApplicationContext ctx = springCtxRef.get();
            if (ctx != null) SpringApplication.exit(ctx, () -> 0);
        } catch (Exception ignored) {}
        if (splash != null) splash.dispose();
        if (fallbackFrame != null) fallbackFrame.dispose();
        System.exit(0);
    }

    /* ── helpers ──────────────────────────────────────────────────────── */

    private static void tryLoadIcon(JFrame f) {
        try (InputStream is = SwingGuiApp.class.getResourceAsStream("/icons/mpd.png")) {
            if (is != null) f.setIconImage(new ImageIcon(javax.imageio.ImageIO.read(is)).getImage());
        } catch (Exception ignored) {}
    }
}
