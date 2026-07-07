package com.ksinfo.license.issuer;

import javax.swing.Icon;
import java.awt.BasicStroke;
import java.awt.Color;
import java.awt.Component;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.geom.Path2D;

/** 코드로 그리는 mint(NAVY) 색 16px 벡터 아이콘. 외부 파일 의존성 없음. */
public final class Icons {

    public static Icon calendar(int size, Color color) {
        return new VectorIcon(size, color, Icons::paintCalendar);
    }

    public static Icon file(int size, Color color) {
        return new VectorIcon(size, color, Icons::paintFile);
    }

    public static Icon folder(int size, Color color) {
        return new VectorIcon(size, color, Icons::paintFolder);
    }

    public static Icon lock(int size, Color color) {
        return new VectorIcon(size, color, Icons::paintLock);
    }

    public static Icon unlock(int size, Color color) {
        return new VectorIcon(size, color, Icons::paintUnlock);
    }

    private static void paintCalendar(Graphics2D g, int size) {
        float u = size / 16f;
        g.setStroke(new BasicStroke(1.4f));
        // body
        g.drawRoundRect(Math.round(u * 2),  Math.round(u * 4),
                        Math.round(u * 12), Math.round(u * 11),
                        Math.round(u * 2),  Math.round(u * 2));
        // header divider
        int y = Math.round(u * 7);
        g.drawLine(Math.round(u * 2), y, Math.round(u * 14), y);
        // two top hangers
        int top = Math.round(u * 1.5f);
        int bot = Math.round(u * 5.5f);
        g.drawLine(Math.round(u * 5),  top, Math.round(u * 5),  bot);
        g.drawLine(Math.round(u * 11), top, Math.round(u * 11), bot);
    }

    private static void paintFile(Graphics2D g, int size) {
        float u = size / 16f;
        g.setStroke(new BasicStroke(1.4f));
        Path2D body = new Path2D.Float();
        body.moveTo(u * 3.5f,  u * 1.8f);
        body.lineTo(u * 10f,   u * 1.8f);
        body.lineTo(u * 13.5f, u * 5.3f);
        body.lineTo(u * 13.5f, u * 14.5f);
        body.lineTo(u * 3.5f,  u * 14.5f);
        body.closePath();
        g.draw(body);
        // folded corner
        Path2D fold = new Path2D.Float();
        fold.moveTo(u * 10f,   u * 1.8f);
        fold.lineTo(u * 10f,   u * 5.3f);
        fold.lineTo(u * 13.5f, u * 5.3f);
        g.draw(fold);
    }

    private static void paintFolder(Graphics2D g, int size) {
        float u = size / 16f;
        g.setStroke(new BasicStroke(1.4f));
        Path2D p = new Path2D.Float();
        p.moveTo(u * 2f,    u * 4.5f);
        p.lineTo(u * 6f,    u * 4.5f);
        p.lineTo(u * 8f,    u * 6.5f);
        p.lineTo(u * 14f,   u * 6.5f);
        p.lineTo(u * 14f,   u * 13.5f);
        p.lineTo(u * 2f,    u * 13.5f);
        p.closePath();
        g.draw(p);
    }

    private static void paintLock(Graphics2D g, int size) {
        float u = size / 16f;
        g.setStroke(new BasicStroke(1.4f, BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND));
        // 닫힌 shackle (U-arc)
        Path2D s = new Path2D.Float();
        s.moveTo(u * 5f,  u * 8f);
        s.lineTo(u * 5f,  u * 5f);
        s.curveTo(u * 5f, u * 1.5f, u * 11f, u * 1.5f, u * 11f, u * 5f);
        s.lineTo(u * 11f, u * 8f);
        g.draw(s);
        // body
        g.draw(new java.awt.geom.RoundRectangle2D.Float(
                u * 3f, u * 7.5f, u * 10f, u * 7f, u * 2f, u * 2f));
    }

    private static void paintUnlock(Graphics2D g, int size) {
        float u = size / 16f;
        g.setStroke(new BasicStroke(1.4f, BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND));
        // 우측이 떨어진 shackle
        Path2D s = new Path2D.Float();
        s.moveTo(u * 5f,  u * 8f);
        s.lineTo(u * 5f,  u * 5f);
        s.curveTo(u * 5f, u * 1.5f, u * 11f, u * 1.5f, u * 11f, u * 5f);
        g.draw(s);
        // body
        g.draw(new java.awt.geom.RoundRectangle2D.Float(
                u * 3f, u * 7.5f, u * 10f, u * 7f, u * 2f, u * 2f));
    }

    private interface Painter { void paint(Graphics2D g, int size); }

    private static class VectorIcon implements Icon {
        private final int size;
        private final Color color;
        private final Painter painter;
        VectorIcon(int size, Color color, Painter painter) {
            this.size = size; this.color = color; this.painter = painter;
        }
        @Override public int getIconWidth()  { return size; }
        @Override public int getIconHeight() { return size; }
        @Override public void paintIcon(Component c, Graphics g, int x, int y) {
            Graphics2D g2 = (Graphics2D) g.create();
            g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
            g2.setRenderingHint(RenderingHints.KEY_STROKE_CONTROL, RenderingHints.VALUE_STROKE_PURE);
            g2.translate(x, y);
            g2.setColor(color);
            painter.paint(g2, size);
            g2.dispose();
        }
    }

    private Icons() {}
}
