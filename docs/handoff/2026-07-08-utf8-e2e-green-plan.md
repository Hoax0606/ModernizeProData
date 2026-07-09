# 2026-07-08 — UTF-8 인코딩 정리 + cutover end-to-end green 계획

> 이 문서는 **작업 계획 브리핑**이다 (아직 착수 전). 새 세션/팀원 Claude Code 가 이 문서만 읽고
> 컨텍스트를 이어받을 수 있도록 조사 결과·결정·파일 참조·순서를 self-contained 로 담았다.
> 소스 실제 루트는 세그먼트가 중복된 `ModernizeProDataBridge/ModernizeProDataBridge/` 아래
> (backend / frontend / cli / issuer / installer).

---

## 0. 한 줄 목표

**UTF-8 CSV 를 넣고 `planning → … → cutover` 까지 8 stage 전부 성공 + PG 적재 데이터 검증 통과를,
반복 가능한(통합테스트) 형태로 한 번 세운다 (= "end-to-end green").**

---

## 1. 이번 라운드의 확정 결정 (스코프 고정)

1. **파이프라인 입력 계약 = UTF-8.** AS-IS 가 어떤 인코딩이든 UTF-8 CSV 로 변환된 뒤 우리 툴에 들어온다.
2. **EBCDIC(및 기타 비-UTF-8) → UTF-8 변환은 외부 툴 책임.** 사내 방침에 따라 나중에 라이브러리화되어
   우리 툴에 붙을 수 있음 → **변환 seam(Source Reader SPI 자리)만 남기고**, 지금은 no-op(이미 UTF-8) 로 둔다.
3. **TO-BE = PostgreSQL 우선.** PG server_encoding = UTF8 → 타깃 transcoding 불필요. 다른 TO-BE DB 는 이후 라운드
   (Loader Adapter SPI 자리 유지).
4. **목표 범위 = cutover 완료까지.** rehearsal 이 아니라 cutover 한 판 완주.
5. **목표 형태 = end-to-end green.** 코드만 있는 상태가 아니라 실제로 한 번 통과시켜 증명한다.

---

## 2. 배경 — 인코딩 조사 결과 (왜 UTF-8 계약으로 가는가)

팀원이 "DuckDB `encodings` 확장의 Shift_JIS 디코더가 유효 바이트를 오거부한다"는 upstream 버그
(byte `95 E3` = 「輔」U+8F14, materialize 시 `Invalid unicode`, COUNT 은 통과, issue #23322)를 공유.
이를 실측 검증한 결과:

- **DuckDB 1.1.3** (m2 잔존 구버전): `read_csv` 에 `encoding` 파라미터 자체가 없음
  (`Binder Error: Invalid named parameter "encoding"`). 팀 초기 "DuckDB 못 함" 기억의 출처. → 지금은 1.5.3.0.
- **DuckDB 1.5.3.0 + 우리 번들 확장(격리 로드)**: 輔(95 E3) 를 COUNT/SELECT/**CTAS materialize**/parquet COPY
  전부 정상 디코드 (U+8F14). 5000행·멀티컬럼·타입추론 변형 포함, **팀원 실패 재현 안 됨.**
  → 우리 번들 확장 빌드(5/31)의 디코더는 정상. 팀원이 본 실패는 **다른 확장 빌드**(autoload 된 community 빌드
  가능성)로 추정. 증상 패턴(COUNT ok / materialize fail)은 lazy-decode + 디코더 버그와 앞뒤 맞음 —
  팀원 관찰 자체는 타당.
- 함정: `LOAD '<번들경로>'` 를 호출해도 `duckdb_extensions()` 가 `install_mode=REPOSITORY`(이전 INSTALL 캐시)
  로 뜨는 경우가 있음 → **"번들 넣음" ≠ "번들이 로드됨".**

**결론**: 확장 디코더 정확성이 빌드마다 흔들리는 것에 의존하는 것 자체가 금융권 도구에 부적합.
그런데 **입력을 UTF-8 로 고정하면 DuckDB `encoding=` 을 아예 안 쓰게 되어 이 버그 경로가 통째로 사라진다.**
그래서 "UTF-8 계약 + 확장 제거" 로 방향 확정. (Shift_JIS→UTF-8 을 우리가 직접 할 경우의 대안은 §6 부록.)

---

## 3. 선행 작업 (Step 0) — 현재 코드 상태 재확인 **먼저**

아래 §4 의 P0 목록은 **2026-05-28** handoff 기준이고 지금은 6주 이상 지났다.
이번 세션 백엔드 스캔에서는 `SqlComposer` 가 "scope 내 complete, rogue TODO 없음" 으로 보였다.
→ **P0 버그가 아직 살아있는지 실코드로 판정한 뒤 착수**할 것. 이미 고쳐진 버그를 다시 잡느라 시간 낭비 방지.

확인 대상:
- `SqlComposer.java` — alias / union / join 조립 로직 현재 상태
- `LoadStage.java` + `PgCopyManager.java` — COPY 시 NULL/empty/bool/date 처리 현재 상태
- cutover 카탈로그(`LocalWorkerExecutor` 의 stage 목록) — `AuditStage` 포함 여부, cutover 전이 로직

---

## 4. 크리티컬 패스 (순서대로)

### A. 인코딩 정리 (선행, 규모 작음)
1. `ExtractStage`(coordinator/worker/stages/ExtractStage.java) 의 `read_csv_auto(...)` 에서 **`encoding=` 절 제거** → UTF-8 고정.
   - 현재: L167-169 에서 `encodingClause` 를 이어붙임. private `encodingClause()` = L375-395.
2. **encodings 확장 의존 제거** (icu 는 timezone 용이라 유지):
   - `common/duckdb/DuckDbService.java` — `loadEncodingsExtension`(L195-196), `resolveBundledExtension`(L180-188, encodings 분),
     연결 open 시 호출(L96), 재로드(L279, L326).
   - `common/util/CsvEncoding.java` — `clause()` 전체(L14-32).
   - `ExtractStage.encodingClause()`(L375-395) 및 호출부.
   - preview: `coordinator/api/SiteCsvPreviewController.java` / report: `coordinator/mapping/MappingReportService.java` 의 encoding 절.
   - `installer/build.ps1` L270-299 의 encodings 다운로드/번들(icu 는 남김). 번들 바이너리 177MB 제거 효과.
3. **입력 가드 추가** (silent 오적재 방지):
   - UTF-8 well-formed 검증 (외부 변환툴이 깨진 UTF-8 뱉을 수 있음) → quarantine/reject.
   - **BOM(`EF BB BF`) strip** (안 지우면 첫 컬럼명이 `﻿id` 로 깨져 매핑 실패).
   - **NUL(`0x00`) 차단** (PG text 는 0x00 저장 불가 → `invalid byte sequence for encoding "UTF8": 0x00`) → quarantine.
   - (참고) 4-byte UTF-8(U+10000+)은 PG UTF8 에서 정상 — 문제 없음.
4. **변환 seam** — 비-UTF-8 → UTF-8 지점을 Source Reader SPI(ONBOARDING §7) 자리로. 현재 구현체 = no-op(이미 UTF-8).
   외부 EBCDIC 변환툴이 라이브러리화되면 여기 어댑터만 꽂는다(파이프라인 불변).

### B. Transform 정합성 (P0 — **Step 0 확인 후**)
5. `SqlComposer` alias 버그 — 생성 SQL 이 `a./c./m.` 개별 alias 인데 FROM 은 `AS "asis"` 고정 → Binder Error.
6. `SqlComposer` union `SELECT *` — UNION CSV 컬럼 순서/이름 다르면 오매핑(silent corruption).
7. `SqlComposer` join `aliasFor` primary fallback — rule.asisTable 불일치 시 오테이블 조인.

### C. Load 정합성 (P0)
8. COPY 타입 계약 명문화 + 테스트 — empty↔NULL 모호, `'Y'/'1'`→bool, date 포맷.
   (UTF-8/PG-UTF8 전제라 인코딩 문제는 없음. 순수 타입 매핑 이슈.)

### D. cutover 경로 (스코프=cutover 라 필수)
9. cutover 라이프사이클 전이 `ready → cutover → hypercare` (미구현 확인 필요).
10. cutover 카탈로그에 `AuditStage` 포함 (현재 누락 → 검증 없이 적재).
11. production 환경 가드 (cutover 는 Stage=production 에서만).

### E. green 실증 (진짜 목표)
12. UTF-8 테스트 데이터셋 준비 — ARCHITECTURE 의 BANKSYS 시나리오(1:1 / 1:N / N:N 변환 포함).
13. **Testcontainers(PG) + DuckDB 통합테스트**로 full run → 8 stage success → PG 적재 데이터 정확성 검증.
    one-off 수동 말고 **반복 가능**하게. (프로젝트 정책: H2 금지, Testcontainers+Flyway.)
14. Verify stage(row count + PK 정렬 비교) + Validation stage(SUM/MIN/MAX/checksum) 통과 확인.

---

## 5. 명시적 out-of-scope (이번 green 에는 불필요 — 별도 라운드)

- abort lock-ordering race, paused-run `RunTimeoutSweeper` 미포착, pre-register pause/abort race
  → happy-path green 과 무관(abort/pause 시나리오).
- PG 외 Loader adapter, Shift_JIS/CP932 **직수신** 디코드(외부 변환 전제).
- Artifacts / SiteExport BE wiring, row-level quarantine 분리 등.

## 리스크 / 미정

- **B(SqlComposer) 가 이미 고쳐졌으면** 이번 작업이 크게 줄어든다 → Step 0 결과에 좌우.
- **cutover 미구현분(D)** 규모가 가장 불확실 — 코드 확인 후 산정.
- **green 판정 기준** 합의 필요: 데이터 "정확"의 정의 = row count? PK 일치? checksum? (Validation stage 기준 채택 여부)

---

## 6. 부록 — 만약 SJIS/CP932 를 우리 툴이 직접 받아야 하게 되면

(현재 결정은 "외부에서 UTF-8 변환" 이라 아래는 보류. 방침 바뀌면 이 절대로 복원.)

- Java `CharsetDecoder` 로 선변환. **charset = `windows-31j`(MS932)** 고정.
  - strict `Shift_JIS`(Java)는 NEC/IBM 벤더 확장문자(機種依存文字 ①·髙·﨑 등)를 **오거부** → 쓰면 안 됨.
  - MS932 는 superset(순수 SJIS 도 커버). 단 파동대시류 약 7문자 코드포인트 차이
    (`81 60`: SJIS→U+301C〜 vs MS932→U+FF5E～) — 문서화 필요.
- invalid byte 정책 = `onMalformedInput/onUnmappableCharacter = REPORT` → byte offset 과 함께 quarantine.
  - 진짜 invalid = lone lead(`95`단독) / 범위밖 trail / 미할당 코드포인트(`85 40`,`EF 40`) / 미정의 바이트(`80`,`A0`,`FD–FF`).
- 메인프레임 주의: 일본 메인프레임은 SJIS 가 아니라 EBCDIC 계열(IBM漢字/JEF/KEIS/JIPS). 진짜 위험은 디코드가 아니라
  **추출 단계의 gaiji(외자, SJIS `F040–F9FC`)/벤더문자 손실(〓 치환)** — 도착 후 복구 불가 →
  추출 규격 사전합의 + 치환문자(〓/U+FFFD/PUA) 탐지 quarantine.

---

## 7. 핵심 파일 참조

| 파일 | 역할 |
|---|---|
| `backend/.../coordinator/worker/stages/ExtractStage.java` | read_csv `encoding=` + U+FFFD scan (인코딩 정리 대상) |
| `backend/.../common/util/CsvEncoding.java` | encoding 절 매핑 (제거 대상) |
| `backend/.../common/duckdb/DuckDbService.java` | 확장 로드 (encodings 제거, icu 유지) |
| `backend/.../coordinator/api/SiteCsvPreviewController.java` | preview read 경로 |
| `backend/.../coordinator/mapping/MappingReportService.java` | report read 경로 |
| `backend/.../coordinator/worker/SqlComposer.java` | Transform SQL 조립 (B: P0) |
| `backend/.../coordinator/worker/stages/LoadStage.java` + `coordinator/load/PgCopyManager.java` | COPY 적재 (C: P0) |
| `backend/.../coordinator/worker/LocalWorkerExecutor.java` | stage 카탈로그 / cutover 경로 (D) |
| `installer/build.ps1` | 확장 번들 (L270-299), jpackage `--input`(L509) |
| `backend/pom.xml` | duckdb_jdbc 1.5.3.0 (L123) |

## 8. 미해결 확인 (해결되면 §2 / 계획 정밀화)

1. 팀원 재현 환경의 `SELECT extension_version, install_mode, installed_from FROM duckdb_extensions() WHERE extension_name='encodings'` — 우리 번들과 버전 해시 비교. (UTF-8 계약으로 가면 무의미해지지만 원인 기록용)
2. issue #23322 의 fixed/target 버전 (조사 시점 오프라인이라 본문 미확인).
