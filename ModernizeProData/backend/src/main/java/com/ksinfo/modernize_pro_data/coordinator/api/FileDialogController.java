package com.ksinfo.modernize_pro_data.coordinator.api;

import com.ksinfo.modernize_pro_data.common.dto.ApiResponse;
import com.ksinfo.modernize_pro_data.common.exception.ApiException;
import lombok.extern.slf4j.Slf4j;
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

    public record PickRequest(String startPath, String title) {}
    public record PickResult(String path, boolean cancelled) {}

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
     * the real Cocoa folder picker. Other OSes use Swing JFileChooser with system L&F.
     */
    private String showDialog(String title, String startPath) {
        String os = System.getProperty("os.name", "").toLowerCase();
        if (os.contains("mac")) {
            return showMacDialog(title, startPath);
        }
        return showSwingDialog(title, startPath);
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

    private String showSwingDialog(String title, String startPath) {
        try {
            UIManager.setLookAndFeel(UIManager.getSystemLookAndFeelClassName());
        } catch (Exception ignored) {
            /* fall back to default L&F */
        }
        JFileChooser chooser = new JFileChooser();
        chooser.setFileSelectionMode(JFileChooser.DIRECTORIES_ONLY);
        chooser.setDialogTitle(title);
        if (startPath != null && !startPath.isBlank()) {
            File start = new File(startPath);
            if (start.isDirectory()) chooser.setCurrentDirectory(start);
        }
        JFrame anchor = new JFrame();
        anchor.setUndecorated(true);
        anchor.setAlwaysOnTop(true);
        anchor.setLocationRelativeTo(null);
        anchor.setVisible(true);
        try {
            int result = chooser.showOpenDialog(anchor);
            if (result != JFileChooser.APPROVE_OPTION) return null;
            File selected = chooser.getSelectedFile();
            return selected == null ? null : selected.getAbsolutePath();
        } finally {
            anchor.dispose();
        }
    }
}
