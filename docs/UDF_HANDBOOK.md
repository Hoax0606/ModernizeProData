# UDF Handbook

Modernize Pro Data 의 도구 내장 **DuckDB UDF (Java)** 카탈로그.
각 UDF 는 `mapping_rules.transform_sql` 의 SELECT 절에 그대로 인젝션되어 평가된다.

## 공통 규칙

- 모든 UDF 는 **null 입력 → null 반환** (`withNullInNullOut()` 또는 함수 내부 가드).
- 실패 / 무효 입력 시 **예외 throw 금지, null 반환** — Quarantine 분기로 흘러간다.
- 결정적 UDF (같은 입력 → 같은 출력) 는 DuckDB 가 캐싱 가능. 호출마다 달라야 하는 UDF 는 반드시 `withVolatile()`.
- 등록 지점: `UdfRegistry.registerAll(Connection)` → `DuckDbService.getConnection()` 직후 1 회. 새 connection 마다 재등록 필요.
- 위치: `backend/src/main/java/com/ksinfo/modernize_pro_data/common/duckdb/udf/`.

자동완성: 프론트엔드 (`MappingPage.tsx`) 의 `UDF_FUNC_SIGS` / `UDF_FUNCS` 와 일치. 새 UDF 추가 시 양쪽 다 갱신.

---

## apply_scale

```
apply_scale(VARCHAR raw_hex, INTEGER scale) → VARCHAR
```

COMP-3 (Packed Decimal) hex 문자열을 unpack 후 scale 만큼 소수점 적용. **정확한 문자열** 반환 (trailing zero 없음).

- 부호 nibble: `C/F/A/E` → 양수, `D/B` → 음수, 기타 → 부호 없는 plain 숫자열로 간주
- 사용자가 row editor 에서 명시적 CAST 필요 — VARCHAR 반환은 DuckDB UDF 가 컴파일 타임 시그니처 고정이라 BigDecimal 기본 scale (DECIMAL(38, 11)) 의 trailing zero 회피용
- null / invalid hex → null
- volatile: no

```sql
CAST(apply_scale(e.SALARY_RAW, 2) AS DECIMAL(15,2))  -- "12345C" → 123.45
CAST(apply_scale(e.COUNT_RAW, 0)  AS INTEGER)         -- "0000045D" → -45
```

---

## unpack_comp

```
unpack_comp(VARCHAR raw_hex, INTEGER scale) → VARCHAR
```

COBOL COMP / COMP-4 (Binary Integer) — 빅엔디언 2's complement signed 정수. hex 길이로 자동 자릿수 판단.

- 4 자 (2 byte) → short, 8 자 (4 byte) → int, 16 자 (8 byte) → long
- COBOL `PIC S9(7)V99 COMP` 같이 implied decimal (scale) 지정 가능
- `apply_scale` 와 같은 VARCHAR 반환 + 사용자 CAST 패턴
- null / hex 길이 4·8·16 외 / 비-hex → null
- volatile: no

```sql
unpack_comp('0064', 0)      -- "100"
unpack_comp('FFFF', 0)      -- "-1"
unpack_comp('00000064', 2)  -- "1.00"
unpack_comp('80000000', 0)  -- "-2147483648"
```

---

## unpack_comp_float

```
unpack_comp_float(VARCHAR raw_hex) → DOUBLE
```

IBM Hexadecimal Floating Point (HFP) — COMP-1 / COMP-2. hex 길이로 자동 분기.

- 8 자 (4 byte) → COMP-1 (single), 16 자 (8 byte) → COMP-2 (double)
- layout: `sign(1) | exp(7, excess-64) | fraction(24 or 56)`
- `value = (-1)^sign × fraction/16^digits × 16^(exp − 64)`
- IEEE 754 와 달리 base 16 — 정확도 손실 가능
- null / 길이 8·16 외 / 비-hex → null
- volatile: no

```sql
unpack_comp_float('41100000')         --  1.0   (COMP-1)
unpack_comp_float('C1100000')         -- -1.0
unpack_comp_float('4110000000000000') --  1.0   (COMP-2)
unpack_comp_float('00000000')         --  0.0
```

---

## unpack_signed_separate

```
unpack_signed_separate(VARCHAR raw) → VARCHAR
```

COBOL `SIGN IS LEADING/TRAILING SEPARATE` — 부호가 별도 문자로 앞 또는 뒤에 붙음. 위치 자동 감지.

- 첫 문자가 `+/-` → leading sign
- 마지막 문자가 `+/-` → trailing sign
- 부호 없으면 양수로 간주
- 양끝 모두 부호 = 모호 → null
- digit 외 문자 / null → null
- volatile: no

```sql
unpack_signed_separate('+12345')   -- "12345"
unpack_signed_separate('-12345')   -- "-12345"
unpack_signed_separate('12345-')   -- "-12345"
unpack_signed_separate('12345')    -- "12345"
unpack_signed_separate('+12345-')  -- null (모호)
```

---

## unpack_overpunch

```
unpack_overpunch(VARCHAR raw) → VARCHAR
```

COBOL `SIGN IS TRAILING` (zone-encoded embedded sign). 부호와 마지막 digit 이 한 문자에 합쳐져 인코딩됨. EBCDIC → ASCII 변환 후 그대로 보이는 문자 처리.

- 양수: `{` = 0, `A`~`I` = 1~9 (EBCDIC zone C)
- 음수: `}` = 0, `J`~`R` = 1~9 (EBCDIC zone D)
- 마지막이 일반 digit 이면 부호 없는 케이스로 통과
- leading overpunch (첫 문자 인코딩) 는 별도 UDF 로 분리 (덜 흔함)
- null / overpunch 외 문자 → null
- volatile: no

```sql
unpack_overpunch('1234{')  -- "12340"
unpack_overpunch('1234I')  -- "12349"
unpack_overpunch('1234}')  -- "-12340"
unpack_overpunch('1234R')  -- "-12349"
unpack_overpunch('12345')  -- "12345" (부호 없는 케이스)
```

---

## convert_era

```
convert_era(VARCHAR era_text) → DATE
```

일본 연호 표기를 서기 DATE 로 변환.

- 연호 기산년: 令和(2019) / 平成(1989) / 昭和(1926) / 大正(1912) / 明治(1868)
- 패턴: `^(연호)(\d+)年(\d+)月(\d+)日$` (元年 미지원 — 1년 으로 명시해야 함)
- 매칭 실패 / 무효 날짜 / null → null
- volatile: no

```sql
convert_era('令和8年5月16日')  -- 2026-05-16
convert_era('昭和64年1月7日')  -- 1989-01-07
convert_era('平成元年1月8日')  -- null (元 미지원)
```

---

## assign_seq

```
assign_seq(VARCHAR partition_key) → BIGINT
```

partition 별 독립 시퀀스. **동일 입력에도 호출마다 다른 값**.

- partition_key 별 `AtomicLong` 카운터 (프로세스 메모리, 재기동 시 1 부터)
- null partition → 전역 카운터 (`__global__`)
- volatile: **yes** — `withVolatile()` 없으면 DuckDB 가 캐싱해 모든 행에 같은 번호가 들어가는 버그 발생
- Production: 메타DB 의 시퀀스 테이블로 옮길 것 (별도 task)

```sql
assign_seq('DEPT_A')  -- 1, 2, 3, ... (호출마다 +1)
assign_seq('DEPT_B')  -- 1, 2, 3, ... (독립 카운터)
```

---

## unpack_zone_decimal

```
unpack_zone_decimal(VARCHAR zone_hex) → VARCHAR
```

IBM 메인프레임 Zone Decimal (EBCDIC Display Numeric) hex 문자열을 정수 문자열로 unpack. byte 단위 — 상위 nibble = zone code, 하위 nibble = digit (0~9).

- 마지막 byte 의 zone: `C/F/A/E` → 양수, `D/B` → 음수, 기타 → null
- null / hex 아님 / 홀수 길이 / digit nibble 범위 외 → null
- volatile: no
- 한계: 실제 EBCDIC byte 시퀀스가 ASCII/CP1252 변환되며 특수 매핑이 일어남. Reader 단계에서 raw byte → hex 로 정규화한 후 호출 권장

```sql
unpack_zone_decimal('F1F2F3F4F5')  -- "12345" (unsigned)
unpack_zone_decimal('F1F2F3F4C5')  -- "12345" (마지막 zone=C → 양수)
unpack_zone_decimal('F1F2F3F4D5')  -- "-12345" (마지막 zone=D → 음수)
```

---

## validate_bizno

```
validate_bizno(VARCHAR bizno) → VARCHAR
```

일본 法人番号 (13 자리) 의 체크디지트 검증. 유효하면 정규화된 13 자리 문자열, 무효하면 null.

- 알고리즘: 国税庁 공식. `Q1 = 9 − (Σ(n=2..13) Q_n × P_n) mod 9`, `P_n = 1 if n even, 2 if odd`
- 입력 정규화: 공백 / 하이픈 제거
- 자릿수 부족 / 숫자 외 문자 / 체크디지트 불일치 → null
- volatile: no
- 한국 사업자번호 (10 자리, modulo 10) 는 별도 UDF (`validate_brn_kr`) 로 분리 권장

```sql
validate_bizno('1234567890123')      -- 체크디지트 일치 시 그대로 반환
validate_bizno('1234-5678-9012-3')   -- 구분자 제거 후 검증
validate_bizno('ABCDEFGHIJKLM')      -- null
```

---

## mask_phone

```
mask_phone(VARCHAR phone) → VARCHAR
```

전화번호 가운데 디지트를 `*` 로 마스킹. 일본 dial-plan 의 다양한 자릿수 (03 / 045 / 090) 를 자연스럽게 처리.

- 구분자 (하이픈 / 공백) 있음 → **첫 그룹** + 마지막 4 디지트 보존
- 구분자 없음 → 앞 3 + 마지막 4 디지트 보존
- 디지트 7 미만 → 마스킹 안 함 (원본 반환)
- null → null
- volatile: no

```sql
mask_phone('090-1234-5678')   -- "090-****-5678"
mask_phone('03-1234-5678')    -- "03-****-5678"
mask_phone('045-123-4567')    -- "045-***-4567"
mask_phone('09012345678')     -- "090****5678"
```

---

## hash_sha256

```
hash_sha256(VARCHAR input) → VARCHAR
```

입력 문자열을 UTF-8 인코딩 후 SHA-256. 64 자리 lowercase hex 반환.

- 동일 입력 → 항상 같은 출력 (deterministic)
- null → null
- volatile: no
- 용도: PII 토큰화 (irreversible), 데이터 무결성 검증, GDPR 가명화
- 주의: 단순 SHA-256 은 rainbow table 공격에 취약 — salt 필요 케이스는 별도 UDF (`hash_sha256_salted`) 분리

```sql
hash_sha256('hello')   -- "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
hash_sha256('')        -- "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
```

---

## normalize_corp

```
normalize_corp(VARCHAR corp_name) → VARCHAR
```

일본 법인명에서 회사 형태 표기 (株式会社, 有限会社, ㈱ 등) 제거 + 앞뒤·연속 공백 정리. 동명 회사 매칭·중복 제거 전처리용.

- 제거 대상: `株式会社` / `有限会社` / `合同会社` / `合資会社` / `合名会社` / `一般社団法人` / `一般財団法人` + 약식 (`㈱`, `㈲`, `(株)`, `(有)` — 전각/반각 괄호 모두)
- 빈 결과 / null → null
- volatile: no
- 영문 (`Inc.`, `Ltd.`) 은 별도 UDF 로 분리 권장 — 케이스 다양

```sql
normalize_corp('株式会社 田中商事')   -- "田中商事"
normalize_corp('㈱田中商事')          -- "田中商事"
normalize_corp('田中商事(株)')        -- "田中商事"
normalize_corp('有限会社さくら')      -- "さくら"
```

---

## 추가 / 변경 시 체크리스트

- [ ] `backend/.../common/duckdb/udf/{Name}Udf.java` 추가
- [ ] `UdfRegistry.registerAll()` 에 `register(conn)` 호출 한 줄 추가
- [ ] null / invalid → null 반환 (예외 throw 금지)
- [ ] 비결정적 UDF 면 `withVolatile()` 명시
- [ ] frontend `MappingPage.tsx` 의 `UDF_FUNC_SIGS` + `UDF_FUNCS` 에 추가
- [ ] **이 파일에 항목 추가** (시그니처 / 동작 / null 정책 / volatile / 예시)
- [ ] `./mvnw compile` + `npx tsc --noEmit` 통과
