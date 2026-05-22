package com.ksinfo.license.issuer;

import javax.swing.JButton;
import javax.swing.JDialog;
import javax.swing.JLabel;
import javax.swing.JPanel;
import javax.swing.SwingConstants;
import javax.swing.SwingUtilities;
import javax.swing.border.CompoundBorder;
import javax.swing.border.EmptyBorder;
import javax.swing.border.LineBorder;
import java.awt.BorderLayout;
import java.awt.Color;
import java.awt.Cursor;
import java.awt.Dialog;
import java.awt.Dimension;
import java.awt.FlowLayout;
import java.awt.Font;
import java.awt.Frame;
import java.awt.GridLayout;
import java.awt.Point;
import java.awt.Window;
import java.time.LocalDate;
import java.time.YearMonth;
import java.time.format.DateTimeFormatter;
import java.util.function.Consumer;

import javax.swing.JComponent;

/** Anchor 컴포넌트 아래에 popup 으로 뜨는 month-view 달력. */
public final class DatePickerPopup {

    private static final Color BG          = new Color(0xffffff);
    private static final Color HOVER       = new Color(0xe8f4f2);
    private static final Color BORDER      = new Color(0xb8cec9);
    private static final Color NAVY        = new Color(0x0e7268);
    private static final Color NAVY_50     = new Color(0xe8f4f2);
    private static final Color TEXT        = new Color(0x0c1f1b);
    private static final Color TEXT_3      = new Color(0x678b86);
    private static final Font  FONT        = new Font("Dialog", Font.PLAIN, 12);
    private static final Font  FONT_BOLD   = new Font("Dialog", Font.BOLD, 13);
    private static final DateTimeFormatter MONTH_FMT = DateTimeFormatter.ofPattern("M月 yyyy");
    private static final String[] DOW_HEADERS = {"日", "月", "火", "水", "木", "金", "土"};

    /** Non-modal popup. onPicked 는 날짜 선택/Today 클릭 시 호출 (Cancel / 외부 클릭 / 토글-닫기 시엔 호출 안 함). */
    public static JDialog open(JComponent anchor, LocalDate initial, Consumer<LocalDate> onPicked) {
        Window owner = SwingUtilities.getWindowAncestor(anchor);
        JDialog dialog = (owner instanceof Frame)
                ? new JDialog((Frame) owner, false)
                : new JDialog((Dialog) owner, false);
        dialog.setUndecorated(true);

        final LocalDate[] selected = { initial };
        final YearMonth[] viewMonth = { YearMonth.from(initial != null ? initial : LocalDate.now()) };

        JPanel root = new JPanel(new BorderLayout());
        root.setBackground(BG);
        root.setBorder(new CompoundBorder(new LineBorder(BORDER, 1), new EmptyBorder(10, 10, 10, 10)));

        // nav
        JPanel nav = new JPanel(new BorderLayout());
        nav.setOpaque(false);
        nav.setBorder(new EmptyBorder(0, 0, 8, 0));
        JLabel monthLabel = new JLabel("", SwingConstants.CENTER);
        monthLabel.setFont(FONT_BOLD);
        monthLabel.setForeground(TEXT);
        JButton prev = miniButton("<");
        JButton next = miniButton(">");
        nav.add(prev, BorderLayout.WEST);
        nav.add(monthLabel, BorderLayout.CENTER);
        nav.add(next, BorderLayout.EAST);

        // grid
        JPanel grid = new JPanel(new GridLayout(0, 7, 2, 2));
        grid.setOpaque(false);
        grid.setPreferredSize(new Dimension(240, 180));

        Runnable rebuild = () -> {
            grid.removeAll();
            monthLabel.setText(viewMonth[0].format(MONTH_FMT));
            for (String d : DOW_HEADERS) {
                JLabel l = new JLabel(d, SwingConstants.CENTER);
                l.setFont(FONT);
                l.setForeground(TEXT_3);
                grid.add(l);
            }
            YearMonth ym = viewMonth[0];
            int blanks = ym.atDay(1).getDayOfWeek().getValue() % 7;
            for (int i = 0; i < blanks; i++) grid.add(new JLabel(""));
            for (int d = 1; d <= ym.lengthOfMonth(); d++) {
                final LocalDate day = ym.atDay(d);
                JButton b = dayButton(String.valueOf(d), day.equals(selected[0]));
                b.addActionListener(e -> { onPicked.accept(day); dialog.dispose(); });
                grid.add(b);
            }
            grid.revalidate();
            grid.repaint();
        };
        prev.addActionListener(e -> { viewMonth[0] = viewMonth[0].minusMonths(1); rebuild.run(); });
        next.addActionListener(e -> { viewMonth[0] = viewMonth[0].plusMonths(1); rebuild.run(); });

        JPanel bottom = new JPanel(new FlowLayout(FlowLayout.RIGHT, 6, 0));
        bottom.setOpaque(false);
        bottom.setBorder(new EmptyBorder(8, 0, 0, 0));
        JButton todayBtn = miniButton("Today");
        todayBtn.addActionListener(e -> { onPicked.accept(LocalDate.now()); dialog.dispose(); });
        JButton cancelBtn = miniButton("Cancel");
        cancelBtn.addActionListener(e -> dialog.dispose());
        bottom.add(todayBtn);
        bottom.add(cancelBtn);

        root.add(nav, BorderLayout.NORTH);
        root.add(grid, BorderLayout.CENTER);
        root.add(bottom, BorderLayout.SOUTH);
        dialog.setContentPane(root);
        dialog.pack();

        Point loc = anchor.getLocationOnScreen();
        dialog.setLocation(loc.x, loc.y + anchor.getHeight() + 4);

        rebuild.run();
        dialog.setVisible(true);
        return dialog;
    }

    private static JButton miniButton(String text) {
        JButton b = new JButton(text);
        b.setFont(FONT);
        b.setForeground(NAVY);
        b.setBackground(NAVY_50);
        b.setBorder(new CompoundBorder(new LineBorder(NAVY, 1), new EmptyBorder(3, 10, 3, 10)));
        b.setFocusPainted(false);
        b.setContentAreaFilled(false);
        b.setOpaque(true);
        b.setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
        return b;
    }

    private static JButton dayButton(String text, boolean selected) {
        JButton b = new JButton(text);
        b.setFont(FONT);
        b.setForeground(selected ? Color.WHITE : TEXT);
        b.setBackground(selected ? NAVY : BG);
        b.setBorder(new EmptyBorder(4, 6, 4, 6));
        b.setFocusPainted(false);
        b.setContentAreaFilled(false);
        b.setOpaque(true);
        b.setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
        b.setHorizontalAlignment(SwingConstants.CENTER);
        if (!selected) {
            b.addMouseListener(new java.awt.event.MouseAdapter() {
                @Override public void mouseEntered(java.awt.event.MouseEvent e) { b.setBackground(HOVER); }
                @Override public void mouseExited (java.awt.event.MouseEvent e) { b.setBackground(BG); }
            });
        }
        return b;
    }

    private DatePickerPopup() {}
}
