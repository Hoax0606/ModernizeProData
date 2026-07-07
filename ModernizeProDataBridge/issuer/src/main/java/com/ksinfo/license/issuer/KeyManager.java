package com.ksinfo.license.issuer;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.X509EncodedKeySpec;
import java.util.Base64;

/**
 * Ed25519 keypair 생성 / 로드 / 지문 계산.
 * private key 는 {@code ~/.ksinfo-license-issuer/private.pem} 에 보관.
 */
public final class KeyManager {

    /**
     * Key 저장 위치 — LicenseIssuer.exe 와 같은 폴더 안의 {@code license/} 서브폴더.
     * 인수인계 시 install 폴더 (예: {@code C:\ksinfo\ModernizeProDataBridge\LicenseIssuer\}) 전체를
     * USB 로 옮기면 키도 함께 따라감.
     *
     * <p>jpackage 가 아닌 dev 모드 (IDE / mvn) 일 때는 user home 으로 fallback.
     */
    public static final Path HOME = resolveHomeDir();
    public static final Path PRIVATE_KEY_PATH = HOME.resolve("private.pem");
    public static final Path PUBLIC_KEY_PATH  = HOME.resolve("public.pem");

    private static Path resolveHomeDir() {
        // 1. jpackage launcher 가 설정하는 시스템 property
        String appPath = System.getProperty("jpackage.app-path");
        if (appPath != null && !appPath.isBlank()) {
            Path exe = Paths.get(appPath);
            if (exe.getParent() != null) return exe.getParent().resolve("license");
        }
        // 2. 실행 중인 jar 위치로 install dir 추정 (jpackage layout: install/app/*.jar)
        try {
            Path jar = Paths.get(KeyManager.class.getProtectionDomain()
                    .getCodeSource().getLocation().toURI());
            Path parent = jar.getParent();
            if (parent != null && "app".equals(parent.getFileName().toString())
                    && parent.getParent() != null) {
                return parent.getParent().resolve("license");
            }
        } catch (Exception ignored) {}
        // 3. dev fallback
        return Paths.get(System.getProperty("user.home"), ".ksinfo-license-issuer");
    }

    public static boolean keypairExists() {
        return Files.exists(PRIVATE_KEY_PATH) && Files.exists(PUBLIC_KEY_PATH);
    }

    public static KeyPair generate() throws Exception {
        if (keypairExists()) {
            throw new IllegalStateException("Keypair already exists at " + HOME
                    + " — rotation requires manual removal");
        }
        Files.createDirectories(HOME);
        KeyPairGenerator g = KeyPairGenerator.getInstance("Ed25519");
        KeyPair kp = g.generateKeyPair();
        savePem(PRIVATE_KEY_PATH, "PRIVATE KEY", kp.getPrivate().getEncoded());
        savePem(PUBLIC_KEY_PATH,  "PUBLIC KEY",  kp.getPublic().getEncoded());
        return kp;
    }

    public static PrivateKey loadPrivate() throws Exception {
        byte[] der = loadPem(PRIVATE_KEY_PATH);
        return KeyFactory.getInstance("Ed25519").generatePrivate(new PKCS8EncodedKeySpec(der));
    }

    public static byte[] loadPublicDer() throws Exception {
        return loadPem(PUBLIC_KEY_PATH);
    }

    public static PublicKey loadPublic() throws Exception {
        return KeyFactory.getInstance("Ed25519").generatePublic(new X509EncodedKeySpec(loadPublicDer()));
    }

    /** SHA-256 의 첫 16 바이트를 hex 로. */
    public static String fingerprint(byte[] der) throws Exception {
        byte[] hash = MessageDigest.getInstance("SHA-256").digest(der);
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 16; i++) sb.append(String.format("%02x", hash[i] & 0xff));
        return sb.toString();
    }

    private static void savePem(Path path, String type, byte[] der) throws Exception {
        StringBuilder sb = new StringBuilder();
        sb.append("-----BEGIN ").append(type).append("-----\n");
        String b64 = Base64.getEncoder().encodeToString(der);
        for (int i = 0; i < b64.length(); i += 64) {
            sb.append(b64, i, Math.min(i + 64, b64.length())).append('\n');
        }
        sb.append("-----END ").append(type).append("-----\n");
        Files.writeString(path, sb.toString(), StandardCharsets.UTF_8);
    }

    private static byte[] loadPem(Path path) throws Exception {
        String pem = Files.readString(path, StandardCharsets.UTF_8);
        String b64 = pem.replaceAll("-----.*-----", "").replaceAll("\\s+", "");
        return Base64.getDecoder().decode(b64);
    }

    private KeyManager() {}
}
