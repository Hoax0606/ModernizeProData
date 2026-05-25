package com.ksinfo.modernize_pro_data.common.util;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;

/**
 * SHA-256 hash helper. 用途:
 *   - API token 의 hash 保管 / 認証時 lookup (CredentialService)
 *   - DDL ファイル / mapping content 의 fingerprint (DdlImportService 等)
 */
public final class HashUtil {

    private HashUtil() {}

    /** byte[] → SHA-256 hex 64 chars. */
    public static String sha256Hex(byte[] bytes) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(md.digest(bytes));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 not available", e);
        }
    }

    /** String (UTF-8) → SHA-256 hex 64 chars. */
    public static String sha256Hex(String input) {
        return sha256Hex(input.getBytes(StandardCharsets.UTF_8));
    }
}
