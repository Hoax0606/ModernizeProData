package com.ksinfo.license.issuer;

import javax.swing.Box;
import javax.swing.BoxLayout;
import javax.swing.ImageIcon;
import javax.swing.JButton;
import javax.swing.JComponent;
import javax.swing.JDialog;
import javax.swing.JFileChooser;
import javax.swing.JFrame;
import javax.swing.JLabel;
import javax.swing.JPanel;
import javax.swing.JScrollPane;
import javax.swing.JSpinner;
import javax.swing.JTextField;
import javax.swing.SwingConstants;
import javax.swing.SpinnerNumberModel;
import javax.swing.SwingUtilities;
import javax.swing.UIManager;
import javax.swing.border.CompoundBorder;
import javax.swing.border.EmptyBorder;
import javax.swing.border.LineBorder;
import javax.swing.border.MatteBorder;
import java.awt.BorderLayout;
import java.awt.Color;
import java.awt.Component;
import java.awt.Cursor;
import java.awt.Dimension;
import java.awt.FlowLayout;
import java.awt.Font;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.GridBagConstraints;
import java.awt.GridBagLayout;
import java.awt.Image;
import java.awt.Insets;
import java.awt.RenderingHints;
import java.awt.Toolkit;
import java.awt.datatransfer.StringSelection;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;
import java.awt.event.WindowAdapter;
import java.awt.event.WindowEvent;
import java.awt.event.WindowFocusListener;
import java.io.File;
import java.net.URL;
import java.nio.file.Files;
import java.security.KeyPair;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;

/**
 * 본사 발급 담당자용 Swing GUI. Modernize Pro Data 의 light-teal 팔레트.
 */
public final class IssuerGui {

    /* palette: frontend/src/index.css :root */
    private static final Color BG            = new Color(0xf9fafb);
    private static final Color PANEL         = new Color(0xffffff);
    private static final Color BORDER        = new Color(0xdae3e0);
    private static final Color BORDER_STRONG = new Color(0xb8cec9);
    private static final Color TEXT          = new Color(0x0c1f1b);
    private static final Color TEXT_2        = new Color(0x334f4a);
    private static final Color TEXT_3        = new Color(0x678b86);
    private static final Color NAVY          = new Color(0x0e7268);
    private static final Color NAVY_700      = new Color(0x0a5850);
    private static final Color NAVY_50       = new Color(0xe8f4f2);
    private static final Color NAVY_100      = new Color(0xd0e6e2);
    private static final Color GREEN         = new Color(0x0c9e6a);
    private static final Color AMBER         = new Color(0xb87219);
    private static final Color RED           = new Color(0xc42f2f);

    // Java logical font "Dialog" → JRE 의 composite 가 Korean/Japanese/Latin 자동 fallback.
    private static final Font FONT_BASE  = new Font("Hoax Mono JP", Font.PLAIN, 12);
    private static final Font FONT_TITLE = new Font("Hoax Mono JP", Font.BOLD, 13);
    private static final Font FONT_LABEL = new Font("Hoax Mono JP", Font.PLAIN, 12);
    public static void launch() {
        // System L&F = Windows native L&F. 글꼴도 Windows 시스템 폰트 (Segoe UI 등) 를
        // 그대로 가져오기 때문에 OS 단의 CJK fallback 이 자동으로 동작 (Korean → Malgun Gothic,
        // Japanese → Yu Gothic). CrossPlatform (Metal) 은 JRE 내장 fontconfig 에 의존해서
        // jpackage'd 환경에서 fallback 실패하는 경우가 있음.
        try { UIManager.setLookAndFeel(UIManager.getSystemLookAndFeelClassName()); } catch (Exception ignored) {}
        SwingUtilities.invokeLater(() -> new IssuerGui().build().setVisible(true));
    }

    private JFrame frame;
    private JLabel keyStatusLabel;
    private JTextField customerField;
    private JTextField siteIdField;
    private JTextField expiresField;
    private JSpinner graceSpinner;
    private JTextField licenseIdField;
    private JTextField outputField;
    private JButton genBtn;
    private JButton copyFpBtn;
    private JButton copyPathBtn;
    private JButton openFolderBtn;
    private JButton lockToggleBtn;
    private boolean keyCardLocked = true;
    private JDialog activeDatePicker;
    private long datePickerClosedAt;

    private JFrame build() {
        frame = new JFrame("ModernizeProData License Creater");
        frame.setDefaultCloseOperation(JFrame.EXIT_ON_CLOSE);
        frame.setSize(720, 680);
        frame.setResizable(false);
        frame.setLocationRelativeTo(null);
        Image logo = loadLogo();
        if (logo != null) frame.setIconImage(logo);

        JPanel root = new JPanel();
        root.setLayout(new BoxLayout(root, BoxLayout.Y_AXIS));
        root.setBackground(BG);
        root.setBorder(new EmptyBorder(20, 24, 20, 24));

        root.add(buildHeader(logo));
        root.add(Box.createVerticalStrut(16));
        root.add(buildKeyCard());
        root.add(Box.createVerticalStrut(10));
        root.add(buildFormCard());

        JScrollPane scroll = new JScrollPane(root,
                JScrollPane.VERTICAL_SCROLLBAR_AS_NEEDED,
                JScrollPane.HORIZONTAL_SCROLLBAR_NEVER);
        scroll.setBorder(null);
        scroll.getViewport().setBackground(BG);
        scroll.getVerticalScrollBar().setUnitIncrement(16);
        frame.setContentPane(scroll);
        refreshKeyStatus();
        return frame;
    }

    /* ── Header ────────────────────────────────────── */

    private JPanel buildHeader(Image logo) {
        JPanel inner = new JPanel(new FlowLayout(FlowLayout.LEFT, 14, 0));
        inner.setOpaque(false);

        String html = "<html>"
                + "<div style='font-family:Segoe UI;'>"
                + "<span style='font-size:18pt;font-weight:bold;color:#0e7268;'>ModernizeProData</span><br>"
                + "<span style='font-size:11pt;color:#678b86;'>License Creater</span>"
                + "</div></html>";
        JLabel header = new JLabel(html);
        if (logo != null) {
            Image scaled = logo.getScaledInstance(56, 56, Image.SCALE_SMOOTH);
            header.setIcon(new ImageIcon(scaled));
            header.setIconTextGap(14);
        }
        header.setHorizontalAlignment(SwingConstants.LEFT);
        header.setVerticalAlignment(SwingConstants.CENTER);
        header.setVerticalTextPosition(SwingConstants.CENTER);
        header.setHorizontalTextPosition(SwingConstants.RIGHT);
        inner.add(header);

        JPanel p = new JPanel(new BorderLayout());
        p.setOpaque(false);
        p.setAlignmentX(Component.LEFT_ALIGNMENT);
        p.setBorder(new javax.swing.border.MatteBorder(0, 0, 1, 0, BORDER));
        p.add(inner, BorderLayout.WEST);
        p.setMaximumSize(new Dimension(Integer.MAX_VALUE, 80));
        return p;
    }

    private Image loadLogo() {
        try {
            URL url = IssuerGui.class.getResource("/com/ksinfo/license/issuer/mpd.png");
            if (url == null) return null;
            return new ImageIcon(url).getImage();
        } catch (Exception ignored) {
            return null;
        }
    }

    /* ── Key card ──────────────────────────────────── */

    private JComponent buildKeyCard() {
        JPanel body = new JPanel();
        body.setLayout(new BoxLayout(body, BoxLayout.Y_AXIS));
        body.setOpaque(false);

        keyStatusLabel = new JLabel(" ");
        keyStatusLabel.setFont(FONT_LABEL);
        keyStatusLabel.setAlignmentX(Component.LEFT_ALIGNMENT);
        body.add(keyStatusLabel);
        body.add(Box.createVerticalStrut(10));

        JPanel row = new JPanel(new FlowLayout(FlowLayout.LEFT, 6, 0));
        row.setOpaque(false);
        row.setAlignmentX(Component.LEFT_ALIGNMENT);
        genBtn         = secondaryButton("Generate keypair", this::onGenerateKeypair);
        copyFpBtn      = secondaryButton("Copy fingerprint", this::onCopyFingerprint);
        copyPathBtn    = secondaryButton("Copy public.pem",  this::onCopyPublicPath);
        openFolderBtn  = secondaryButton("Open folder",      this::onOpenKeyFolder);
        row.add(genBtn);
        row.add(copyFpBtn);
        row.add(copyPathBtn);
        row.add(openFolderBtn);
        body.add(row);

        lockToggleBtn = ghostIconButton(Icons.lock(16, NAVY), "Click to unlock", this::onToggleLock);
        return card("Signing keypair", body, lockToggleBtn);
    }

    private void refreshKeyStatus() {
        boolean exists = KeyManager.keypairExists();
        if (exists) {
            try {
                String fp = KeyManager.fingerprint(KeyManager.loadPublicDer());
                keyStatusLabel.setText("● Present  ·  fingerprint = " + fp);
                keyStatusLabel.setForeground(GREEN);
            } catch (Exception ex) {
                keyStatusLabel.setText("● Present but unreadable — " + ex.getMessage());
                keyStatusLabel.setForeground(RED);
            }
        } else {
            keyStatusLabel.setText("● Not generated");
            keyStatusLabel.setForeground(AMBER);
        }
        if (genBtn != null) {
            if (keyCardLocked) {
                genBtn.setEnabled(false);
                copyFpBtn.setEnabled(false);
                copyPathBtn.setEnabled(false);
                openFolderBtn.setEnabled(false);
                String locked = "잠겨 있습니다. 우측 자물쇠 아이콘 클릭으로 해제.";
                genBtn.setToolTipText(locked);
                copyFpBtn.setToolTipText(locked);
                copyPathBtn.setToolTipText(locked);
                openFolderBtn.setToolTipText(locked);
            } else {
                genBtn.setEnabled(!exists);
                genBtn.setToolTipText(exists
                        ? "이미 키가 있습니다. 회전이 필요하면 license 폴더를 수동 삭제 후 재실행."
                        : null);
                copyFpBtn.setEnabled(exists);
                copyFpBtn.setToolTipText(exists ? null : "키쌍 generate 후 사용 가능합니다.");
                copyPathBtn.setEnabled(exists);
                copyPathBtn.setToolTipText(exists ? null : "키쌍 generate 후 사용 가능합니다.");
                openFolderBtn.setEnabled(true);
                openFolderBtn.setToolTipText(null);
            }
        }
    }

    private void onToggleLock() {
        keyCardLocked = !keyCardLocked;
        lockToggleBtn.setIcon(keyCardLocked ? Icons.lock(16, NAVY) : Icons.unlock(16, NAVY));
        lockToggleBtn.setToolTipText(keyCardLocked ? "Click to unlock" : "Click to lock");
        refreshKeyStatus();
    }

    private void onGenerateKeypair() {
        if (KeyManager.keypairExists()) {
            warn("Keypair already exists at\n" + KeyManager.HOME
                    + "\n\nTo rotate, delete that folder manually first.");
            return;
        }
        try {
            KeyPair kp = KeyManager.generate();
            String fp = KeyManager.fingerprint(kp.getPublic().getEncoded());
            refreshKeyStatus();
            success("Keypair generated",
                    "fingerprint = " + fp
                            + "\nprivate : " + KeyManager.PRIVATE_KEY_PATH
                            + "\npublic  : " + KeyManager.PUBLIC_KEY_PATH);
        } catch (Exception ex) {
            error("Keypair generation failed: " + ex.getMessage());
        }
    }

    private void onCopyFingerprint() {
        if (!KeyManager.keypairExists()) { warn("Keypair not generated yet."); return; }
        try {
            copyToClipboard(KeyManager.fingerprint(KeyManager.loadPublicDer()));
        } catch (Exception ex) {
            error("Could not read keypair: " + ex.getMessage());
        }
    }

    private void onCopyPublicPath() {
        copyToClipboard(KeyManager.PUBLIC_KEY_PATH.toString());
    }

    private void onOpenKeyFolder() {
        try {
            Files.createDirectories(KeyManager.HOME);
            java.awt.Desktop.getDesktop().open(KeyManager.HOME.toFile());
        } catch (Exception ex) {
            error("Could not open folder: " + ex.getMessage());
        }
    }

    /* ── Form card ─────────────────────────────────── */

    private JComponent buildFormCard() {
        JPanel body = new JPanel();
        body.setLayout(new BoxLayout(body, BoxLayout.Y_AXIS));
        body.setOpaque(false);

        JPanel grid = new JPanel(new GridBagLayout());
        grid.setOpaque(false);
        grid.setAlignmentX(Component.LEFT_ALIGNMENT);
        GridBagConstraints c = new GridBagConstraints();
        c.insets = new Insets(5, 0, 5, 0);
        c.anchor = GridBagConstraints.WEST;
        c.fill = GridBagConstraints.NONE;
        int row = 0;

        customerField = styledTextField();
        customerField.getDocument().addDocumentListener(new SimpleDocListener(this::autoFillLicenseId));
        addRow(grid, c, row++, "Customer", customerField);

        siteIdField = styledTextField();
        addRow(grid, c, row++, "Site ID", siteIdField);

        expiresField = new JTextField();
        expiresField.setText(LocalDate.now().plusYears(1).format(DateTimeFormatter.ISO_LOCAL_DATE));
        expiresField.setToolTipText("YYYY-MM-DD");
        addRow(grid, c, row++, "Expires",
                textFieldWithTrailingIcon(expiresField, Icons.calendar(16, NAVY), "Pick date", this::onPickDate));

        graceSpinner = new JSpinner(new SpinnerNumberModel(14, 0, 365, 1));
        styleSpinner(graceSpinner);
        JPanel graceWrap = new JPanel(new FlowLayout(FlowLayout.LEFT, 0, 0));
        graceWrap.setOpaque(false);
        graceWrap.add(graceSpinner);
        addRow(grid, c, row++, "Grace days", graceWrap);

        licenseIdField = styledTextField();
        addRow(grid, c, row++, "License ID", licenseIdField);

        outputField = new JTextField();
        outputField.setText(System.getProperty("user.home") + File.separator + "Desktop");
        outputField.setToolTipText("폴더만 선택하세요. 파일 이름은 {License ID}.lic 로 자동.");
        addRow(grid, c, row++, "Output folder",
                textFieldWithTrailingIcon(outputField, Icons.folder(16, NAVY), "Choose folder", this::onBrowseOutput));

        body.add(grid);

        JPanel actionRow = new JPanel(new FlowLayout(FlowLayout.RIGHT, 0, 4));
        actionRow.setOpaque(false);
        actionRow.setAlignmentX(Component.LEFT_ALIGNMENT);
        actionRow.setBorder(new EmptyBorder(8, 0, 0, 0));
        JButton create = primaryButton("Create", this::onSign);
        create.setPreferredSize(new Dimension(140, 36));
        create.setMaximumSize(new Dimension(140, 36));
        actionRow.add(create);
        body.add(actionRow);

        return card("Issue a license", body);
    }

    private void autoFillLicenseId() {
        String c = customerField.getText().trim();
        if (c.isEmpty()) return;
        if (licenseIdField.getText().isBlank() || licenseIdField.getText().startsWith("MPD-")) {
            licenseIdField.setText(LicenseSigner.defaultLicenseId(c));
        }
    }

    private void onPickDate() {
        // 직전에 외부 클릭으로 닫힌 직후라면 (200ms 이내) 재오픈 차단 — toggle 효과.
        if (System.currentTimeMillis() - datePickerClosedAt < 200) {
            return;
        }
        if (activeDatePicker != null && activeDatePicker.isDisplayable()) {
            activeDatePicker.dispose();
            return;
        }
        LocalDate current;
        try { current = LocalDate.parse(expiresField.getText().trim()); }
        catch (Exception ignored) { current = LocalDate.now().plusYears(1); }

        activeDatePicker = DatePickerPopup.open(expiresField, current, picked -> {
            if (picked != null) expiresField.setText(picked.format(DateTimeFormatter.ISO_LOCAL_DATE));
        });
        activeDatePicker.addWindowListener(new WindowAdapter() {
            @Override public void windowClosed(WindowEvent e) {
                datePickerClosedAt = System.currentTimeMillis();
                activeDatePicker = null;
            }
        });
        activeDatePicker.addWindowFocusListener(new WindowFocusListener() {
            @Override public void windowGainedFocus(WindowEvent e) {}
            @Override public void windowLostFocus(WindowEvent e) {
                if (activeDatePicker != null) activeDatePicker.dispose();
            }
        });
    }

    private void onBrowseOutput() {
        // L&F 를 잠깐 Windows 시스템 으로 바꿔서 JFileChooser 가 native 룩으로 뜨게.
        String prevLaf = UIManager.getLookAndFeel().getClass().getName();
        try { UIManager.setLookAndFeel(UIManager.getSystemLookAndFeelClassName()); } catch (Exception ignored) {}

        JFileChooser chooser = new JFileChooser();
        chooser.setFileSelectionMode(JFileChooser.DIRECTORIES_ONLY);
        chooser.setDialogTitle("Choose output folder");
        chooser.setApproveButtonText("Select");
        File current = new File(outputField.getText());
        if (current.isDirectory()) {
            chooser.setCurrentDirectory(current);
        } else if (current.getParentFile() != null) {
            chooser.setCurrentDirectory(current.getParentFile());
        }
        int result = chooser.showOpenDialog(frame);

        try { UIManager.setLookAndFeel(prevLaf); } catch (Exception ignored) {}

        if (result == JFileChooser.APPROVE_OPTION) {
            outputField.setText(chooser.getSelectedFile().getAbsolutePath());
        }
    }

    private void onSign() {
        if (!KeyManager.keypairExists()) {
            warn("Keypair not generated. Click \"Generate new keypair\" first.");
            return;
        }
        try {
            String customer = required("Customer", customerField.getText());
            String siteId   = required("Site ID",  siteIdField.getText());
            String licId    = required("License ID", licenseIdField.getText());
            String outDir   = required("Output folder", outputField.getText());
            File   dir      = new File(outDir);
            if (!dir.isDirectory()) { error("Output folder does not exist: " + outDir); return; }
            LocalDate expires;
            try {
                expires = LocalDate.parse(expiresField.getText().trim());
            } catch (Exception ex) { error("Expires must be YYYY-MM-DD."); return; }
            if (!expires.isAfter(LocalDate.now())) {
                error("Expires date must be in the future.");
                return;
            }

            File outFile = new File(dir, licId + ".lic");
            LicenseSigner.Input in = new LicenseSigner.Input(
                    licId, customer, siteId, expires,
                    (Integer) graceSpinner.getValue()
            );
            LicenseDocument doc = LicenseSigner.signToFile(in, outFile.toPath());
            success("License created",
                    "Path: " + outFile.getAbsolutePath()
                            + "\n\ncustomer = " + doc.payload().customer()
                            + "\nsiteId   = " + doc.payload().siteId()
                            + "\nexpires  = " + doc.payload().expiresAt());
        } catch (IllegalArgumentException iae) {
            warn(iae.getMessage());
        } catch (Exception ex) {
            error("Sign failed: " + ex.getMessage());
        }
    }

    /* ── Card / control helpers ────────────────────── */

    private static JPanel card(String title, JComponent body) {
        return card(title, body, null);
    }

    /** 메인 툴 Card 컴포넌트 — 흰색 패널, 1px BORDER, 타이틀 + 하단 separator + 선택적 우측 액션. */
    private static JPanel card(String title, JComponent body, JComponent headerRight) {
        JPanel card = new JPanel() {
            @Override public Dimension getMaximumSize() {
                return new Dimension(Integer.MAX_VALUE, getPreferredSize().height);
            }
        };
        card.setLayout(new BoxLayout(card, BoxLayout.Y_AXIS));
        card.setBackground(PANEL);
        card.setBorder(new CompoundBorder(
                new LineBorder(BORDER, 1),
                new EmptyBorder(14, 18, 14, 18)
        ));
        card.setAlignmentX(Component.LEFT_ALIGNMENT);

        JPanel titleRow = new JPanel(new BorderLayout());
        titleRow.setOpaque(false);
        titleRow.setBorder(new CompoundBorder(
                new MatteBorder(0, 0, 1, 0, BORDER),
                new EmptyBorder(0, 0, 8, 0)
        ));
        titleRow.setAlignmentX(Component.LEFT_ALIGNMENT);
        JLabel titleLabel = new JLabel(title);
        titleLabel.setFont(FONT_TITLE);
        titleLabel.setForeground(TEXT);
        titleRow.add(titleLabel, BorderLayout.WEST);
        if (headerRight != null) titleRow.add(headerRight, BorderLayout.EAST);
        card.add(titleRow);
        card.add(Box.createVerticalStrut(12));

        body.setAlignmentX(Component.LEFT_ALIGNMENT);
        card.add(body);
        return card;
    }

    /** 카드 헤더용 — 배경/보더 없는 아이콘 토글 버튼. */
    private static JButton ghostIconButton(javax.swing.Icon icon, String tooltip, Runnable onClick) {
        JButton b = new JButton(icon);
        b.setToolTipText(tooltip);
        b.setBorder(new EmptyBorder(2, 6, 2, 6));
        b.setContentAreaFilled(false);
        b.setBorderPainted(false);
        b.setFocusPainted(false);
        b.setOpaque(false);
        b.setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
        b.addActionListener(e -> onClick.run());
        return b;
    }

    private static void addRow(JPanel grid, GridBagConstraints c, int row, String label, JComponent field) {
        c.gridx = 0; c.gridy = row; c.weightx = 0;
        c.insets = new Insets(5, 0, 5, 14);

        JLabel l = new JLabel(label);
        l.setFont(FONT_LABEL);
        l.setForeground(TEXT_2);
        l.setPreferredSize(new Dimension(100, 22));
        grid.add(l, c);

        c.gridx = 1; c.weightx = 1;
        c.insets = new Insets(5, 0, 5, 0);
        grid.add(field, c);
    }

    /* ── Styled controls ───────────────────────────── */

    private static JTextField styledTextField() {
        JTextField tf = new JTextField();
        tf.setFont(FONT_BASE);
        tf.setForeground(TEXT);
        tf.setBackground(PANEL);
        tf.setBorder(new CompoundBorder(new LineBorder(BORDER_STRONG, 1), new EmptyBorder(5, 8, 5, 8)));
        tf.setPreferredSize(new Dimension(460, 28));
        tf.setMaximumSize(new Dimension(460, 28));
        return tf;
    }

    private static void styleSpinner(JSpinner sp) {
        sp.setFont(FONT_BASE);
        sp.setBorder(new LineBorder(BORDER_STRONG, 1));
        sp.setPreferredSize(new Dimension(96, 28));
        sp.setMaximumSize(new Dimension(96, 28));
        javax.swing.JFormattedTextField tf = ((JSpinner.DefaultEditor) sp.getEditor()).getTextField();
        tf.setColumns(4);
        tf.setMargin(new Insets(0, 8, 0, 8));
        tf.setHorizontalAlignment(SwingConstants.LEFT);
        tf.setBorder(new EmptyBorder(0, 8, 0, 4));
    }

    private static JButton primaryButton(String text, Runnable onClick) {
        return new FlatButton(text, NAVY, NAVY_700, Color.WHITE, NAVY, onClick, true);
    }

    private static JButton secondaryButton(String text, Runnable onClick) {
        return new FlatButton(text, NAVY_50, NAVY_100, NAVY, NAVY, onClick, false);
    }

    /** 460px wrapper: 안에 border 없는 JTextField + 우측 끝에 클릭 가능한 mint 아이콘. */
    private static JComponent textFieldWithTrailingIcon(
            JTextField inner, javax.swing.Icon icon, String tooltip, Runnable onClick
    ) {
        inner.setFont(FONT_BASE);
        inner.setForeground(TEXT);
        inner.setBackground(PANEL);
        inner.setBorder(new EmptyBorder(5, 8, 5, 4));

        JButton iconBtn = new JButton(icon);
        iconBtn.setToolTipText(tooltip);
        iconBtn.setBorder(new EmptyBorder(0, 4, 0, 8));
        iconBtn.setContentAreaFilled(false);
        iconBtn.setBorderPainted(false);
        iconBtn.setFocusPainted(false);
        iconBtn.setOpaque(false);
        iconBtn.setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
        iconBtn.addActionListener(e -> onClick.run());

        JPanel wrap = new JPanel(new BorderLayout());
        wrap.setBackground(PANEL);
        wrap.setBorder(new LineBorder(BORDER_STRONG, 1));
        wrap.setPreferredSize(new Dimension(460, 28));
        wrap.setMaximumSize(new Dimension(460, 28));
        wrap.add(inner, BorderLayout.CENTER);
        wrap.add(iconBtn, BorderLayout.EAST);
        return wrap;
    }

    /** L&F 무시하고 직접 그리는 flat 버튼. */
    private static class FlatButton extends JButton {
        private final Color bg, hover, border;
        private final boolean primary;
        private boolean hovered;
        FlatButton(String text, Color bg, Color hover, Color fg, Color border, Runnable onClick, boolean primary) {
            super(text);
            this.bg = bg; this.hover = hover; this.border = border; this.primary = primary;
            setForeground(fg);
            setFont(FONT_LABEL.deriveFont(primary ? Font.BOLD : Font.PLAIN, primary ? 12.5f : 12f));
            setFocusPainted(false);
            setContentAreaFilled(false);
            setBorderPainted(false);
            setOpaque(false);
            setMargin(new Insets(0, 0, 0, 0));
            setHorizontalAlignment(SwingConstants.CENTER);
            setVerticalAlignment(SwingConstants.CENTER);
            setHorizontalTextPosition(SwingConstants.CENTER);
            setVerticalTextPosition(SwingConstants.CENTER);
            setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
            setBorder(new EmptyBorder(primary ? 8 : 6, primary ? 20 : 16, primary ? 8 : 6, primary ? 20 : 16));
            addActionListener(e -> onClick.run());
            addMouseListener(new MouseAdapter() {
                @Override public void mouseEntered(MouseEvent e) { if (isEnabled()) { hovered = true; repaint(); } }
                @Override public void mouseExited (MouseEvent e) { hovered = false; repaint(); }
            });
        }
        @Override public void setEnabled(boolean enabled) {
            super.setEnabled(enabled);
            setCursor(enabled ? Cursor.getPredefinedCursor(Cursor.HAND_CURSOR) : Cursor.getDefaultCursor());
            if (!enabled) hovered = false;
            repaint();
        }
        @Override protected void paintComponent(Graphics g) {
            Graphics2D g2 = (Graphics2D) g.create();
            g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
            Color fillColor;
            Color borderColor;
            if (isEnabled()) {
                fillColor = hovered ? hover : bg;
                borderColor = border;
            } else {
                fillColor = new Color(0xf2f4f3);   // gray-50
                borderColor = new Color(0xdae3e0); // border
            }
            g2.setColor(fillColor);
            g2.fillRoundRect(0, 0, getWidth(), getHeight(), 6, 6);
            g2.setColor(borderColor);
            g2.drawRoundRect(0, 0, getWidth() - 1, getHeight() - 1, 6, 6);
            g2.dispose();
            super.paintComponent(g);
        }
    }

    /* ── misc ──────────────────────────────────────── */

    private static String required(String name, String value) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException(name + " is required.");
        return value.trim();
    }

    private static void copyToClipboard(String s) {
        Toolkit.getDefaultToolkit().getSystemClipboard().setContents(new StringSelection(s), null);
    }

    private void info   (String title, String msg) { showAppDialog(title, msg, NAVY); }
    private void success(String title, String msg) { showAppDialog(title, msg, GREEN); }
    private void warn   (String msg)               { showAppDialog("Check input", msg, AMBER); }
    private void error  (String msg)               { showAppDialog("Error", msg, RED); }

    /** 우리 카드 디자인을 따르는 modal dialog. accent 색이 상단 헤더 띠. */
    private void showAppDialog(String title, String message, Color accent) {
        JDialog dialog = new JDialog(frame, title, true);
        dialog.setResizable(false);
        dialog.setDefaultCloseOperation(JDialog.DISPOSE_ON_CLOSE);

        JPanel root = new JPanel(new BorderLayout());
        root.setBackground(PANEL);

        // accent 헤더
        JPanel header = new JPanel(new BorderLayout());
        header.setBackground(accent);
        header.setBorder(new EmptyBorder(10, 18, 10, 18));
        JLabel titleLabel = new JLabel(title);
        titleLabel.setForeground(Color.WHITE);
        titleLabel.setFont(FONT_TITLE);
        header.add(titleLabel, BorderLayout.WEST);
        root.add(header, BorderLayout.NORTH);

        // 메시지 본문
        String html = "<html><div style='width:380px;font-family:Dialog;font-size:11pt;color:#0c1f1b;'>"
                + htmlEscape(message).replace("\n", "<br>")
                + "</div></html>";
        JLabel msgLabel = new JLabel(html);
        msgLabel.setBorder(new EmptyBorder(18, 20, 18, 20));
        msgLabel.setBackground(PANEL);
        msgLabel.setOpaque(true);
        root.add(msgLabel, BorderLayout.CENTER);

        // 버튼 행
        JPanel buttonRow = new JPanel(new FlowLayout(FlowLayout.RIGHT, 0, 0));
        buttonRow.setBackground(PANEL);
        buttonRow.setBorder(new EmptyBorder(0, 20, 16, 20));
        JButton ok = primaryButton("OK", dialog::dispose);
        ok.setPreferredSize(new Dimension(100, 32));
        ok.setMaximumSize(new Dimension(100, 32));
        buttonRow.add(ok);
        root.add(buttonRow, BorderLayout.SOUTH);

        dialog.setContentPane(root);
        dialog.pack();
        dialog.setLocationRelativeTo(frame);
        dialog.setVisible(true);
    }

    private static String htmlEscape(String s) {
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }

    private static class SimpleDocListener implements javax.swing.event.DocumentListener {
        private final Runnable fn;
        SimpleDocListener(Runnable fn) { this.fn = fn; }
        @Override public void insertUpdate (javax.swing.event.DocumentEvent e) { fn.run(); }
        @Override public void removeUpdate (javax.swing.event.DocumentEvent e) { fn.run(); }
        @Override public void changedUpdate(javax.swing.event.DocumentEvent e) { fn.run(); }
    }

    private IssuerGui() {}
}
