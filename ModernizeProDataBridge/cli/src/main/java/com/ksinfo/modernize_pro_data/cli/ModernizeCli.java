package com.ksinfo.modernize_pro_data.cli;

import picocli.CommandLine;
import picocli.CommandLine.Command;

/**
 * Modernize Pro Data CLI のエントリポイント.
 *
 * 使い方:
 * <pre>
 *   modernize run --project p-abc12345 --type rehearsal
 *   modernize --help
 * </pre>
 *
 * Exit code:
 *   0 — run が無事に起動された (STARTED)
 *   1 — validation 失敗 (REJECTED)
 *   2 — 二重起動 (LOCKED)
 *   3 — 認証エラー (401)
 *   4 — external integrations 無効 (503)
 *   9 — 設定不備 / その他 client 側エラー
 */
@Command(
        name = "modernize",
        mixinStandardHelpOptions = true,
        version = "modernize-cli 0.0.1-SNAPSHOT",
        description = "Trigger Modernize Pro Data runs from external schedulers.",
        subcommands = {
                RunCommand.class,
                RunAllCommand.class
        }
)
public class ModernizeCli implements Runnable {

    @Override
    public void run() {
        // sub-command 無し時は help 表示
        new CommandLine(this).usage(System.out);
    }

    public static void main(String[] args) {
        int exitCode = new CommandLine(new ModernizeCli()).execute(args);
        System.exit(exitCode);
    }
}
