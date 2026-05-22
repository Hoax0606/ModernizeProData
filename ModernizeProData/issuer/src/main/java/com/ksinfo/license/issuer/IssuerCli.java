package com.ksinfo.license.issuer;

import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.KeyPair;
import java.time.LocalDate;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;

/**
 * 본사에서 .lic 파일을 발급할 때 쓰는 CLI 모드.
 * GUI 모드는 {@link IssuerGui}, 진입점은 {@link IssuerMain}.
 *
 * <pre>
 *   modernize-pro-data-issuer cli generate-keypair
 *   modernize-pro-data-issuer cli sign --customer "KDB Bank" --site-id kdb-2026 \
 *                                      --expires 2027-04-21 --out kdb.lic
 *   modernize-pro-data-issuer cli fingerprint
 * </pre>
 */
public final class IssuerCli {

    public static void run(String[] args) throws Exception {
        if (args.length == 0) { usage(); return; }
        switch (args[0]) {
            case "generate-keypair" -> generateKeyPair();
            case "sign"             -> sign(parseArgs(Arrays.copyOfRange(args, 1, args.length)));
            case "fingerprint"      -> printFingerprint();
            default                 -> usage();
        }
    }

    private static void generateKeyPair() throws Exception {
        if (KeyManager.keypairExists()) {
            System.err.println("ERROR: keypair already exists at " + KeyManager.HOME);
            System.err.println("       remove it manually first if you really want to rotate.");
            System.exit(2);
            return;
        }
        KeyPair kp = KeyManager.generate();
        System.out.println("Keypair generated (Ed25519):");
        System.out.println("  private: " + KeyManager.PRIVATE_KEY_PATH);
        System.out.println("  public:  " + KeyManager.PUBLIC_KEY_PATH);
        System.out.println("  fingerprint: " + KeyManager.fingerprint(kp.getPublic().getEncoded()));
        System.out.println();
        System.out.println("Copy the public.pem content to backend resources at:");
        System.out.println("  backend/src/main/resources/license/public-key.pem");
    }

    private static void printFingerprint() throws Exception {
        if (!KeyManager.keypairExists()) {
            System.err.println("ERROR: public.pem not found at " + KeyManager.PUBLIC_KEY_PATH);
            System.exit(2);
            return;
        }
        System.out.println(KeyManager.fingerprint(KeyManager.loadPublicDer()));
    }

    private static void sign(Map<String, String> arg) throws Exception {
        require(arg, "customer", "site-id", "expires", "out");
        if (!KeyManager.keypairExists()) {
            System.err.println("ERROR: private.pem not found. Run `generate-keypair` first.");
            System.exit(2);
            return;
        }
        String customer = arg.get("customer");
        LicenseSigner.Input in = new LicenseSigner.Input(
                arg.getOrDefault("license-id", LicenseSigner.defaultLicenseId(customer)),
                customer,
                arg.get("site-id"),
                LocalDate.parse(arg.get("expires")),
                Integer.parseInt(arg.getOrDefault("grace-days", "14"))
        );
        Path out = Paths.get(arg.get("out"));
        LicenseDocument doc = LicenseSigner.signToFile(in, out);
        System.out.println(".lic written: " + out.toAbsolutePath());
        System.out.println("  customer=" + doc.payload().customer());
        System.out.println("  siteId="   + doc.payload().siteId());
        System.out.println("  expires="  + doc.payload().expiresAt());
    }

    private static void usage() {
        System.err.println("""
                Usage (CLI mode):
                  java -jar issuer.jar cli generate-keypair
                  java -jar issuer.jar cli sign --customer <name> --site-id <id> \
                              --expires YYYY-MM-DD --out file.lic
                              [--grace-days N]
                              [--license-id MPD-...]
                  java -jar issuer.jar cli fingerprint

                Without `cli`, the GUI launches.
                """);
    }

    private static Map<String, String> parseArgs(String[] args) {
        Map<String, String> map = new HashMap<>();
        for (int i = 0; i < args.length; i++) {
            String a = args[i];
            if (a.startsWith("--") && i + 1 < args.length) {
                map.put(a.substring(2), args[i + 1]);
                i++;
            }
        }
        return map;
    }

    private static void require(Map<String, String> arg, String... keys) {
        for (String k : keys) {
            if (!arg.containsKey(k) || arg.get(k).isBlank()) {
                System.err.println("ERROR: missing required --" + k);
                System.exit(2);
            }
        }
    }

    private IssuerCli() {}
}
