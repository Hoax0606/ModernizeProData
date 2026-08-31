package com.ksinfo.modernize_pro_data.coordinator.worker.source;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** EbcdicSourceReader — 코드페이지별 디코드 + 모호 alias / invalid 바이트 fail-fast (Docker 불필요, EucJp 대칭). */
class EbcdicSourceReaderTest {

    private static final Charset IBM930 = Charset.forName("x-IBM930");
    private static final Charset IBM037 = Charset.forName("IBM037");

    private final EbcdicSourceReader reader = new EbcdicSourceReader();

    @Test
    void supports_ebcdicAliases_notOthers() {
        assertTrue(reader.supports("ebcdic-ibm930"));
        assertTrue(reader.supports("IBM930"));
        assertTrue(reader.supports("cp939"));
        assertTrue(reader.supports("EBCDIC-KANJI"));
        assertTrue(reader.supports("ebcdic-ibm037"));
        // 모호한 값도 supports=true — 레지스트리가 우리에게 라우팅해야 우리가 제대로 된 에러를 낸다.
        assertTrue(reader.supports("ebcdic"));
        assertFalse(reader.supports("UTF-8"));
        assertFalse(reader.supports("Shift_JIS"));
        assertFalse(reader.supports(null));
    }

    @Test
    void bareEbcdic_rejectedAsAmbiguous(@TempDir Path dir) throws Exception {
        Path src = Files.write(dir.resolve("in.csv"), "id\n1\n".getBytes(IBM930));

        IOException ex = assertThrows(IOException.class,
                () -> reader.toUtf8(src, "ebcdic", dir.resolve("work")));
        assertTrue(ex.getMessage().contains("ebcdic-ibm930"),
                "선택 가능한 코드페이지를 안내해야 함: " + ex.getMessage());
    }

    @Test
    void validIbm930_decodedToUtf8(@TempDir Path dir) throws Exception {
        String csv = "EMP_ID,EMP_NAME\nE001,田中太郎\n";
        Path src = Files.write(dir.resolve("in.csv"), csv.getBytes(IBM930));

        // workDir 은 아직 없는 하위 디렉터리 — reader 가 createDirectories 해야 한다.
        Path out = reader.toUtf8(src, "ebcdic-ibm930", dir.resolve("work"));
        assertEquals(csv, Files.readString(out, StandardCharsets.UTF_8));
    }

    @Test
    void variantRouting_ibm037NotReadAsIbm930(@TempDir Path dir) throws Exception {
        // IBM037 은 한자를 못 담으므로 ASCII 전용 픽스처.
        String csv = "id,name\n1,tanaka\n";
        Path src = Files.write(dir.resolve("in.csv"), csv.getBytes(IBM037));

        Path right = reader.toUtf8(src, "ebcdic-ibm037", dir.resolve("w1"));
        assertEquals(csv, Files.readString(right, StandardCharsets.UTF_8));

        /* 같은 바이트를 930 으로 읽으면 다른 문자열이 나오는데 예외는 안 난다.
           = 코드페이지 오선택은 조용한 손상 → 모호한 'ebcdic' 을 거부하는 근거. */
        Path wrong = reader.toUtf8(src, "ebcdic-ibm930", dir.resolve("w2"));
        assertNotEquals(csv, Files.readString(wrong, StandardCharsets.UTF_8));
    }

    @Test
    void invalidByte_failsFastWithOffset(@TempDir Path dir) throws Exception {
        // 0x57 은 IBM930 에 매핑이 없다. 앞에 정상 2바이트 → offset 2.
        byte[] bad = new byte[]{0x62, 0x63, 0x57, 0x64};
        Path src = Files.write(dir.resolve("bad.csv"), bad);

        IOException ex = assertThrows(IOException.class,
                () -> reader.toUtf8(src, "ebcdic-ibm930", dir.resolve("work")));
        assertTrue(ex.getMessage().contains("byte offset"), ex.getMessage());
        assertTrue(ex.getMessage().contains("2"), "unmappable 위치(offset 2): " + ex.getMessage());
    }

    @Test
    void everySupportedVariant_mapsEbcdicNewlineToLf() {
        /* "개행 정규화가 불필요하다" 는 이 리더 설계의 전제다 — 가정이 아니라 검사되는 불변식으로
           고정한다. 나중에 0x15 를 U+0085(NEL) 로 매핑하는 변형이 추가되면 여기서 터진다. */
        for (String enc : new String[]{"ebcdic-ibm930", "ebcdic-ibm939", "ebcdic-ibm037"}) {
            Charset cs = Charset.forName(switch (enc) {
                case "ebcdic-ibm930" -> "x-IBM930";
                case "ebcdic-ibm939" -> "x-IBM939";
                default -> "IBM037";
            });
            assertEquals("\n", new String(new byte[]{0x15}, cs), enc + " NL(0x15)");
            assertEquals("\n", new String(new byte[]{0x25}, cs), enc + " LF(0x25)");
        }
    }

    @Test
    void lineTerminators_areEbcdicNotAscii() {
        // 원본에 ASCII 0x0A 가 없으므로 행 수 카운트는 0x15/0x25 를 세야 한다.
        assertEquals(2, reader.sourceLineTerminators().length);
        assertEquals(0x15, reader.sourceLineTerminators()[0]);
        assertEquals(0x25, reader.sourceLineTerminators()[1]);
    }

    @Test
    void largeFile_dbcsSurvivesChunkBoundaries(@TempDir Path dir) throws Exception {
        /* 64KB(BUF) 청크를 여러 번 넘기며 DBCS 를 검증한다. IBM930 은 SBCS/DBCS 혼재라
           shift-out(0x0E)/shift-in(0x0F) 상태를 CharsetDecoder 인스턴스가 들고 있고,
           그 상태가 bb.compact() 경계를 넘어 유지돼야 한다. 인라인 픽스처(수십 바이트)로는
           경계를 한 번도 안 넘어 이 경로가 통째로 미검증이었다.
           이름 길이를 일부러 제각각으로 둬 DBCS 런이 매번 다른 위치에서 경계에 걸리게 한다. */
        String[] names = {"田中太郎", "佐藤花子", "鈴木一郎", "さいたま", "山本大輔"};
        StringBuilder sb = new StringBuilder("ID,NAME,CITY\n");
        int rows = 20_000;
        for (int i = 1; i <= rows; i++) {
            sb.append(i).append(',').append(names[i % names.length]).append(",東京\n");
        }
        String csv = sb.toString();
        byte[] ebcdic = csv.getBytes(IBM930);
        assertTrue(ebcdic.length > 5 * (1 << 16),
                "64KB 청크를 여러 번 넘겨야 의미 있음 — 실제 " + ebcdic.length + " bytes");

        Path src = Files.write(dir.resolve("big.csv"), ebcdic);
        Path out = reader.toUtf8(src, "ebcdic-ibm930", dir.resolve("work"));

        assertEquals(csv, Files.readString(out, StandardCharsets.UTF_8),
                "청크 경계를 넘는 DBCS/shift 상태가 보존돼야 한다");
    }

    @Test
    void preview_truncatesToLastCompleteRow(@TempDir Path dir) throws Exception {
        // 기존 두 reader 가 빠뜨린 toUtf8Preview 커버리지.
        String csv = "id,name\n1,aaa\n2,bbb\n";
        Path src = Files.write(dir.resolve("in.csv"), csv.getBytes(IBM930));

        // 첫 행 + 둘째 행 일부만 걸리도록 자름 → 완전한 행까지만 남아야 한다.
        Path out = reader.toUtf8Preview(src, "ebcdic-ibm930", dir.resolve("work"), 12);
        String s = Files.readString(out, StandardCharsets.UTF_8);
        assertTrue(s.endsWith("\n"), "완전한 행까지만: " + s);
        assertEquals("id,name\n", s);
    }
}
