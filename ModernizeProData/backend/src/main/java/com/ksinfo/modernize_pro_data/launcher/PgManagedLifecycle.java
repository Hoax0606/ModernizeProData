package com.ksinfo.modernize_pro_data.launcher;

import java.io.File;
import java.io.IOException;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardOpenOption;
import java.util.Arrays;
import java.util.concurrent.TimeUnit;

/**
 * MSI 안 bundle 된 portable PG 18 의 lifecycle 관리.
 *
 * <p>흐름:
 * <ol>
 *   <li>port 5432 detect — 이미 누가 PG / 서비스 띄우고 있으면 skip (use existing).</li>
 *   <li>data dir ({@code %LOCALAPPDATA%/ModernizeProData/pg-data}) 확인.
 *       없으면 {@code initdb} 실행 + {@code CREATE DATABASE mpd_meta} + role 생성.</li>
 *   <li>{@code pg_ctl start} 로 PG 띄움.</li>
 *   <li>backend shutdown 시 {@code pg_ctl stop}.</li>
 * </ol>
 *
 * <p>PG binary 위치: jpackage 의 {@code $APPDIR/postgresql/} (build.ps1 가 staging
 * 시 PG zip extract).
 *
 * <p>인증: initdb 시 local + host 모두 trust (사용자 PC localhost only — 5432 port
 * 외부 노출은 분산 운영에서 별도 firewall 처리).
 */
public final class PgManagedLifecycle {

    private static final String DATA_DIR_NAME = "pg-data";
    private static final String DB_NAME = "mpd_meta";
    private static final String DB_USER = "mpd";
    private static final String DB_PASSWORD = "mpd";
    private static final int DB_PORT = 5432;

    private static File pgRoot;       // $APPDIR/postgresql/
    private static File dataDir;      // %LOCALAPPDATA%/ModernizeProData/pg-data
    private static File logFile;      // %LOCALAPPDATA%/ModernizeProData/pg.log
    private static boolean managed;   // 우리가 띄운 PG 면 true (shutdown 시 stop)

    private PgManagedLifecycle() {}

    /** main 진입 시 한 번 호출. PG 가 이미 5432 listen 중이면 skip. 아니면 우리 PG start. */
    public static void ensureRunning() {
        if (isPortListening(DB_PORT)) {
            System.out.println("PgManagedLifecycle: port " + DB_PORT + " already listening — use existing PG");
            managed = false;
            return;
        }

        pgRoot = resolvePgRoot();
        if (pgRoot == null) {
            System.err.println("PgManagedLifecycle: bundled PG not found at $APPDIR/postgresql/ — skip");
            return;
        }

        String localAppData = System.getenv("LOCALAPPDATA");
        if (localAppData == null) localAppData = System.getProperty("user.home");
        File baseDir = new File(localAppData, "ModernizeProData");
        if (!baseDir.exists() && !baseDir.mkdirs()) {
            System.err.println("PgManagedLifecycle: cannot create " + baseDir);
            return;
        }
        dataDir = new File(baseDir, DATA_DIR_NAME);
        logFile = new File(baseDir, "pg.log");

        try {
            if (!isInitialized(dataDir)) {
                System.out.println("PgManagedLifecycle: initdb to " + dataDir);
                initdb();
            }
            System.out.println("PgManagedLifecycle: starting PG");
            pgCtl("start");
            // ready 까지 wait — pg_isready loop.
            if (!waitForReady(30_000)) {
                System.err.println("PgManagedLifecycle: PG did not become ready within 30s");
                return;
            }
            ensureRoleAndDatabase();
            managed = true;
            System.out.println("PgManagedLifecycle: PG ready on port " + DB_PORT);
        } catch (Exception e) {
            System.err.println("PgManagedLifecycle.ensureRunning failed: " + e.getMessage());
            e.printStackTrace();
        }
    }

    /* ── helpers ──────────────────────────────────────────────────────── */

    /**
     * jpackage 의 $APPDIR/app/postgresql-portable.zip 을 user dir 에 extract 후
     * pgsql/ 디렉토리 반환. WiX 의 file count 한계로 zip 으로 bundle, 첫 launch 시 unzip.
     */
    private static File resolvePgRoot() {
        // user dir 의 unpack 위치.
        String localAppData = System.getenv("LOCALAPPDATA");
        if (localAppData == null) localAppData = System.getProperty("user.home");
        File unpackDir = new File(localAppData, "ModernizeProData/pg-binaries");
        File pgsql = new File(unpackDir, "pgsql");
        if (new File(pgsql, "bin/initdb.exe").isFile()) return pgsql;

        // zip 찾기 — jpackage $APPDIR/app/postgresql-portable.zip (or dev mode 의 cache).
        File zip = findPgZip();
        if (zip == null) {
            System.err.println("PgManagedLifecycle: bundled PG zip not found");
            return null;
        }
        try {
            System.out.println("PgManagedLifecycle: extracting " + zip + " → " + unpackDir);
            if (unpackDir.exists()) deleteRecursive(unpackDir);
            if (!unpackDir.mkdirs()) throw new IOException("mkdir failed: " + unpackDir);
            unzip(zip, unpackDir);
        } catch (Exception e) {
            System.err.println("PG zip extract failed: " + e.getMessage());
            e.printStackTrace();
            return null;
        }
        return new File(pgsql, "bin/initdb.exe").isFile() ? pgsql : null;
    }

    private static File findPgZip() {
        String javaHome = System.getProperty("java.home");
        if (javaHome == null) return null;
        File runtime = new File(javaHome);
        File appDir = runtime.getParentFile();
        if (appDir == null) return null;
        File c = new File(appDir, "app/postgresql-portable.zip");
        if (c.isFile()) return c;
        c = new File(appDir, "postgresql-portable.zip");
        if (c.isFile()) return c;
        // dev mode fallback.
        c = new File(System.getProperty("user.dir"), "installer/cache/postgresql-18.4-windows-x64-binaries.zip");
        if (c.isFile()) return c;
        return null;
    }

    private static void unzip(File zip, File destDir) throws IOException {
        try (java.util.zip.ZipFile zf = new java.util.zip.ZipFile(zip)) {
            java.util.Enumeration<? extends java.util.zip.ZipEntry> en = zf.entries();
            while (en.hasMoreElements()) {
                java.util.zip.ZipEntry e = en.nextElement();
                File out = new File(destDir, e.getName());
                // zip slip 방어.
                if (!out.getCanonicalPath().startsWith(destDir.getCanonicalPath() + File.separator)
                        && !out.getCanonicalPath().equals(destDir.getCanonicalPath())) {
                    throw new IOException("zip entry outside dest: " + e.getName());
                }
                if (e.isDirectory()) {
                    if (!out.mkdirs() && !out.isDirectory()) throw new IOException("mkdir: " + out);
                } else {
                    File parent = out.getParentFile();
                    if (parent != null && !parent.exists() && !parent.mkdirs() && !parent.isDirectory()) {
                        throw new IOException("mkdir: " + parent);
                    }
                    try (java.io.InputStream is = zf.getInputStream(e);
                         java.io.OutputStream os = new java.io.FileOutputStream(out)) {
                        is.transferTo(os);
                    }
                }
            }
        }
    }

    private static void deleteRecursive(File f) {
        if (f.isDirectory()) {
            File[] children = f.listFiles();
            if (children != null) for (File c : children) deleteRecursive(c);
        }
        f.delete();
    }

    private static boolean isPortListening(int port) {
        try (Socket s = new Socket()) {
            s.connect(new java.net.InetSocketAddress("127.0.0.1", port), 500);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private static boolean isInitialized(File dataDir) {
        return new File(dataDir, "PG_VERSION").isFile();
    }

    private static void initdb() throws IOException, InterruptedException {
        // password file — initdb 의 --pwfile.
        File pwFile = File.createTempFile("mpd-pg-pw", ".txt");
        try {
            Files.writeString(pwFile.toPath(), DB_PASSWORD, StandardCharsets.UTF_8);
            File initdb = new File(pgRoot, "bin/initdb.exe");
            int code = run(initdb,
                    "-D", dataDir.getAbsolutePath(),
                    "-U", DB_USER,
                    "-A", "scram-sha-256",
                    "--pwfile=" + pwFile.getAbsolutePath(),
                    "--encoding=UTF8",
                    "--locale=C");
            if (code != 0) throw new IOException("initdb exit=" + code);

            // pg_hba.conf — localhost trust (single-user desktop).
            File hba = new File(dataDir, "pg_hba.conf");
            String hbaContent = """
                    local   all             all                                     trust
                    host    all             all             127.0.0.1/32            trust
                    host    all             all             ::1/128                 trust
                    """;
            Files.writeString(hba.toPath(), hbaContent, StandardCharsets.UTF_8);

            // postgresql.conf — port + listen_addresses.
            File conf = new File(dataDir, "postgresql.conf");
            String extra = "\nport = " + DB_PORT + "\nlisten_addresses = 'localhost'\n";
            Files.writeString(conf.toPath(), extra, StandardCharsets.UTF_8, StandardOpenOption.APPEND);
        } finally {
            try { Files.deleteIfExists(pwFile.toPath()); } catch (Exception ignored) {}
        }
    }

    private static void pgCtl(String action) throws IOException, InterruptedException {
        File pgCtl = new File(pgRoot, "bin/pg_ctl.exe");
        int code = run(pgCtl,
                "-D", dataDir.getAbsolutePath(),
                "-l", logFile.getAbsolutePath(),
                "-w",
                action);
        if (code != 0) throw new IOException("pg_ctl " + action + " exit=" + code);
    }

    private static boolean waitForReady(long maxMillis) throws InterruptedException {
        long deadline = System.currentTimeMillis() + maxMillis;
        File pgIsReady = new File(pgRoot, "bin/pg_isready.exe");
        while (System.currentTimeMillis() < deadline) {
            try {
                int code = run(pgIsReady, "-h", "localhost", "-p", String.valueOf(DB_PORT));
                if (code == 0) return true;
            } catch (Exception ignored) {}
            Thread.sleep(500);
        }
        return false;
    }

    private static void ensureRoleAndDatabase() {
        // initdb 가 -U mpd 로 superuser 만들었음. CREATEROLE 자동 (superuser 이라).
        // mpd_meta DB 생성 (없으면).
        File psql = new File(pgRoot, "bin/psql.exe");
        try {
            run(psql,
                    "-h", "localhost",
                    "-p", String.valueOf(DB_PORT),
                    "-U", DB_USER,
                    "-d", "postgres",
                    "-c", "SELECT 1 FROM pg_database WHERE datname='" + DB_NAME + "'");
            // 존재 검사 안 함 — CREATE DATABASE IF NOT EXISTS 없으니 separate query.
            // 간단하게 CREATE 시도, 이미 존재면 fail (silent).
            run(psql,
                    "-h", "localhost",
                    "-p", String.valueOf(DB_PORT),
                    "-U", DB_USER,
                    "-d", "postgres",
                    "-c", "CREATE DATABASE " + DB_NAME);
        } catch (Exception ignored) {
            // already exists or transient — Flyway 가 다음 단계에 확인.
        }
    }

    private static int run(File exe, String... args) throws IOException, InterruptedException {
        java.util.List<String> cmd = new java.util.ArrayList<>();
        cmd.add(exe.getAbsolutePath());
        cmd.addAll(Arrays.asList(args));
        System.out.println("PgManagedLifecycle exec: " + String.join(" ", cmd));
        ProcessBuilder pb = new ProcessBuilder(cmd).redirectErrorStream(true);
        pb.environment().put("PGPASSWORD", DB_PASSWORD);
        Process p = pb.start();
        // stdout 흘려넣음
        new Thread(() -> {
            try (java.io.BufferedReader r = new java.io.BufferedReader(
                    new java.io.InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = r.readLine()) != null) System.out.println("[pg] " + line);
            } catch (Exception ignored) {}
        }, "pg-out").start();
        if (!p.waitFor(120, TimeUnit.SECONDS)) {
            p.destroyForcibly();
            return -1;
        }
        return p.exitValue();
    }
}
