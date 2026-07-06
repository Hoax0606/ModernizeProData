package com.ksinfo.modernize_pro_data.coordinator.api;

import com.ksinfo.modernize_pro_data.common.dto.ApiResponse;
import com.ksinfo.modernize_pro_data.common.exception.ApiException;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import javax.swing.JFileChooser;
import javax.swing.JFrame;
import javax.swing.SwingUtilities;
import javax.swing.UIManager;
import java.awt.FileDialog;
import java.awt.Frame;
import java.awt.GraphicsEnvironment;
import java.io.File;

/**
 * Native folder picker exposed to the frontend.
 *
 * Browsers can't reveal absolute paths from showDirectoryPicker / webkitdirectory,
 * but this product ships as a desktop app (jpackage) where backend and browser
 * run on the same user PC. So when the frontend asks, we open an OS-native
 * folder dialog from the backend and return the chosen absolute path.
 *
 *   POST /api/v1/util/pick-directory   body: { "startPath": "/optional/start" }
 */
@Slf4j
@RestController
@RequestMapping("/api/v1/util")
public class FileDialogController {

    /** System L&F 는 첫 호출 시 한 번만 적용 — 매번 setLookAndFeel 하면 클래스 로딩 비용. */
    private static volatile boolean lafApplied = false;
    private static synchronized void ensureSystemLookAndFeel() {
        if (lafApplied) return;
        try {
            UIManager.setLookAndFeel(UIManager.getSystemLookAndFeelClassName());
        } catch (Exception ignored) {
            // 실패해도 기본 Metal L&F 로 계속.
        }
        lafApplied = true;
    }

    public record PickRequest(String startPath, String title) {}
    public record PickResult(String path, boolean cancelled) {}

    /**
     * Backend 시작 직후 백그라운드로 Swing L&F + JFileChooser 클래스를 미리 로드해둔다.
     * 첫 Browse 클릭 때만 1~2초 걸리던 지연을 사용자가 체감하지 못하게.
     * Spring Boot 의 main thread 는 막지 않는다 (별도 thread).
     */
    @EventListener(ApplicationReadyEvent.class)
    public void warmUpSwing() {
        if (GraphicsEnvironment.isHeadless()) return;
        Thread t = new Thread(() -> {
            try {
                ensureSystemLookAndFeel();
                SwingUtilities.invokeAndWait(() -> {
                    // 생성만으로 Swing UI 클래스 + 파일시스템 모델이 초기화된다.
                    new JFileChooser();
                });
                log.info("Swing file-chooser pre-warmed");
            } catch (Exception e) {
                log.warn("Swing pre-warm failed (non-fatal)", e);
            }
        }, "swing-warmup");
        t.setDaemon(true);
        t.start();
    }

    @PostMapping("/pick-directory")
    public ApiResponse<PickResult> pickDirectory(@RequestBody(required = false) PickRequest req) {
        if (GraphicsEnvironment.isHeadless()) {
            throw new ApiException(
                    "HEADLESS_BACKEND",
                    "서버가 headless 모드라 네이티브 다이얼로그를 열 수 없습니다. 경로를 직접 입력해 주세요.",
                    HttpStatus.SERVICE_UNAVAILABLE);
        }

        final String startPath = req != null ? req.startPath() : null;
        final String title = req != null && req.title() != null ? req.title() : "Select directory";
        final String[] picked = new String[1];

        try {
            SwingUtilities.invokeAndWait(() -> picked[0] = showDialog(title, startPath));
        } catch (Exception e) {
            log.warn("Folder picker failed", e);
            throw new ApiException(
                    "DIALOG_FAILED",
                    "다이얼로그 표시 실패: " + e.getMessage(),
                    HttpStatus.INTERNAL_SERVER_ERROR);
        }

        boolean cancelled = picked[0] == null;
        return ApiResponse.ok(new PickResult(picked[0], cancelled));
    }

    /**
     * macOS — AWT FileDialog with {@code apple.awt.fileDialogForDirectories} gives
     * the real Cocoa folder picker (the directory itself is selectable).
     *
     * Windows/Linux — Swing JFileChooser with DIRECTORIES_ONLY. AWT FileDialog 는
     * Windows 에서 폴더 자체를 선택할 수 없어서(파일만 가능) JFileChooser 로 폴더
     * 다이얼로그를 띄운다. native Explorer 룩은 아니지만 디렉토리 자체를 선택할 수
     * 있다는 점이 우선. System L&F 를 적용해 가능한 한 OS 느낌에 맞춘다.
     */
    private String showDialog(String title, String startPath) {
        String os = System.getProperty("os.name", "").toLowerCase();
        if (os.contains("mac")) {
            return showMacDialog(title, startPath);
        }
        return showSwingDirChooser(title, startPath);
    }

    private String showMacDialog(String title, String startPath) {
        String prev = System.getProperty("apple.awt.fileDialogForDirectories");
        System.setProperty("apple.awt.fileDialogForDirectories", "true");
        try {
            FileDialog fd = new FileDialog((Frame) null, title, FileDialog.LOAD);
            if (startPath != null && !startPath.isBlank()) {
                File start = new File(startPath);
                if (start.isDirectory()) fd.setDirectory(start.getAbsolutePath());
            }
            fd.setAlwaysOnTop(true);
            fd.setVisible(true);
            String dir = fd.getDirectory();
            String file = fd.getFile();
            if (file == null) return null;
            return new File(dir, file).getAbsolutePath();
        } finally {
            if (prev == null) System.clearProperty("apple.awt.fileDialogForDirectories");
            else System.setProperty("apple.awt.fileDialogForDirectories", prev);
        }
    }

    private String showSwingDirChooser(String title, String startPath) {
        ensureSystemLookAndFeel();
        JFileChooser chooser = new JFileChooser();
        chooser.setDialogTitle(title);
        chooser.setFileSelectionMode(JFileChooser.DIRECTORIES_ONLY);
        chooser.setAcceptAllFileFilterUsed(false);
        chooser.setMultiSelectionEnabled(false);
        if (startPath != null && !startPath.isBlank()) {
            File start = new File(startPath);
            if (start.isDirectory()) {
                chooser.setCurrentDirectory(start);
            } else if (start.getParentFile() != null && start.getParentFile().isDirectory()) {
                chooser.setCurrentDirectory(start.getParentFile());
            }
        }
        // showOpenDialog(null) 은 parent 가 없어서 다른 창(브라우저 등) 뒤로 가려질 수 있다.
        // 보이지 않는 alwaysOnTop anchor JFrame 을 띄워 그것을 parent 로 넘기면 다이얼로그가
        // 최상단으로 올라오고 포커스도 잡힌다.
        JFrame anchor = new JFrame();
        anchor.setUndecorated(true);
        anchor.setSize(1, 1);
        anchor.setLocationRelativeTo(null);
        anchor.setAlwaysOnTop(true);
        anchor.setVisible(true);
        anchor.toFront();
        anchor.requestFocus();
        try {
            int ret = chooser.showOpenDialog(anchor);
            if (ret != JFileChooser.APPROVE_OPTION) return null; // cancelled
            File selected = chooser.getSelectedFile();
            return selected != null ? selected.getAbsolutePath() : null;
        } finally {
            anchor.dispose();
        }
    }
}
