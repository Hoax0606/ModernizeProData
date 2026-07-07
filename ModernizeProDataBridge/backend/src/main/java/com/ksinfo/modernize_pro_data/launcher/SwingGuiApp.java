package com.ksinfo.modernize_pro_data.launcher;

import com.ksinfo.modernize_pro_data.ModernizeProDataBridgeApplication;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.context.event.ApplicationEnvironmentPreparedEvent;
import org.springframework.boot.context.event.ApplicationPreparedEvent;
import org.springframework.boot.web.context.WebServerInitializedEvent;
import org.springframework.context.ConfigurableApplicationContext;

import javax.swing.BorderFactory;
import javax.swing.BoxLayout;
import javax.swing.ImageIcon;
import javax.swing.JButton;
import javax.swing.JComponent;
import javax.swing.JFrame;
import javax.swing.JLabel;
import javax.swing.JPanel;
import javax.swing.JWindow;
import javax.swing.SwingConstants;
import javax.swing.SwingUtilities;
import javax.swing.Timer;
import javax.swing.WindowConstants;
import javax.swing.border.LineBorder;
import java.awt.BorderLayout;
import java.awt.Color;
import java.awt.Component;
import java.awt.Dimension;
import java.awt.Font;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.Image;
import java.awt.RenderingHints;
import java.awt.event.WindowAdapter;
import java.awt.event.WindowEvent;
import java.io.InputStream;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Coordinator / Standalone main GUI — JavaFX WebView / JCEF 모두 폐기 후 OS Edge `--app`
 * chrome-less window 사용 (2026-05-30).
 *
 * <p>Splash: 흰 배경 + logo + brand + custom navy progress bar + status text.
 * Spring boot stage 별 listener + 150ms timer 로 0~100% 부드럽게 진행. Modern
 * installer 패턴 (Slack / Notion / VSCode).
 *
 * <p>Edge launch 성공 → splash dispose → Edge `--app` 단일 window.
 * Edge X 닫음 → backend shutdown (edge-watcher).
 */
public class SwingGuiApp {

    /** {@code ?app=mpd} = ad-hoc cache-bust. 사용자 PC 에 stale force-installed PWA
     *  (옛 build 의 잔존) 가 살아 있어도 start_url 과 다르므로 Edge 가 PWA scope
     *  match 안 함 → forward / self-exit 회피. */
    private static final String START_URL = "http://localhost:8080/?app=mpd";

    private JWindow splash;
    private JLabel statusLabel;
    private BrandProgressBar progressBar;
    private Timer progressTimer;

    private JFrame fallbackFrame;
    private JLabel fallbackStatus;
    private JButton fallbackStopBtn;

    private final AtomicReference<ConfigurableApplicationContext> springCtxRef = new AtomicReference<>();
    private final AtomicReference<Process> edgeProcRef = new AtomicReference<>();
    private final AtomicBoolean shuttingDown = new AtomicBoolean(false);
    private final AtomicBoolean uiLaunched = new AtomicBoolean(false);

    public void start(String[] startArgs) {
        cleanupStaleEdgePolicy();
        SwingUtilities.invokeLater(this::createSplash);
        new Thread(this::bootSpring, "spring-boot-launcher").start();
    }

    /**
     * 옛 build 가 사용자 PC HKCU 에 남긴 WCO force-install policy 의 best-effort
     * 제거. 정책 없으면 reg 가 exit≠0 — 무시. 정책 살아있으면 Edge 다음 launch 시
     * 우리 PWA force install / forward race 재발 가능.
     */
    private static void cleanupStaleEdgePolicy() {
        try {
            new ProcessBuilder("reg", "delete",
                    "HKCU\\Software\\Policies\\Microsoft\\Edge",
                    "/v", "WebAppInstallForceList", "/f")
                    .redirectErrorStream(true).start().waitFor();
        } catch (Exception ignored) {}
    }

    /* ── Splash ──────────────────────────────────────────────────────── */

    private void createSplash() {
        splash = new JWindow();
        splash.setSize(460, 280);
        splash.setLocationRelativeTo(null);
        splash.setBackground(Color.WHITE);

        JPanel panel = new JPanel(new BorderLayout());
        panel.setBackground(Color.WHITE);
        panel.setBorder(new LineBorder(new Color(0xda, 0xe3, 0xe0), 1));

        // upper = logo + brand (vertical center, top half)
        JPanel upper = new JPanel();
        upper.setLayout(new BoxLayout(upper, BoxLayout.Y_AXIS));
        upper.setOpaque(false);
        upper.setBorder(BorderFactory.createEmptyBorder(72, 0, 0, 0));

        JLabel logoLabel = new JLabel("", SwingConstants.CENTER);
        logoLabel.setAlignmentX(Component.CENTER_ALIGNMENT);
        try (InputStream is = SwingGuiApp.class.getResourceAsStream("/icons/mpd.png")) {
            if (is != null) {
                Image img = javax.imageio.ImageIO.read(is);
                Image scaled = img.getScaledInstance(72, 72, Image.SCALE_SMOOTH);
                logoLabel.setIcon(new ImageIcon(scaled));
            }
        } catch (Exception ignored) {}

        JLabel brand = new JLabel("ModernizeProDataBridge", SwingConstants.CENTER);
        brand.setAlignmentX(Component.CENTER_ALIGNMENT);
        brand.setFont(brand.getFont().deriveFont(Font.BOLD, 22f));
        brand.setForeground(new Color(0x0e, 0x72, 0x68));
        brand.setBorder(BorderFactory.createEmptyBorder(14, 0, 0, 0));

        upper.add(logoLabel);
        upper.add(brand);
        panel.add(upper, BorderLayout.CENTER);

        // lower = progress bar + status text (south, with padding)
        JPanel lower = new JPanel();
        lower.setLayout(new BoxLayout(lower, BoxLayout.Y_AXIS));
        lower.setOpaque(false);
        lower.setBorder(BorderFactory.createEmptyBorder(0, 40, 24, 40));

        progressBar = new BrandProgressBar();
        progressBar.setAlignmentX(Component.CENTER_ALIGNMENT);
        progressBar.setMaximumSize(new Dimension(Integer.MAX_VALUE, 6));

        statusLabel = new JLabel("Starting…");
        statusLabel.setAlignmentX(Component.LEFT_ALIGNMENT);
        statusLabel.setFont(statusLabel.getFont().deriveFont(Font.PLAIN, 11f));
        statusLabel.setForeground(new Color(0x67, 0x8b, 0x86));
        statusLabel.setBorder(BorderFactory.createEmptyBorder(10, 0, 0, 0));

        lower.add(progressBar);
        lower.add(statusLabel);
        panel.add(lower, BorderLayout.SOUTH);

        splash.setContentPane(panel);
        splash.setVisible(true);

        // 150ms timer — progress < 90 이면 +1 자동 증가 (Spring listener 가 jump-up).
        progressTimer = new Timer(150, e -> {
            if (progressBar != null && progressBar.getValue() < 90) {
                progressBar.setValue(progressBar.getValue() + 1);
            }
        });
        progressTimer.start();
    }

    private void setProgress(int v) {
        SwingUtilities.invokeLater(() -> {
            if (progressBar != null) progressBar.setValue(v);
        });
    }

    private void setStatus(String msg) {
        SwingUtilities.invokeLater(() -> {
            if (statusLabel != null) statusLabel.setText(msg);
            if (fallbackStatus != null) fallbackStatus.setText(msg);
        });
    }

    private void disposeSplash() {
        if (progressTimer != null) {
            progressTimer.stop();
            progressTimer = null;
        }
        if (splash != null) {
            splash.setVisible(false);
            splash.dispose();
            splash = null;
            statusLabel = null;
            progressBar = null;
        }
    }

    /* ── Custom progress bar (brand-colored, rounded, thin) ──────────── */

    static class BrandProgressBar extends JComponent {
        private static final Color TRACK = new Color(0xe6, 0xec, 0xea);
        private static final Color FOREGROUND = new Color(0x0e, 0x72, 0x68);
        private int value = 0;

        BrandProgressBar() {
            setPreferredSize(new Dimension(0, 6));
            setOpaque(false);
        }

        int getValue() { return value; }

        void setValue(int v) {
            int nv = Math.max(0, Math.min(100, v));
            if (nv == value) return;
            value = nv;
            repaint();
        }

        @Override
        protected void paintComponent(Graphics g) {
            Graphics2D g2 = (Graphics2D) g.create();
            try {
                g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
                int w = getWidth();
                int h = getHeight();
                g2.setColor(TRACK);
                g2.fillRoundRect(0, 0, w, h, h, h);
                int fw = (int) ((long) w * value / 100);
                if (fw > 0) {
                    g2.setColor(FOREGROUND);
                    g2.fillRoundRect(0, 0, fw, h, h, h);
                }
            } finally {
                g2.dispose();
            }
        }
    }

    /* ── Spring Boot ──────────────────────────────────────────────────── */

    private void bootSpring() {
        try {
            // bundled PG 시작 (5432 이미 listen 중이면 skip).
            setStatus("Starting database…");
            setProgress(Math.max(8, progressBar == null ? 0 : progressBar.getValue()));
            PgManagedLifecycle.ensureRunning();

            ConfigurableApplicationContext ctx = new SpringApplicationBuilder(ModernizeProDataBridgeApplication.class)
                    .headless(false)
                    .listeners(
                            (ApplicationEnvironmentPreparedEvent ev) -> {
                                setStatus("Loading config…");
                                setProgress(Math.max(25, progressBar == null ? 0 : progressBar.getValue()));
                            },
                            (ApplicationPreparedEvent ev) -> {
                                setStatus("Connecting database…");
                                setProgress(Math.max(60, progressBar == null ? 0 : progressBar.getValue()));
                            },
                            (WebServerInitializedEvent ev) -> {
                                setStatus("Opening UI…");
                                setProgress(Math.max(90, progressBar == null ? 0 : progressBar.getValue()));
                                launchEdgeOnce();
                            }
                    )
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
        // WebView2 host (.NET 8) 가 우선. 미발견 시 Edge `--app` fallback.
        Process p = WebViewHostLauncher.launch(
                START_URL,
                "edge-app-coordinator",
                "ModernizeProDataBridge",
                WebViewHostLauncher.COORDINATOR_APP_ID);
        if (p == null) {
            // Edge/Chrome 미발견 → default browser fallback. splash dispose + fallback frame.
            SwingUtilities.invokeLater(() -> {
                setProgress(100);
                disposeSplash();
                showFallbackControlFrame();
            });
            return;
        }
        edgeProcRef.set(p);

        // Edge process spawn → 잠시 (200ms) 후 progress 100% → 200ms 후 splash dispose.
        // Chromium 가 paint 할 시간 줘 splash → Edge 매끄러운 전환.
        Timer finish = new Timer(200, e -> {
            setProgress(100);
            setStatus("Ready");
            Timer hide = new Timer(200, e2 -> disposeSplash());
            hide.setRepeats(false);
            hide.start();
        });
        finish.setRepeats(false);
        finish.start();

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

    private void showFallbackControlFrame() {
        fallbackFrame = new JFrame("ModernizeProDataBridge");
        fallbackFrame.setDefaultCloseOperation(WindowConstants.DO_NOTHING_ON_CLOSE);
        fallbackFrame.setSize(380, 200);
        fallbackFrame.setLocationRelativeTo(null);
        tryLoadIcon(fallbackFrame);

        JPanel panel = new JPanel(new BorderLayout());
        panel.setBackground(Color.WHITE);

        JPanel center = new JPanel();
        center.setLayout(new BoxLayout(center, BoxLayout.Y_AXIS));
        center.setOpaque(false);

        JLabel brand = new JLabel("ModernizeProDataBridge", SwingConstants.CENTER);
        brand.setAlignmentX(Component.CENTER_ALIGNMENT);
        brand.setFont(brand.getFont().deriveFont(Font.BOLD, 18f));
        brand.setForeground(new Color(0x0e, 0x72, 0x68));

        fallbackStatus = new JLabel("Running in default browser", SwingConstants.CENTER);
        fallbackStatus.setAlignmentX(Component.CENTER_ALIGNMENT);
        fallbackStatus.setFont(fallbackStatus.getFont().deriveFont(Font.PLAIN, 12f));
        fallbackStatus.setForeground(new Color(0x67, 0x8b, 0x86));
        fallbackStatus.setBorder(BorderFactory.createEmptyBorder(12, 0, 12, 0));

        fallbackStopBtn = new JButton("Stop");
        fallbackStopBtn.setAlignmentX(Component.CENTER_ALIGNMENT);
        fallbackStopBtn.addActionListener(e -> shutdown());

        center.add(brand);
        center.add(fallbackStatus);
        center.add(fallbackStopBtn);

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
        // PG stop 의도적 안 함 — launcher 동시 실행 / 빠른 재시작 시 race condition
        // (이전 instance shutdown 의 PG stop ↔ 새 instance startup detect 가
        // 겹치면 새 instance 의 connect 가 refused). PG 그대로 두면 다음 launcher
        // launch 가 reuse, Windows 종료 시 자연 die. ~200MB RAM trade.
        if (progressTimer != null) progressTimer.stop();
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
