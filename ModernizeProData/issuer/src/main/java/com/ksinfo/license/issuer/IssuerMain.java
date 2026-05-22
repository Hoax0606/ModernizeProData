package com.ksinfo.license.issuer;

import java.util.Arrays;

/**
 * 엔트리 포인트. 첫 인자가 "cli" 면 CLI 모드, 그 외 (인자 없음 포함) 면 Swing GUI.
 */
public final class IssuerMain {

    public static void main(String[] args) throws Exception {
        if (args.length > 0 && "cli".equalsIgnoreCase(args[0])) {
            IssuerCli.run(Arrays.copyOfRange(args, 1, args.length));
            return;
        }
        IssuerGui.launch();
    }

    private IssuerMain() {}
}
