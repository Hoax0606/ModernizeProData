# ModernizeProData — 설계 및 개발 계획

작성일: 2026-05-11

대형 금융권 코어 이행을 위한 데이터 이행 도구. 일본 금융권 대상.

---

## 1. 방향성

### 1.1 대상 시장

- **일본 금융권** (한국은 향후 확장 가능성)
- 메인프레임·Oracle → 모던 RDBMS 이행 수요
- 대형 코어 가정 (예: 11TB 데이터 + 8TB 인덱스 + 월 2억건 트랜잭션 + 25개 업무)

### 1.2 운영 환경

- **완전 air-gapped 폐쇄망**
- 망연계·본사 모니터링·외부 통신 일체 없음
- 본사 ↔ 현장 전달은 USB 매체로만

### 1.3 핵심 아키텍처 원칙

- **Java (Spring Boot + Spring Batch)**: 적재·오케스트레이션·UI
- **DuckDB**: 변환 + 검증 엔진 (target-agnostic)
- **TO-BE RDBMS**: 변환 결과 받기만 (PostgreSQL/Db2/Oracle/Symfoware 등 자유)

세 컴포넌트가 각자 한 가지만 함.

---

## 2. 시스템 구조

```
              [ 본사 ]
                 │
            사람이 USB로 운반
              ↓
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[ 사이트 폐쇄망 ]

  ┌────────────────────────────────────────────┐
  │ [Coordinator]  (PC 1대, 워커 중 한 대 겸용) │
  │  - 매핑 정의 (SQLite)                       │
  │  - 작업 분배·진행상황                       │
  │  - .lic 검증 (Ed25519)                       │
  │  - Audit log                                │
  │  - UI (Spring Boot + React)                 │
  │     │                                       │
  │  LAN (REST: 작업 큐 + 상태 보고)             │
  │  ┌────┬────┬────┬────┐                     │
  │  │    │    │    │    │                     │
  │ [W1][W2][W3][W4][W5] ...                    │
  │  Java + DuckDB embedded                     │
  │                                             │
  │  Oracle JDBC ←→ [ AS-IS Oracle ]            │
  │  TO-BE driver ←→ [ TO-BE RDBMS ]            │
  └────────────────────────────────────────────┘
```

---

## 3. 데이터 흐름

```
[ AS-IS Oracle ]
       │
   ① 추출 (DBA 통제, 운영 OFF time)
       ↓
[ CSV / dump 파일 — 폐쇄망 디스크 ]
       │
   ② DuckDB 가 SQL 로 변환 (JOIN / UNION / N:N)
       ↓
[ 변환된 Parquet (임시 중간 파일) ]
       │
   ③ Java 가 TO-BE driver 로 적재
       ↓
[ TO-BE RDBMS (PostgreSQL / Db2 / Oracle / ...) ]
       │
   ④ DuckDB 가 검증 (CSV ↔ TO-BE 비교)
```

**역할:**
- Java: 짐 운반 (파일 적재·TO-BE 적재·오케스트레이션)
- DuckDB: 변환·검증 (SQL 실행 엔진)
- TO-BE: 받는 창고 (영구 저장)

---

## 4. 이행 단계

### 4.1 Pre-load (D-30 ~ D-7)

1. DBA 가 AS-IS 운영 OFF time 에 dump → CSV 추출
2. CSV 가 폐쇄망에 들어옴 (USB / 망연계)
3. DuckDB 가 SQL 변환 → Parquet 출력
4. Java 가 TO-BE 에 COPY 적재
5. 인덱스 사전 생성 (CONCURRENTLY)

### 4.2 Delta sync (D-7 ~ 금 야간)

1. Oracle LogMiner 로 변경 row (INSERT/UPDATE/DELETE) 가져옴
2. DuckDB 가 변환
3. Java 가 TO-BE 에 적용

### 4.3 Cutover (토 새벽)

1. 금 야간 배치 결과의 마지막 delta sync
2. DuckDB 검증 (행수·합계·sample·cross-source JOIN)
3. 신 시스템 앱 테스트 (도구 외부)

### 4.4 운영 시작 (월)

- TO-BE = 새 운영 DB
- AS-IS 는 일정 기간 후 폐기

---

## 5. 필수 개발 환경

### 5.1 도구

| 항목 | 선택 |
|---|---|
| JDK | **21 (LTS)** |
| IDE | **IntelliJ IDEA** (Community 또는 Ultimate) |
| 빌드 | Maven 또는 Gradle |
| 버전관리 | Git |

### 5.2 로컬 DB

- **PostgreSQL** (Docker) — TO-BE 주 후보
- **Oracle XE** (Docker, Express Edition 무료) — 실 Oracle 호환 테스트
- **H2** (간이 단위 테스트)

### 5.3 OS

- 개발: Windows / macOS / Linux 모두 가능
- 배포 target:
  - Worker = Windows Server (폐쇄망 PC 다수)
  - Coordinator = Windows 또는 Linux 서버
  - TO-BE DB = 사이트 환경에 따름

---

## 6. 필수 라이브러리

| 라이브러리 | 용도 | 필수성 |
|---|---|---|
| `spring-boot-starter-web` | REST API, DI, 설정 | 필수 |
| `spring-boot-starter-batch` | chunk-oriented ETL | 필수 |
| **DuckDB JDBC** (`org.duckdb:duckdb_jdbc`) | 변환 + 검증 엔진 | 필수 |
| **Oracle JDBC** (`ojdbc11.jar`) | AS-IS 추출 + LogMiner | 필수 |
| **TO-BE 별 JDBC** | TO-BE 적재 (사이트별로 추가) | 필수 |
| SLF4J + Logback | 로깅 | 필수 |
| Jackson | JSON | 필수 |

테스트:
- JUnit 5 + Spring Boot Test
- TestContainers (실 DB 컨테이너로 통합 테스트)

---

## 7. 매핑 정의 형식

```yaml
table: tobe_customer
sources: [asis_cust_a, asis_cust_b]
transform: |
  SELECT
    a.id,
    a.name,
    b.amount,
    CASE WHEN a.status = 'A' THEN 'active' ELSE 'inactive' END AS status
  FROM 'asis_cust_a.csv' a
  JOIN 'asis_cust_b.csv' b ON a.id = b.cust_id
```

- 단순 1:1 도 SQL, 복잡 N:N 도 SQL
- 한 가지 형식, 구분 불필요
- DuckDB 가 직접 실행

---

## 8. 폐쇄망 배포 패키지

```
ZIP 한 개
 ├ JRE 21
 ├ 도구 JAR (Spring Boot fat jar)
 │   ├ spring-boot
 │   ├ spring-batch
 │   ├ duckdb-jdbc
 │   └ 기타 의존성
 ├ ojdbc11.jar (Oracle JDBC)
 ├ TO-BE driver jar (PostgreSQL / Db2 / ...)
 ├ .lic 파일 (Ed25519 서명)
 └ 설정 파일 (application.yml)
```

전체 약 300~500MB. USB 운반 → 폐쇄망 서버 unzip → 실행.

외부 통신 0건.

---

## 9. 개발 시작에 필요한 작업

### 9.1 Project skeleton

Spring Boot multi-module project:

```
ModernizeProData/
 ├ coordinator/          ← REST API, 매핑 보관, UI 호스팅
 ├ worker/               ← Spring Batch job, DuckDB, TO-BE 적재
 ├ common/               ← 모델·매핑 파서 공유
 ├ ui/                   ← React prototype (기존 자산)
 └ packaging/            ← 폐쇄망 ZIP 빌드 스크립트
```

### 9.2 핵심 컴포넌트

| 컴포넌트 | 역할 |
|---|---|
| **매핑 정의 파서** | YAML → DuckDB SQL 추출 |
| **Coordinator REST API** | 작업 분배, 상태 보고, 매핑 CRUD |
| **Worker job runner** | Spring Batch step → DuckDB 호출 → TO-BE 적재 |
| **License module** | Ed25519 .lic 검증 (Java) |
| **Audit log** | 모든 run 기록 (Coordinator SQLite) |
| **UI** | 기존 React prototype + Spring Boot 호스팅 |

### 9.3 구현 순서

1. Project skeleton + 의존성 설정
2. **매핑 정의 파서 + DuckDB SQL 실행 prototype** (단일 테이블, 가장 작은 검증)
3. AS-IS CSV → DuckDB 변환 → Parquet 출력 동작 확인
4. Java + JDBC TO-BE 적재 (PostgreSQL 부터)
5. 검증 단계 (DuckDB cross-source SQL)
6. Spring Batch chunk-oriented + 재시작 가능 구조
7. Coordinator + Worker 분리 (REST 통신)
8. License module 통합
9. UI 통합 (기존 React → Spring Boot 호스팅)
10. Oracle JDBC + LogMiner CDC (Delta sync)
11. 폐쇄망 단일 ZIP 빌드 파이프라인

---

## 10. 결정 안 된 항목

- 라이선스 만료 정책 (만료 없음 vs 5년)
- Coordinator ↔ Worker 인증 토큰 발급·만료
- Pre-load 시작 시점 (D-30 vs D-14)
- Delta sync 주기 (시간당 vs 일1회)
- TO-BE driver 지원 우선순위 (PostgreSQL 먼저? Db2? Oracle?)
- 매핑 정의 저장 형식 (YAML + SQL? 단일 JSON?)
- Worker PC 등록·해제 절차
- 인덱스 사전 생성 범위 (전부 vs 핵심만)

---

## 11. 한 줄 요약

**Java 가 짐 운반, DuckDB 가 변환·검증, TO-BE 는 받기만.**

폐쇄망 안에서 Coordinator + Worker 가 LAN 으로 분산 처리. 사이트 ZIP 단일 패키지로 USB 배포.

---

## 12. 참고 — 규모 가정

- 데이터 11TB / 인덱스 8TB / 총 19TB
- 월 트랜잭션 2억 row
- 업무 25개
- 누적 트랜잭션 약 12B row (5년 retention 가정)
- Cutover 윈도우: 금 야간 ~ 월 오픈 (실 데이터 작업 budget 약 6~12h)

이 규모에서 빅뱅 cutover 불가능 → Pre-load + Delta sync 패턴 필수.
