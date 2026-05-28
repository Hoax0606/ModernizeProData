---
title: "ModernizeProData 개발 매뉴얼"
subtitle: "Developer Manual · Enterprise Edition"
author: "KS Info System Co., Ltd."
date: "2026"
lang: ko
---

## 목차

1. 머리말
2. 시스템 아키텍처
3. 기술 스택
4. 디렉토리 구조
5. 개발 환경 구축
6. 도메인 모델
7. 메타 데이터베이스 (H2)
8. AS-IS 데이터 수집 — CSV 적재 + 도구 내장 DB
9. 백엔드 구현
10. Spring Batch — 이행 엔진
11. JDBC 드라이버 동적 로딩 (TO-BE)
12. 프론트엔드 구현
13. REST API 명세
14. WebSocket 명세
15. 인증·인가
16. 라이선스 검증
17. Phase 라이프사이클
18. 테스트 전략
19. 빌드와 패키징
20. 배포와 운영
21. 부록 A. 패키지 구조 표준
22. 부록 B. 명명 규칙
23. 부록 C. 코드 스타일
24. 부록 D. 호환성 정책

---

## 1. 머리말

본 매뉴얼은 ModernizeProData(이하 “본 도구”)의 시스템 구조·구현 방식·확장 절차를 정의합니다. 본 매뉴얼을 따른 구현은 본사 표준 산출물로 간주되며, 본사 검토를 통과해야 릴리즈 후보가 됩니다.

본 도구는 단일 사이트(고객사 데이터센터) 안에 설치되어 운영되는 **온프레미스 데스크탑 설치형 제품**이며, 인터넷 접근이 불가한 폐쇄망 환경에서도 모든 기능이 동작해야 합니다. 따라서 외부 SaaS 의존성·런타임 모듈 다운로드·자동 업데이트 채널은 채택하지 않습니다.

본 도구의 데이터 이행 모델은 *AS-IS DB 직접 접속이 아닌* 다음 흐름을 기본 가정으로 합니다.

- 운영팀이 야간 배치로 AS-IS 시스템에서 추출한 **CSV / 고정폭 / EBCDIC binary** 파일을 사이트 내부망(sFTP·전용선·NDM)으로 도구에 전달
- 도구는 추출 파일을 **도구 내장 AS-IS DB(DuckDB 임베디드)** 에 *raw 그대로* 적재(모든 컬럼 = VARCHAR, 인코딩 변환 0)
- 매핑 단계에서 ASIS DDL 정의를 *해석 가이드* 로 사용해 변환·인코딩 처리 규칙을 정의
- 실행 시 변환·검증 후 TO-BE DB(외부 RDB, JDBC 직접 연결) 로 적재

### 1.1 본 매뉴얼의 구현 명명에 대하여

본 매뉴얼은 *결정된 사양* (enum 값·Preflight ID·API endpoint 경로·DB 스키마·색상 토큰 등 도구 동작에 박혀있는 사실) 만 구체값으로 명시하고, *구현 명명* (클래스 이름·인터페이스·메서드 시그니처·패키지 구조·모듈 분리·DTO 필드 이름·Spring Bean 명명·Gradle 빌드 옵션) 은 책임·역할 중심으로 기술합니다. 구체적인 명명은 V1 본 개발 착수 시점에 본사 개발팀이 확정합니다. 본 문서의 표기와 다르더라도 결정된 사양만 충족하면 본 매뉴얼의 요구를 위반하지 않습니다.

따라서 매뉴얼은 "다음 책임을 갖는 컴포넌트가 필요하다" / "다음 역할을 수행하는 인터페이스" 형태로 컴포넌트를 기술하며, 구체 클래스명·패키지 트리·DTO 필드 이름은 의도적으로 제시하지 않습니다.

---

## 2. 시스템 아키텍처

### 2.1 전체 구성도

```
┌──────────────────────────────────────────────────────────────────┐
│ 사이트 내부망                                                     │
│                                                                  │
│  ASIS 운영 시스템                                                 │
│   │ (운영팀 야간 배치 추출 · 본 도구 미접근)                      │
│   ▼                                                              │
│  추출 파일 (CSV / 고정폭 / EBCDIC binary)                        │
│   │ sFTP · NDM · 전용선                                          │
│   ▼                                                              │
│ ┌─ Desktop installer (Electron / native) ────────────────────┐  │
│ │  Frontend SPA  (React 18 · TypeScript 5 · Vite · Tailwind) │  │
│ │     │ REST + WebSocket (loopback)                          │  │
│ │  ┌──┴──────────────────────────────────────────────────┐  │  │
│ │  │ Backend (Spring Boot 3 · Spring Batch 5 · MyBatis)  │  │  │
│ │  │  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌──┐ │  │  │
│ │  │  │  CSV   │ │ Batch  │ │ Driver │ │ Web    │ │L │ │  │  │
│ │  │  │  Ing.  │ │ Engine │ │ Mgr    │ │ API/WS │ │ic│ │  │  │
│ │  │  └───┬────┘ └───┬────┘ └───┬────┘ └───┬────┘ └──┘ │  │  │
│ │  │      │          │          │          │            │  │  │
│ │  │  ┌───┴──────────┴──────────┴──────────┴────────┐  │  │  │
│ │  │  │ Persistence (MyBatis)                       │  │  │  │
│ │  │  └───┬──────────┬──────────┬─────────────────┬─┘  │  │  │
│ │  │      │          │          │                 │    │  │  │
│ │  │ ┌────┴───┐ ┌────┴───┐ ┌────┴────────┐ ┌──────┴─┐ │  │  │
│ │  │ │ H2 Meta│ │ DuckDB │ │ JDBC drivers│ │ License│ │  │  │
│ │  │ │ (file) │ │ AS-IS  │ │  (TO-BE 등) │ │  store │ │  │  │
│ │  │ └────────┘ └────────┘ └─────────────┘ └────────┘ │  │  │
│ │  └─────────────────────────────────────────────────┘  │  │
│ └────────────────────────────────────────────────────────┘  │
│                            │                                 │
│                            │ JDBC (TO-BE 전용)              │
│                            ▼                                 │
│                   TO-BE 신규 시스템 RDB                      │
└──────────────────────────────────────────────────────────────┘
```

### 2.2 핵심 설계 원칙

- **단일 노드 우선** — 본 도구는 한 사이트당 1개 인스턴스를 기본 형태로 합니다. HA·DR 인스턴스를 추가할 수 있으나 동시 실행은 라이선스로 통제됩니다.
- **로컬 우선 통신** — 프론트엔드와 백엔드는 동일 호스트 내 loopback 으로만 통신합니다. 외부 노출이 필요한 경우(External integrations 활성화) 별도 endpoint 를 통해 노출합니다.
- **AS-IS 비침투** — 본 도구는 AS-IS 운영 DB 에 직접 접속하지 않습니다. 운영팀이 추출한 CSV 만 입력으로 받습니다.
- **AS-IS DB 임베디드** — 추출된 데이터는 도구 내장 DuckDB 에 raw 적재하여 AS-IS DB 처럼 다룹니다. 사이트 운영팀이 별도 staging RDB 를 관리할 필요가 없습니다.
- **명시적 사용자 결정** — 자동 매핑 추론을 최소화하고, 모든 매핑은 사용자 결정으로만 활성화됩니다.
- **승인 게이트** — 실행은 반드시 승인된 매핑 스냅샷에 대해서만 가능하며, 매핑 변경·실행은 모두 Audit log 에 기록됩니다.

### 2.3 모듈 분리

백엔드는 다음 책임 단위로 모듈을 분리합니다. 구체 모듈 이름은 본 개발 시점에 확정합니다.

| 책임 단위 | 역할 |
|---|---|
| 공통 도메인 모듈 | 도메인 모델·공통 유틸리티·도메인 enum·예외 정의 |
| 메타 영속성 모듈 | H2 Meta DB 마이그레이션·MyBatis 매퍼 |
| CSV 파싱 모듈 | CSV / 고정폭 / EBCDIC binary 파서 |
| AS-IS DB 모듈 | DuckDB 임베디드 AS-IS DB 라이프사이클 (적재·카탈로그·readiness) |
| TO-BE 드라이버 모듈 | TO-BE 측 JDBC 드라이버 등록·격리·연결 풀 관리 |
| Spring Batch 모듈 | 이행 Job·Step·Reader·Processor·Writer |
| REST API 모듈 | REST 컨트롤러·DTO·검증·예외 변환 |
| WebSocket 모듈 | WebSocket 채널·이벤트 브로드캐스트 |
| 보안 모듈 | 인증·인가·라이선스 검증 |
| 앱 부트스트랩 모듈 | Spring Boot 부트스트랩·구성 통합 |

---

## 3. 기술 스택

### 3.1 런타임

| 항목 | 버전 | 비고 |
|---|---|---|
| Java | 17.0.x LTS | Temurin 또는 Azul 권장 |
| Spring Boot | 3.2.x | 3.3 마이너 업데이트 가능 |
| Spring Batch | 5.1.x | |
| Spring Web (MVC) | Boot 동봉 | WebFlux 사용 안 함 |
| Spring WebSocket | Boot 동봉 | STOMP over SockJS |
| MyBatis | 3.5.x + mybatis-spring-boot-starter | |
| **H2 (메타 DB)** | 2.2.x | file mode (`AUTO_SERVER=FALSE`) |
| **DuckDB (AS-IS DB)** | 0.10.x 이상 | duckdb_jdbc, file mode |
| Tomcat | 10.1 (embedded) | |
| Apache Commons CSV | 1.10.x | CSV 파싱 |
| OpenCSV | 5.x | 대안 파서 |

### 3.2 프론트엔드

| 항목 | 버전 | 비고 |
|---|---|---|
| Node.js | 20.x LTS | 빌드 시점에만 필요 |
| React | 18.x | |
| TypeScript | 5.x | strict 모드 |
| Vite | 5.x | 번들러 |
| Tailwind CSS | 3.x | JIT |
| react-router | 6.x | |
| zustand 또는 redux-toolkit | 최신 안정 | 상태 관리 |
| axios | 1.x | REST 호출 |
| @stomp/stompjs + sockjs-client | 최신 안정 | WS 클라이언트 |

### 3.3 빌드 도구

| 항목 | 비고 |
|---|---|
| Gradle 8.x | 멀티 모듈 |
| pnpm 9.x | 프론트엔드 패키지 매니저 |
| jpackage | 데스크탑 설치형 패키징 |

---

## 4. 디렉토리 구조

저장소는 *백엔드 / 프론트엔드 / 설치 패키저* 3개 영역으로 나눠 책임 단위로 다음과 같이 구성합니다. 구체 모듈 디렉토리명은 본 개발 시점에 확정합니다.

```
ModernizeProData/
├── backend/                           Gradle 멀티 모듈 루트
│   ├── (Gradle 빌드 정의 파일)
│   ├── 앱 부트스트랩 모듈/             Spring Boot 진입점 + 구성 통합
│   │   ├── (Java 소스 + 리소스)
│   │   │   ├── application.yml        프로파일별 구성
│   │   │   └── db/migration/          메타 DB 마이그레이션 스크립트
│   │   └── (테스트 소스)
│   ├── 공통 도메인 모듈/                도메인 모델·enum·예외
│   ├── 메타 영속성 모듈/                H2 Meta DB · MyBatis 매퍼
│   ├── CSV 파싱 모듈/                   CSV / 고정폭 / EBCDIC binary 파서
│   ├── AS-IS DB 모듈/                   DuckDB 임베디드 AS-IS DB 라이프사이클
│   ├── TO-BE 드라이버 모듈/             JDBC 드라이버 등록·격리
│   ├── Spring Batch 모듈/               이행 Job·Step·Reader·Processor·Writer
│   ├── REST API 모듈/                   REST 컨트롤러·DTO·예외 변환
│   ├── WebSocket 모듈/                  WebSocket 채널·이벤트 브로드캐스트
│   └── 보안 모듈/                       인증·인가·라이선스 검증
├── frontend/                          React SPA 빌드 루트
│   ├── (Vite / Tailwind / TS 설정 파일)
│   ├── public/
│   ├── src/
│   │   ├── 진입점·앱 셸                 라우트·전역 레이아웃
│   │   ├── pages/                     화면 단위 컴포넌트 (페이지별 폴더)
│   │   ├── components/                재사용 UI 컴포넌트
│   │   ├── hooks/                     공통 훅
│   │   ├── stores/                    클라이언트 상태 (UI 토글·선택 등)
│   │   ├── services/                  REST API 클라이언트
│   │   ├── ws/                        WebSocket 클라이언트
│   │   ├── types/                     DTO 타입 정의
│   │   ├── utils/
│   │   └── styles/
│   └── tests/
└── installer/                         데스크탑 설치 패키저
    ├── electron/
    └── jpackage/
```

---

## 5. 개발 환경 구축

### 5.1 전제 조건

- JDK 17 이 설치되어 있고 `JAVA_HOME` 이 설정되어 있어야 합니다.
- Node.js 20 LTS·pnpm 9 이상이 설치되어 있어야 합니다.
- Git 2.40 이상.

### 5.2 백엔드

전체 빌드와 로컬 실행은 Gradle 멀티 모듈 루트에서 다음 두 동작을 제공합니다.

- 전체 모듈 클린 빌드
- 앱 부트스트랩 모듈을 통한 로컬 부트런 (기본 포트 8080)

기본 프로파일은 `dev` 입니다. 메타 DB 파일은 `./data/` 하위에 생성됩니다.

### 5.3 프론트엔드

```bash
cd frontend
pnpm install
pnpm dev                        # Vite dev server (포트 5173)
```

dev 모드에서는 Vite 가 `/api` 와 `/ws` 를 백엔드(`localhost:8080`)로 프록시합니다(`vite.config.ts`).

---

## 6. 도메인 모델

### 6.1 핵심 엔티티

다음 트리는 *책임 단위 라벨* 입니다. 각 라벨이 표상하는 도메인 객체의 구체 클래스명·필드명은 본 개발 시점에 확정합니다 (§1.1).

```
Site (사이트)
  └─ Project (프로젝트)
        ├─ TO-BE Connection × 1                    (JDBC)
        ├─ DDL Import × 2                          (asis, tobe)
        ├─ AS-IS 추출 파일 메타 × 1                  (CsvSource 책임)
        ├─ AS-IS DB(DuckDB) 메타 × 1                (AsisDb 책임)
        ├─ Schema Diff × N                         (TO-BE 테이블별)
        │     ├─ Binding Source × N                (JOIN/UNION 바인딩)
        │     ├─ AS-IS Column × N
        │     ├─ TO-BE Column × N
        │     ├─ Column Override × N               (사용자 매핑 결정)
        │     └─ Where Filter (선택)
        ├─ Mapping Snapshot × N                    (버전)
        │     └─ Approval (1:1)
        ├─ Run × N                                 (실행 이력)
        │     ├─ Stage × N                         (§10.6 의 7개 결정 식별자)
        │     └─ Quarantine × N
        └─ Audit Log × N
```

TO-BE Connection 만 외부 DB 자격증명(JDBC) 을 보유합니다. AS-IS 측은 *외부 DB 가 아니므로* JDBC 자격증명을 보유하지 않으며, *AS-IS 추출 파일 메타* (도착·파싱 상태) 와 *AS-IS DB 메타* (도구 내장 DuckDB store 의 적재·readiness 상태) 두 객체가 그 자리를 대체합니다.

### 6.2 주요 enum (결정 사양)

다음 enum 의 *값 식별자* 는 결정된 사양입니다. 도메인 객체에서 동일한 값을 사용해야 합니다 (대소문자·구분자 포함).

- **Project phase** — `PLANNING`, `ANALYSIS`, `REHEARSAL`, `SIGN_OFF`, `CUTOVER`, `HYPERCARE`, `DONE`
- **Snapshot status** — `DRAFT`, `PENDING`, `APPROVED`, `REJECTED`
- **Run mode** — `REHEARSAL`, `CUTOVER`
- **Run result** — `RUNNING`, `OK`, `WARN`, `FAILED`, `ABORTED`
- **MappingStrategy (사용자 결정값)** — `SOURCE_COLUMN`, `NULL_FILL`, `DDL_DEFAULT`
  - 사용자는 Inspector 에서 `SOURCE_COLUMN` 으로 소스 컬럼만 지정하고, 시스템이 type delta·SQL 식 유무로 `PASSTHROUGH` 또는 `TRANSFORM` 으로 결정합니다.
- **MappingRule (시스템 결정값)** — `PASSTHROUGH`, `TRANSFORM`, `NULL_FILL`, `DDL_DEFAULT`, `UNMAPPED`
  - `PASSTHROUGH` — 소스 컬럼 + 자료형 동일 → 직접 복사
  - `TRANSFORM` — 소스 컬럼 + 자료형 차이 또는 SQL 변환식 입력
  - `NULL_FILL` — NULL 채움
  - `DDL_DEFAULT` — DDL DEFAULT 적용
  - `UNMAPPED` — 사용자 결정 대기
- **MappingStatus** — `OK`, `WARN`, `ERROR`, `QUEUED`
- **BindingRole** — `PRIMARY`, `JOIN`, `UNION`
- **CsvParseStatus** (AS-IS 추출 파일 상태) — `UNTESTED`(파일 미도착), `PENDING`(파일 도착, 파싱 미실행), `OK`(파싱 성공), `FAILED`(파싱 실패)
- **SchemaMatchStatus** (ASIS DDL ↔ AS-IS DB 일치) — `OK`, `MISMATCH`, `PENDING`(적재 미완료 또는 비교 미수행)
- **DbReadyState** (AS-IS DB 접근 가능 여부) — `OK`(파일 열기·메타테이블 조회 OK), `FAILED`(파일 손상·잠금·권한 등 접근 실패), `PENDING`(미적재)
- **ConnectionStatus** (TO-BE JDBC 연결) — `UNTESTED`, `OK`, `FAILED`, `STALE`, `TESTING`

위 값 집합·의미·차단 효과는 V1 도구 동작에 박혀있는 결정 사양이며, 구체 enum 타입 명명은 본 개발 시점에 확정합니다.

### 6.3 Project 의 AS-IS 측 데이터 구조

AS-IS 측은 외부 DB 가 아니므로 JDBC 자격증명을 보유하지 않습니다. 대신 두 도메인 객체가 그 자리를 대체합니다.

**AS-IS 추출 파일 메타** — 다음 책임의 필드를 보유합니다.

- 파일명, 인코딩 (UTF-8 / EUC-KR / EBCDIC-KANA / EBCDIC-KANJI 등), 구분자 (`,` / `|` / `\t` / `FB` (고정폭))
- 레코드 길이 (고정폭일 때만), 헤더 유무
- 도착 시각, 파싱 상태(`CsvParseStatus`), 행 수, 파싱 오류 메시지

**AS-IS DB(DuckDB) 메타** — 다음 책임의 필드를 보유합니다.

- DuckDB store 파일 경로 (예: `data/staging/<projectCode>.duckdb`), 파일 크기, 테이블 수
- 적재 완료 여부·적재 시각
- 스키마 일치 상태(`SchemaMatchStatus`) + 불일치 상세
- DB 접근 가능 상태(`DbReadyState`) + 실패 상세

UI 와 DB 양쪽에서 위 두 객체가 *AS-IS DB connection* 의 자리를 대체합니다. 구체 record/class 명명과 필드 식별자는 본 개발 시점에 확정합니다.

---

## 7. 메타 데이터베이스 (H2)

### 7.1 마이그레이션 도구

Flyway 또는 Liquibase 중 하나를 채택합니다. 본 매뉴얼은 Flyway 기준으로 기술합니다.

마이그레이션 스크립트는 앱 부트스트랩 모듈의 클래스패스 리소스(`db/migration/`) 아래에 `V<날짜>__<설명>.sql` 형식으로 보관합니다.

### 7.2 표준 스키마 (요약)

```sql
-- V20260101__init.sql

CREATE TABLE site (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  code          VARCHAR(40) NOT NULL UNIQUE,
  name          VARCHAR(120) NOT NULL,
  env           VARCHAR(40),
  db_kind       VARCHAR(40),
  db_version    VARCHAR(40),
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE project (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  site_id       BIGINT NOT NULL,
  code          VARCHAR(40) NOT NULL,
  name          VARCHAR(200) NOT NULL,
  domain        VARCHAR(80),
  phase         VARCHAR(20) NOT NULL,
  cutover_at    TIMESTAMP,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_project_site FOREIGN KEY (site_id) REFERENCES site(id),
  CONSTRAINT uq_project_site_code UNIQUE (site_id, code)
);

-- TO-BE 전용 (AS-IS 는 외부 DB 가 아니라 별도 테이블)
CREATE TABLE connection (
  id              BIGINT PRIMARY KEY AUTO_INCREMENT,
  project_id      BIGINT NOT NULL,
  side            VARCHAR(8) NOT NULL,        -- 현재 'tobe' 만 사용
  driver_id       VARCHAR(80),
  jdbc_url        VARCHAR(500),
  username        VARCHAR(120),
  password_enc    VARCHAR(500),               -- AES-GCM
  status          VARCHAR(20) NOT NULL DEFAULT 'UNTESTED',
  last_tested_at  TIMESTAMP,
  latency_ms      INT,
  CONSTRAINT fk_conn_project FOREIGN KEY (project_id) REFERENCES project(id)
);

-- AS-IS 추출 파일 메타
CREATE TABLE csv_source (
  id              BIGINT PRIMARY KEY AUTO_INCREMENT,
  project_id      BIGINT NOT NULL UNIQUE,
  filename        VARCHAR(300) NOT NULL,
  encoding        VARCHAR(40)  NOT NULL,
  delimiter       VARCHAR(8)   NOT NULL,        -- ',', '|', '\t', 'FB'
  record_length   INT,                          -- 고정폭일 때만
  has_header      BOOLEAN NOT NULL DEFAULT FALSE,
  arrived_at      TIMESTAMP,
  parse_status    VARCHAR(16) NOT NULL DEFAULT 'UNTESTED',
  record_count    BIGINT,
  parse_error     VARCHAR(2000),
  CONSTRAINT fk_csv_project FOREIGN KEY (project_id) REFERENCES project(id)
);

-- 도구 내장 AS-IS DB(DuckDB) 메타
CREATE TABLE asis_db (
  id                       BIGINT PRIMARY KEY AUTO_INCREMENT,
  project_id               BIGINT NOT NULL UNIQUE,
  store                    VARCHAR(500) NOT NULL,    -- 'data/staging/p1.duckdb'
  store_size_bytes         BIGINT,
  tables_count             INT NOT NULL DEFAULT 0,
  loaded                   BOOLEAN NOT NULL DEFAULT FALSE,
  loaded_at                TIMESTAMP,
  schema_match             VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  schema_mismatch_detail   VARCHAR(2000),
  db_ready                 VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  db_ready_detail          VARCHAR(2000),
  CONSTRAINT fk_asisdb_project FOREIGN KEY (project_id) REFERENCES project(id)
);

CREATE TABLE ddl_import (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  project_id    BIGINT NOT NULL,
  side          VARCHAR(8) NOT NULL,           -- 'asis' | 'tobe'
  filename      VARCHAR(300) NOT NULL,
  table_count   INT NOT NULL,
  column_count  INT NOT NULL,
  imported_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  raw_text      CLOB
);

CREATE TABLE schema_diff (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  project_id    BIGINT NOT NULL,
  internal_name VARCHAR(120) NOT NULL,
  asis_label    VARCHAR(300),
  tobe_name     VARCHAR(300) NOT NULL,
  where_filter  VARCHAR(2000),
  auto_mapped   BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE binding_source (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  schema_diff_id BIGINT NOT NULL,
  alias         VARCHAR(40) NOT NULL,
  table_name    VARCHAR(300) NOT NULL,
  role          VARCHAR(10) NOT NULL,
  join_type     VARCHAR(20),
  join_on       VARCHAR(2000),
  ord           INT NOT NULL
);

CREATE TABLE column_override (
  id              BIGINT PRIMARY KEY AUTO_INCREMENT,
  schema_diff_id  BIGINT NOT NULL,
  tobe_col_name   VARCHAR(300) NOT NULL,
  strategy        VARCHAR(20) NOT NULL,        -- SOURCE_COLUMN / NULL_FILL / DDL_DEFAULT
  source_column   VARCHAR(300),                -- strategy=SOURCE_COLUMN 일 때만
  source_alias    VARCHAR(40),
  transform_expr  VARCHAR(4000),
  note            VARCHAR(1000),
  edited_by       VARCHAR(80),
  edited_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_override UNIQUE (schema_diff_id, tobe_col_name)
);

CREATE TABLE mapping_snapshot (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  project_id    BIGINT NOT NULL,
  version       VARCHAR(20) NOT NULL,
  status        VARCHAR(20) NOT NULL,
  notes         VARCHAR(2000),
  author        VARCHAR(80) NOT NULL,
  reviewer      VARCHAR(80),
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_at   TIMESTAMP,
  approved_by   VARCHAR(80),
  rejected_at   TIMESTAMP,
  rejected_by   VARCHAR(80),
  reject_reason VARCHAR(2000),
  payload_json  CLOB NOT NULL,                 -- 전체 매핑 정의 동결본
  CONSTRAINT uq_snapshot_version UNIQUE (project_id, version)
);

CREATE TABLE migration_run (
  id              BIGINT PRIMARY KEY AUTO_INCREMENT,
  project_id      BIGINT NOT NULL,
  snapshot_id     BIGINT NOT NULL,
  mode            VARCHAR(20) NOT NULL,
  result          VARCHAR(20) NOT NULL,
  triggered_by    VARCHAR(120) NOT NULL,
  trigger_source  VARCHAR(40),
  started_at      TIMESTAMP NOT NULL,
  ended_at        TIMESTAMP,
  rows_total      BIGINT,
  rows_loaded     BIGINT,
  rows_quarantined BIGINT,
  CONSTRAINT fk_run_snap FOREIGN KEY (snapshot_id) REFERENCES mapping_snapshot(id)
);

CREATE TABLE run_quarantine (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  run_id        BIGINT NOT NULL,
  stage         VARCHAR(40) NOT NULL,
  severity      VARCHAR(20) NOT NULL,
  reason        VARCHAR(500) NOT NULL,
  detail        VARCHAR(2000),
  table_name    VARCHAR(300),
  count_rows    INT NOT NULL,
  first_seen_at TIMESTAMP NOT NULL,
  sample_json   CLOB
);

CREATE TABLE audit_log (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  project_id    BIGINT,
  at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actor         VARCHAR(120) NOT NULL,
  action        VARCHAR(40) NOT NULL,
  target        VARCHAR(300),
  detail        VARCHAR(2000)
);

CREATE INDEX ix_audit_project_at ON audit_log(project_id, at DESC);
CREATE INDEX ix_run_project_started ON migration_run(project_id, started_at DESC);
```

### 7.3 백업

H2 file mode 의 데이터 파일(`*.mv.db`, `*.trace.db`)을 운영 시간 외에 주기적으로 복사합니다. AS-IS DB(DuckDB)의 `*.duckdb` 파일도 함께 백업 대상에 포함합니다. 운영 절차서의 “Meta DB Backup” 절을 참조하시기 바랍니다.

---

## 8. AS-IS 데이터 수집 — CSV 적재 + 도구 내장 DB

본 도구의 가장 큰 아키텍처 결정은 **AS-IS DB 직접 접속을 하지 않는다는 점** 입니다. 본 절은 그 대안 흐름을 정의합니다.

### 8.1 도입 동기

한국 SI 데이터 이행 환경에서는 다음과 같은 이유로 AS-IS 운영 DB 에 도구가 직접 JDBC 접속하는 모델이 거의 채택되지 않습니다.

- **네트워크 분리** — ASIS(메인프레임·레거시) 망과 신규 망 간 직통 JDBC 연결이 방화벽 정책상 불가능
- **운영 위험** — ASIS 운영 DB 에 외부 도구가 직접 SELECT 시 부하·락·트랜잭션 영향. 운영팀이 절대 허용 안 함
- **컴플라이언스** — 데이터 이동 경로의 단계별 감사·해시·로그가 표준

따라서 본 도구는 **운영팀이 야간 배치로 추출한 파일** 을 입력으로 받습니다.

### 8.2 입력 파일 포맷 지원

| 포맷 | 사용처 | 구분자 / 레코드 |
|---|---|---|
| CSV (UTF-8) | Oracle / DB2 / 일반 RDB 추출 | `,` 콤마 |
| CSV (EUC-KR) | 구형 한국 시스템 | `,` 또는 `\|` |
| TSV | 일반 추출 | `\t` |
| 고정폭 (Fixed-block, FB) | **메인프레임 EBCDIC binary** | `recordLength` 바이트 단위 |

### 8.3 CSV → AS-IS DB 적재 흐름

```
1. 파일 도착 감지 (sFTP 디렉토리 폴링 또는 명시적 업로드 트리거)
2. 메타 등록 (csv_source 테이블에 filename, encoding, delimiter, recordLength)
3. 파싱 검증 (인코딩 BOM·구분자·레코드 길이 일치 등)
4. DuckDB 임베디드 store 초기화 (data/staging/<projectId>.duckdb)
5. raw 적재 — 모든 컬럼 = VARCHAR, 인코딩 변환 0, 타입 변환 0
6. 스키마 일치 검증 — DuckDB 컬럼 수·이름·길이 vs ASIS DDL 정의
7. db_ready 검증 — 파일 열기·메타테이블 조회 무결성
```

### 8.4 DuckDB 적재 흐름

*AS-IS DB 적재 책임을 갖는 컴포넌트* 는 다음 흐름을 수행합니다.

1. 프로젝트별 store 파일 경로(`data/staging/<projectCode>.duckdb`) 산출
2. DuckDB 임베디드 connection 을 *쓰기 모드* 로 개방
3. 적재 대상 테이블(예: `raw_<projectCode>`) 을 `CREATE OR REPLACE TABLE ... AS SELECT * FROM read_csv_auto(...)` 형태로 일괄 적재
   - DuckDB 의 `read_csv_auto` 에 인코딩·구분자·헤더 유무를 추출 파일 메타에서 그대로 전달
   - **모든 컬럼은 VARCHAR — 인코딩 변환·타입 변환을 적재 시점에 수행하지 않음**
4. 적재된 행 수를 카운트하여 적재 결과(성공/실패·행 수·store 경로) 를 반환

고정폭(FB) 파일은 DuckDB 의 `read_csv_auto` 가 직접 처리할 수 없으므로 별도 전처리 단계에서 *바이트 슬라이스 → 가상 CSV* 로 변환 후 위 흐름에 투입합니다.

### 8.5 raw 적재 원칙 — 모두 VARCHAR

DuckDB 의 AS-IS 적재 결과는 모든 컬럼이 `VARCHAR` 입니다. 이유:

- ASIS COBOL `COMP-3 S9(13)V99` 같은 *비표준 자료형* 을 도구가 *해석하는 시점* 을 명확히 분리
- 인코딩 변환을 *적재 시점이 아닌 매핑 시점* 에 수행 → 변환 실패 시 *어떤 시점에 깨졌는지* 추적 가능
- 단일 컬럼에 대해 *여러 매핑 규칙을 동시 시연* 가능 (raw 가 보존되니까)

매핑 단계에서 ASIS DDL 정의를 *해석 가이드* 로 사용해 변환 SQL 을 적용합니다.

```sql
-- 매핑 시점 (Spring Batch 의 transform stage 에서 실행되는 SQL 예시)
SELECT
  unpack_comp3(BAL_AMT)                        AS balance_amount,
  iconv(NAME_KANJI, 'ebcdic-kana', 'utf-8')    AS account_name,
  to_date(OPEN_DT, '%Y%m%d')                   AS opened_at,
  CAST(STATUS_FLG AS CHAR(1))                  AS status_flag
FROM staging.acct_master
```

### 8.6 스키마 일치 검증

적재 직후 DuckDB 의 `information_schema.columns` 를 조회해 ASIS DDL 정의와 비교하는 *스키마 일치 검증 책임을 갖는 컴포넌트* 가 다음 절차를 수행합니다.

1. ASIS DDL 도입본에서 파싱된 테이블 목록을 가져옴
2. DuckDB 카탈로그에서 적재된 테이블 목록을 가져옴
3. 다음 순서로 비교:
   - 테이블 누락 → `MISMATCH` (`table missing: <name>`)
   - 컬럼 수 불일치 → `MISMATCH` (`column count differs in <table>`)
   - 컬럼명 불일치 (대소문자 무시 비교) → `MISMATCH` (`column name differs at <table>:<index>`)
4. 모두 통과 시 `OK`

본 검증은 `schema-match` Preflight 체크의 백엔드 구현이며, 산출 상태값은 §6.2 의 `SchemaMatchStatus` enum 입니다.

### 8.7 DB 무결성 (db_ready)

적재 완료 이후에도 AS-IS DB 파일은 *손상·잠금·권한* 등의 사유로 접근 불가능 상태가 될 수 있습니다. 매 Run 시작 전에 *DB 무결성 점검 책임을 갖는 컴포넌트* 가 다음 절차를 수행합니다.

1. store 파일 존재 여부 확인 — 없으면 `PENDING`
2. DuckDB connection 을 *읽기 전용* 으로 개방
3. `PRAGMA integrity_check` 실행 + `information_schema.tables` 카운트 조회로 메타테이블 접근성 확인
4. 모두 성공 시 `OK`, 예외 발생 시 `FAILED` (예외 메시지는 상세 필드에 보존)

본 검증은 `asis-db-ready` Preflight 체크의 백엔드 구현이며, 산출 상태값은 §6.2 의 `DbReadyState` enum 입니다.

---

## 9. 백엔드 구현

### 9.1 패키지 표준

백엔드 패키지는 §2.3 의 책임 단위를 그대로 반영하는 다음 구조를 준수합니다. 각 책임 영역 내부는 더 세분화된 책임(파서·리더·밸리데이터·로더·카탈로그·readiness 등) 으로 한 단계 더 분할합니다. 구체 패키지 root 와 식별자는 본 개발 시점에 확정합니다.

```
백엔드 패키지 root
├── 공통 도메인           예외·도메인 enum·상수
├── 메타 영속성            도메인 객체 / 매퍼 / 리포지토리 분리
├── CSV 파싱              파서 / 리더 / 밸리데이터
├── AS-IS DB             적재기 / 카탈로그 / readiness
├── TO-BE 드라이버         드라이버 등록·격리·조회
├── Spring Batch         Job / Step / Reader / Processor / Writer
├── REST API             컨트롤러 / DTO / DTO ↔ 도메인 매퍼 / 예외 변환
├── WebSocket            컨트롤러 / 이벤트
├── 보안                 인증·인가·라이선스 검증
└── 구성                 모든 Spring 구성 클래스 집결
```

### 9.2 예외 처리 표준

도메인 예외는 *공통 도메인 모듈* 의 예외 영역 아래에 정의합니다. 기본 예외형은 다음 책임을 갖습니다.

- 도메인 코드(문자열) 보유 — 클라이언트가 분기에 사용
- HTTP 상태 매핑 보유 — REST 변환 시 사용
- 메시지·상세 필드 보유

표준 도메인 코드와 HTTP 상태 매핑(결정 사양):

| 코드 | HTTP |
|---|---|
| `PROJECT_NOT_FOUND` | 404 |
| `SNAPSHOT_NOT_APPROVED` | 409 |
| `PREFLIGHT_BLOCKED` | 409 |
| `LICENSE_EXPIRED` | 402 |
| `DRIVER_NOT_REGISTERED` | 412 |
| `CSV_PARSE_FAILED` | 422 |
| `ASIS_DB_NOT_READY` | 409 |
| `SCHEMA_MISMATCH` | 409 |

REST 컨트롤러 어드바이스가 도메인 예외를 다음 형태의 응답으로 일괄 변환합니다.

```json
{
  "code": "SCHEMA_MISMATCH",
  "message": "ASIS DDL 과 적재된 AS-IS DB 의 컬럼 수가 다릅니다.",
  "details": {
    "table": "ACCT_MASTER",
    "ddlColumns": 13,
    "stagingColumns": 12
  },
  "traceId": "a9f3c1..."
}
```

### 9.3 트랜잭션 경계

- 조회는 *읽기 전용* 트랜잭션으로 명시
- 쓰기는 서비스 레이어에서 단일 트랜잭션 경계로 통일
- Spring Batch Step 내부의 chunk 트랜잭션은 별도 (자동)
- DuckDB 측 트랜잭션은 메타 DB(H2) 트랜잭션과 *분리* — 둘은 다른 물리 DB

### 9.4 보안

- 메타 DB 의 외부 DB(TO-BE) 비밀번호는 AES-GCM 으로 암호화
- 키는 OS 키링(Windows DPAPI / macOS Keychain) 또는 사이트 KMS 에 보관
- 로그에 비밀번호·자격증명·토큰 출력 금지 (Logback 의 패턴 마스킹 적용)
- AS-IS 측은 외부 자격증명이 없어 본 절차에서 제외

---

## 10. Spring Batch — 이행 엔진

### 10.1 Job 구성

이행 Job 은 다음 Step 으로 구성됩니다 (각 Step 은 책임 단위 — 구체 Step 명명은 본 개발 시점에 확정).

```
이행 Job
  ├─ Preflight 검증 Step               (검증; 실패 시 Job 차단)
  ├─ Snapshot 고정 Step                (실행에 사용할 snapshot 동결)
  ├─ TO-BE 스키마 준비 Step             (TO-BE DDL apply, 인덱스 비활성화 등)
  ├─ 이행 Flow
  │    ├─ Extract Step                 (DuckDB AS-IS DB → 처리 큐)
  │    ├─ Transform Step               (매핑 룰 적용 + 인코딩·타입 변환)
  │    ├─ Load Step                    (TO-BE → INSERT / COPY)
  │    └─ Validate Step                (FK·NOT NULL 검증, 격리)
  ├─ TO-BE 스키마 마무리 Step           (인덱스·통계 갱신)
  └─ 산출물 보고 Step                   (산출물 생성·해시)
```

Extract Step 의 source 가 *DuckDB 임베디드* 라는 점이 본 도구의 특이점입니다. 같은 JVM 안에서 동작하므로 네트워크 왕복이 없고, 컬럼 지향 저장이라 대용량 SELECT 가 빠릅니다.

각 Step 의 진행률 보고에 사용되는 stage 식별자(결정 사양) 는 §10.6 의 7개 — `extract`, `encode`, `unpack`, `transform`, `validate`, `load`, `verify` — 입니다.

### 10.2 Reader / Processor / Writer

#### Reader

DuckDB JDBC URL (`jdbc:duckdb:./data/staging/<projectCode>.duckdb;ACCESS_MODE=read_only`) 에 대해 *Spring Batch 의 cursor 또는 paging 기반 ItemReader* 를 사용합니다. 대용량 테이블은 partitioned step 으로 분할하여 파티셔닝 키 기반 병렬 실행합니다.

Reader 의 책임:

- 프로젝트 코드(jobParameter) 로 store 경로·테이블 이름을 결정
- DuckDB 데이터소스를 *읽기 전용* 으로 개방
- 테이블의 모든 raw 행을 도메인 행 객체(VARCHAR 컬럼 다발) 로 매핑

#### Processor

*매핑 처리 Processor* 는 입력 행을 받아 매핑 룰을 적용한 산출 행을 반환합니다. 룰 적용 책임은 *룰 종류별 적용기* 로 분리됩니다.

- 입력: 소스 행, 매핑 룰 정의(컬럼 단위), 실행 컨텍스트
- 출력: 룰 적용 산출 값

룰 종류별로 다음 5종의 적용기를 둡니다 (식별자는 §6.2 `MappingRule` enum 과 일치).

- `PASSTHROUGH` — 소스 컬럼 값을 자료형 변환 없이 그대로 사용
- `TRANSFORM` — 소스 컬럼 값에 SQL 변환식 또는 자료형 캐스트 적용
- `NULL_FILL` — NULL 출력
- `DDL_DEFAULT` — TO-BE DDL DEFAULT 값 출력
- `UNMAPPED` — 사용자 결정 대기 — Run 전에 모두 해소되어야 함 (Preflight `unmapped-cols` 가 차단)

#### Writer

Spring Batch 의 *JDBC 배치 ItemWriter* 로 INSERT 를 chunk 단위로 commit 합니다. chunk 크기는 사이트 환경에 맞게 외부 설정으로 노출합니다 (기본 1,000).

PostgreSQL TO-BE 의 경우 `COPY` 모드 writer 도 지원하여 적재 속도를 크게 높입니다.

### 10.3 격리(Quarantine) 처리

Validate Step 에서 위반이 검출되면 즉시 Job 을 실패시키지 않고 §7 메타 DB 의 `run_quarantine` 테이블에 적재합니다. 격리 정책:

- 동일 사유 누적이 사이트별 임계치(기본 0.1%) 초과 → Job FAIL
- 그 미만은 Job 은 완료, Run 결과는 `WARN`

### 10.4 멱등성과 재시작

Spring Batch 의 Step Execution 메타데이터를 활용하여 다음을 보장합니다.

- 실패한 Job 의 재실행 시 마지막 커밋 시점부터 재개
- 같은 snapshot+target 으로 두 번 실행 방지 (lock)
- Cutover 모드에서는 `restart-disabled` 정책 적용 (재실행 대신 롤백 절차)

### 10.5 진행률 보고

각 Step 의 chunk 커밋 시 *Run 진행률 이벤트* 를 발행합니다. 이벤트는 다음 정보를 담습니다.

- runId, stageId(§10.6 의 7개 결정 식별자 중 하나), 처리 행 수, 총 행 수
- 초당 처리율, ETA(초), 누적 오류·경고 수

WebSocket 모듈이 본 이벤트를 구독하여 §14.2 의 `/topic/runs/{runId}/progress` 토픽으로 브로드캐스트합니다.

### 10.6 Stage 정의

| 순서 | Stage | 부제 | 책임 |
|---|---|---|---|
| 01 | Extract | DuckDB raw 읽기 | DuckDB AS-IS DB 에서 SELECT |
| 02 | Encode | EBCDIC → UTF-8 | 인코딩 변환 (raw VARCHAR → 변환된 UTF-8) |
| 03 | Unpack | COMP-3 → NUMERIC | 메인프레임 압축 십진수 풀기 |
| 04 | Transform | 룰·룩업 | 사용자 매핑 규칙 적용 |
| 05 | Validate | PK · FK · 제약 | TO-BE DDL 제약 검증, 격리 |
| 06 | Load | TO-BE 적재 | COPY / 벌크 INSERT |
| 07 | Verify | 행 수·체크섬 | 적재 후 정합성 검증 |

본 도구의 *AS-IS 가 DuckDB 임베디드* 라는 사실 외에는 다른 ETL 도구와 흐름이 동일합니다.

---

## 11. JDBC 드라이버 동적 로딩 (TO-BE)

### 11.1 요구사항

- TO-BE DB 가 사이트마다 다르므로(PostgreSQL, Oracle, DB2, Tibero, MariaDB 등) 본 도구 출하 시점에 모든 드라이버를 포함하지 않습니다.
- 사용자가 `*.jar` 드라이버를 등록하면 즉시 사용 가능해야 합니다.
- 드라이버끼리의 클래스 충돌이 발생해도 안전해야 합니다.
- AS-IS 측은 외부 DB 가 아니라 DuckDB 임베디드이므로 본 절의 대상이 아닙니다.

### 11.2 구현 방식

본 절은 두 책임을 갖는 두 컴포넌트로 구성됩니다.

**격리된 JDBC 드라이버 인스턴스** — 자체 ClassLoader 안에서 로드되어 다른 드라이버와 클래스 충돌이 차단되는 단일 드라이버 표현. 다음을 캡슐화합니다.

- driverId, 전용 ClassLoader, 인스턴스화된 Driver 객체
- JDBC URL 과 properties 를 받아 Connection 을 생성하는 책임

**JDBC 드라이버 레지스트리** — 등록된 드라이버를 driverId 로 조회·관리하는 컴포넌트. 등록 절차:

1. 입력: driverId, jar 파일 경로, driver 클래스 FQCN
2. jar 의 URL 만을 수반하는 *분리된 ClassLoader* 를 생성 — 부모를 시스템 ClassLoader 의 부모로 지정해 메인 애플리케이션 클래스패스로부터 격리
3. 분리된 ClassLoader 에서 driver 클래스를 인스턴스화
4. driverId 키로 *격리된 드라이버 인스턴스* 를 레지스트리에 보관

전역 `DriverManager` 등록은 사용하지 않습니다(다른 드라이버 라이프사이클과 간섭).

### 11.3 등록 화면

UI: *Solution Settings › Drivers* (License 활성 시 노출).

- 등록 정보: driverId, 표시 이름, jar 파일, driver class FQCN, JDBC URL 템플릿
- 등록 시 자동 검증: 클래스 로딩 가능 여부 + 메타 DB 에 임시 connection 시도

### 11.4 DuckDB JDBC

DuckDB 자체도 JDBC 드라이버(`duckdb_jdbc`) 를 통해 접근하지만, 이는 *동적 로딩 대상이 아니라* AS-IS DB 모듈에 컴파일 타임 의존성으로 포함됩니다.

---

## 12. 프론트엔드 구현

### 12.1 라우팅

```
/                      Dashboard (활성 프로젝트)
/projects/:id          (=/) 와 동일
/projects/:id/mapping
/projects/:id/versions
/projects/:id/execution
/projects/:id/artifacts
/projects/:id/logs
/projects/:id/settings/:section?
/sites/:id/overview
/sites/:id/settings
```

### 12.2 상태 관리

- 서버 상태: TanStack Query (또는 axios + zustand)
- 클라이언트 상태(UI): zustand (사이드바 토글, 선택 상태, 모달, 알림 인박스)

### 12.3 디자인 시스템

`tailwind.config.ts` 의 토큰을 본 도구의 색·여백 표준으로 정의합니다.

```ts
// 색상 (light theme 기준)
colors: {
  navy:   '#1f3a5f',   navy50:  '#e7eef8',
  green:  '#0c9e6a',   green50: '#e2f5ec',
  amber:  '#d97706',   amber50: '#fef3c7',
  red:    '#c0392b',   red50:   '#fbe8e6',
  text:   '#1c1f23',   text2:   '#3a3f47',
  text3:  '#6b7280',   text4:   '#9ca3af',
  border: '#e2e6ec',   borderStrong: '#c7ccd4',
  panel:  '#ffffff',   panel2:  '#f7f8fa',
  bg:     '#f3f5f7',
}
```

dark theme 은 `data-theme="dark"` 셀렉터로 동일 키를 오버라이드합니다.

### 12.4 Phase 색상 토큰

7개 phase 의 뱃지 색을 단일 진실로 정의합니다.

```ts
// utils/phases.ts
export const PHASES = [
  { k: 'planning',  l: 'Planning',  color: '#A78BFA', bg: '#EDE9FE' },
  { k: 'analysis',  l: 'Analysis',  color: '#38BDF8', bg: '#E0F2FE' },
  { k: 'rehearsal', l: 'Rehearsal', color: '#FB923C', bg: '#FFEDD5' },
  { k: 'sign-off',  l: 'Sign-off',  color: '#FACC15', bg: '#FEF9C3' },
  { k: 'cutover',   l: 'Cutover',   color: '#F87171', bg: '#FEE2E2' },
  { k: 'hypercare', l: 'Hypercare', color: '#4ADE80', bg: '#DCFCE7' },
  { k: 'done',      l: 'Done',      color: '#94A3B8', bg: '#F1F5F9' },
];
```

### 12.5 컴포넌트 배치 규칙

- **페이지 컴포넌트** — 화면 단위로 한 폴더씩 `pages/` 하위에 배치 (예: 매핑 화면 폴더, 실행 화면 폴더).
- **재사용 컴포넌트** — 여러 페이지가 공유하는 시각 위젯(상태 배지·툴바 버튼·모달 등) 은 `components/` 하위에 평면 배치.
- **도메인-특화 위젯** — 매핑 그리드·Inspector 등 단일 페이지 전용 위젯은 해당 페이지 폴더 안에 모읍니다.

구체 컴포넌트 파일명·export 명명은 본 개발 시점에 §22 명명 규칙에 따라 확정합니다.

### 12.6 폼 검증

react-hook-form + zod 스키마로 모든 입력 폼을 통합합니다. 서버 측 검증 오류는 REST API 의 *전역 예외 변환 어드바이스* 에서 동일 zod 호환 형식으로 변환하여 폼에 표시합니다.

---

## 13. REST API 명세

### 13.1 공통 규칙

- Base path: `/api/v1`
- 인증: `Authorization: Bearer <jwt>` (Solution Settings 에서 외부 노출 활성 시) 또는 세션 쿠키(로컬)
- 응답 형식: JSON
- 페이징: `?page=0&size=50` (Spring Data 호환)

### 13.2 엔드포인트

URL 경로·HTTP 메서드·쿼리 파라미터는 결정 사양입니다. 본문 표기에 등장하는 *Body* / 응답형 라벨(예: `ProjectCreateRequest`, `ColumnOverride`, `PreflightCheck`) 은 *DTO 책임 라벨* 이며, 구체 record/class 명명과 필드 식별자는 본 개발 시점에 확정합니다 (§1.1, §13.3).

#### 사이트 / 프로젝트

```
GET    /sites
GET    /sites/{siteId}
GET    /sites/{siteId}/projects
POST   /sites/{siteId}/projects                  Body: ProjectCreateRequest
GET    /projects/{projectId}
PATCH  /projects/{projectId}                     Body: ProjectPatch
DELETE /projects/{projectId}
POST   /projects/{projectId}:duplicate
```

#### DDL · CSV · AS-IS DB

```
POST   /projects/{id}/ddl/{side}                 Body: multipart/form-data
DELETE /projects/{id}/ddl/{side}

POST   /projects/{id}/csv-source                 Body: CsvSourceRegisterRequest
                                                  (filename, encoding, delimiter,
                                                   recordLength, hasHeader)
POST   /projects/{id}/csv-source:upload          Body: multipart (raw 파일)
POST   /projects/{id}/csv-source:parse           → CsvParseResult
GET    /projects/{id}/csv-source                 → CsvSource

POST   /projects/{id}/asis-db:load               → AsisDbLoadResult
GET    /projects/{id}/asis-db                    → AsisDb
POST   /projects/{id}/asis-db:verify-schema      → SchemaMatchResult
POST   /projects/{id}/asis-db:check-ready        → DbReadyState
GET    /projects/{id}/asis-db/tables             → table list (DuckDB catalog)
GET    /projects/{id}/asis-db/tables/{name}/sample  ?limit=10  → sample rows
```

#### TO-BE 연결

```
POST   /projects/{id}/connections/tobe           Body: ConnectionRequest
POST   /projects/{id}/connections/tobe:test      → ConnectionResult
```

#### 매핑

```
GET    /projects/{id}/inventory                  → AsisInventory + TobeInventory
GET    /projects/{id}/schema-diff                → SchemaDiff[]
GET    /projects/{id}/schema-diff/{internalName}/mappings
PUT    /projects/{id}/schema-diff/{internalName}/bindings
                                                  Body: BindingsUpdate
PUT    /projects/{id}/schema-diff/{internalName}/where-filter
                                                  Body: { whereFilter: string }
PUT    /projects/{id}/schema-diff/{internalName}/columns/{col}
                                                  Body: ColumnOverride
DELETE /projects/{id}/schema-diff/{internalName}/columns/{col}
```

#### 스냅샷 · 승인

```
GET    /projects/{id}/snapshots
POST   /projects/{id}/snapshots                  Body: SnapshotCreate
GET    /snapshots/{snapshotId}
POST   /snapshots/{snapshotId}:approve
POST   /snapshots/{snapshotId}:reject            Body: { reason: string }
```

#### 실행

```
GET    /projects/{id}/preflight                  → PreflightCheck[]
POST   /projects/{id}/runs                       Body: RunCreateRequest
                                                  { mode: 'rehearsal' | 'cutover',
                                                    snapshotId, confirmCutover? }
GET    /runs/{runId}
POST   /runs/{runId}:pause
POST   /runs/{runId}:resume
POST   /runs/{runId}:abort
GET    /runs/{runId}/quarantine
GET    /projects/{id}/runs                       (history)
```

#### 산출물 · Audit · 알림 · 솔루션 설정

```
GET    /runs/{runId}/artifacts/{kind}            kind: mapping-yaml | bindings-yaml |
                                                       tobe-ddl | migration-sql | validation-report
GET    /projects/{id}/audit-log                  ?since=...&limit=...
GET    /notifications                            ?unread=true
POST   /notifications/{id}:read
POST   /notifications:read-all
DELETE /notifications

GET    /solution/settings
PUT    /solution/settings                        Body: { lang, theme, notifEnabled,
                                                          extIntegrationsEnabled, ... }
GET    /solution/license
POST   /solution/license:upload                  Body: multipart .lic
GET    /solution/drivers
POST   /solution/drivers                         Body: multipart .jar + meta
DELETE /solution/drivers/{driverId}
```

### 13.3 표준 DTO

DTO 는 다음 책임을 갖는 4종을 표준으로 제공합니다. 구체 record/class 명명·필드 식별자는 본 개발 시점에 확정하지만, 직렬화 시 키 의미와 enum 값(§6.2) 은 결정 사양으로 유지합니다.

**AS-IS 추출 파일 메타 DTO** — §6.3 의 *AS-IS 추출 파일 메타* 와 동일한 필드 책임. 직렬화 시 `parseStatus` 는 `CsvParseStatus` 의 문자열 값 (`"OK" | "FAILED" | "PENDING" | "UNTESTED"`) 을 사용합니다.

**AS-IS DB 메타 DTO** — §6.3 의 *AS-IS DB 메타* 와 동일한 필드 책임. 직렬화 시 `schemaMatch` 는 `SchemaMatchStatus`, `dbReady` 는 `DbReadyState` 의 문자열 값을 사용합니다.

**컬럼 매핑 결정 DTO** — 사용자가 Inspector 에서 저장한 매핑 결정을 담는 객체. 다음 필드 책임을 갖습니다.

- 매핑 전략(`MappingStrategy` — `SOURCE_COLUMN` / `NULL_FILL` / `DDL_DEFAULT`)
- AS-IS 소스 컬럼, 소스 별칭, SQL 변환식 — `SOURCE_COLUMN` 일 때만 의미
- 비고, 편집자, 편집 시각

**Preflight 검사 결과 DTO** — 한 검사 항목의 결과를 담는 객체. 다음 필드 책임을 갖습니다.

- 검사 ID — §13.4 의 13개 결정 식별자 중 하나 (`csv-arrived` ~ `approved-snapshot`)
- 한국어 표시 제목
- 상태 — `pass` / `warn` / `fail` / `skip`
- 상세 메시지
- Fix hint — 사용자를 *문제 해결 화면* 으로 보내기 위한 위치 정보 (탭·섹션·타깃: side·tobeName·internalName·colName)

### 13.4 표준 Preflight 항목 (13건)

| ID | 한국어 title | 차단 |
|---|---|---|
| `csv-arrived` | AS-IS 추출 데이터 도착 | 차단 |
| `csv-parsed` | AS-IS 추출 데이터 파싱 | 차단 |
| `staging-loaded` | AS-IS DB 적재 | 차단 |
| `asis-db-ready` | AS-IS DB 접근 가능 | 차단 |
| `schema-match` | AS-IS DDL 과 AS-IS DB 스키마 일치 | 차단 |
| `ddl-asis` | AS-IS DDL 도입 완료 | 차단 |
| `ddl-tobe` | TO-BE DDL 도입 완료 | 차단 |
| `conn-tobe` | TO-BE 데이터베이스 접속 가능 | 차단 |
| `tobe-bindings` | 모든 TO-BE 테이블 소스 바인딩 | 차단 |
| `asis-orphans` | 미사용 AS-IS 테이블 확인 | 경고 |
| `added-not-null` | NOT NULL 신규 컬럼 default 지정 | 차단 |
| `unmapped-cols` | 모든 TO-BE 컬럼 매핑 지정 | 차단 |
| `approved-snapshot` | 승인된 매핑 스냅샷 존재 | 차단 |

---

## 14. WebSocket 명세

### 14.1 프로토콜

STOMP over SockJS. Endpoint: `/ws`.

### 14.2 토픽

토픽 destination 경로는 결정 사양입니다. 페이로드는 책임 단위로만 기술하며 구체 DTO 명명은 본 개발 시점에 확정합니다.

| Destination | 페이로드 책임 |
|---|---|
| `/topic/projects/{projectId}/csv` | CSV 파싱 진행 이벤트 — 진행률·완료·실패 |
| `/topic/projects/{projectId}/asis-load` | AS-IS DB(DuckDB) 적재 진행 이벤트 |
| `/topic/runs/{runId}/progress` | Run 진행률 이벤트 (chunk 커밋마다) — §10.5 의 정보 항목 |
| `/topic/runs/{runId}/log` | 실시간 로그 라인 |
| `/topic/runs/{runId}/quarantine` | 격리 추가 이벤트 |
| `/topic/projects/{projectId}/notifications` | 인앱 알림 푸시 |
| `/topic/system/health` | 시스템 헬스 — DB·라이선스·연결 상태 |

### 14.3 연결 라이프사이클

- 클라이언트는 페이지 로드 시 `/ws` 로 연결
- 활성 Run · 활성 적재 페이지 진입 시 해당 토픽 subscribe, 이탈 시 unsubscribe
- 60초 ping/pong, 끊김 감지 시 지수 백오프 재연결

---

## 15. 인증·인가

### 15.1 인증 방식

- **로컬 모드(기본)** — 단일 사용자(설치 시 정의)·세션 쿠키
- **확장 모드(엔터프라이즈)** — Spring Security + JWT, 사이트 LDAP/AD 연동

### 15.2 권한 모델

```
Owner       — 모든 동작
Maintainer  — 매핑·실행 가능, 프로젝트 삭제 불가
Reviewer    — 스냅샷 승인 가능, 매핑 편집 불가
Viewer      — 읽기 전용
```

API 측 인가는 *Spring Security 의 메서드 단위 사전 권한 검사* 로 명시합니다. 결정 사양인 권한 매트릭스:

- 매핑·바인딩·실행 등 *변경* 동작 → `OWNER` 또는 `MAINTAINER`
- 스냅샷 *승인/거부* 동작 → `REVIEWER` 또는 `OWNER`
- *읽기* 동작 → 모든 역할

권한 표현식의 구체 표기·어노테이션 위치는 본 개발 시점에 확정합니다.

---

## 16. 라이선스 검증

### 16.1 라이선스 파일 (.lic)

페이로드 + Ed25519 서명을 base64 로 묶은 단일 파일.

```json
{
  "v": 1,
  "licenseId": "MPD-2026-0421-KDB",
  "customer": "KDB Bank",
  "siteId": "s1",
  "edition": "enterprise",
  "features": ["multi-site", "external-trigger"],
  "issuedAt": "2026-04-21",
  "expiresAt": "2027-04-21",
  "graceDays": 14
}
```

`signature` 는 위 페이로드의 JCS 정규화 + SHA-256 + Ed25519 서명입니다.

### 16.2 검증 로직

*라이선스 검증 컴포넌트* 는 빌드 타임에 임베드된 Ed25519 공개키를 사용해 다음 절차를 수행합니다.

- 입력: `.lic` 파일 바이트
- 출력: 라이선스 상태 — `ACTIVE` / `IN_GRACE` / `EXPIRED` / `NOT_YET_VALID` / `SITE_MISMATCH` / `CLOCK_TAMPERED`

검증 흐름 (결정 사양):

1. 페이로드 파싱 + 서명 검증 — JCS 정규화된 payload 의 SHA-256 에 대한 Ed25519 서명을 공개키로 검증. 실패 시 라이선스 비활성화.
2. siteId 매칭 — 페이로드의 siteId 가 설치 사이트와 다르면 `SITE_MISMATCH`.
3. 현재 시각이 `issuedAt` 이전 → `NOT_YET_VALID`.
4. 현재 시각이 `expiresAt + graceDays` 이후 → `EXPIRED`.
5. 현재 시각이 `expiresAt` 이후이지만 grace 기간 내 → `IN_GRACE`.
6. 그 외 → `ACTIVE`.

### 16.3 시계 되감기 방지

마지막 검증 시각을 AES-GCM 으로 봉인하여 `data/license-state.bin` 에 저장합니다. 검증 시 현재 시각이 봉인된 last-seen 보다 이전이면 `CLOCK_TAMPERED` 로 처리하고 라이선스를 비활성화합니다.

### 16.4 만료 영향

| 상태 | 도구 동작 |
|---|---|
| ACTIVE | 모든 기능 사용 가능 |
| IN_GRACE | 모든 기능 사용 가능 + 화면 상단 빨간 배너 |
| EXPIRED | 매핑 편집·실행 차단, 조회·내보내기만 가능 |
| SITE_MISMATCH / CLOCK_TAMPERED | 모든 기능 차단, 사이트 관리자 안내 화면 |

---

## 17. Phase 라이프사이클

본 도구의 Project 는 7개 phase 중 하나에 위치합니다. 전환은 *자동* 과 *수동* 의 혼합입니다.

### 17.1 전환 매트릭스

| 전환 | 트리거 | 자동/수동 | 이유 |
|---|---|---|---|
| (신규) → planning | 프로젝트 생성 | 자동 | 시작점 |
| planning → analysis | AS-IS DDL 도입 | 자동 | 분석 가능 신호 |
| analysis → rehearsal | TO-BE DDL 도입 + AS-IS DB 적재·schema_match=OK + 첫 binding 생성 | 자동 | 매핑 작업 시작 신호 |
| rehearsal → sign-off | 모든 컬럼 매핑 완료 + 스냅샷을 `pending` 으로 생성 | 자동 (스냅샷 생성 시점) | 작업자 손 뗌 신호 |
| sign-off → rehearsal | 리뷰어가 Request changes (rejected) | 자동 | 거부 = 다시 매핑 |
| sign-off → cutover | Cutover 모드로 Run 시작 (Start cutover 클릭) | **수동** | 운영 적용은 명시적 결정 |
| cutover → hypercare | Cutover run 이 result=ok 로 종료 | 자동 | 컷오버 끝 = 안정화 진입 |
| hypercare → done | 운영팀이 안정화 완료 선언 (Settings 에서 명시 변경) | **수동** | 비즈니스 판단 |

### 17.2 Run 모드와 phase

| Run 모드 | phase 영향 |
|---|---|
| Rehearsal run 시작/종료 | phase 변경 없음 (rehearsal/sign-off 안에서 반복) |
| Cutover run 시작 | sign-off → cutover (자동) |
| Cutover run 정상 완료 | cutover → hypercare (자동) |
| Cutover run 실패/abort | cutover 유지 (사용자가 롤백 후 sign-off 로 회귀하거나 재시도) |

### 17.3 Project Settings 에서 수동 phase 변경

원칙적으로 phase 는 자동 전환됩니다. 다만 *예외 케이스* (운영 사정으로 강제 후퇴 또는 done 선언) 를 위해 *Project Settings › General* 에 phase 콤보박스를 노출할 수 있습니다. 수동 변경 이벤트는 Audit log 에 기록됩니다.

---

## 18. 테스트 전략

### 18.1 백엔드

- **단위 테스트** — JUnit 5 + AssertJ + Mockito. 도메인 로직(룰 적용기, 매핑 생성기, 서명 검증) 100% 커버.
- **MyBatis 매퍼 테스트** — H2 in-memory 로 매퍼 단위 검증.
- **DuckDB 적재 통합 테스트** — 임시 store 파일을 만든 뒤 적재·검증 시나리오를 end-to-end 로 실행.
- **Spring Batch 통합 테스트** — Spring Batch 의 테스트 지원으로 Job·Step 단위 검증.
- **REST API 테스트** — Spring Boot 의 컨트롤러 슬라이스 테스트 또는 랜덤 포트 부트 테스트와 RestAssured 조합.
- **이행 시나리오 통합** — Testcontainers 로 PostgreSQL·Oracle XE 컨테이너 띄워 end-to-end 시나리오 실행.

### 18.2 프론트엔드

- **단위** — Vitest + Testing Library.
- **E2E** — Playwright. 핵심 시나리오: 로그인 → 프로젝트 생성 → DDL 도입 → CSV 업로드 → AS-IS DB 적재 → binding → 매핑 → 스냅샷 → 승인 → run.

### 18.3 회귀

- 모든 PR 은 단위 + 매퍼 + API 테스트가 통과해야 머지 가능
- 메이저 릴리즈 이전에 통합 시나리오 + E2E 실행 및 회귀 보고서 첨부

---

## 19. 빌드와 패키징

### 19.1 빌드 산출물

- 앱 부트스트랩 모듈의 Spring Boot fat jar — `<앱 모듈>/build/libs/<artifact>-{version}.jar`
- 프론트엔드 정적 자산 — `frontend/dist/` — 본 자산은 fat jar 의 `static/` 으로 포함됩니다.

### 19.2 패키징

본사 표준은 두 형태를 동시 제공합니다.

#### A. Standalone fat jar

앱 부트스트랩 모듈의 fat jar 를 표준 `java -jar <artifact>-<version>.jar` 로 실행합니다. 설치 호스트의 OS 가 임의여도 동작합니다.

#### B. 데스크탑 설치형 (jpackage)

`jpackage` 빌드는 다음 옵션을 결정 사양으로 사용합니다 (jar 파일명은 §19.1 의 fat jar 산출물에 맞춰 치환).

```bash
jpackage --type msi --name ModernizeProData \
  --input dist/ \
  --main-jar <fat-jar 파일명>.jar \
  --main-class org.springframework.boot.loader.launch.JarLauncher \
  --runtime-image build/jdk-17-runtime \
  --icon installer/icons/mpd.ico \
  --vendor "KS Info System Co., Ltd." \
  --app-version <release version>
```

Windows 는 `.msi`, macOS 는 `.dmg`, Linux 는 `.deb` / `.rpm` 으로 산출합니다.

### 19.3 버전 표기

`major.minor.patch` (Semantic Versioning). About 모달의 build 식별자는 다음 형식으로 자동 주입합니다.

```
v1.0.0 · build 2026.04.18-a9f3c1
```

`a9f3c1` 은 Git 단축 SHA.

---

## 20. 배포와 운영

### 20.1 시스템 요구사항

| 항목 | 최소 | 권장 |
|---|---|---|
| CPU | 4 cores | 8 cores 이상 |
| RAM | 8 GB | 16 GB 이상 |
| Disk | 50 GB (Meta + 산출물) | 200 GB SSD (대용량 AS-IS DB 적재 대비) |
| Java | 17.0.x LTS | 17.0.10 이상 |
| OS | Windows Server 2019 / RHEL 8 / Ubuntu 20.04 | 동일 최신 패치 |

대용량 AS-IS DB(억 단위 행) 적재 시 SSD + 충분한 RAM 권장.

### 20.2 디렉토리 구조 (설치 후)

설치 산출 디렉토리는 다음 책임 단위로 구성됩니다. 데이터 디렉토리 안의 식별자(`staging/`, `incoming/`, `license-state.bin`, `drivers/`, `runs/`) 는 결정 사양으로 유지하며, 실행 jar 파일명·H2 메타 DB 파일명은 본 개발 시점의 아티팩트명에 맞춰 확정합니다.

```
<install>/
├── bin/                    실행 스크립트
├── lib/                    Spring Boot fat jar
├── runtime/                동봉 JRE
├── data/
│   ├── <메타 DB 파일>.mv.db   H2 메타 DB
│   ├── staging/            도구 내장 AS-IS DB (DuckDB) — 프로젝트별 store
│   │   ├── <projectCode>.duckdb
│   │   └── ...
│   ├── incoming/           CSV 추출 파일 도착 디렉토리 (sFTP 대상)
│   ├── license-state.bin   봉인된 라이선스 상태
│   ├── drivers/            등록된 TO-BE JDBC 드라이버
│   └── runs/               Run 산출물
├── config/
│   ├── application.yml
│   └── public-key.pem      라이선스 검증용 공개키 (사실상 빌드 임베드)
└── logs/
    ├── app.log
    ├── audit.log
    └── access.log
```

### 20.3 systemd 서비스 (Linux)

```
[Unit]
Description=ModernizeProData
After=network.target

[Service]
Type=simple
User=mpd
WorkingDirectory=/opt/modernizeprodata
ExecStart=/opt/modernizeprodata/bin/mpd
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### 20.4 모니터링

- `/api/v1/health` 엔드포인트 (Spring Actuator)
- 로그는 logback-spring.xml 의 RollingFileAppender 로 분리:
  - `logs/app.log` — 애플리케이션 로그 (DEBUG/INFO/WARN/ERROR)
  - `logs/audit.log` — Audit log (변경 불가)
  - `logs/access.log` — HTTP 액세스
- Syslog 전달은 *Solution Settings › External integrations* 에서 활성화

### 20.5 백업 / 복구

운영 절차서의 "백업·복구" 장 참조. 핵심 항목:

- Meta DB 일일 백업 (cron + `cp` 또는 H2 의 `BACKUP TO`)
- **AS-IS DB(DuckDB) 일일 백업** — `data/staging/*.duckdb` 파일 복사. 단 적재 진행 중에는 락이 걸려있을 수 있어 적재 완료 후 시점에 백업.
- 등록 드라이버 디렉토리 함께 백업
- 라이선스 파일은 본사 보관본을 정본으로 함

### 20.6 AS-IS DB 디스크 관리

DuckDB store 는 적재된 raw 데이터를 보관하므로 사이트별로 수 GB ~ 수십 GB 가 누적될 수 있습니다.

- 한 프로젝트가 *cutover 완료* 상태에 도달하면 해당 store 는 *읽기 전용 보존* 으로 전환 가능 (운영 절차서 참조)
- *done* 단계의 프로젝트는 store 를 별도 압축·보관 후 활성 디스크에서 제거 가능

---

## 21. 부록 A. 패키지 구조 표준

본 도구의 백엔드 패키지 root 는 본 개발 시점에 본사 개발팀이 확정합니다. 모든 신규 클래스는 §9.1 의 책임 단위 분할(공통 도메인·메타 영속성·CSV 파싱·AS-IS DB·TO-BE 드라이버·Spring Batch·REST API·WebSocket·보안·구성) 안에 배치되어야 합니다.

신규 모듈 추가 시 준수 사항:

1. Gradle 멀티 모듈 settings 에 모듈을 등록
2. 모듈 빌드 정의의 dependencies 에는 *현재 모듈이 의존하는 모듈* 만 선언 (역방향 의존 금지 — 책임 단위 표를 의존 방향과 일치시킴)
3. 모듈 패키지 root 에 *모듈 책임 한 줄 설명* 을 보유한 패키지 정보 파일을 둘 것

---

## 22. 부록 B. 명명 규칙

### 22.1 Java

- 클래스: PascalCase, 약어는 첫 글자만 대문자 (`JdbcUrl` 가 아니라 `JdbcUrl`)
- 메서드: camelCase, 동사로 시작 (`fetchAsisColumns`, `applyOverride`)
- 상수: SCREAMING_SNAKE_CASE
- 패키지: 단수 명사 (`mapping`, `binding`, 복수 금지)

### 22.2 TypeScript / React

- 컴포넌트: PascalCase 파일명 + default export
- 훅: `use` 접두 + camelCase (`useColumnMappings`)
- 타입: PascalCase, 인터페이스 접두 `I` 사용 안 함
- 상수: SCREAMING_SNAKE_CASE 또는 camelCase (단일 모듈 내부)

### 22.3 SQL

- 테이블·컬럼: snake_case
- 인덱스: `ix_<table>_<columns>`
- 외래키: `fk_<table>_<ref>`
- 유니크: `uq_<table>_<columns>`

---

## 23. 부록 C. 코드 스타일

### 23.1 Java

- `.editorconfig` 에 들여쓰기 4 스페이스, LF, UTF-8 강제
- Google Java Format 적용 (Gradle 플러그인)
- import 정렬: java → javax → org → com → 기타 → 정적
- `var` 는 우변에서 타입이 명백할 때만 사용 (체이닝·제네릭 추론 X)

### 23.2 TypeScript

- ESLint + Prettier 강제, `tsconfig.json` 의 `strict: true`
- `any` 사용 금지 (불가피한 경우 `// eslint-disable-next-line ... -- 사유` 명시)
- 컴포넌트 props 는 인라인 type alias (`type Props = { ... }`)

### 23.3 커밋 메시지

Conventional Commits 준수:

```
feat(asis): add DuckDB schema-match verification
fix(batch): retry transient DuckDB read on integrity_check
docs(dev): clarify AS-IS DB ingestion flow
refactor(api): extract column-override mapper
```

---

## 24. 부록 D. 호환성 정책

REST API 또는 도메인 모델의 비호환 변경은 릴리즈 노트와 커밋 메시지에서 `BREAKING:` 접두로 명시하고, 클라이언트가 따라야 할 마이그레이션 절차를 함께 제공합니다. 마이너 릴리즈에는 비호환 변경을 포함하지 않습니다.

---

**문서 끝.**
